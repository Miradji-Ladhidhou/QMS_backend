import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { buildKpiReportPdf } from '../services/kpiReportPdf.js';
import { fetchTenantLogoBuffer } from '../services/tenantLogo.js';
import { computeGroup, describeCalculation, groupRowsByPeriod, validateFilters } from '../services/kpiCalculation.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const KPI_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];
const KPI_TARGET_DIRECTIONS = ['min', 'max'];
// Le type de calcul précis (ratio, sum, average, min, max, count, count_grouped) vit dans
// kpi_calculation_configs.calc_type — ici on distingue seulement saisie manuelle vs calculée.
const KPI_CALCULATION_TYPES = ['manual', 'import'];
export const KPI_CALC_TYPES = ['ratio', 'sum', 'average', 'min', 'max', 'count', 'count_grouped'];
const PATCHABLE_FIELDS = ['name', 'unit', 'target', 'target_direction', 'frequency', 'calculation_type', 'folder_id', 'category_id'];
const RECORD_PATCHABLE_FIELDS = ['period_date', 'value', 'comment'];
export const RECORDS_SELECT =
  'id, period_date, value, comment, source, source_import_id, config_id, recorded_by, recorded_by_user:users!kpi_records_recorded_by_fkey(id, full_name)';

router.use(requireAuth);
router.use(requireMenuVisible('kpis'));

