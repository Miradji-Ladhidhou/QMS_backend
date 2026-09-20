import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { buildQmsSnapshot } from '../services/qmsSnapshot.js';
import { ACTION_STATUSES, describeAction, enrichActions, buildInputBlocks, formatReviewDate } from '../services/managementReviewContent.js';
import { generateManagementReviewDraft } from '../services/groq.js';
import { fetchTenantLogoBuffer } from '../services/tenantLogo.js';
import { buildManagementReviewPdf } from '../services/managementReviewPdf.js';
import { buildManagementReviewWord } from '../services/managementReviewWord.js';
import { buildManagementReviewXlsx } from '../services/managementReviewXlsx.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const REVIEW_STATUSES = ['draft', 'completed'];
// Même niveaux que capas.js (CAPA_LEVELS) — dupliqués ici comme dans audits.js/qqoqccp.js,
// pas de couplage utile entre ces fichiers indépendants.
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];

router.use(requireAuth);
router.use(requireMenuVisible('management-reviews'));

const REVIEW_TEXT_FIELDS = [
  'title',
  'participants',
  'previous_actions_status',
  'context_changes',
  'resource_adequacy',
  'improvement_opportunities',
  'conclusions',
];

// Colonnes d'une action, avec la CAPA liée et le responsable résolus.
const ACTION_SELECT =
  '*, linked_capa:capas!management_review_actions_linked_capa_id_fkey(id, number, title, status), owner_user:users!management_review_actions_owner_fkey(id, full_name)';

// Le responsable d'une action doit être un utilisateur de CE tenant (jamais l'id d'un autre).
async function isTenantUser(tenantId, userId) {
  const { data } = await supabase.from('users').select('id').eq('tenant_id', tenantId).eq('id', userId).maybeSingle();
  return Boolean(data);
}

// Revue précédente = la revue CLÔTURÉE la plus récente antérieure à celle-ci (§9.3.2 a : le statut des
// actions de la revue précédente est un élément d'entrée), avec ses actions et leur statut actuel.
// null s'il n'y en a pas, ou si sa catégorie est inaccessible à l'appelant.
async function fetchPreviousReview(req, review) {
  const { data: previous } = await supabase
    .from('management_reviews')
    .select('id, title, review_date, status, category_id')
    .eq('tenant_id', req.tenantId)
    .eq('status', 'completed')
    .neq('id', review.id)
    .lt('review_date', review.review_date)
    .order('review_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!previous) return null;

  const allowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: previous.category_id,
    permission: 'view',
  });
  if (!allowed) return null;

  const { data: actions } = await supabase
    .from('management_review_actions')
    .select(ACTION_SELECT)
    .eq('tenant_id', req.tenantId)
    .eq('review_id', previous.id)
    .order('created_at', { ascending: true });

  return { id: previous.id, title: previous.title, review_date: previous.review_date, actions: enrichActions(actions || []) };
}

// GET /api/management-reviews — liste tenant-wide, tous les rôles (même transparence que les
// audits : une revue de direction concerne le SMQ dans son ensemble).
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('management_reviews')
    .select('*, category:categories(id, name, color, is_restricted, owner_user_id)')
    .eq('tenant_id', req.tenantId)
    .order('review_date', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les revues de direction.' });
  }

  if (req.userRole === 'admin') {
    return res.json(data);
  }

  // Catégorie restreinte (voir Paramètres > Catégories modules) — opt-in, ne change rien tant
  // qu'aucune catégorie revue n'est marquée restreinte.
  const viewable = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(viewable);
});

