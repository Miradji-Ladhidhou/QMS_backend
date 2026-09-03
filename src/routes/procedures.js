import { Router } from 'express';
import { body, query, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import {
  generateProcedureDraft,
  checkProcedureTemplateCompliance,
  compareProcedureVersions,
} from '../services/groq.js';

const router = Router();
const MANAGER_ROLES = ['admin', 'manager'];
const PROCEDURE_STATUSES = ['draft', 'in_review', 'approved', 'obsolete'];

router.use(requireAuth);
router.use(requireMenuVisible('procedures'));

// Même logique que bumpVersion (documents.js) : "1.0" -> "1.1", 1.0 par défaut pour la
// toute première version d'une procédure.
function bumpVersion(version) {
  const match = /^(\d+)\.(\d+)$/.exec(version ?? '');
  if (match) return `${match[1]}.${Number(match[2]) + 1}`;
  return `${version}.1`;
}

// Auteur de la version ou admin/manager — même principe que canManageTask (tasks.js) : celui
// qui a écrit garde la main sur sa propre soumission, sans qu'un autre member ne puisse la
// pousser à sa place.
function canActOnVersion(req, version) {
  return MANAGER_ROLES.includes(req.userRole) || version.author_id === req.user.id;
}

async function fetchTenantTemplate(tenantId) {
  const { data } = await supabase.from('procedure_templates').select('*').eq('tenant_id', tenantId).maybeSingle();
  return data;
}

// POST /api/procedures/generate-draft — appelé depuis le formulaire de création, AVANT que la
// procédure existe : rien n'est persisté ici, le frontend préremplit juste l'éditeur avec le
// résultat (éditable, jamais publié tel quel — voir POST /:id/versions pour la vraie création).
router.post(
  '/generate-draft',
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('process').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const template = await fetchTenantTemplate(req.tenantId);

    try {
      const draft = await generateProcedureDraft({ title: req.body.title, process: req.body.process }, template);
      res.json(draft);
    } catch (err) {
      res.status(503).json({ error: `Impossible de générer un brouillon IA : ${err.message}` });
    }
  }
);

// GET /api/procedures — liste, filtrable par statut/processus/recherche texte. Pas de système
// de catégories pour ce module (contrairement à CAPA/Documents) : ouvert à tout rôle
// authentifié, comme la lecture des audits/CAPA.
router.get(
  '/',
  [
    query('status').optional({ values: 'falsy' }).isIn(PROCEDURE_STATUSES).withMessage('Statut invalide.'),
    query('process').optional({ values: 'falsy' }).trim(),
    query('search').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Paramètres invalides.', details: errors.array() });
    }

    let queryBuilder = supabase
      .from('procedures')
      .select('*, current_version:procedure_versions!procedures_current_version_id_fkey(id, version, status)')
      .eq('tenant_id', req.tenantId)
      .order('number', { ascending: true });

    if (req.query.status) queryBuilder = queryBuilder.eq('status', req.query.status);
    if (req.query.process) queryBuilder = queryBuilder.ilike('process', `%${req.query.process}%`);
    if (req.query.search) queryBuilder = queryBuilder.or(`title.ilike.%${req.query.search}%,number.ilike.%${req.query.search}%`);

    const { data, error } = await queryBuilder;
    if (error) {
      return res.status(500).json({ error: 'Impossible de récupérer les procédures.' });
    }

    res.json(data);
  }
);

// GET /api/procedures/:id — détail + historique complet des versions (plus récentes d'abord).
router.get('/:id', async (req, res) => {
  const { data: procedure, error } = await supabase
    .from('procedures')
    .select('*, current_version:procedure_versions!procedures_current_version_id_fkey(id, version, status)')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !procedure) {
    return res.status(404).json({ error: 'Procédure introuvable.' });
  }

  const { data: versions, error: versionsError } = await supabase
    .from('procedure_versions')
    .select('*, author:users!procedure_versions_author_id_fkey(id, full_name), validator:users!procedure_versions_validator_id_fkey(id, full_name)')
    .eq('procedure_id', procedure.id)
    .order('created_at', { ascending: false });

  if (versionsError) {
    return res.status(500).json({ error: "Impossible de récupérer l'historique des versions." });
  }

  // Accusé de lecture de l'utilisateur courant POUR LA VERSION COURANTE uniquement — même
  // principe que my_acknowledgment sur GET /api/documents/:id : une nouvelle validation change
  // current_version_id, ce qui rend naturellement cette valeur null pour tout le monde.
  let myAcknowledgment = null;
  if (procedure.current_version_id) {
    const { data } = await supabase
      .from('procedure_acknowledgments')
      .select('acknowledged_at')
      .eq('procedure_version_id', procedure.current_version_id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    myAcknowledgment = data || null;
  }

  res.json({ ...procedure, versions, my_acknowledgment: myAcknowledgment });
});

