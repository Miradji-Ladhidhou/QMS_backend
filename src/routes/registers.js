import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { buildRegisterXlsx } from '../services/registerReportXlsx.js';
import { cellToValue } from '../services/excelParsing.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
router.use(requireAuth);
router.use(requireMenuVisible('documents'));

const DEFAULT_COLUMNS = [
  { id: 'col_item', name: 'Désignation / Élément', type: 'text' },
  { id: 'col_responsible', name: 'Responsable', type: 'text' },
  { id: 'col_due_date', name: "Date d'échéance", type: 'date', is_planning: true },
  { id: 'col_status', name: 'Statut', type: 'select', options: ['À planifier', 'En cours', 'Conforme', 'À réviser', 'Terminé'] },
  { id: 'col_notes', name: 'Observations / Commentaires', type: 'text' },
];

function extractPlanningFields(registerColumns, rowData) {
  const columns = Array.isArray(registerColumns) ? registerColumns : [];
  let planningDate = null;
  let planningTitle = null;

  // Colonne date marquée pour le planning (ou première date avec is_planning)
  const planningCol = columns.find((c) => c.type === 'date' && c.is_planning) || columns.find((c) => c.type === 'date');
  if (planningCol && rowData?.[planningCol.id]) {
    const raw = String(rowData[planningCol.id]).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      planningDate = raw;
    }
  }

  // Titre représentatif (premier champ texte non-vide)
  for (const col of columns) {
    if (col.type !== 'date' && rowData?.[col.id]) {
      const val = String(rowData[col.id]).trim();
      if (val) {
        planningTitle = val.slice(0, 100);
        break;
      }
    }
  }

  return { planningDate, planningTitle: planningTitle || 'Ligne de registre' };
}

// GET /api/registers — liste de tous les registres du tenant
router.get('/', async (req, res) => {
  const { data: registers, error } = await supabase
    .from('document_registers')
    .select('*, rows:document_register_rows(id)')
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les registres.' });
  }

  const formatted = (registers || []).map((r) => ({
    ...r,
    rows_count: r.rows?.length || 0,
    rows: undefined,
  }));

  res.json(formatted);
});

// POST /api/registers — création d'un nouveau registre
router.post(
  '/',
  requireRole('admin', 'manager'),
  [
    body('title').trim().notEmpty().withMessage('Le titre du registre est requis.'),
    body('description').optional().trim(),
    body('folder').optional({ nullable: true }).isString().trim().isLength({ max: 120 }),
    body('columns').optional().isArray(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { title, description, columns, folder } = req.body;
    const finalColumns = Array.isArray(columns) && columns.length > 0 ? columns : DEFAULT_COLUMNS;

    const { data, error } = await supabase
      .from('document_registers')
      .insert({
        tenant_id: req.tenantId,
        title,
        description: description || null,
        folder: folder || null,
        columns: finalColumns,
        created_by: req.user.id,
      })
      .select('*')
      .single();

    if (error || !data) {
      return res.status(500).json({ error: 'Erreur lors de la création du registre.' });
    }

    res.status(201).json({ ...data, rows: [], rows_count: 0 });
  }
);

// GET /api/registers/:id — détail d'un registre et de ses lignes
router.get('/:id', async (req, res) => {
  const { data: register, error: regError } = await supabase
    .from('document_registers')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (regError || !register) {
    return res.status(404).json({ error: 'Registre introuvable.' });
  }

  const { data: rows, error: rowsError } = await supabase
    .from('document_register_rows')
    .select('*, creator:users(id, full_name)')
    .eq('tenant_id', req.tenantId)
    .eq('register_id', req.params.id)
    .order('created_at', { ascending: true });

  if (rowsError) {
    return res.status(500).json({ error: 'Impossible de charger les lignes du registre.' });
  }

  res.json({
    ...register,
    rows: rows || [],
    rows_count: rows?.length || 0,
  });
});

// PATCH /api/registers/:id — mise à jour du registre (titre, colonnes)
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('title').optional().trim().notEmpty().withMessage('Le titre ne peut pas être vide.'),
    body('description').optional().trim(),
    body('folder').optional({ nullable: true }).isString().trim().isLength({ max: 120 }),
    body('columns').optional().isArray().withMessage('Les colonnes doivent être un tableau.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    const { title, description, columns, folder } = req.body;
    const update = {};
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description || null;
    if (folder !== undefined) update.folder = folder || null;
    if (columns !== undefined) update.columns = columns;

    const { data: updated, error } = await supabase
      .from('document_registers')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error || !updated) {
      return res.status(500).json({ error: 'Impossible de mettre à jour le registre.' });
    }

    // Si les colonnes ont changé, réactualiser les dates de planning des lignes existantes
    if (columns !== undefined) {
      const { data: rows } = await supabase
        .from('document_register_rows')
        .select('id, data')
        .eq('tenant_id', req.tenantId)
        .eq('register_id', req.params.id);

      if (rows && rows.length > 0) {
        for (const row of rows) {
          const { planningDate, planningTitle } = extractPlanningFields(updated.columns, row.data);
          await supabase
            .from('document_register_rows')
            .update({ planning_date: planningDate, planning_title: planningTitle })
            .eq('id', row.id);
        }
      }
    }

    res.json(updated);
  }
);