// GET /api/management-reviews/:id — détail avec ses actions, CAPA liée résolue pour chacune.
router.get('/:id', async (req, res) => {
  const { data: review, error } = await supabase
    .from('management_reviews')
    .select('*, category:categories(id, name, color, is_restricted, owner_user_id)')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !review) {
    return res.status(404).json({ error: 'Revue de direction introuvable.' });
  }

  if (req.userRole !== 'admin') {
    const categoryAllowed = await hasGenericCategoryPermission({
      tenantId: req.tenantId,
      userId: req.user.id,
      userRole: req.userRole,
      categoryId: review.category_id,
      permission: 'view',
    });
    if (!categoryAllowed) {
      return res.status(404).json({ error: 'Revue de direction introuvable.' });
    }
  }

  const { data: actions, error: actionsError } = await supabase
    .from('management_review_actions')
    .select(ACTION_SELECT)
    .eq('tenant_id', req.tenantId)
    .eq('review_id', review.id)
    .order('created_at', { ascending: true });

  if (actionsError) {
    return res.status(500).json({ error: 'Impossible de récupérer les actions de cette revue.' });
  }

  res.json({
    ...review,
    actions: enrichActions(actions),
    previous_review: await fetchPreviousReview(req, review),
    is_private_to_me: review.category?.owner_user_id === req.user.id,
  });
});

// Données d'une revue pour ses exports (PDF, Word, Excel) : la revue et ses actions, la revue précédente et
// ses actions, le nom/logo de l'entreprise. Répond 404 lui-même et retourne null si la revue est
// introuvable ou inaccessible (catégorie restreinte).
async function loadReviewForExport(req, res) {
  const { data: review, error } = await supabase
    .from('management_reviews')
    .select('*, category:categories(id, name, color, is_restricted, owner_user_id)')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();
  if (error || !review) {
    res.status(404).json({ error: 'Revue de direction introuvable.' });
    return null;
  }
  if (req.userRole !== 'admin') {
    const allowed = await hasGenericCategoryPermission({ tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole, categoryId: review.category_id, permission: 'view' });
    if (!allowed) {
      res.status(404).json({ error: 'Revue de direction introuvable.' });
      return null;
    }
  }

  const [{ data: actions }, previousReview, { data: tenant }, { data: me }] = await Promise.all([
    supabase.from('management_review_actions').select(ACTION_SELECT).eq('tenant_id', req.tenantId).eq('review_id', review.id).order('created_at', { ascending: true }),
    fetchPreviousReview(req, review),
    supabase.from('tenants').select('name, logo_url').eq('id', req.tenantId).single(),
    supabase.from('users').select('full_name').eq('id', req.user.id).single(),
  ]);

  return {
    tenantName: tenant?.name,
    tenantLogo: await fetchTenantLogoBuffer(tenant?.logo_url),
    review: { ...review, actions: enrichActions(actions || []) },
    previousReview,
    generatedBy: me?.full_name,
  };
}

// GET /api/management-reviews/:id/pdf | /word | /xlsx — le compte rendu de la revue : éléments d'entrée, suivi des
// actions de la revue précédente, rubriques rédigées, actions décidées (responsable, échéance, statut).
router.get('/:id/pdf', async (req, res) => {
  const data = await loadReviewForExport(req, res);
  if (!data) return;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="revue-de-direction.pdf"');
  res.send(await buildManagementReviewPdf(data));
});

router.get('/:id/word', async (req, res) => {
  const data = await loadReviewForExport(req, res);
  if (!data) return;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', 'attachment; filename="revue-de-direction.docx"');
  res.send(await buildManagementReviewWord(data));
});

router.get('/:id/xlsx', async (req, res) => {
  const data = await loadReviewForExport(req, res);
  if (!data) return;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="revue-de-direction.xlsx"');
  res.send(Buffer.from(await buildManagementReviewXlsx(data)));
});

