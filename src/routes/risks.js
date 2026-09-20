import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { generateRiskSuggestion } from '../services/groq.js';
import {
  assessmentChanged,
  fetchAssessments,
  getUnacceptableScore,
  recordAssessment,
  reviewState,
  unacceptableFlags,
  withUnacceptableFlags,
  CLOSED_RISK_STATUSES,
} from '../services/riskAssessments.js';
import { RISK_LINK_KINDS, RISK_LINK_KIND_KEYS, fetchKpiRiskSuggestions, fetchRiskLinks, findLinkTarget, listLinkCandidates } from '../services/riskLinks.js';
import { buildRiskPdf } from '../services/riskPdf.js';
import { buildRiskWord } from '../services/riskWord.js';
import { fetchTenantLogoBuffer } from '../services/tenantLogo.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const RISK_TYPES = ['risk', 'opportunity'];
const RISK_STATUSES = ['identified', 'treating', 'treated', 'accepted', 'closed'];
// Statuts qui affirment qu'une décision a été prise sur ce risque (traité/accepté/clôturé) et
// exigent donc une évaluation résiduelle à l'appui — voir le gate dans PATCH /:id.
const RISK_DECISION_STATUSES = ['treated', 'accepted', 'closed'];
// Même niveaux que capas.js (CAPA_LEVELS) — dupliqués ici comme dans audits.js/complaints.js.
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];

router.use(requireAuth);
router.use(requireMenuVisible('risks'));

// La relation module_categories est aliasée "folder", pas "category" : `risks` a sa propre
// colonne texte historique `category` (même raisonnement que SUPPLIER_SELECT dans
// routes/suppliers.js) — l'aliaser en "category" écraserait cette colonne dans le JSON
// renvoyé par PostgREST, rendant le texte libre inaccessible et cassant l'affichage (un objet
// rendu là où le frontend attend une chaîne).
const RISK_SELECT =
  '*, owner_user:users!risks_owner_fkey(id, full_name), service:services(id, name), linked_capa:capas!risks_linked_capa_id_fkey(id, number, title, status), folder:categories(id, name, color, is_restricted, owner_user_id)';

// GET /api/risks — liste tenant-wide, tous les rôles (transparence : le registre des risques
// concerne le SMQ dans son ensemble, comme les audits). Filtrable par statut/type/service. Une
// catégorie explicitement restreinte (Paramètres > Catégories) peut limiter l'accès — opt-in,
// sans effet tant qu'aucune catégorie n'est créée.
router.get('/', async (req, res) => {
  let query = supabase.from('risks').select(RISK_SELECT).eq('tenant_id', req.tenantId).order('risk_score', { ascending: false });

  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.type) query = query.eq('type', req.query.type);
  if (req.query.service_id) query = query.eq('service_id', req.query.service_id);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer le registre des risques.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data, categoryKey: 'folder' });
  res.json(withUnacceptableFlags(visible, await getUnacceptableScore(req.tenantId)));
});

// GET /api/risks/settings — seuil d'acceptabilité de l'entreprise (score = probabilité × gravité).
router.get('/settings', async (req, res) => {
  res.json({ unacceptable_score: await getUnacceptableScore(req.tenantId) });
});

// PATCH /api/risks/settings — admin uniquement : à partir de quel score le risque résiduel est
// inacceptable (alerte, et CAPA obligatoire avant de passer traité/accepté/clôturé).
router.patch(
  '/settings',
  requireRole('admin'),
  [body('unacceptable_score').isInt({ min: 2, max: 25 }).withMessage("Le seuil d'acceptabilité doit être un score entre 2 et 25.").toInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
    }
    const { error } = await supabase.from('tenants').update({ risk_unacceptable_score: req.body.unacceptable_score }).eq('id', req.tenantId);
    if (error) return res.status(500).json({ error: 'Impossible d\'enregistrer le seuil.' });
    res.json({ unacceptable_score: req.body.unacceptable_score });
  }
);

// Fenêtre par défaut de la vue « à revoir » : le trimestre qui vient.
const REVIEW_QUEUE_DEFAULT_DAYS = 90;

