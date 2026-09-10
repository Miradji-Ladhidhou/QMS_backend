import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';

const router = Router();

const SCOPES = ['internal', 'external'];

router.use(requireAuth);
router.use(requireMenuVisible('communication-plan'));

const ITEM_SELECT = '*, responsible:users!communication_plan_items_responsible_user_id_fkey(id, full_name)';

// GET /api/communication-plan — le plan de communication du SMQ (ISO 9001 §7.4). Ouvert à
// tous les rôles : tout le monde doit pouvoir consulter qui communique quoi à qui — c'est le
// but même de la clause. Renvoie les lignes actives ET inactives (la page de gestion admin a
// besoin de voir les inactives pour les réactiver, même logique que services.js).
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('communication_plan_items')
    .select(ITEM_SELECT)
    .eq('tenant_id', req.tenantId)
    .order('scope', { ascending: true })
    .order('subject', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer le plan de communication.' });
  }

  res.json(data);
});

// POST /api/communication-plan — admin uniquement (même modèle que services.js : le plan est
// un référentiel géré par l'admin, pas alimenté par n'importe qui).
router.post(
  '/',
  requireRole('admin'),
  [
    body('subject').trim().notEmpty().withMessage("L'objet de la communication est requis."),
    body('audience').trim().notEmpty().withMessage('Le public visé est requis.'),
    body('scope').optional({ values: 'falsy' }).isIn(SCOPES).withMessage('Portée invalide.'),
    body('timing').trim().notEmpty().withMessage('La fréquence / le moment est requis.'),
    body('channel').trim().notEmpty().withMessage('Le canal est requis.'),
    body('responsible_user_id').optional({ values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
    body('notes').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      subject,
      audience,
      scope,
      timing,
      channel,
      responsible_user_id: responsibleUserId,
      notes,
    } = req.body;

    const { data, error } = await supabase
      .from('communication_plan_items')
      .insert({
        tenant_id: req.tenantId,
        subject,
        audience,
        scope: scope || undefined,
        timing,
        channel,
        responsible_user_id: responsibleUserId || null,
        notes: notes || null,
        created_by: req.user.id,
      })
      .select(ITEM_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la ligne.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/communication-plan/:id — admin uniquement. Tous les champs optionnels + bascule
// is_active.
router.patch(
  '/:id',
  requireRole('admin'),
  [
    body('subject').optional().trim().notEmpty().withMessage("L'objet ne peut pas être vide."),
    body('audience').optional().trim().notEmpty().withMessage('Le public visé ne peut pas être vide.'),
    body('scope').optional().isIn(SCOPES).withMessage('Portée invalide.'),
    body('timing').optional().trim().notEmpty().withMessage('La fréquence / le moment ne peut pas être vide.'),
    body('channel').optional().trim().notEmpty().withMessage('Le canal ne peut pas être vide.'),
    body('responsible_user_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
    body('notes').optional({ nullable: true, values: 'falsy' }).trim(),
    body('is_active').optional().isBoolean().withMessage('Valeur invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of ['subject', 'audience', 'scope', 'timing', 'channel', 'notes']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('responsible_user_id' in req.body) update.responsible_user_id = req.body.responsible_user_id || null;
    if ('is_active' in req.body) update.is_active = req.body.is_active;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('communication_plan_items')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(ITEM_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Ligne introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/communication-plan/:id — admin uniquement. Suppression directe : rien ne
// référence communication_plan_items (pas de garde-fou comme services.js). is_active reste
// le moyen recommandé de retirer une ligne sans perdre l'historique.
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { error, count } = await supabase
    .from('communication_plan_items')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de la ligne.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Ligne introuvable.' });
  }

  res.status(204).end();
});

export default router;
