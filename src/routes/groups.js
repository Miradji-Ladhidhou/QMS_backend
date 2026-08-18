import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);
// Gestion des groupes réservée aux admins : ils déterminent qui accède à quelles
// catégories restreintes, au même titre que category_permissions.
router.use(requireRole('admin'));

// GET /api/groups — liste des groupes du tenant, avec leurs membres
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('groups')
    .select('id, name, created_at, members:group_members(user:users(id, full_name, role))')
    .eq('tenant_id', req.tenantId)
    .order('name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les groupes.' });
  }

  const groups = data.map((group) => ({
    ...group,
    members: group.members.map((m) => m.user).filter(Boolean),
  }));

  res.json(groups);
});

// POST /api/groups — création
router.post('/', [body('name').trim().notEmpty().withMessage('Le nom du groupe est requis.')], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
  }

  const { data, error } = await supabase
    .from('groups')
    .insert({ tenant_id: req.tenantId, name: req.body.name })
    .select('id, name, created_at')
    .single();

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la création du groupe.' });
  }

  res.status(201).json({ ...data, members: [] });
});

// PATCH /api/groups/:id — renommage
router.patch('/:id', [body('name').trim().notEmpty().withMessage('Le nom du groupe est requis.')], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
  }

  const { data, error } = await supabase
    .from('groups')
    .update({ name: req.body.name })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .select('id, name, created_at')
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Groupe introuvable.' });
  }

  res.json(data);
});

// DELETE /api/groups/:id — supprime le groupe (et ses appartenances, cascade)
router.delete('/:id', async (req, res) => {
  const { error, count } = await supabase
    .from('groups')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du groupe.' });
  }

  if (!count) {
    return res.status(404).json({ error: 'Groupe introuvable.' });
  }

  res.status(204).send();
});

// POST /api/groups/:id/members — ajoute un membre
router.post('/:id/members', [body('user_id').isUUID().withMessage('Utilisateur invalide.')], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
  }

  const { data: group, error: groupError } = await supabase
    .from('groups')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (groupError || !group) {
    return res.status(404).json({ error: 'Groupe introuvable.' });
  }

  const { data: member, error: memberError } = await supabase
    .from('users')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.body.user_id)
    .single();

  if (memberError || !member) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  const { error } = await supabase.from('group_members').insert({ group_id: group.id, user_id: member.id });

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Cet utilisateur est déjà membre du groupe.' });
    }
    return res.status(500).json({ error: "Erreur lors de l'ajout du membre." });
  }

  res.status(201).json({ group_id: group.id, user_id: member.id });
});

// DELETE /api/groups/:id/members/:userId — retire un membre
router.delete('/:id/members/:userId', async (req, res) => {
  // group_members n'a pas de tenant_id propre : on vérifie d'abord que le groupe
  // appartient bien à ce tenant avant de toucher à ses appartenances.
  const { data: group, error: groupError } = await supabase
    .from('groups')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (groupError || !group) {
    return res.status(404).json({ error: 'Groupe introuvable.' });
  }

  const { error, count } = await supabase
    .from('group_members')
    .delete({ count: 'exact' })
    .eq('group_id', group.id)
    .eq('user_id', req.params.userId);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors du retrait du membre.' });
  }

  if (!count) {
    return res.status(404).json({ error: 'Ce membre ne fait pas partie du groupe.' });
  }

  res.status(204).send();
});

export default router;