// GET /api/risks/review-queue — risques non clos dont la revue est dépassée, proche (dans ?days=, 90 par
// défaut) ou jamais planifiée. Les plus en retard d'abord, puis ceux sans date en dernier.
router.get('/review-queue', async (req, res) => {
  const days = Number.isInteger(Number(req.query.days)) && Number(req.query.days) > 0 ? Math.min(Number(req.query.days), 730) : REVIEW_QUEUE_DEFAULT_DAYS;

  const { data, error } = await supabase
    .from('risks')
    .select(RISK_SELECT)
    .eq('tenant_id', req.tenantId)
    .not('status', 'in', `(${CLOSED_RISK_STATUSES.join(',')})`);
  if (error) return res.status(500).json({ error: 'Impossible de récupérer les risques à revoir.' });

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data, categoryKey: 'folder' });
  const threshold = await getUnacceptableScore(req.tenantId);
  const queue = withUnacceptableFlags(visible, threshold)
    .map((risk) => ({ ...risk, review_state: reviewState(risk.review_date, days) }))
    .filter((risk) => risk.review_state)
    .sort((a, b) => {
      if (!a.review_date) return b.review_date ? 1 : 0;
      if (!b.review_date) return -1;
      return a.review_date < b.review_date ? -1 : a.review_date > b.review_date ? 1 : b.current_score - a.current_score;
    });
  res.json({ days, threshold, items: queue });
});

// GET /api/risks/suggestions/kpis — KPI hors objectif que aucun risque ne couvre encore (voir riskLinks.js).
router.get('/suggestions/kpis', requireRole('admin', 'manager'), async (req, res) => {
  res.json(await fetchKpiRiskSuggestions(req.tenantId));
});

// GET /api/risks/link-candidates?kind= — audits / fournisseurs / KPI / procédures rattachables à un risque
// (id + titre, ceux que l'utilisateur peut voir).
router.get('/link-candidates', requireRole('admin', 'manager'), async (req, res) => {
  if (!RISK_LINK_KIND_KEYS.includes(req.query.kind)) return res.status(400).json({ error: 'Type de lien invalide.' });
  res.json(await listLinkCandidates(req.tenantId, req.query.kind, { userId: req.user.id, userRole: req.userRole }));
});

// Applique une revue à un risque : nouvelle cotation éventuelle, prochaine date de revue, trace « revu le …
// par … », et une ligne d'historique — y compris pour un risque « revu, inchangé » (la revue elle-même est
// la preuve que le risque a été réexaminé).
async function reviewOne(req, current, { likelihood, impact, residual_likelihood: residualLikelihood, residual_impact: residualImpact, next_review_date: nextReviewDate, reason }) {
  const update = { last_reviewed_at: new Date().toISOString(), last_reviewed_by: req.user.id };
  if (likelihood !== undefined) update.likelihood = likelihood;
  if (impact !== undefined) update.impact = impact;
  if (residualLikelihood !== undefined) update.residual_likelihood = residualLikelihood || null;
  if (residualImpact !== undefined) update.residual_impact = residualImpact || null;
  if (nextReviewDate) update.review_date = nextReviewDate;

  const { data, error } = await supabase.from('risks').update(update).eq('tenant_id', req.tenantId).eq('id', current.id).select(RISK_SELECT).single();
  if (error || !data) return null;
  await recordAssessment({ tenantId: req.tenantId, risk: data, userId: req.user.id, reason: reason || (assessmentChanged(current, data) ? 'Revue : cotation modifiée' : 'Revue : risque inchangé') });
  return data;
}