// POST /api/procedures — création (statut brouillon), ouvert à tout rôle authentifié, même
// esprit que POST /api/capas (n'importe qui peut ouvrir un enregistrement qualité). Aucune
// version n'est créée ici : POST /:id/versions s'en charge séparément, une procédure peut donc
// exister brièvement sans contenu tant que sa première version n'est pas rédigée.
router.post(
  '/',
  [
    body('number').trim().notEmpty().withMessage('Le numéro est requis.'),
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('process').optional({ values: 'falsy' }).trim(),
    body('next_review_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date de révision invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { number, title, process, next_review_date: nextReviewDate } = req.body;

    const { data, error } = await supabase
      .from('procedures')
      .insert({
        tenant_id: req.tenantId,
        number,
        title,
        process: process || null,
        next_review_date: nextReviewDate || null,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Ce numéro de procédure est déjà utilisé.' });
      }
      return res.status(500).json({ error: 'Erreur lors de la création de la procédure.' });
    }

    res.status(201).json(data);
  }
);

// POST /api/procedures/:id/versions — nouvelle version brouillon. author_id toujours
// req.user.id (jamais fourni par le client) : contrairement à assigned_to sur les CAPA, il n'y
// a pas de notion de "rédiger au nom de quelqu'un d'autre".
router.post(
  '/:id/versions',
  [
    body('content').optional().isObject().withMessage('Contenu invalide.'),
    body('ai_generated').optional().isBoolean().withMessage('Valeur invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: procedure, error: procedureError } = await supabase
      .from('procedures')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (procedureError || !procedure) {
      return res.status(404).json({ error: 'Procédure introuvable.' });
    }

    const { data: latestVersion } = await supabase
      .from('procedure_versions')
      .select('version')
      .eq('procedure_id', procedure.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextVersion = latestVersion ? bumpVersion(latestVersion.version) : '1.0';

    const { data, error } = await supabase
      .from('procedure_versions')
      .insert({
        tenant_id: req.tenantId,
        procedure_id: procedure.id,
        version: nextVersion,
        content: req.body.content || {},
        ai_generated: req.body.ai_generated || false,
        author_id: req.user.id,
      })
      .select('*, author:users!procedure_versions_author_id_fkey(id, full_name)')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la version.' });
    }

    res.status(201).json(data);
  }
);

async function fetchVersionForAction(req, res) {
  const { data: version, error } = await supabase
    .from('procedure_versions')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.versionId)
    .eq('procedure_id', req.params.id)
    .single();

  if (error || !version) {
    res.status(404).json({ error: 'Version introuvable.' });
    return null;
  }
  return version;
}

// POST /api/procedures/:id/versions/:versionId/check-compliance — vérifie le contenu de cette
// version contre le gabarit du tenant. Rien n'est persisté (ni le résultat, ni un flag sur la
// version) : c'est une aide avant soumission, pas une décision enregistrée.
router.post('/:id/versions/:versionId/check-compliance', async (req, res) => {
  const version = await fetchVersionForAction(req, res);
  if (!version) return;

  const template = await fetchTenantTemplate(req.tenantId);

  try {
    const result = await checkProcedureTemplateCompliance(version.content, template);
    res.json(result);
  } catch (err) {
    res.status(503).json({ error: `Impossible de vérifier la conformité : ${err.message}` });
  }
});

// POST /api/procedures/:id/versions/:versionId/compare — compare cette version à celle qui la
// précède immédiatement pour la même procédure (previous = null pour une toute première
// version, voir compareProcedureVersions dans groq.js qui gère ce cas explicitement).
router.post('/:id/versions/:versionId/compare', async (req, res) => {
  const version = await fetchVersionForAction(req, res);
  if (!version) return;

  const { data: previousVersion } = await supabase
    .from('procedure_versions')
    .select('content')
    .eq('procedure_id', req.params.id)
    .neq('id', version.id)
    .lt('created_at', version.created_at)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  try {
    const result = await compareProcedureVersions(previousVersion?.content ?? null, version.content);
    res.json(result);
  } catch (err) {
    res.status(503).json({ error: `Impossible de comparer les versions : ${err.message}` });
  }
});

// POST /api/procedures/:id/versions/:versionId/submit — passage en attente de validation
// ("en_validation"). Réservé à l'auteur de CETTE version, ou admin/manager.
router.post('/:id/versions/:versionId/submit', async (req, res) => {
  const version = await fetchVersionForAction(req, res);
  if (!version) return;

  if (!canActOnVersion(req, version)) {
    return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
  }
  if (version.status !== 'draft') {
    return res.status(409).json({ error: 'Cette version a déjà été soumise.' });
  }

  const { data, error } = await supabase
    .from('procedure_versions')
    .update({ status: 'pending', submitted_at: new Date().toISOString(), comment: null })
    .eq('id', version.id)
    .select()
    .single();

  if (error || !data) {
    return res.status(500).json({ error: 'Erreur lors de la soumission.' });
  }

  await supabase.from('procedures').update({ status: 'in_review' }).eq('id', req.params.id);

  res.json(data);
});

// POST /api/procedures/:id/versions/:versionId/validate — même principe que la vérification
// d'efficacité CAPA (requireRole admin/manager) : pas d'approbateur désigné à l'avance,
// n'importe quel admin/manager du tenant peut valider une version en attente.
router.post('/:id/versions/:versionId/validate', requireRole(...MANAGER_ROLES), async (req, res) => {
  const version = await fetchVersionForAction(req, res);
  if (!version) return;

  if (version.status !== 'pending') {
    return res.status(409).json({ error: "Cette version n'est pas en attente de validation." });
  }

  const validatedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from('procedure_versions')
    .update({ status: 'approved', validator_id: req.user.id, validated_at: validatedAt })
    .eq('id', version.id)
    .select()
    .single();

  if (error || !data) {
    return res.status(500).json({ error: 'Erreur lors de la validation.' });
  }

  await supabase.from('procedures').update({ status: 'approved', current_version_id: version.id }).eq('id', req.params.id);

  res.json(data);
});

// POST /api/procedures/:id/versions/:versionId/reject — retour au rédacteur, commentaire
// obligatoire. La procédure repasse en "draft" : la version rejetée reste consultable
// (traçabilité), mais n'est plus la version courante (elle ne l'était de toute façon jamais
// devenue, seule /validate touche current_version_id).
router.post(
  '/:id/versions/:versionId/reject',
  requireRole(...MANAGER_ROLES),
  [body('comment').trim().notEmpty().withMessage('Un commentaire est requis en cas de rejet.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const version = await fetchVersionForAction(req, res);
    if (!version) return;

    if (version.status !== 'pending') {
      return res.status(409).json({ error: "Cette version n'est pas en attente de validation." });
    }

    const { data, error } = await supabase
      .from('procedure_versions')
      .update({
        status: 'rejected',
        validator_id: req.user.id,
        validated_at: new Date().toISOString(),
        comment: req.body.comment,
      })
      .eq('id', version.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(500).json({ error: 'Erreur lors du rejet.' });
    }

    await supabase.from('procedures').update({ status: 'draft' }).eq('id', req.params.id);

    res.json(data);
  }
);

// POST /api/procedures/:id/acknowledge — accusé de lecture de la version COURANTE (celle
// pointée par procedures.current_version_id), même principe que POST /documents/:id/acknowledge.
router.post('/:id/acknowledge', async (req, res) => {
  const { data: procedure, error } = await supabase
    .from('procedures')
    .select('id, current_version_id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !procedure) {
    return res.status(404).json({ error: 'Procédure introuvable.' });
  }
  if (!procedure.current_version_id) {
    return res.status(400).json({ error: 'Aucune version approuvée à accuser réception.' });
  }

  const { data: acknowledgment, error: ackError } = await supabase
    .from('procedure_acknowledgments')
    .upsert(
      { tenant_id: req.tenantId, procedure_version_id: procedure.current_version_id, user_id: req.user.id },
      { onConflict: 'procedure_version_id,user_id', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (ackError || !acknowledgment) {
    return res.status(500).json({ error: "Erreur lors de l'enregistrement de l'accusé de lecture." });
  }

  res.status(201).json(acknowledgment);
});

export default router;