// GET /api/kpis — liste avec valeurs historiques. Sans ?folder_id, renvoie TOUS les KPI du
// tenant (utilisé par le tableau de bord et le rapport PDF, qui ont besoin de l'ensemble
// indépendamment du classement). Avec ?folder_id=root ou =<uuid>, ne renvoie que les KPI de
// ce dossier — c'est ce qu'utilise la page KPI en navigation par dossier.
router.get('/', async (req, res) => {
  const { folder_id: folderId } = req.query;

  let query = supabase
    .from('kpis')
    // calculation_configs (toutes les séries du KPI, id+label+calc_type surtout) permet au
    // frontend de choisir la bonne visualisation par carte (tendance multi-séries vs
    // répartition) et de nommer chaque courbe, sans une requête par KPI.
    .select(
      `*, records:kpi_records(${RECORDS_SELECT}), calculation_configs:kpi_calculation_configs(id, label, calc_type, group_by_column), category:categories(id, name, color, is_restricted, owner_user_id)`
    )
    .eq('tenant_id', req.tenantId);

  if (folderId) {
    query = folderId === 'root' ? query.is('folder_id', null) : query.eq('folder_id', folderId);
  }

  const { data, error } = await query.order('name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les KPIs.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  // is_private_to_me : la carte KPI n'a que cette liste pour ouvrir sa modale d'édition (voir
  // Kpis.jsx, onEdit={setFormModal}), jamais un second appel GET /:id — calculé ici pour la
  // même raison que sur GET /:id juste en dessous.
  res.json(visible.map((kpi) => ({ ...kpi, is_private_to_me: kpi.category?.owner_user_id === req.user.id })));
});

// GET /api/kpis/report — rapport PDF de synthèse (audit / revue de direction). Placée
// avant GET /:id : sinon "report" serait capturé comme un id et renverrait 404.
// ?folder_id= optionnel, mêmes valeurs que GET / ('root' ou un uuid) : sans lui, le rapport
// couvre tout le tenant (comportement historique, conservé pour un appel externe éventuel) ;
// avec lui, le rapport se limite exactement aux KPI du dossier actuellement affiché à l'écran
// — la page KPI le fournit désormais systématiquement (voir handleGenerateReport côté
// frontend) pour que le PDF corresponde toujours à ce que l'utilisateur regarde, plutôt que de
// toujours tout exporter en vrac quel que soit le dossier ouvert.
router.get('/report', async (req, res) => {
  const { folder_id: folderId } = req.query;

  const { data: tenant } = await supabase.from('tenants').select('name, logo_url').eq('id', req.tenantId).single();
  const tenantLogo = await fetchTenantLogoBuffer(tenant?.logo_url);

  let query = supabase
    .from('kpis')
    // calculation_configs nécessaire pour reconnaître un KPI multi-séries dans le PDF (voir
    // buildSeriesInfo dans kpiReportPdf.js) — même embed que GET /.
    .select(
      `*, records:kpi_records(${RECORDS_SELECT}), calculation_configs:kpi_calculation_configs(id, label, calc_type, group_by_column), category:categories(id, name, color, is_restricted, owner_user_id)`
    )
    .eq('tenant_id', req.tenantId);

  if (folderId) {
    query = folderId === 'root' ? query.is('folder_id', null) : query.eq('folder_id', folderId);
  }

  const { data: rawKpis, error } = await query.order('name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de générer le rapport.' });
  }

  const kpis = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: rawKpis });

  // Pour les KPI calculés depuis un import, la mention "preuve d'audit" du rapport a besoin
  // du nombre total de lignes brutes jamais importées et de la date du dernier import.
  // kpi_raw_imports.row_count évite de recompter kpi_raw_rows ligne par ligne.
  const importKpiIds = kpis.filter((kpi) => kpi.calculation_type === 'import').map((kpi) => kpi.id);
  const detailStatsByKpi = {};

  if (importKpiIds.length > 0) {
    const { data: importRows } = await supabase
      .from('kpi_raw_imports')
      .select('kpi_id, imported_at, row_count')
      .eq('tenant_id', req.tenantId)
      .in('kpi_id', importKpiIds)
      .order('imported_at', { ascending: false });

    for (const importRow of importRows || []) {
      detailStatsByKpi[importRow.kpi_id] = detailStatsByKpi[importRow.kpi_id] || { count: 0, lastImportedAt: null };
      detailStatsByKpi[importRow.kpi_id].count += importRow.row_count;
      if (!detailStatsByKpi[importRow.kpi_id].lastImportedAt) {
        detailStatsByKpi[importRow.kpi_id].lastImportedAt = importRow.imported_at;
      }
    }
  }

  const pdfBuffer = await buildKpiReportPdf({ tenantName: tenant?.name, tenantLogo, kpis, detailStatsByKpi, scoped: Boolean(folderId) });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="rapport-kpis-${new Date().toISOString().slice(0, 10)}.pdf"`);
  res.send(pdfBuffer);
});

// POST /api/kpis — création (admin/manager uniquement — même périmètre que PATCH/DELETE
// ci-dessous ; un member ne définit pas d'indicateur d'entreprise, seul le frontend
// l'empêchait jusqu'ici via canManage, voir Kpis.jsx).
router.post(
  '/',
  requireRole('admin', 'manager'),
  [
    body('name').trim().notEmpty().withMessage('Le nom du KPI est requis.'),
    body('unit').optional({ values: 'falsy' }).trim(),
    body('target').optional({ values: 'falsy' }).isFloat().withMessage('Objectif invalide.'),
    body('target_direction')
      .optional({ values: 'falsy' })
      .isIn(KPI_TARGET_DIRECTIONS)
      .withMessage('Sens de l\'objectif invalide.'),
    body('frequency').optional({ values: 'falsy' }).isIn(KPI_FREQUENCIES).withMessage('Fréquence invalide.'),
    body('calculation_type')
      .optional({ values: 'falsy' })
      .isIn(KPI_CALCULATION_TYPES)
      .withMessage('Type de calcul invalide.'),
    body('folder_id').optional({ values: 'falsy' }).isUUID().withMessage('Dossier invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('kpi'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      name,
      unit,
      target,
      target_direction: targetDirection,
      frequency,
      calculation_type: calculationType,
      folder_id: folderId,
      category_id: categoryId,
    } = req.body;

    if (folderId) {
      const { data: folder } = await supabase
        .from('kpi_folders')
        .select('id')
        .eq('tenant_id', req.tenantId)
        .eq('id', folderId)
        .maybeSingle();
      if (!folder) {
        return res.status(400).json({ error: 'Dossier introuvable.' });
      }
    }

    const { data, error } = await supabase
      .from('kpis')
      .insert({
        tenant_id: req.tenantId,
        name,
        unit: unit || null,
        target: target ?? null,
        target_direction: targetDirection || undefined,
        frequency: frequency || null,
        calculation_type: calculationType || undefined,
        folder_id: folderId || null,
        category_id: categoryId || null,
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création du KPI.' });
    }

    res.status(201).json(data);
  }
);

// GET /api/kpis/:id — détail avec l'historique des valeurs, trié par période croissante
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('kpis')
    .select(
      `*, records:kpi_records(${RECORDS_SELECT}), calculation_configs:kpi_calculation_configs(id, label, calc_type, group_by_column), category:categories(id, name, color, is_restricted, owner_user_id)`
    )
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .order('period_date', { foreignTable: 'kpi_records', ascending: true })
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  const categoryAllowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: data.category_id,
    permission: 'view',
  });
  if (!categoryAllowed) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  res.json({ ...data, is_private_to_me: data.category?.owner_user_id === req.user.id });
});

// PATCH /api/kpis/bulk-category — déplace plusieurs KPI d'un coup vers une catégorie. Placée
// avant PATCH /:id pour ne pas être capturée comme un id — distinct du déplacement par dossier
// (voir "Déplacer" dans le menu de la carte KPI, qui gère folder_id, pas category_id).
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un KPI.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('kpi'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('kpis')
      .update({ category_id: req.body.category_id || null })
      .eq('tenant_id', req.tenantId)
      .in('id', req.body.ids)
      .select('id');

    if (error) {
      return res.status(500).json({ error: 'Erreur lors du déplacement.' });
    }

    res.json({ updated: data.length });
  }
);

// PATCH /api/kpis/:id — met à jour un ou plusieurs champs (ex: sens de l'objectif)
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('target').optional({ values: 'falsy' }).isFloat().withMessage('Objectif invalide.'),
    body('target_direction')
      .optional({ values: 'falsy' })
      .isIn(KPI_TARGET_DIRECTIONS)
      .withMessage('Sens de l\'objectif invalide.'),
    body('frequency').optional({ values: 'falsy' }).isIn(KPI_FREQUENCIES).withMessage('Fréquence invalide.'),
    body('calculation_type')
      .optional({ values: 'falsy' })
      .isIn(KPI_CALCULATION_TYPES)
      .withMessage('Type de calcul invalide.'),
    body('folder_id').optional({ nullable: true }).custom((value) => value === null || typeof value === 'string').withMessage('Dossier invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('kpi'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of PATCHABLE_FIELDS) {
      if (field in req.body) {
        update[field] = req.body[field];
      }
    }
    if ('folder_id' in update) {
      update.folder_id = update.folder_id || null;
    }
    if ('category_id' in update) {
      update.category_id = update.category_id || null;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    if (update.folder_id) {
      const { data: folder } = await supabase
        .from('kpi_folders')
        .select('id')
        .eq('tenant_id', req.tenantId)
        .eq('id', update.folder_id)
        .maybeSingle();
      if (!folder) {
        return res.status(400).json({ error: 'Dossier introuvable.' });
      }
    }

    const { data, error } = await supabase
      .from('kpis')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'KPI introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/kpis/:id — suppression, réservée aux rôles admin/manager (les valeurs
// associées sont supprimées en cascade en base, cf. kpi_records.kpi_id dans schema.sql)
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('kpis')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du KPI.' });
  }

  if (!count) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  res.status(204).send();
});

// POST /api/kpis/:id/records — saisie d'une valeur pour une période, sans double saisie
router.post(
  '/:id/records',
  [
    body('period_date').isISO8601().withMessage('Date de période invalide.'),
    body('value').isFloat().withMessage('Valeur invalide.'),
    body('comment').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: kpi, error: kpiError } = await supabase
      .from('kpis')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (kpiError || !kpi) {
      return res.status(404).json({ error: 'KPI introuvable.' });
    }

    const { period_date: periodDate, value, comment } = req.body;

    const { data, error } = await supabase
      .from('kpi_records')
      .insert({
        tenant_id: req.tenantId,
        kpi_id: kpi.id,
        period_date: periodDate,
        value,
        comment: comment || null,
        recorded_by: req.user.id,
      })
      .select('*, recorded_by_user:users!kpi_records_recorded_by_fkey(id, full_name)')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Une valeur existe déjà pour cette période.' });
      }
      return res.status(500).json({ error: "Erreur lors de l'enregistrement de la valeur." });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/kpis/:id/records/:recordId — corrige une valeur déjà saisie
router.patch(
  '/:id/records/:recordId',
  requireRole('admin', 'manager'),
  [
    body('period_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date de période invalide.'),
    body('value').optional({ values: 'falsy' }).isFloat().withMessage('Valeur invalide.'),
    body('comment').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: kpi, error: kpiError } = await supabase
      .from('kpis')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (kpiError || !kpi) {
      return res.status(404).json({ error: 'KPI introuvable.' });
    }

    const update = {};
    for (const field of RECORD_PATCHABLE_FIELDS) {
      if (field in req.body) {
        update[field] = req.body[field];
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    // Un humain qui corrige une valeur calculée en fait, de fait, une valeur saisie
    // manuellement, détachée de la série qui l'avait produite — elle ne doit plus être
    // présentée comme issue de l'import.
    if ('value' in update) {
      update.source = 'manual';
      update.source_import_id = null;
      update.config_id = null;
    }

    const { data, error } = await supabase
      .from('kpi_records')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('kpi_id', kpi.id)
      .eq('id', req.params.recordId)
      .select('*, recorded_by_user:users!kpi_records_recorded_by_fkey(id, full_name)')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Une valeur existe déjà pour cette période.' });
      }
      return res.status(404).json({ error: 'Valeur introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/kpis/:id/records/:recordId — supprime une valeur précise
router.delete('/:id/records/:recordId', requireRole('admin', 'manager'), async (req, res) => {
  const { data: kpi, error: kpiError } = await supabase
    .from('kpis')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (kpiError || !kpi) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  const { error, count } = await supabase
    .from('kpi_records')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('kpi_id', kpi.id)
    .eq('id', req.params.recordId);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de la valeur.' });
  }

  if (!count) {
    return res.status(404).json({ error: 'Valeur introuvable.' });
  }

  res.status(204).send();
});

const SERIES_VALIDATORS = [
  body('label').trim().notEmpty().withMessage('Le nom de la série est requis.'),
  body('calc_type').isIn(KPI_CALC_TYPES).withMessage('Type de calcul invalide.'),
  body('source_column').optional({ values: 'falsy' }).trim(),
  body('filters').optional().isArray().withMessage('filters doit être un tableau.'),
  body('filter_logic').optional({ values: 'falsy' }).isIn(['all', 'any']).withMessage('filter_logic invalide.'),
  body('group_by_column').optional({ values: 'falsy' }).trim(),
  body('period_column').optional({ values: 'falsy' }).trim(),
];

function parseSeriesBody(req) {
  const {
    label,
    calc_type: calcType,
    source_column: sourceColumn,
    filters = [],
    filter_logic: filterLogic = 'all',
    group_by_column: groupByColumn,
    period_column: periodColumn,
  } = req.body;

  const filtersError = validateFilters(filters);
  if (filtersError) return { error: filtersError };
  if (calcType === 'ratio' && filters.length === 0) {
    return { error: 'Au moins une condition (filters) est requise pour un calcul de type ratio.' };
  }
  if (['sum', 'average', 'min', 'max'].includes(calcType) && !sourceColumn) {
    return { error: `source_column est requis pour un calcul de type ${calcType}.` };
  }
  if (calcType === 'count_grouped' && !groupByColumn) {
    return { error: 'group_by_column est requis pour un calcul de type count_grouped.' };
  }

  return { label, calcType, sourceColumn, filters, filterLogic, groupByColumn, periodColumn };
}

// Avertissement non bloquant : les colonnes référencées ne figurent pas dans le dernier
// import de ce KPI, mais un futur fichier pourrait tout de même les contenir (colonnes
// renommées entre-temps, ou série créée avant le premier import).
async function computeColumnWarning(tenantId, kpiId, referencedColumns) {
  if (referencedColumns.length === 0) return null;

  const { data: lastImport } = await supabase
    .from('kpi_raw_imports')
    .select('detected_columns')
    .eq('tenant_id', tenantId)
    .eq('kpi_id', kpiId)
    .order('imported_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lastImport) return null;

  const knownColumns = new Set(lastImport.detected_columns || []);
  const unknownColumns = [...new Set(referencedColumns)].filter((column) => !knownColumns.has(column));
  return unknownColumns.length > 0
    ? `Colonne(s) absente(s) du dernier import de ce KPI : ${unknownColumns.join(', ')}. Un futur fichier pourrait néanmoins les contenir.`
    : null;
}

// GET /api/kpis/:id/series — toutes les séries (recettes de calcul nommées) de ce KPI. Un
// KPI peut en porter plusieurs, affichées ensemble sur le même graphique (ex : "Conforme"
// et "Non conforme" comparées sur la même période plutôt que deux KPI séparés).
router.get('/:id/series', async (req, res) => {
  const { data: kpi, error: kpiError } = await supabase
    .from('kpis')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (kpiError || !kpi) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  const { data, error } = await supabase
    .from('kpi_calculation_configs')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('kpi_id', kpi.id)
    .order('created_at', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la récupération des séries.' });
  }

  res.json(data);
});

// POST /api/kpis/:id/series — crée une nouvelle série (recette de calcul nommée).
router.post('/:id/series', SERIES_VALIDATORS, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
  }

  const { data: kpi, error: kpiError } = await supabase
    .from('kpis')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (kpiError || !kpi) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  const parsed = parseSeriesBody(req);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const referencedColumns = [parsed.sourceColumn, parsed.groupByColumn, parsed.periodColumn, ...parsed.filters.map((f) => f.column)].filter(
    Boolean
  );
  const warning = await computeColumnWarning(req.tenantId, kpi.id, referencedColumns);

  const { data, error } = await supabase
    .from('kpi_calculation_configs')
    .insert({
      tenant_id: req.tenantId,
      kpi_id: kpi.id,
      label: parsed.label,
      calc_type: parsed.calcType,
      source_column: parsed.sourceColumn || null,
      filters: parsed.filters,
      filter_logic: parsed.filterLogic,
      group_by_column: parsed.groupByColumn || null,
      period_column: parsed.periodColumn || null,
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: "Erreur lors de la création de la série." });
  }

  res.status(201).json({ ...data, warning });
});

// PATCH /api/kpis/:id/series/:configId — modifie une série existante (recalcule à nouveau
// via POST /api/kpi-imports/:importId/apply avec ce config_id une fois enregistrée).
router.patch('/:id/series/:configId', requireRole('admin', 'manager'), SERIES_VALIDATORS, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
  }

  const { data: kpi, error: kpiError } = await supabase
    .from('kpis')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (kpiError || !kpi) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  const parsed = parseSeriesBody(req);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const referencedColumns = [parsed.sourceColumn, parsed.groupByColumn, parsed.periodColumn, ...parsed.filters.map((f) => f.column)].filter(
    Boolean
  );
  const warning = await computeColumnWarning(req.tenantId, kpi.id, referencedColumns);

  const { data, error } = await supabase
    .from('kpi_calculation_configs')
    .update({
      label: parsed.label,
      calc_type: parsed.calcType,
      source_column: parsed.sourceColumn || null,
      filters: parsed.filters,
      filter_logic: parsed.filterLogic,
      group_by_column: parsed.groupByColumn || null,
      period_column: parsed.periodColumn || null,
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', req.tenantId)
    .eq('kpi_id', kpi.id)
    .eq('id', req.params.configId)
    .select()
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Série introuvable.' });
  }

  res.status(200).json({ ...data, warning });
});

// DELETE /api/kpis/:id/series/:configId — supprime une série ; les valeurs qu'elle a
// produites disparaissent avec elle (kpi_records.config_id ON DELETE CASCADE).
router.delete('/:id/series/:configId', requireRole('admin', 'manager'), async (req, res) => {
  const { data: kpi, error: kpiError } = await supabase
    .from('kpis')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (kpiError || !kpi) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  const { error, count } = await supabase
    .from('kpi_calculation_configs')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('kpi_id', kpi.id)
    .eq('id', req.params.configId);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de la série.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Série introuvable.' });
  }

  res.status(204).send();
});

// GET /api/kpis/:id/imports — historique des imports pour ce KPI (fichier, qui, quand,
// combien de lignes, quelle(s) période(s) affectée(s)) — remplace l'ancien
// GET .../import-batches, sur le nouveau système générique.
//
// Dérivé de kpi_records.source_import_id plutôt que de kpi_raw_imports.kpi_id : un même
// import peut désormais être réutilisé par plusieurs KPI (POST .../apply avec un kpi_id
// différent, sans jamais réattribuer la propriété de l'import), donc "quel import
// appartient à ce KPI" n'identifie plus fiablement ses imports — "quel import a produit
// les valeurs de ce KPI" si.
router.get('/:id/imports', async (req, res) => {
  const { data: kpi, error: kpiError } = await supabase
    .from('kpis')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (kpiError || !kpi) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  const { data: records, error: recordsError } = await supabase
    .from('kpi_records')
    .select('source_import_id, period_date')
    .eq('tenant_id', req.tenantId)
    .eq('kpi_id', kpi.id)
    .not('source_import_id', 'is', null);

  if (recordsError) {
    return res.status(500).json({ error: "Impossible de récupérer l'historique des imports." });
  }

  const affectedPeriodsByImport = {};
  for (const record of records || []) {
    const list = (affectedPeriodsByImport[record.source_import_id] ||= []);
    list.push(record.period_date);
  }

  const importIds = Object.keys(affectedPeriodsByImport);
  if (importIds.length === 0) {
    return res.json([]);
  }

  const { data: imports, error } = await supabase
    .from('kpi_raw_imports')
    .select('id, file_name, imported_at, row_count, imported_by_user:users!kpi_raw_imports_imported_by_fkey(id, full_name)')
    .eq('tenant_id', req.tenantId)
    .in('id', importIds)
    .order('imported_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: "Impossible de récupérer l'historique des imports." });
  }

  res.json(
    imports.map((imp) => ({
      ...imp,
      affected_periods: (affectedPeriodsByImport[imp.id] || []).sort(),
    }))
  );
});

// GET /api/kpis/:id/records/:recordId/proof?page=1&page_size=50 — la preuve derrière une
// valeur calculée : reproduit exactement le regroupement par période fait à l'import (même
// logique, cf. services/kpiCalculation.js) pour retrouver les lignes brutes qui ont produit
// cette valeur, avec une description en langage clair et pagination du détail.
router.get('/:id/records/:recordId/proof', async (req, res) => {
  const { data: kpi, error: kpiError } = await supabase
    .from('kpis')
    .select('id, unit')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (kpiError || !kpi) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  const { data: record, error: recordError } = await supabase
    .from('kpi_records')
    .select('id, period_date, value, source, source_import_id, config_id')
    .eq('tenant_id', req.tenantId)
    .eq('kpi_id', kpi.id)
    .eq('id', req.params.recordId)
    .single();

  if (recordError || !record) {
    return res.status(404).json({ error: 'Valeur introuvable.' });
  }

  if (record.source !== 'import' || !record.source_import_id || !record.config_id) {
    return res.status(400).json({ error: "Cette valeur n'a pas été calculée depuis un import : aucune preuve à afficher." });
  }

  // La preuve doit reproduire la recette exacte qui a produit CETTE valeur — un KPI pouvant
  // désormais porter plusieurs séries, on lit la recette via le config_id propre à
  // l'enregistrement plutôt que "la" configuration du KPI.
  const { data: config, error: configError } = await supabase
    .from('kpi_calculation_configs')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('id', record.config_id)
    .single();

  if (configError || !config) {
    return res.status(404).json({ error: 'Configuration de calcul introuvable pour cette série.' });
  }

  const { data: importRow, error: importError } = await supabase
    .from('kpi_raw_imports')
    .select('id, file_name, imported_at, detected_columns, imported_by_user:users!kpi_raw_imports_imported_by_fkey(id, full_name)')
    .eq('tenant_id', req.tenantId)
    .eq('id', record.source_import_id)
    .single();

  if (importError || !importRow) {
    return res.status(404).json({ error: 'Import source introuvable.' });
  }

  const { data: rawRows, error: rowsError } = await supabase
    .from('kpi_raw_rows')
    .select('row_index, row_data')
    .eq('tenant_id', req.tenantId)
    .eq('import_id', importRow.id)
    .order('row_index', { ascending: true });

  if (rowsError) {
    return res.status(500).json({ error: 'Erreur lors de la récupération des lignes importées.' });
  }

  // Reproduit le même regroupement qu'à l'application de l'import, pour isoler exactement
  // les lignes qui ont produit cette période — sans colonne de période, l'import entier est
  // une période unique (c'est la même règle que POST .../apply).
  let matchedRows;
  if (config.period_column) {
    const groups = groupRowsByPeriod(rawRows, config.period_column, null);
    matchedRows = groups.get(record.period_date) || [];
  } else {
    matchedRows = rawRows.map((row) => ({ rowIndex: row.row_index, rowData: row.row_data }));
  }

  const calcResult = computeGroup(config, matchedRows);
  const description = describeCalculation(config, calcResult, matchedRows.length, record.value, kpi.unit);

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.page_size, 10) || 50));
  const start = (page - 1) * pageSize;
  const pagedRows = matchedRows.slice(start, start + pageSize);

  res.json({
    record: { id: record.id, period_date: record.period_date, value: record.value },
    import: {
      id: importRow.id,
      file_name: importRow.file_name,
      imported_at: importRow.imported_at,
      imported_by_user: importRow.imported_by_user,
    },
    series: { id: config.id, label: config.label },
    calc_type: config.calc_type,
    description,
    columns: importRow.detected_columns,
    rows_total: matchedRows.length,
    page,
    page_size: pageSize,
    rows: pagedRows.map((row) => ({ row_index: row.rowIndex, row_data: row.rowData })),
  });
});

// GET /api/kpis/:id/distribution — répartition par catégorie (calc_type='count_grouped')
// calculée à la volée depuis le dernier import de ce KPI. Jamais persisté dans kpi_records
// (ce mode sert à une vue de répartition, pas à un point de tendance), donc recalculé à
// chaque consultation plutôt que stocké.
router.get('/:id/distribution', async (req, res) => {
  const { data: kpi, error: kpiError } = await supabase
    .from('kpis')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (kpiError || !kpi) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  // Un KPI pouvant porter plusieurs séries, ?config_id précise laquelle afficher ; à défaut,
  // la première série en répartition par catégorie trouvée pour ce KPI.
  let configQuery = supabase.from('kpi_calculation_configs').select('*').eq('tenant_id', req.tenantId).eq('kpi_id', kpi.id);
  configQuery = req.query.config_id
    ? configQuery.eq('id', req.query.config_id)
    : configQuery.eq('calc_type', 'count_grouped').limit(1);

  const { data: configRows, error: configError } = await configQuery;
  const config = (configRows || [])[0];

  if (configError || !config) {
    return res.status(404).json({ error: 'Aucune configuration de calcul pour ce KPI.' });
  }
  if (config.calc_type !== 'count_grouped') {
    return res.status(400).json({ error: "Ce KPI n'est pas configuré en répartition par catégorie (count_grouped)." });
  }

  const { data: importRow, error: importError } = await supabase
    .from('kpi_raw_imports')
    .select('id, file_name, imported_at')
    .eq('tenant_id', req.tenantId)
    .eq('kpi_id', kpi.id)
    .order('imported_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (importError) {
    return res.status(500).json({ error: "Erreur lors de la récupération de l'import." });
  }
  if (!importRow) {
    return res.status(404).json({ error: 'Aucun import pour ce KPI.' });
  }

  const { data: rawRows, error: rowsError } = await supabase
    .from('kpi_raw_rows')
    .select('row_index, row_data')
    .eq('tenant_id', req.tenantId)
    .eq('import_id', importRow.id)
    .order('row_index', { ascending: true });

  if (rowsError) {
    return res.status(500).json({ error: 'Erreur lors de la récupération des lignes importées.' });
  }

  // Sans colonne de période, l'import entier forme un seul groupe (étiqueté avec la date de
  // l'import, faute de mieux) ; avec une colonne de période, une répartition par période.
  const groups = config.period_column
    ? groupRowsByPeriod(rawRows, config.period_column, null)
    : new Map([[importRow.imported_at.slice(0, 10), rawRows.map((row) => ({ rowIndex: row.row_index, rowData: row.row_data }))]]);

  const periods = Array.from(groups.entries()).map(([periodKey, rows]) => {
    const isRawFallback = periodKey.startsWith('__raw__:');
    const periodLabel = isRawFallback ? periodKey.slice('__raw__:'.length) : periodKey;
    const result = computeGroup(config, rows);
    return { period_label: periodLabel, grouped_counts: result.groupedCounts, rows_total: rows.length };
  });

  res.json({
    import: { id: importRow.id, file_name: importRow.file_name, imported_at: importRow.imported_at },
    group_by_column: config.group_by_column,
    periods,
  });
});

export default router;