// DELETE /api/registers/:id — suppression d'un registre
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error } = await supabase
    .from('document_registers')
    .delete()
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Impossible de supprimer le registre.' });
  }

  res.json({ success: true });
});

// POST /api/registers/:id/rows — ajout d'une ligne
router.post(
  '/:id/rows',
  requireRole('admin', 'manager'),
  [body('data').isObject().withMessage('Données de ligne invalides.')],
  async (req, res) => {
    const { data: register, error: regError } = await supabase
      .from('document_registers')
      .select('id, columns')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (regError || !register) {
      return res.status(404).json({ error: 'Registre introuvable.' });
    }

    const { planningDate, planningTitle } = extractPlanningFields(register.columns, req.body.data);

    const { data: createdRow, error: insertError } = await supabase
      .from('document_register_rows')
      .insert({
        tenant_id: req.tenantId,
        register_id: register.id,
        data: req.body.data || {},
        planning_date: planningDate,
        planning_title: planningTitle,
        created_by: req.user.id,
      })
      .select('*, creator:users(id, full_name)')
      .single();

    if (insertError || !createdRow) {
      return res.status(500).json({ error: "Erreur lors de l'enregistrement de la ligne." });
    }

    res.status(201).json(createdRow);
  }
);

// PATCH /api/registers/:id/rows/:rowId — modification d'une ligne
router.patch(
  '/:id/rows/:rowId',
  requireRole('admin', 'manager'),
  [body('data').isObject().withMessage('Données de ligne invalides.')],
  async (req, res) => {
    const { data: register } = await supabase
      .from('document_registers')
      .select('id, columns')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (!register) {
      return res.status(404).json({ error: 'Registre introuvable.' });
    }

    const { planningDate, planningTitle } = extractPlanningFields(register.columns, req.body.data);

    const { data: updatedRow, error } = await supabase
      .from('document_register_rows')
      .update({
        data: req.body.data,
        planning_date: planningDate,
        planning_title: planningTitle,
      })
      .eq('tenant_id', req.tenantId)
      .eq('register_id', req.params.id)
      .eq('id', req.params.rowId)
      .select('*, creator:users(id, full_name)')
      .single();

    if (error || !updatedRow) {
      return res.status(500).json({ error: 'Impossible de modifier la ligne.' });
    }

    res.json(updatedRow);
  }
);

// DELETE /api/registers/:id/rows/:rowId — suppression d'une ligne
router.delete('/:id/rows/:rowId', requireRole('admin', 'manager'), async (req, res) => {
  const { error } = await supabase
    .from('document_register_rows')
    .delete()
    .eq('tenant_id', req.tenantId)
    .eq('register_id', req.params.id)
    .eq('id', req.params.rowId);

  if (error) {
    return res.status(500).json({ error: 'Impossible de supprimer la ligne.' });
  }

  res.json({ success: true });
});