// POST /api/management-reviews/:id/ai-draft — brouillon IA des conclusions, des opportunités d'amélioration et
// des décisions, d'après les éléments d'entrée de la revue et le suivi des actions précédentes. RIEN n'est
// enregistré : le frontend présente la proposition, la direction retient et corrige ; les décisions retenues
// deviennent des actions (source « ai »).
router.post('/:id/ai-draft', requireRole('admin', 'manager'), async (req, res) => {
  const data = await loadReviewForExport(req, res);
  if (!data) return;
  const { review, previousReview } = data;

  const blocks = buildInputBlocks(review);
  if (blocks.length === 0) {
    return res.status(400).json({ error: "Aucune donnée d'entrée pour cette revue : définissez une période (Modifier la revue) pour que l'IA puisse s'appuyer sur des chiffres." });
  }

  const context = [
    `Revue de direction : ${review.title} (${formatReviewDate(review.review_date)})`,
    `Participants : ${review.participants || 'non renseignés'}`,
    '',
    "ÉLÉMENTS D'ENTRÉE",
    ...blocks.flatMap((block) => [block.title, ...block.lines.map((line) => `- ${line}`)]),
    '',
    previousReview
      ? `ACTIONS DE LA REVUE PRÉCÉDENTE (${previousReview.title}, ${formatReviewDate(previousReview.review_date)})\n${
          previousReview.actions.length > 0 ? previousReview.actions.map((action) => `- ${describeAction(action)}`).join('\n') : '- aucune action décidée'
        }`
      : 'ACTIONS DE LA REVUE PRÉCÉDENTE : aucune revue précédente clôturée.',
    '',
    `Évolutions du contexte (déjà rédigé) : ${review.context_changes || 'non renseigné'}`,
    `Adéquation des ressources (déjà rédigé) : ${review.resource_adequacy || 'non renseigné'}`,
    `Actions déjà décidées : ${review.actions.length > 0 ? review.actions.map((action) => action.description).join(' ; ') : 'aucune'}`,
  ].join('\n');

  try {
    const result = await generateManagementReviewDraft(context);
    const text = (value) => (typeof value === 'string' ? value.trim() : '');
    const existingActions = new Set(review.actions.map((action) => action.description.trim().toLowerCase()));
    const decisions = (Array.isArray(result?.decisions) ? result.decisions : [])
      .filter((decision) => typeof decision === 'string')
      .map((decision) => decision.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter((decision, index, all) => decision && decision.length <= 500 && !existingActions.has(decision.toLowerCase()) && all.findIndex((d) => d.toLowerCase() === decision.toLowerCase()) === index)
      .slice(0, 8);
    const draft = { conclusions: text(result?.conclusions), improvement_opportunities: text(result?.improvement_opportunities), decisions };
    if (!draft.conclusions && !draft.improvement_opportunities && decisions.length === 0) {
      return res.status(503).json({ error: "L'IA n'a rien proposé d'exploitable. Réessayez." });
    }
    res.json(draft);
  } catch (err) {
    res.status(503).json({ error: `Impossible de générer le brouillon : ${err.message}` });
  }
});

// POST /api/management-reviews — admin/manager uniquement, comme pour les audits : une revue
// de direction n'est pas ouverte à l'initiative d'un member.
router.post(
  '/',
  requireRole('admin', 'manager'),
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('review_date').isISO8601().withMessage('Date de revue invalide.'),
    body('participants').optional({ values: 'falsy' }).trim(),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
    body('period_start').optional({ values: 'falsy' }).isISO8601().withMessage('Date de début de période invalide.'),
    body('period_end')
      .optional({ values: 'falsy' })
      .isISO8601()
      .withMessage('Date de fin de période invalide.')
      .custom((value, { req }) => {
        if (Boolean(value) !== Boolean(req.body.period_start)) {
          throw new Error('period_start et period_end doivent être fournis ensemble.');
        }
        if (value && req.body.period_start && value < req.body.period_start) {
          throw new Error('period_end doit être postérieure ou égale à period_start.');
        }
        return true;
      }),
  ],
  requireValidCategoryId('management_review'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const periodStart = req.body.period_start || null;
    const periodEnd = req.body.period_end || null;
    // Calcul synchrone : ce projet n'a pas de file d'attente de tâches (seulement des jobs cron
    // périodiques, voir app.js), et quelques centaines de ms sur une action admin peu fréquente
    // sont acceptables plutôt que de construire une infrastructure asynchrone pour ce seul besoin.
    const inputSnapshot = periodStart && periodEnd ? await buildQmsSnapshot(req.tenantId, { periodStart, periodEnd }) : null;

    const { data, error } = await supabase
      .from('management_reviews')
      .insert({
        tenant_id: req.tenantId,
        title: req.body.title,
        review_date: req.body.review_date,
        period_start: periodStart,
        period_end: periodEnd,
        input_snapshot: inputSnapshot,
        participants: req.body.participants || null,
        category_id: req.body.category_id || null,
        created_by: req.user.id,
      })
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la revue de direction.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/management-reviews/bulk-category — déplace plusieurs revues d'un coup vers une
// catégorie. Placée avant PATCH /:id pour ne pas être capturée comme un id.
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une revue.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('management_review'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('management_reviews')
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

// PATCH /api/management-reviews/:id — admin/manager uniquement. Le passage à status =
// 'completed' capture automatiquement un snapshot chiffré du SMQ (une seule fois : un
// snapshot déjà posé n'est jamais recalculé, pour rester une photo fidèle du jour de clôture
// même si la revue est rouverte/modifiée ensuite).
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('title').optional().trim().notEmpty().withMessage('Le titre ne peut pas être vide.'),
    body('review_date').optional().isISO8601().withMessage('Date de revue invalide.'),
    body('status').optional().isIn(REVIEW_STATUSES).withMessage('Statut invalide.'),
    ...REVIEW_TEXT_FIELDS.filter((f) => f !== 'title').map((field) => body(field).optional({ values: 'falsy' }).trim()),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
    body('period_start').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Date de début de période invalide.'),
    body('period_end').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Date de fin de période invalide.'),
  ],
  requireValidCategoryId('management_review'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('management_reviews')
      .select('id, status, snapshot, period_start, period_end, conclusions, previous_actions_status, review_date')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Revue de direction introuvable.' });
    }

    // Une revue clôturée ne doit plus jamais voir sa période bouger : ce serait invalider
    // silencieusement l'input_snapshot déjà figé, qui est censé refléter cette période précise.
    // Comparé à la valeur déjà en base (pas juste la présence du champ) : EditReviewModal
    // envoie toujours period_start/period_end dans son payload, y compris pour une revue
    // clôturée où l'utilisateur ne voulait modifier qu'un autre champ (ex. les conclusions) —
    // un simple "le champ est présent" bloquerait à tort cette édition légitime.
    const periodChanged =
      ('period_start' in req.body && (req.body.period_start || null) !== existing.period_start) ||
      ('period_end' in req.body && (req.body.period_end || null) !== existing.period_end);
    if (periodChanged && existing.status === 'completed') {
      return res.status(400).json({ error: 'Impossible de modifier la période une fois la revue clôturée.' });
    }

    const update = {};
    for (const field of [...REVIEW_TEXT_FIELDS, 'review_date']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('status' in req.body) update.status = req.body.status;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;
    if ('period_start' in req.body) update.period_start = req.body.period_start || null;
    if ('period_end' in req.body) update.period_end = req.body.period_end || null;

    // Clôturer une revue est sa sortie formelle (§9.3.3) : la performance chiffrée vient du
    // snapshot automatique, mais la synthèse elle-même doit être écrite. On relit l'existant
    // pour couvrir le cas où conclusions n'est pas dans CETTE requête (même idiome que
    // routes/audits.js PATCH /:id).
    if (update.status === 'completed') {
      const conclusions = 'conclusions' in update ? update.conclusions : existing.conclusions;
      if (!conclusions) {
        return res.status(400).json({ error: 'Renseignez les conclusions de la revue avant de la clôturer.' });
      }

      // §9.3.2 a) : le statut des actions de la/des revue(s) précédente(s) est un élément
      // d'entrée obligatoire — sauf s'il n'existe encore aucune revue *chronologiquement*
      // antérieure déjà clôturée pour ce tenant (rien à rapporter pour la toute première revue).
      // Scopé sur review_date, pas seulement "une autre revue complétée existe quelque part" :
      // clôturer une revue de janvier après avoir déjà clôturé celle de juin ne doit pas exiger
      // un rapport sur une revue qui, chronologiquement, n'a rien de "précédent".
      const reviewDate = 'review_date' in update ? update.review_date : existing.review_date;
      const { count: priorCompletedCount, error: priorError } = await supabase
        .from('management_reviews')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', req.tenantId)
        .eq('status', 'completed')
        .neq('id', req.params.id)
        .lt('review_date', reviewDate);

      if (priorError) {
        return res.status(500).json({ error: 'Impossible de vérifier les revues précédentes.' });
      }

      if (priorCompletedCount > 0) {
        const previousActionsStatus = 'previous_actions_status' in update ? update.previous_actions_status : existing.previous_actions_status;
        if (!previousActionsStatus) {
          return res
            .status(400)
            .json({ error: 'Renseignez le statut des actions de la revue précédente avant de clôturer celle-ci.' });
        }
      }
    }

    if (update.status === 'completed' && !existing.snapshot) {
      update.snapshot = await buildQmsSnapshot(req.tenantId);
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('management_reviews')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Revue de direction introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/management-reviews/:id — admin/manager uniquement. Cascade sur les actions
// (voir schema.sql) ; les CAPA déjà créées à partir d'une action survivent
// (management_review_action_id passe à null, on delete set null).
// DELETE /api/management-reviews/bulk — suppression en masse. Placée avant DELETE /:id pour
// ne pas être capturée comme un id, même convention que /bulk-category.
router.delete(
  '/bulk',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une revue.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { error, count } = await supabase
      .from('management_reviews')
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
  const { error, count } = await supabase
    .from('management_reviews')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de la revue de direction.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Revue de direction introuvable.' });
  }

  res.status(204).end();
});

// POST /api/management-reviews/:id/refresh-snapshot — recalcule input_snapshot à la demande,
// uniquement tant que la revue est en brouillon : une fois clôturée, les données d'entrée
// restent figées exactement comme `snapshot` (même invariant d'auditabilité — une revue déjà
// tenue ne doit plus jamais changer de chiffres).
router.post('/:id/refresh-snapshot', requireRole('admin', 'manager'), async (req, res) => {
  const { data: existing, error: fetchError } = await supabase
    .from('management_reviews')
    .select('id, status, period_start, period_end')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (fetchError || !existing) {
    return res.status(404).json({ error: 'Revue de direction introuvable.' });
  }
  if (existing.status !== 'draft') {
    return res.status(400).json({ error: "Les données d'entrée ne peuvent être actualisées que sur une revue en brouillon." });
  }
  if (!existing.period_start || !existing.period_end) {
    return res.status(400).json({ error: 'Aucune période définie pour cette revue.' });
  }

  const inputSnapshot = await buildQmsSnapshot(req.tenantId, {
    periodStart: existing.period_start,
    periodEnd: existing.period_end,
  });

  const { data, error } = await supabase
    .from('management_reviews')
    .update({ input_snapshot: inputSnapshot })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error || !data) {
    return res.status(500).json({ error: "Erreur lors de l'actualisation des données d'entrée." });
  }

  res.json(data);
});

async function resolveReview(req, res) {
  const { data: review, error } = await supabase
    .from('management_reviews')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.reviewId)
    .single();

  if (error || !review) {
    res.status(404).json({ error: 'Revue de direction introuvable.' });
    return null;
  }
  return review;
}