const REVIEW_ITEM_VALIDATORS = [
  body('likelihood').optional().isInt({ min: 1, max: 5 }).withMessage('Probabilité invalide (1 à 5).').toInt(),
  body('impact').optional().isInt({ min: 1, max: 5 }).withMessage('Gravité invalide (1 à 5).').toInt(),
  body('residual_likelihood').optional({ nullable: true, values: 'falsy' }).isInt({ min: 1, max: 5 }).withMessage('Probabilité résiduelle invalide (1 à 5).').toInt(),
  body('residual_impact').optional({ nullable: true, values: 'falsy' }).isInt({ min: 1, max: 5 }).withMessage('Gravité résiduelle invalide (1 à 5).').toInt(),
  body('next_review_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date de revue invalide.'),
  body('reason').optional({ values: 'falsy' }).trim().isLength({ max: 500 }).withMessage('Le motif ne peut pas dépasser 500 caractères.'),
];

// POST /api/risks/bulk-review — revue de plusieurs risques d'un coup (vue « à revoir »). Chaque élément peut
// porter une nouvelle cotation ; `next_review_date` et `reason` s'appliquent à tous. Les risques introuvables
// ou hors de la vue de l'utilisateur sont listés dans `skipped`, jamais modifiés.
router.post(
  '/bulk-review',
  requireRole('admin', 'manager'),
  [
    body('items').isArray({ min: 1, max: 100 }).withMessage('Sélectionnez au moins un risque (100 maximum).'),
    body('items.*.id').isUUID().withMessage('Identifiant invalide.'),
    body('items.*.likelihood').optional().isInt({ min: 1, max: 5 }).withMessage('Probabilité invalide (1 à 5).').toInt(),
    body('items.*.impact').optional().isInt({ min: 1, max: 5 }).withMessage('Gravité invalide (1 à 5).').toInt(),
    body('items.*.residual_likelihood').optional({ nullable: true, values: 'falsy' }).isInt({ min: 1, max: 5 }).withMessage('Probabilité résiduelle invalide (1 à 5).').toInt(),
    body('items.*.residual_impact').optional({ nullable: true, values: 'falsy' }).isInt({ min: 1, max: 5 }).withMessage('Gravité résiduelle invalide (1 à 5).').toInt(),
    body('next_review_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date de revue invalide.'),
    body('reason').optional({ values: 'falsy' }).trim().isLength({ max: 500 }).withMessage('Le motif ne peut pas dépasser 500 caractères.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
    }

    const ids = [...new Set(req.body.items.map((item) => item.id))];
    const { data: rows, error } = await supabase.from('risks').select(RISK_SELECT).eq('tenant_id', req.tenantId).in('id', ids);
    if (error) return res.status(500).json({ error: 'Erreur lors de la revue.' });
    const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: rows, categoryKey: 'folder' });
    const byId = new Map(visible.map((risk) => [risk.id, risk]));

    const reviewed = [];
    const skipped = [];
    for (const item of req.body.items) {
      const current = byId.get(item.id);
      const updated = current ? await reviewOne(req, current, { ...item, next_review_date: req.body.next_review_date, reason: req.body.reason }) : null;
      if (updated) reviewed.push(updated);
      else skipped.push(item.id);
    }
    res.json({ reviewed: reviewed.length, skipped });
  }
);

// GET /api/risks/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('risks').select(RISK_SELECT).eq('tenant_id', req.tenantId).eq('id', req.params.id).single();

  if (error || !data) {
    return res.status(404).json({ error: 'Risque introuvable.' });
  }

  const categoryAllowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: data.category_id,
    permission: 'view',
  });
  if (!categoryAllowed) {
    return res.status(404).json({ error: 'Risque introuvable.' });
  }

  const threshold = await getUnacceptableScore(req.tenantId);
  res.json({
    ...data,
    ...unacceptableFlags(data, threshold),
    unacceptable_score: threshold,
    is_private_to_me: data.folder?.owner_user_id === req.user.id,
  });
});

