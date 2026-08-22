import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { generateQqoqccpSuggestion } from '../services/groq.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { buildQqoqccpPdf } from '../services/qqoqccpPdf.js';
import { fetchTenantLogoBuffer } from '../services/tenantLogo.js';
import { isSharedWithUser, getSharedResourceIds } from '../services/recordSharing.js';
import { hasGenericCategoryPermission, filterViewableByCategory } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const QQOQCCP_FIELDS = ['qui', 'quoi', 'ou_', 'quand_', 'comment_', 'combien', 'pourquoi'];
const PATCHABLE_FIELDS = ['title', ...QQOQCCP_FIELDS, 'category_id'];
// Mêmes valeurs que capas.js (CAPA_LEVELS) — dupliquées ici plutôt qu'importées : le prompt
// scope les changements à ce fichier, et cette route ne doit pas modifier capas.js.
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];
const MANAGER_ROLES = ['admin', 'manager'];

router.use(requireAuth);

// GET /api/qqoqccp — liste légère (sans les 7 champs longs), la plus récente en premier.
// Visible par tout le tenant par défaut (même modèle que les Documents) — seule une catégorie
// explicitement restreinte (Paramètres > Catégories) limite l'accès.
router.get('/', async (req, res) => {
  const query = supabase
    .from('qqoqccp_analyses')
    .select('id, title, status, created_at, created_by, category_id, category:categories(id, name, color, is_restricted)')
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false });

  const sharedIds =
    req.userRole === 'admin'
      ? new Set()
      : await getSharedResourceIds({ tenantId: req.tenantId, resourceType: 'qqoqccp', userId: req.user.id, userRole: req.userRole });

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les analyses QQOQCCP.' });
  }

  if (req.userRole === 'admin') {
    return res.json(data);
  }

  // Catégorie restreinte : filterViewableByCategory laisse passer toute analyse dont la
  // catégorie n'est PAS restreinte (ou sans catégorie) — visible par tous dans ce cas. Sur une
  // catégorie explicitement restreinte, seule la permission de catégorie (ou un partage
  // individuel) donne accès.
  const categoryViewableIds = new Set(
    (await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data })).map((a) => a.id)
  );
  const visible = data.filter((analysis) => sharedIds.has(analysis.id) || categoryViewableIds.has(analysis.id));
  res.json(visible);
});

// GET /api/qqoqccp/:id — détail complet
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('qqoqccp_analyses')
    // Deux FK existent maintenant entre les deux tables (linked_capa_id et
    // qqoqccp_analysis_id, voir B1) : sans préciser laquelle suivre, PostgREST refuse
    // l'embed (ambigu). many-to-one via linked_capa_id = "LA capa que cette analyse
    // référence", un objet singulier — c'est le sens de "navigation inverse" recherché ici.
    .select(
      '*, capa:capas!qqoqccp_analyses_linked_capa_id_fkey(id, number, title, status), category:categories(id, name, color, is_restricted)'
    )
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Analyse QQOQCCP introuvable.' });
  }

  if (req.userRole !== 'admin') {
    const shared = await isSharedWithUser({
      tenantId: req.tenantId,
      resourceType: 'qqoqccp',
      resourceId: data.id,
      userId: req.user.id,
      userRole: req.userRole,
    });
    if (!shared) {
      const categoryAllowed = await hasGenericCategoryPermission({
        tenantId: req.tenantId,
        userId: req.user.id,
        userRole: req.userRole,
        categoryId: data.category_id,
        permission: 'view',
      });
      if (!categoryAllowed) {
        return res.status(404).json({ error: 'Analyse QQOQCCP introuvable.' });
      }
    }
  }

  res.json(data);
});

