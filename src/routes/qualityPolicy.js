import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
const MANAGER_ROLES = ['admin', 'manager'];

router.use(requireAuth);

const VERSION_SELECT = '*, author:users!quality_policy_versions_created_by_fkey(id, full_name)';

// GET /api/quality-policy — la politique qualité en vigueur (ISO 9001 §5.2), son historique, et
// la preuve qu'elle est "communiquée et comprise" : accusé de lecture de l'appelant, et pour
// admin/manager un agrégat du nombre de personnes l'ayant déjà lue. Ouvert à tout rôle
// authentifié — contrairement aux autres réglages de Paramètres, la politique qualité doit
// rester visible de tout le tenant ; seule sa republication est réservée admin (voir POST /).
router.get('/', async (req, res) => {
  const { data: versions, error } = await supabase
    .from('quality_policy_versions')
    .select(VERSION_SELECT)
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer la politique qualité.' });
  }

  const current = versions[0] || null;

  // Accusé de lecture de l'utilisateur courant POUR LA VERSION EN VIGUEUR uniquement — même
  // principe que my_acknowledgment sur GET /api/procedures/:id : une republication change
  // quelle version est "current", ce qui rend naturellement cette valeur null pour tout le
  // monde tant que personne n'a encore accusé réception de la nouvelle.
  let myAcknowledgment = null;
  if (current) {
    const { data } = await supabase
      .from('quality_policy_acknowledgments')
      .select('acknowledged_at')
      .eq('quality_policy_version_id', current.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    myAcknowledgment = data || null;
  }

  // Preuve concrète de diffusion (§5.2 : "communiquée, comprise") — réservée admin/manager,
  // même esprit que les autres agrégats de pilotage de l'app (ex. acknowledged_count sur les
  // documents à accusé de lecture obligatoire).
  let acknowledgmentSummary = null;
  if (current && MANAGER_ROLES.includes(req.userRole)) {
    const [{ count: acknowledgedCount, error: ackError }, { count: totalUsers, error: usersError }] = await Promise.all([
      supabase
        .from('quality_policy_acknowledgments')
        .select('id', { count: 'exact', head: true })
        .eq('quality_policy_version_id', current.id),
      supabase.from('users').select('id', { count: 'exact', head: true }).eq('tenant_id', req.tenantId).eq('is_active', true),
    ]);

    if (ackError || usersError) {
      return res.status(500).json({ error: 'Impossible de calculer le suivi des accusés de réception.' });
    }

    acknowledgmentSummary = { acknowledged_count: acknowledgedCount || 0, total_users: totalUsers || 0 };
  }

  res.json({
    current,
    versions,
    my_acknowledgment: myAcknowledgment,
    acknowledgment_summary: acknowledgmentSummary,
  });
});

// POST /api/quality-policy — publie une nouvelle version, qui devient immédiatement "en
// vigueur" (la plus récente par created_at) — pas de workflow de validation séparé (voir
// schema.sql) : la politique qualité est portée par la direction elle-même, pas rédigée par
// quelqu'un puis validée par quelqu'un d'autre. Réservé admin.
router.post(
  '/',
  requireRole('admin'),
  [body('content').trim().notEmpty().withMessage('Le contenu de la politique qualité est requis.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('quality_policy_versions')
      .insert({ tenant_id: req.tenantId, content: req.body.content, created_by: req.user.id })
      .select(VERSION_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la publication de la politique qualité.' });
    }

    res.status(201).json(data);
  }
);

// POST /api/quality-policy/acknowledge — accuse réception de la version EN VIGUEUR, même
// principe que POST /procedures/:id/acknowledge : une republication remet tout le monde à "pas
// encore lu" du simple fait que quality_policy_version_id change, sans purge ni job. Idempotent
// (upsert) : un second appel sur la même version ne fait rien de plus.
router.post('/acknowledge', async (req, res) => {
  const { data: current, error } = await supabase
    .from('quality_policy_versions')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer la politique qualité.' });
  }
  if (!current) {
    return res.status(400).json({ error: 'Aucune politique qualité publiée pour l’instant.' });
  }

  const { data: acknowledgment, error: ackError } = await supabase
    .from('quality_policy_acknowledgments')
    .upsert(
      { tenant_id: req.tenantId, quality_policy_version_id: current.id, user_id: req.user.id },
      { onConflict: 'quality_policy_version_id,user_id', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (ackError || !acknowledgment) {
    return res.status(500).json({ error: "Erreur lors de l'enregistrement de l'accusé de lecture." });
  }

  res.status(201).json(acknowledgment);
});

export default router;