// POST /api/risks — admin/manager uniquement : l'identification structurée d'un risque est
// une activité de pilotage SMQ, comme pour les audits/revues de direction — un member ne
// l'ouvre pas de sa propre initiative.
router.post(
  '/',
  requireRole('admin', 'manager'),
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('type').optional({ values: 'falsy' }).isIn(RISK_TYPES).withMessage('Type invalide.'),
    body('category').optional({ values: 'falsy' }).trim(),
    body('description').optional({ values: 'falsy' }).trim(),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('owner').optional({ values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
    body('likelihood').isInt({ min: 1, max: 5 }).withMessage('Probabilité invalide (1 à 5).'),
    body('impact').isInt({ min: 1, max: 5 }).withMessage('Gravité invalide (1 à 5).'),
    body('review_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date de revue invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
    body('ai_generated').optional().isBoolean().withMessage('Valeur invalide.'),
  ],
  requireValidCategoryId('risk'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      type,
      category,
      description,
      service_id: serviceId,
      owner,
      likelihood,
      impact,
      review_date: reviewDate,
      category_id: categoryId,
      ai_generated: aiGenerated,
    } = req.body;

    const { data, error } = await supabase
      .from('risks')
      .insert({
        tenant_id: req.tenantId,
        title,
        type: type || undefined,
        category: category || null,
        description: description || null,
        service_id: serviceId || null,
        owner: owner || null,
        likelihood,
        impact,
        review_date: reviewDate || null,
        category_id: categoryId || null,
        ai_generated: aiGenerated || false,
        created_by: req.user.id,
      })
      .select(RISK_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création du risque.' });
    }

    await recordAssessment({ tenantId: req.tenantId, risk: data, userId: req.user.id, reason: 'Cotation initiale' });
    res.status(201).json(data);
  }
);

// POST /api/risks/service-suggestion — suggestion IA de risques/opportunités à partir d'un
// service et d'une description libre de son activité (voir AiRiskSuggestion.jsx). Admin/manager
// uniquement, comme la création de risques : rien n'est persisté ici, le frontend affiche les
// suggestions dans une liste à cocher, chacune acceptée devient un POST /risks distinct (avec
// ai_generated: true) — même mécanique que POST /haccp/steps/:stepId/hazard-suggestion.
router.post(
  '/service-suggestion',
  requireRole('admin', 'manager'),
  [
    body('service_name').trim().notEmpty().withMessage('Le nom du service est requis.'),
    body('context').trim().isLength({ min: 10 }).withMessage('Décrivez l’activité du service (10 caractères minimum).'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    try {
      const suggestion = await generateRiskSuggestion({ serviceName: req.body.service_name, context: req.body.context });
      res.json(suggestion);
    } catch (err) {
      res.status(503).json({ error: `Impossible de générer une suggestion IA : ${err.message}` });
    }
  }
);

// PATCH /api/risks/bulk-category — déplace plusieurs risques d'un coup vers une catégorie.
// Placée avant PATCH /:id pour ne pas être capturée comme un id.
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un risque.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('risk'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('risks')
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

// PATCH /api/risks/:id — admin/manager uniquement. risk_score/residual_score ne sont jamais
// acceptés en entrée : ce sont des generated columns (voir schema.sql), Postgres les calcule
// lui-même à partir de likelihood/impact et residual_likelihood/residual_impact.
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('title').optional().trim().notEmpty().withMessage('Le titre ne peut pas être vide.'),
    body('type').optional({ values: 'falsy' }).isIn(RISK_TYPES).withMessage('Type invalide.'),
    body('category').optional({ values: 'falsy' }).trim(),
    body('description').optional({ values: 'falsy' }).trim(),
    body('service_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('owner').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
    body('likelihood').optional().isInt({ min: 1, max: 5 }).withMessage('Probabilité invalide (1 à 5).'),
    body('impact').optional().isInt({ min: 1, max: 5 }).withMessage('Gravité invalide (1 à 5).'),
    body('current_controls').optional({ values: 'falsy' }).trim(),
    body('treatment_plan').optional({ values: 'falsy' }).trim(),
    body('residual_likelihood').optional({ nullable: true, values: 'falsy' }).isInt({ min: 1, max: 5 }).withMessage('Probabilité résiduelle invalide (1 à 5).'),
    body('residual_impact').optional({ nullable: true, values: 'falsy' }).isInt({ min: 1, max: 5 }).withMessage('Gravité résiduelle invalide (1 à 5).'),
    body('status').optional().isIn(RISK_STATUSES).withMessage('Statut invalide.'),
    body('review_date').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Date de revue invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
    body('change_reason').optional({ values: 'falsy' }).trim().isLength({ max: 500 }).withMessage('Le motif ne peut pas dépasser 500 caractères.'),
  ],
  requireValidCategoryId('risk'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
    }

    const update = {};
    for (const field of ['title', 'type', 'category', 'description', 'current_controls', 'treatment_plan', 'status', 'review_date']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('service_id' in req.body) update.service_id = req.body.service_id || null;
    if ('owner' in req.body) update.owner = req.body.owner || null;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;
    if ('likelihood' in req.body) update.likelihood = req.body.likelihood;
    if ('impact' in req.body) update.impact = req.body.impact;
    if ('residual_likelihood' in req.body) update.residual_likelihood = req.body.residual_likelihood || null;
    if ('residual_impact' in req.body) update.residual_impact = req.body.residual_impact || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    // L'état actuel : comparé à l'état modifié pour l'historique de cotation, et lu pour la règle ci-dessous.
    const { data: current, error: fetchError } = await supabase
      .from('risks')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !current) {
      return res.status(404).json({ error: 'Risque introuvable.' });
    }

    // Passer à "traité"/"accepté"/"clôturé" affirme qu'une décision a été prise sur ce risque —
    // ça n'a de sens que si le risque résiduel a réellement été évalué (ISO 9001 §6.1.2 c :
    // évaluer l'efficacité des actions). Les champs résiduels peuvent ne pas figurer dans CETTE
    // requête : on retombe alors sur l'existant.
    if (RISK_DECISION_STATUSES.includes(update.status)) {
      const residualLikelihood = 'residual_likelihood' in update ? update.residual_likelihood : current.residual_likelihood;
      const residualImpact = 'residual_impact' in update ? update.residual_impact : current.residual_impact;

      if (!residualLikelihood || !residualImpact) {
        return res.status(400).json({
          error: "Renseignez l'évaluation résiduelle (probabilité et gravité) avant de faire évoluer ce statut.",
        });
      }

      // Un risque résiduel au-dessus du seuil d'acceptabilité de l'entreprise ne doit pas quitter le
      // pilotage SMQ sans action associée (même logique que la clôture d'un audit avec NC majeure non traitée).
      const threshold = await getUnacceptableScore(req.tenantId);
      const residualScore = residualLikelihood * residualImpact;
      if (residualScore >= threshold && !current.linked_capa_id) {
        return res.status(400).json({
          error: `Le risque résiduel (${residualScore}) atteint le seuil d'acceptabilité (${threshold}) : liez une CAPA avant de faire évoluer ce statut.`,
        });
      }
    }

    const { data, error } = await supabase
      .from('risks')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(RISK_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Risque introuvable.' });
    }

    // Historique de cotation : seulement si la cotation, le résiduel ou le statut a réellement changé.
    if (assessmentChanged(current, data)) {
      await recordAssessment({ tenantId: req.tenantId, risk: data, userId: req.user.id, reason: req.body.change_reason });
    }

    const threshold = await getUnacceptableScore(req.tenantId);
    res.json({ ...data, ...unacceptableFlags(data, threshold), unacceptable_score: threshold });
  }
);

// DELETE /api/risks/:id — admin/manager uniquement.
// DELETE /api/risks/bulk — suppression en masse. Placée avant DELETE /:id pour ne pas être
// capturée comme un id, même convention que /bulk-category.
router.delete(
  '/bulk',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un risque.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { error, count } = await supabase
      .from('risks')
      .delete({ count: 'exact' })
      .eq('tenant_id', req.tenantId)
      .in('id', req.body.ids);

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la suppression.' });
    }

    res.json({ deleted: count });
  }
);

