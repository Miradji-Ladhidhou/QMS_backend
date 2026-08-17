import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const PATCHABLE_FIELDS = ['title', 'qui', 'quoi', 'ou_', 'quand_', 'comment_', 'combien', 'pourquoi'];

router.use(requireAuth);

// GET /api/qqoqccp — liste légère (sans les 7 champs longs), la plus récente en premier
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('qqoqccp_analyses')
    .select('id, title, status, created_at')
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les analyses QQOQCCP.' });
  }

  res.json(data);
});

// GET /api/qqoqccp/:id — détail complet
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('qqoqccp_analyses')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Analyse QQOQCCP introuvable.' });
  }

  res.json(data);
});

// POST /api/qqoqccp — création
router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('qui').optional({ values: 'falsy' }).trim(),
    body('quoi').optional({ values: 'falsy' }).trim(),
    body('ou_').optional({ values: 'falsy' }).trim(),
    body('quand_').optional({ values: 'falsy' }).trim(),
    body('comment_').optional({ values: 'falsy' }).trim(),
    body('combien').optional({ values: 'falsy' }).trim(),
    body('pourquoi').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { title, qui, quoi, ou_: ou, quand_: quand, comment_: comment, combien, pourquoi } = req.body;

    const { data, error } = await supabase
      .from('qqoqccp_analyses')
      .insert({
        tenant_id: req.tenantId,
        title,
        qui: qui || null,
        quoi: quoi || null,
        ou_: ou || null,
        quand_: quand || null,
        comment_: comment || null,
        combien: combien || null,
        pourquoi: pourquoi || null,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de la création de l'analyse QQOQCCP." });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/qqoqccp/:id — met à jour le titre et/ou n'importe lequel des 7 champs
router.patch(
  '/:id',
  [
    body('title').optional({ values: 'falsy' }).trim().notEmpty().withMessage('Le titre est requis.'),
    body('qui').optional({ values: 'falsy' }).trim(),
    body('quoi').optional({ values: 'falsy' }).trim(),
    body('ou_').optional({ values: 'falsy' }).trim(),
    body('quand_').optional({ values: 'falsy' }).trim(),
    body('comment_').optional({ values: 'falsy' }).trim(),
    body('combien').optional({ values: 'falsy' }).trim(),
    body('pourquoi').optional({ values: 'falsy' }).trim(),
  ],
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

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('qqoqccp_analyses')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Analyse QQOQCCP introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/qqoqccp/:id — suppression
router.delete('/:id', async (req, res) => {
  const { error, count } = await supabase
    .from('qqoqccp_analyses')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: "Erreur lors de la suppression de l'analyse QQOQCCP." });
  }

  if (!count) {
    return res.status(404).json({ error: 'Analyse QQOQCCP introuvable.' });
  }

  res.status(204).send();
});

export default router;