router.post('/:id/import', requireRole('admin', 'manager'), upload.single('file'), async (req, res) => {
  if (!req.file || !/\.xlsx$/i.test(req.file.originalname)) {
    return res.status(400).json({ error: 'Sélectionnez un fichier .xlsx.' });
  }

  const { data: register } = await supabase.from('document_registers').select('id, columns')
    .eq('tenant_id', req.tenantId).eq('id', req.params.id).maybeSingle();
  if (!register) return res.status(404).json({ error: 'Registre introuvable.' });

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return res.status(400).json({ error: 'Le fichier Excel ne contient aucune feuille.' });
    const exported = String(sheet.getRow(4).getCell(1).text).trim() === 'Ligne';
    const headerIndex = exported ? 4 : 1;
    const firstColumn = exported ? 2 : 1;
    const header = sheet.getRow(headerIndex);
    const names = Array.from({ length: Math.min(header.cellCount - firstColumn + 1, 100) }, (_, index) =>
      String(header.getCell(firstColumn + index).text || '').replace(/\s*📅\s*$/, '').trim());
    if (!names.length || names.some((name) => !name) || new Set(names.map((name) => name.toLocaleLowerCase('fr'))).size !== names.length || header.cellCount - firstColumn + 1 > 100) {
      return res.status(400).json({ error: 'La première ligne doit contenir des noms de colonnes uniques et non vides (100 maximum).' });
    }

    let columns = register.columns || [];
    const matches = names.length === columns.length && names.every((name) => columns.some((col) => col.name === name));
    let replaceColumns = false;
    if (!matches) {
      const { count, error: countError } = await supabase.from('document_register_rows')
        .select('id', { count: 'exact', head: true }).eq('tenant_id', req.tenantId).eq('register_id', register.id);
      if (countError) return res.status(500).json({ error: 'Impossible de vérifier les entrées du registre.' });
      columns = count ? [...columns] : [];
      names.forEach((name, index) => {
        if (!columns.some((column) => column.name === name)) {
          columns.push({ id: count ? `col_import_${Date.now()}_${index + 1}` : `col_import_${index + 1}`, name, type: 'text' });
        }
      });
      replaceColumns = true;
    }

    const entries = [];
    for (let rowIndex = headerIndex + 1; rowIndex <= sheet.rowCount; rowIndex += 1) {
      const row = sheet.getRow(rowIndex);
      const values = names.map((_, index) => cellToValue(row.getCell(firstColumn + index)));
      if (values.every((value) => value == null || value === '')) continue;
      if (entries.length >= 1000) return res.status(400).json({ error: 'Limite de 1000 lignes par import.' });

      const data = {};
      for (let index = 0; index < names.length; index += 1) {
        const col = columns.find((column) => column.name === names[index]);
        let value = values[index];
        if (col.type === 'date' && value) {
          const match = String(value).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
          if (match) value = `${match[3]}-${match[2]}-${match[1]}`;
          const date = new Date(`${value}T00:00:00Z`);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
            return res.status(400).json({ error: `Date invalide à la ligne ${rowIndex} (${col.name}).` });
          }
        }
        if (col.type === 'number' && value !== '' && value != null) {
          value = Number(value);
          if (!Number.isFinite(value)) return res.status(400).json({ error: `Nombre invalide à la ligne ${rowIndex} (${col.name}).` });
        }
        data[col.id] = value == null ? '' : String(value);
      }
      const { planningDate, planningTitle } = extractPlanningFields(columns, data);
      entries.push({ tenant_id: req.tenantId, register_id: register.id, data,
        planning_date: planningDate, planning_title: planningTitle, created_by: req.user.id });
    }
    if (!entries.length) return res.status(400).json({ error: 'Aucune ligne à importer.' });
    if (replaceColumns) {
      const { error: updateError } = await supabase.from('document_registers').update({ columns })
        .eq('tenant_id', req.tenantId).eq('id', register.id);
      if (updateError) return res.status(500).json({ error: 'Impossible de configurer les colonnes du registre.' });
    }
    const { error } = await supabase.from('document_register_rows').insert(entries);
    if (error) return res.status(500).json({ error: "Impossible d'importer les lignes." });
    res.json({ imported: entries.length, columns });
  } catch {
    res.status(400).json({ error: 'Fichier Excel illisible ou invalide.' });
  }
});

// GET /api/registers/:id/export-xlsx — export complet sous forme de tableur Excel
router.get('/:id/export-xlsx', async (req, res) => {
  const { data: register, error: regError } = await supabase
    .from('document_registers')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (regError || !register) {
    return res.status(404).json({ error: 'Registre introuvable.' });
  }

  const { data: rows } = await supabase
    .from('document_register_rows')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('register_id', req.params.id)
    .order('created_at', { ascending: true });

  const [{ data: tenant }, { data: userProfile }] = await Promise.all([
    supabase.from('tenants').select('name').eq('id', req.tenantId).maybeSingle(),
    supabase.from('users').select('full_name').eq('id', req.user.id).maybeSingle(),
  ]);

  const buffer = await buildRegisterXlsx({
    register,
    rows: rows || [],
    tenantName: tenant?.name,
    exportedBy: userProfile?.full_name || req.user?.email,
  });

  const safeTitle = (register.title || 'registre').replace(/[^a-zA-Z0-9à-ÿÀ-Ý_-]+/g, '_');
  const filename = `${safeTitle}-tableur-registre.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(buffer);
});

export default router;