router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase.from('risks').delete({ count: 'exact' }).eq('tenant_id', req.tenantId).eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du risque.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Risque introuvable.' });
  }

  res.status(204).end();
});

// POST /api/risks/:id/create-capa — crée une CAPA à partir de ce risque (typiquement pour
// porter le plan de traitement) et lie les deux dans les deux sens. Même mécanique que
// POST /complaints/:id/create-capa.
router.post(
  '/:id/create-capa',
  requireRole('admin', 'manager'),
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('severity').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Gravité invalide.'),
    body('priority').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Priorité invalide.'),
    body('assigned_to').optional({ values: 'falsy' }).isUUID().withMessage('Utilisateur assigné invalide.'),
    body('due_date').optional({ values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
    body('root_cause').optional({ values: 'falsy' }).trim(),
    body('corrective_action').optional({ values: 'falsy' }).trim(),
    body('preventive_action').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const { data: risk, error: fetchError } = await supabase
      .from('risks')
      .select('id, title')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !risk) {
      return res.status(404).json({ error: 'Risque introuvable.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      service_id: serviceId,
      severity,
      priority,
      assigned_to: assignedTo,
      due_date: dueDate,
      root_cause: rootCause,
      corrective_action: correctiveAction,
      preventive_action: preventiveAction,
    } = req.body;

    const { data: capa, error: capaError } = await supabase
      .from('capas')
      .insert({
        tenant_id: req.tenantId,
        title,
        origin: `Risque/opportunité — ${risk.title}`,
        service_id: serviceId || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        risk_id: risk.id,
        created_by: req.user.id,
      })
      .select('*, assigned:users!capas_assigned_to_fkey(id, full_name)')
      .single();

    if (capaError) {
      return res.status(500).json({ error: 'Erreur lors de la création de la CAPA.' });
    }

    if (capa.assigned_to) {
      notifyCapaAssigned(req.tenantId, capa).catch((err) =>
        console.error("Échec de la notification d'assignation CAPA :", err.message)
      );
    }

    const { error: linkError } = await supabase.from('risks').update({ linked_capa_id: capa.id }).eq('tenant_id', req.tenantId).eq('id', risk.id);

    if (linkError) {
      console.error('Échec de la mise à jour du risque après création de la CAPA :', linkError.message);
    }

    res.status(201).json(capa);
  }
);

const viewerOf = (req) => ({ userId: req.user.id, userRole: req.userRole });

// Risque de l'entreprise, dans la vue de l'utilisateur (catégorie restreinte incluse) — `null` sinon.
async function findVisibleRisk(req) {
  const { data } = await supabase.from('risks').select(RISK_SELECT).eq('tenant_id', req.tenantId).eq('id', req.params.id).maybeSingle();
  if (!data) return null;
  const allowed = await hasGenericCategoryPermission({ tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole, categoryId: data.category_id, permission: 'view' });
  return allowed ? data : null;
}

// POST /api/risks/:id/review — « marquer revu » : nouvelle cotation éventuelle, prochaine date de revue.
router.post('/:id/review', requireRole('admin', 'manager'), REVIEW_ITEM_VALIDATORS, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
  }
  const current = await findVisibleRisk(req);
  if (!current) return res.status(404).json({ error: 'Risque introuvable.' });

  const updated = await reviewOne(req, current, req.body);
  if (!updated) return res.status(500).json({ error: 'Erreur lors de la revue.' });
  const threshold = await getUnacceptableScore(req.tenantId);
  res.json({ ...updated, ...unacceptableFlags(updated, threshold), unacceptable_score: threshold });
});

