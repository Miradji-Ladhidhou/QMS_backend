import { Router } from 'express';
import { body, query, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { SHAREABLE_ROLES } from '../services/recordSharing.js';

const router = Router();

// Table source par type de ressource — utilisée pour vérifier que resource_id existe bien
// dans ce tenant avant de créer un partage dessus (jamais un partage sur un id fantôme).
const RESOURCE_TABLES = {
  document: 'documents',
  capa: 'capas',
  complaint: 'complaints',
  qqoqccp: 'qqoqccp_analyses',
  procedure: 'procedures',
};

router.use(requireAuth);
// Gérer les partages est réservé à admin/manager : ce sont déjà les seuls rôles qui voient
// tout par défaut dans les modules concernés (documents, CAPA) — laisser un membre partager
// lui-même reviendrait à le laisser s'auto-accorder ou accorder à d'autres un accès qu'il n'a
// pas le pouvoir de décider.
router.use(requireRole('admin', 'manager'));

// GET /api/shares?resource_type=capa&resource_id=... — partages actifs sur UN élément précis,
// avec le nom de la personne résolu pour les partages par utilisateur (affichage direct côté
// frontend sans aller-retour supplémentaire).
router.get(
  '/',
  [
    query('resource_type').isIn(Object.keys(RESOURCE_TABLES)).withMessage('Type de ressource invalide.'),
    query('resource_id').isUUID().withMessage('Identifiant de ressource invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Requête invalide.', details: errors.array() });
    }

    const { resource_type: resourceType, resource_id: resourceId } = req.query;

    const { data, error } = await supabase
      .from('record_shares')
      .select('id, subject_type, subject_id, created_at, created_by_user:users!record_shares_created_by_fkey(full_name)')
      .eq('tenant_id', req.tenantId)
      .eq('resource_type', resourceType)
      .eq('resource_id', resourceId)
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Impossible de récupérer les partages.' });
    }

    const userIds = data.filter((row) => row.subject_type === 'user').map((row) => row.subject_id);
    let usersById = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase.from('users').select('id, full_name').in('id', userIds);
      usersById = Object.fromEntries((users || []).map((u) => [u.id, u.full_name]));
    }

    res.json(
      data.map((row) => ({
        id: row.id,
        subject_type: row.subject_type,
        subject_id: row.subject_id,
        subject_label: row.subject_type === 'user' ? usersById[row.subject_id] || 'Utilisateur supprimé' : row.subject_id,
        created_at: row.created_at,
        created_by: row.created_by_user?.full_name || null,
      }))
    );
  }
);

// POST /api/shares — accorde l'accès à UN élément précis à un rôle ou une personne.
router.post(
  '/',
  [
    body('resource_type').isIn(Object.keys(RESOURCE_TABLES)).withMessage('Type de ressource invalide.'),
    body('resource_id').isUUID().withMessage('Identifiant de ressource invalide.'),
    body('subject_type').isIn(['role', 'user']).withMessage('Type de destinataire invalide.'),
    body('subject_id').trim().notEmpty().withMessage('Destinataire requis.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { resource_type: resourceType, resource_id: resourceId, subject_type: subjectType, subject_id: subjectId } =
      req.body;

    if (subjectType === 'role' && !SHAREABLE_ROLES.includes(subjectId)) {
      return res.status(400).json({ error: 'Rôle invalide — choisissez manager ou membre.' });
    }
    if (subjectType === 'user') {
      const { data: user } = await supabase
        .from('users')
        .select('id')
        .eq('tenant_id', req.tenantId)
        .eq('id', subjectId)
        .maybeSingle();
      if (!user) {
        return res.status(400).json({ error: "Cet utilisateur n'appartient pas à votre entreprise." });
      }
    }

    const { data: resource } = await supabase
      .from(RESOURCE_TABLES[resourceType])
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', resourceId)
      .maybeSingle();
    if (!resource) {
      return res.status(404).json({ error: 'Élément introuvable.' });
    }

    const { data, error } = await supabase
      .from('record_shares')
      .insert({
        tenant_id: req.tenantId,
        resource_type: resourceType,
        resource_id: resourceId,
        subject_type: subjectType,
        subject_id: subjectId,
        created_by: req.user.id,
      })
      .select('id, subject_type, subject_id, created_at')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Cet élément est déjà partagé avec ce destinataire.' });
      }
      return res.status(500).json({ error: 'Impossible de créer le partage.' });
    }

    res.status(201).json(data);
  }
);

// DELETE /api/shares/:id — retire un partage.
router.delete('/:id', async (req, res) => {
  const { error, count } = await supabase
    .from('record_shares')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Impossible de retirer ce partage.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Partage introuvable.' });
  }

  res.status(204).send();
});

export default router;