// Champs de suivi d'une action, communs à la création et à la modification.
const ACTION_TRACKING_VALIDATORS = [
  body('owner').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
  body('due_date').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
  body('status').optional().isIn(ACTION_STATUSES).withMessage('Statut invalide.'),
];

// POST /api/management-reviews/:reviewId/actions — admin/manager uniquement.
router.post(
  '/:reviewId/actions',
  requireRole('admin', 'manager'),
  [
    body('description').trim().notEmpty().withMessage('La description est requise.'),
    body('source').optional().isIn(['manual', 'ai']).withMessage('Source invalide.'),
    ...ACTION_TRACKING_VALIDATORS,
  ],
  async (req, res) => {
    const review = await resolveReview(req, res);
    if (!review) return;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }
    if (req.body.owner && !(await isTenantUser(req.tenantId, req.body.owner))) {
      return res.status(400).json({ error: 'Responsable invalide.' });
    }

    const status = req.body.status || 'open';
    const { data, error } = await supabase
      .from('management_review_actions')
      .insert({
        tenant_id: req.tenantId,
        review_id: review.id,
        description: req.body.description,
        owner: req.body.owner || null,
        due_date: req.body.due_date || null,
        status,
        completed_at: status === 'done' ? new Date().toISOString() : null,
        source: req.body.source || 'manual',
        created_by: req.user.id,
      })
      .select(ACTION_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de la création de l'action." });
    }

    res.status(201).json(enrichActions([data])[0]);
  }
);