// GET /api/risks/:id/assessments — historique de cotation, du plus ancien au plus récent.
router.get('/:id/assessments', async (req, res) => {
  if (!(await findVisibleRisk(req))) return res.status(404).json({ error: 'Risque introuvable.' });
  try {
    res.json(await fetchAssessments(req.tenantId, req.params.id));
  } catch {
    res.status(500).json({ error: "Impossible de récupérer l'historique de cotation." });
  }
});

// GET /api/risks/:id/links — audits, fournisseurs, KPI et procédures rattachés à ce risque.
router.get('/:id/links', async (req, res) => {
  if (!(await findVisibleRisk(req))) return res.status(404).json({ error: 'Risque introuvable.' });
  try {
    res.json(await fetchRiskLinks(req.tenantId, req.params.id, viewerOf(req)));
  } catch {
    res.status(500).json({ error: 'Impossible de récupérer les liens du risque.' });
  }
});

// POST /api/risks/:id/links — rattache un audit, un fournisseur, un KPI ou une procédure de l'entreprise.
router.post(
  '/:id/links',
  requireRole('admin', 'manager'),
  [
    body('kind').isIn(RISK_LINK_KIND_KEYS).withMessage('Type de lien invalide.'),
    body('ref_id').isUUID().withMessage('Objet invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
    }
    if (!(await findVisibleRisk(req))) return res.status(404).json({ error: 'Risque introuvable.' });

    const { kind, ref_id: refId } = req.body;
    if (!(await findLinkTarget(req.tenantId, kind, refId, viewerOf(req)))) {
      return res.status(404).json({ error: `${RISK_LINK_KINDS[kind].label} introuvable.` });
    }

    const { error } = await supabase
      .from('risk_links')
      .insert({ tenant_id: req.tenantId, risk_id: req.params.id, [RISK_LINK_KINDS[kind].column]: refId, created_by: req.user.id });
    if (error?.code === '23505') return res.status(409).json({ error: 'Ce lien existe déjà.' });
    if (error) return res.status(500).json({ error: 'Impossible de créer le lien.' });

    res.status(201).json(await fetchRiskLinks(req.tenantId, req.params.id, viewerOf(req)));
  }
);

