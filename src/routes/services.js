import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);

// GET /api/services/my-services — services auxquels l'utilisateur connecté est rattaché
// (utile pour le filtrage du tableau de bord côté manager) — avant /:id pour ne pas être
// capturé par la route paramétrée.
router.get('/my-services', async (req, res) => {
  const { data, error } = await supabase
    .from('user_services')
    .select('service:services(id, name, is_active)')
    .eq('tenant_id', req.tenantId)
    .eq('user_id', req.user.id);

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer vos services.' });
  }

  res.json(data.map((row) => row.service).filter(Boolean));
});

// GET /api/services — liste de tous les services du tenant, actifs et inactifs (tous les
// rôles) — la page de gestion (admin) a besoin de voir les inactifs pour les réactiver ;
// un sélecteur d'usage courant (ex. création de CAPA) filtre lui-même sur is_active.
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('services')
    .select('id, name, is_active')
    .eq('tenant_id', req.tenantId)
    .order('name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les services.' });
  }

  res.json(data);
});

// POST /api/services — création (admin uniquement)
router.post(
  '/',
  requireRole('admin'),
  [body('name').trim().notEmpty().withMessage('Le nom du service est requis.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('services')
      .insert({ tenant_id: req.tenantId, name: req.body.name })
      .select('id, name, is_active')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création du service.' });
    }

    res.status(201).json(data);
  }
);

// GET /api/services/:id/managers — managers actuellement rattachés à ce service (admin
// uniquement) — sert la page de gestion des services, pas le filtrage dashboard (my-services).
router.get('/:id/managers', requireRole('admin'), async (req, res) => {
  const { data: service, error: serviceError } = await supabase
    .from('services')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (serviceError || !service) {
    return res.status(404).json({ error: 'Service introuvable.' });
  }

  const { data, error } = await supabase
    .from('user_services')
    .select('user:users(id, full_name, role)')
    .eq('tenant_id', req.tenantId)
    .eq('service_id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les managers rattachés.' });
  }

  const managers = data.map((row) => row.user).filter((user) => user && user.role === 'manager');
  res.json(managers);
});

// PATCH /api/services/:id — renomme et/ou active/désactive un service (admin uniquement)
router.patch(
  '/:id',
  requireRole('admin'),
  [
    body('name').optional().trim().notEmpty().withMessage('Le nom du service ne peut pas être vide.'),
    body('is_active').optional().isBoolean().withMessage('Valeur invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    if (!('name' in req.body) && !('is_active' in req.body)) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const update = {};
    if ('name' in req.body) update.name = req.body.name;
    if ('is_active' in req.body) update.is_active = req.body.is_active;

    const { data, error } = await supabase
      .from('services')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select('id, name, is_active')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Service introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/services/:id — refuse si des CAPA sont rattachées (admin uniquement)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { data: service, error: serviceError } = await supabase
    .from('services')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (serviceError || !service) {
    return res.status(404).json({ error: 'Service introuvable.' });
  }

  const { count, error: countError } = await supabase
    .from('capas')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', req.tenantId)
    .eq('service_id', req.params.id);

  if (countError) {
    return res.status(500).json({ error: 'Impossible de vérifier les CAPA rattachées.' });
  }

  if (count > 0) {
    return res.status(409).json({
      error: `${count} CAPA sont rattachées à ce service. Désactivez-le plutôt que de le supprimer.`,
    });
  }

  const { error: deleteError } = await supabase
    .from('services')
    .delete()
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (deleteError) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du service.' });
  }

  res.status(204).end();
});

// POST /api/services/:id/assign-user — rattache un utilisateur (typiquement un manager) à
// ce service (admin uniquement)
router.post(
  '/:id/assign-user',
  requireRole('admin'),
  [body('user_id').isUUID().withMessage('Utilisateur invalide.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: service, error: serviceError } = await supabase
      .from('services')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (serviceError || !service) {
      return res.status(404).json({ error: 'Service introuvable.' });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.body.user_id)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    const { error } = await supabase
      .from('user_services')
      .upsert(
        { tenant_id: req.tenantId, service_id: req.params.id, user_id: req.body.user_id },
        { onConflict: 'user_id,service_id' }
      );

    if (error) {
      return res.status(500).json({ error: "Erreur lors du rattachement de l'utilisateur." });
    }

    res.status(201).json({ ok: true });
  }
);

// DELETE /api/services/:id/assign-user/:userId — détache (admin uniquement)
router.delete('/:id/assign-user/:userId', requireRole('admin'), async (req, res) => {
  const { error, count } = await supabase
    .from('user_services')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('service_id', req.params.id)
    .eq('user_id', req.params.userId);

  if (error) {
    return res.status(500).json({ error: "Erreur lors du détachement de l'utilisateur." });
  }

  if (!count) {
    return res.status(404).json({ error: 'Rattachement introuvable.' });
  }

  res.status(204).end();
});

export default router;
