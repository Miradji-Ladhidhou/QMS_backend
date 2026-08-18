import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
const MAX_ANCESTOR_DEPTH = 30;

router.use(requireAuth);

// Remonte la chaîne des parents jusqu'à la racine, pour le fil d'Ariane et pour détecter
// les cycles avant un déplacement (voir PATCH ci-dessous). Une boucle de requêtes plutôt
// qu'une CTE récursive : la profondeur réelle d'un classement de KPI reste faible.
async function loadAncestors(tenantId, folderId) {
  const ancestors = [];
  let currentId = folderId;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH && currentId; i += 1) {
    const { data } = await supabase
      .from('kpi_folders')
      .select('id, name, parent_id')
      .eq('tenant_id', tenantId)
      .eq('id', currentId)
      .maybeSingle();
    if (!data) break;
    ancestors.unshift({ id: data.id, name: data.name });
    currentId = data.parent_id;
  }
  return ancestors;
}

// GET /api/kpi-folders?parent_id=<uuid>|root — sous-dossiers directs d'un dossier (ou les
// dossiers racine si parent_id est absent ou vaut "root").
router.get('/', async (req, res) => {
  const { parent_id: parentId } = req.query;

  let query = supabase.from('kpi_folders').select('*').eq('tenant_id', req.tenantId);
  query = !parentId || parentId === 'root' ? query.is('parent_id', null) : query.eq('parent_id', parentId);

  const { data, error } = await query.order('name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les dossiers.' });
  }

  res.json(data);
});

// GET /api/kpi-folders/:id/breadcrumb — chaîne des ancêtres (racine → dossier), pour le fil
// d'Ariane de navigation.
router.get('/:id/breadcrumb', async (req, res) => {
  const { data: folder } = await supabase
    .from('kpi_folders')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .maybeSingle();

  if (!folder) {
    return res.status(404).json({ error: 'Dossier introuvable.' });
  }

  const breadcrumb = await loadAncestors(req.tenantId, req.params.id);
  res.json(breadcrumb);
});

// POST /api/kpi-folders — création
router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('Le nom du dossier est requis.'),
    body('parent_id').optional({ values: 'falsy' }).isUUID().withMessage('Dossier parent invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { name, parent_id: parentId } = req.body;

    if (parentId) {
      const { data: parent } = await supabase
        .from('kpi_folders')
        .select('id')
        .eq('tenant_id', req.tenantId)
        .eq('id', parentId)
        .maybeSingle();
      if (!parent) {
        return res.status(400).json({ error: 'Dossier parent introuvable.' });
      }
    }

    const { data, error } = await supabase
      .from('kpi_folders')
      .insert({ tenant_id: req.tenantId, name, parent_id: parentId || null })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création du dossier.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/kpi-folders/:id — renomme et/ou déplace (parent_id) un dossier
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('name').optional().trim().notEmpty().withMessage('Le nom du dossier est requis.'),
    body('parent_id').optional({ nullable: true }).custom((value) => value === null || typeof value === 'string').withMessage('Dossier parent invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    if ('name' in req.body) update.name = req.body.name;

    if ('parent_id' in req.body) {
      const parentId = req.body.parent_id;

      if (parentId) {
        if (parentId === req.params.id) {
          return res.status(400).json({ error: 'Un dossier ne peut pas être son propre parent.' });
        }
        const { data: parent } = await supabase
          .from('kpi_folders')
          .select('id')
          .eq('tenant_id', req.tenantId)
          .eq('id', parentId)
          .maybeSingle();
        if (!parent) {
          return res.status(400).json({ error: 'Dossier parent introuvable.' });
        }
        // Empêche de déplacer un dossier dans l'un de ses propres sous-dossiers, ce qui
        // créerait un cycle et casserait la remontée du fil d'Ariane.
        const ancestors = await loadAncestors(req.tenantId, parentId);
        if (ancestors.some((ancestor) => ancestor.id === req.params.id)) {
          return res.status(400).json({ error: 'Impossible de déplacer un dossier dans l\'un de ses sous-dossiers.' });
        }
      }

      update.parent_id = parentId || null;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('kpi_folders')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Dossier introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/kpi-folders/:id — supprime le dossier et ses sous-dossiers (cascade en base) ;
// les KPI qu'ils contenaient reviennent à la racine (folder_id remis à null en base), ils ne
// sont jamais supprimés par cette action.
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('kpi_folders')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du dossier.' });
  }

  if (!count) {
    return res.status(404).json({ error: 'Dossier introuvable.' });
  }

  res.status(204).send();
});

export default router;