// GET /api/qqoqccp/:id/pdf — rapport imprimable d'une analyse (7 questions, synthèse IA si
// générée, CAPA liée si existante). Chemin à deux segments : ne rentre jamais en conflit
// avec GET /:id ci-dessus, contrairement à /report dans kpis.js qui devait être placé avant.
router.get('/:id/pdf', async (req, res) => {
  const { data: analysis, error } = await supabase
    .from('qqoqccp_analyses')
    .select(
      '*, capa:capas!qqoqccp_analyses_linked_capa_id_fkey(id, number, title, status), category:categories(id, name, color, is_restricted)'
    )
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !analysis) {
    return res.status(404).json({ error: 'Analyse QQOQCCP introuvable.' });
  }

  if (req.userRole !== 'admin') {
    const shared = await isSharedWithUser({
      tenantId: req.tenantId,
      resourceType: 'qqoqccp',
      resourceId: analysis.id,
      userId: req.user.id,
      userRole: req.userRole,
    });
    if (!shared) {
      const categoryAllowed = await hasGenericCategoryPermission({
        tenantId: req.tenantId,
        userId: req.user.id,
        userRole: req.userRole,
        categoryId: analysis.category_id,
        permission: 'view',
      });
      if (!categoryAllowed) {
        return res.status(404).json({ error: 'Analyse QQOQCCP introuvable.' });
      }
    }
  }

  const { data: tenant } = await supabase.from('tenants').select('name, logo_url').eq('id', req.tenantId).single();
  const tenantLogo = await fetchTenantLogoBuffer(tenant?.logo_url);
  const pdfBuffer = await buildQqoqccpPdf({ tenantName: tenant?.name, tenantLogo, analysis });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="qqoqccp-${analysis.id}.pdf"`);
  res.send(pdfBuffer);
});

const CREATE_VALIDATORS = [
  body('title').trim().notEmpty().withMessage('Le titre est requis.'),
  body('qui').optional({ values: 'falsy' }).trim(),
  body('quoi').optional({ values: 'falsy' }).trim(),
  body('ou_').optional({ values: 'falsy' }).trim(),
  body('quand_').optional({ values: 'falsy' }).trim(),
  body('comment_').optional({ values: 'falsy' }).trim(),
  body('combien').optional({ values: 'falsy' }).trim(),
  body('pourquoi').optional({ values: 'falsy' }).trim(),
  body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
];

// Logique d'insertion partagée par POST / (création classique) et POST /quick-start (alias
// sémantique utilisé côté frontend pour "je démarre un diagnostic qui va mener à une CAPA")
// — même validation, même comportement, juste deux points d'entrée.
async function createAnalysis(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
  }

  const { title, qui, quoi, ou_: ou, quand_: quand, comment_: comment, combien, pourquoi, category_id: categoryId } = req.body;

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
      category_id: categoryId || null,
      created_by: req.user.id,
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: "Erreur lors de la création de l'analyse QQOQCCP." });
  }

  res.status(201).json(data);
}

// POST /api/qqoqccp — création
router.post('/', CREATE_VALIDATORS, createAnalysis);

// POST /api/qqoqccp/quick-start — alias sémantique de POST /, pour un diagnostic destiné à
// déboucher sur une CAPA (voir qqoqccp_analyses.linked_capa_id / capas.qqoqccp_analysis_id).
router.post('/quick-start', CREATE_VALIDATORS, createAnalysis);

// PATCH /api/qqoqccp/:id — met à jour le titre et/ou n'importe lequel des 7 champs. Un
// member peut modifier SA PROPRE analyse tant qu'elle n'est pas encore validée (liée à une
// CAPA) — le diagnostic guidé doit rester utilisable en autonomie (c'est ce PATCH qui porte
// la sauvegarde automatique des 7 questions). Owner/admin/manager peuvent toujours modifier
// n'importe quelle analyse, y compris déjà validée.
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
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('qqoqccp_analyses')
      .select('id, created_by, status')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Analyse QQOQCCP introuvable.' });
    }

    const isManager = MANAGER_ROLES.includes(req.userRole);
    const isOwnUnvalidatedAnalysis = existing.created_by === req.user.id && existing.status !== 'validated';
    if (!isManager && !isOwnUnvalidatedAnalysis) {
      return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
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
        preventive_actions: suggestion.preventive_actions,
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

// POST /api/qqoqccp/:id/create-capa — crée une CAPA à partir de cette analyse et lie les
// deux dans les deux sens. Règles de validation identiques à POST /api/capas (capas.js) pour
// les champs communs, plus root_cause/corrective_action/preventive_action (mêmes règles que
// PATCH /api/capas/:id pour ces trois-là, absents de POST /api/capas à l'origine).
router.post(
  '/:id/create-capa',
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('service').optional({ values: 'falsy' }).trim(),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('ref_document').optional({ values: 'falsy' }).isUUID().withMessage('Document de référence invalide.'),
    body('severity').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Gravité invalide.'),
    body('priority').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Priorité invalide.'),
    body('assigned_to').optional({ values: 'falsy' }).isUUID().withMessage('Utilisateur assigné invalide.'),
    body('due_date').optional({ values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
    body('root_cause').optional({ values: 'falsy' }).trim(),
    body('corrective_action').optional({ values: 'falsy' }).trim(),
    body('preventive_action').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const { data: analysis, error: fetchError } = await supabase
      .from('qqoqccp_analyses')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !analysis) {
      return res.status(404).json({ error: 'Analyse QQOQCCP introuvable.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      service,
      service_id: serviceId,
      ref_document: refDocument,
      severity,
      priority,
      assigned_to: assignedTo,
      due_date: dueDate,
      root_cause: rootCause,
      corrective_action: correctiveAction,
      preventive_action: preventiveAction,
    } = req.body;

    // Même règle que POST /api/capas : un member ne choisit pas l'assigné, la CAPA lui est
    // automatiquement rattachée quelle que soit la valeur envoyée dans le corps de la requête.
    const finalAssignedTo = req.userRole === 'member' ? req.user.id : assignedTo || null;

    // Pas de numérotation manuelle : la base s'en charge déjà (voir set_capa_number côté
    // schema.sql), comme pour POST /api/capas.
    const { data: capa, error: capaError } = await supabase
      .from('capas')
      .insert({
        tenant_id: req.tenantId,
        title,
        service: service || null,
        service_id: serviceId || null,
        ref_document: refDocument || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: finalAssignedTo,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        qqoqccp_analysis_id: analysis.id,
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
      .from('qqoqccp_analyses')
      .update({ linked_capa_id: capa.id, status: 'validated' })
      .eq('tenant_id', req.tenantId)
      .eq('id', analysis.id);

    if (linkError) {
      // La CAPA existe déjà et est valide : on ne fait pas échouer la requête pour autant,
      // mais on le signale — l'analyse ne pointera pas vers elle tant que ce n'est pas corrigé.
      console.error("Échec de la mise à jour de l'analyse QQOQCCP après création de la CAPA :", linkError.message);
    }

    res.status(201).json(capa);
  }
);

// DELETE /api/qqoqccp/:id — suppression
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
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