// PATCH /api/management-reviews/:reviewId/actions/:id — admin/manager uniquement. Tous les champs sont
// optionnels (le responsable, l'échéance et le statut se modifient un par un depuis la page) ; passer au
// statut « réalisée » date l'action, en sortir efface cette date.
router.patch(
  '/:reviewId/actions/:id',
  requireRole('admin', 'manager'),
  [body('description').optional().trim().notEmpty().withMessage('La description ne peut pas être vide.'), ...ACTION_TRACKING_VALIDATORS],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }
    if (req.body.owner && !(await isTenantUser(req.tenantId, req.body.owner))) {
      return res.status(400).json({ error: 'Responsable invalide.' });
    }

    const update = {};
    if ('description' in req.body) update.description = req.body.description;
    if ('owner' in req.body) update.owner = req.body.owner || null;
    if ('due_date' in req.body) update.due_date = req.body.due_date || null;
    if ('status' in req.body) {
      update.status = req.body.status;
      update.completed_at = req.body.status === 'done' ? new Date().toISOString() : null;
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }
    update.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('management_review_actions')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('review_id', req.params.reviewId)
      .eq('id', req.params.id)
      .select(ACTION_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Action introuvable.' });
    }

    res.json(enrichActions([data])[0]);
  }
);

// DELETE /api/management-reviews/:reviewId/actions/:id — admin/manager uniquement.
router.delete('/:reviewId/actions/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('management_review_actions')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('review_id', req.params.reviewId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: "Erreur lors de la suppression de l'action." });
  }
  if (!count) {
    return res.status(404).json({ error: 'Action introuvable.' });
  }

  res.status(204).end();
});

// POST /api/management-reviews/:reviewId/actions/:id/create-capa — crée une CAPA à partir
// d'une action de revue et lie les deux dans les deux sens. Même mécanique que
// POST /audits/:auditId/findings/:id/create-capa.
router.post(
  '/:reviewId/actions/:id/create-capa',
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
    const { data: action, error: fetchError } = await supabase
      .from('management_review_actions')
      .select('id, description')
      .eq('tenant_id', req.tenantId)
      .eq('review_id', req.params.reviewId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !action) {
      return res.status(404).json({ error: 'Action introuvable.' });
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
        origin: `Revue de direction — action : ${action.description.slice(0, 200)}`,
        service_id: serviceId || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        management_review_action_id: action.id,
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

    const { error: linkError } = await supabase
      .from('management_review_actions')
      .update({ linked_capa_id: capa.id })
      .eq('tenant_id', req.tenantId)
      .eq('id', action.id);

    if (linkError) {
      console.error("Échec de la mise à jour de l'action après création de la CAPA :", linkError.message);
    }

    res.status(201).json(capa);
  }
);

export default router;