// DELETE /api/risks/:id/links/:linkId
router.delete('/:id/links/:linkId', requireRole('admin', 'manager'), async (req, res) => {
  if (!(await findVisibleRisk(req))) return res.status(404).json({ error: 'Risque introuvable.' });
  const { error, count } = await supabase
    .from('risk_links')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('risk_id', req.params.id)
    .eq('id', req.params.linkId);
  if (error) return res.status(500).json({ error: 'Impossible de supprimer le lien.' });
  if (!count) return res.status(404).json({ error: 'Lien introuvable.' });
  res.status(204).end();
});

// Données de la fiche imprimable d'un risque (PDF et Word) : le risque, son historique de cotation, ses
// liens, sa CAPA, et l'entreprise (nom, logo, fuseau, seuil d'acceptabilité).
async function loadRiskExportData(req) {
  const risk = await findVisibleRisk(req);
  if (!risk) return null;
  const [assessments, links, { data: tenant }, threshold, { data: reviewer }] = await Promise.all([
    fetchAssessments(req.tenantId, risk.id),
    fetchRiskLinks(req.tenantId, risk.id, viewerOf(req)),
    supabase.from('tenants').select('name, logo_url, timezone').eq('id', req.tenantId).single(),
    getUnacceptableScore(req.tenantId),
    risk.last_reviewed_by ? supabase.from('users').select('full_name').eq('id', risk.last_reviewed_by).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  return {
    risk: { ...risk, ...unacceptableFlags(risk, threshold), last_reviewed_by_name: reviewer?.full_name || null },
    assessments,
    links,
    threshold,
    tenantName: tenant?.name,
    tenantTimezone: tenant?.timezone,
    tenantLogo: await fetchTenantLogoBuffer(tenant?.logo_url),
  };
}

function riskFileName(risk, extension) {
  return `risque-${risk.title.replace(/[^A-Za-z0-9À-ÿ_-]+/g, '_').slice(0, 60)}.${extension}`;
}

// GET /api/risks/:id/pdf et /word — fiche imprimable d'un seul risque (cotation, mesures, CAPA liée, résiduel, historique).
router.get('/:id/pdf', async (req, res) => {
  const data = await loadRiskExportData(req);
  if (!data) return res.status(404).json({ error: 'Risque introuvable.' });
  const buffer = await buildRiskPdf(data);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(riskFileName(data.risk, 'pdf'))}"`);
  res.send(buffer);
});

router.get('/:id/word', async (req, res) => {
  const data = await loadRiskExportData(req);
  if (!data) return res.status(404).json({ error: 'Risque introuvable.' });
  const buffer = await buildRiskWord(data);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(riskFileName(data.risk, 'docx'))}"`);
  res.send(buffer);
});


export default router;
