import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { generateQqoqccpSuggestion } from '../services/groq.js';

const router = Router();

const QQOQCCP_FIELDS = ['qui', 'quoi', 'ou_', 'quand_', 'comment_', 'combien', 'pourquoi'];
const PATCHABLE_FIELDS = ['title', ...QQOQCCP_FIELDS];

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

// POST /api/qqoqccp/:id/generate — suggestion IA (Groq) à partir des réponses déjà saisies
router.post('/:id/generate', async (req, res) => {
  const { data: analysis, error: fetchError } = await supabase
    .from('qqoqccp_analyses')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (fetchError || !analysis) {
    return res.status(404).json({ error: 'Analyse QQOQCCP introuvable.' });
  }

  const filledCount = QQOQCCP_FIELDS.filter((field) => analysis[field]).length;
  if (filledCount < 3) {
    return res.status(400).json({ error: 'Remplissez au moins 3 des 7 questions avant de générer une proposition.' });
  }

  let suggestion;
  try {
    suggestion = await generateQqoqccpSuggestion({
      qui: analysis.qui,
      quoi: analysis.quoi,
      ou_: analysis.ou_,
      quand_: analysis.quand_,
      comment_: analysis.comment_,
      combien: analysis.combien,
      pourquoi: analysis.pourquoi,
    });
  } catch (err) {
    // L'analyse elle-même n'est pas touchée : aucune écriture en base n'a encore eu lieu
    // à ce stade, elle reste consultable normalement même si Groq échoue.
    return res.status(503).json({ error: `Impossible de générer une suggestion IA : ${err.message}` });
  }

  const { data, error } = await supabase
    .from('qqoqccp_analyses')
    .update({
      ai_synthesis: suggestion.synthesis,
      ai_suggested_actions: {
        root_causes: suggestion.root_causes,
        suggested_actions: suggestion.suggested_actions,
        overall_priority: suggestion.overall_priority,
      },
      status: 'ai_generated',
    })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error || !data) {
    return res.status(500).json({ error: "Erreur lors de l'enregistrement de la suggestion IA." });
  }

  res.json(data);
});

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
