import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { fetchTenantLogoBuffer } from '../services/tenantLogo.js';
import { buildCapaPdf } from '../services/capaPdf.js';
import { isSharedWithUser, getSharedResourceIds } from '../services/recordSharing.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const CAPA_STATUSES = ['open', 'in_progress', 'pending_verification', 'closed', 'overdue'];
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];
const PATCHABLE_FIELDS = [
  'status',
  'priority',
  'severity',
  'assigned_to',
  'due_date',
  'service_id',
  'description',
  'root_cause',
  'corrective_action',
  'preventive_action',
  'effectiveness_verified',
  'effectiveness_notes',
  'comment',
  'category_id',
];

// Colonnes explicites (sans "service", le champ texte libre historique) plutôt que '*' :
// aliaser l'embed services(...) en "service" à côté d'un '*' qui contient déjà une colonne
// service texte du même nom provoquerait une collision de clé côté PostgREST. "service" reste
// en base (non supprimée, voir schema.sql) mais l'API ne la lit/écrit plus nulle part — seul
// service_id fait foi désormais, résolu ici en {id, name} comme pour audits/risks/complaints/
// suppliers (voir leurs routes GET respectives, même pattern déjà en place chez eux).
const CAPA_COLUMNS =
  'id, tenant_id, number, title, origin, ref_document, priority, status, assigned_to, due_date, closed_at, created_by, created_at, updated_at, description, severity, root_cause, corrective_action, preventive_action, effectiveness_verified, effectiveness_notes, comment, qqoqccp_analysis_id, service_id, audit_finding_id, management_review_action_id, complaint_id, risk_id, supplier_evaluation_id, haccp_monitoring_log_id, accident_id, category_id';
const CAPA_SELECT = `${CAPA_COLUMNS}, assigned:users!capas_assigned_to_fkey(id, full_name), service:services(id, name), category:categories(id, name, color, is_restricted, owner_user_id)`;

// Délai de traitement par défaut (en jours depuis la création) quand le tenant n'a pas
// paramétré ses propres valeurs via PUT /api/capas/priority-delays.
const DEFAULT_PRIORITY_DELAYS = { critical: 30, high: 60, medium: 90, low: 120 };

router.use(requireAuth);
router.use(requireMenuVisible('capas'));

async function closeOverdueCapas(tenantId) {
  const today = new Date().toISOString().slice(0, 10);

  await supabase
    .from('capas')
    .update({ status: 'overdue' })
    .eq('tenant_id', tenantId)
    .lt('due_date', today)
    .not('status', 'in', '(closed,overdue)');
}

// GET /api/capas/priority-delays — délais de traitement configurés (jours), avec repli sur
// les valeurs par défaut pour toute priorité non paramétrée par ce tenant.
router.get('/priority-delays', async (req, res) => {
  const { data, error } = await supabase
    .from('capa_priority_delays')
    .select('priority, delay_days')
    .eq('tenant_id', req.tenantId);

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les délais de traitement.' });
  }

  const delays = { ...DEFAULT_PRIORITY_DELAYS };
  for (const row of data) {
    delays[row.priority] = row.delay_days;
  }

  res.json(delays);
});

// PUT /api/capas/priority-delays — paramétrage des délais par priorité (admin uniquement)
router.put(
  '/priority-delays',
  requireRole('admin'),
  CAPA_LEVELS.map((level) => body(level).isInt({ min: 1 }).withMessage(`Délai invalide pour la priorité "${level}".`)),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const rows = CAPA_LEVELS.map((level) => ({
      tenant_id: req.tenantId,
      priority: level,
      delay_days: Number(req.body[level]),
    }));

    const { error } = await supabase.from('capa_priority_delays').upsert(rows, { onConflict: 'tenant_id,priority' });

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la mise à jour des délais de traitement.' });
    }

    const delays = Object.fromEntries(rows.map((row) => [row.priority, row.delay_days]));
    res.json(delays);
  }
);

// GET /api/capas — liste avec le responsable assigné, statuts en retard mis à jour.
// Visible par tout le tenant par défaut (même modèle que les Documents) — seule une catégorie
// explicitement restreinte (Paramètres > Catégories) limite l'accès, quel que soit le rôle.
// Un member ne peut toujours MODIFIER que les CAPA qui lui sont assignées (voir PATCH /:id) —
// ça, ça reste inchangé, seule la visibilité en lecture s'est simplifiée.
router.get('/', async (req, res) => {
  await closeOverdueCapas(req.tenantId);

  const query = supabase
    .from('capas')
    .select(CAPA_SELECT)
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false });

  // Un partage (voir record_shares/recordSharing.js, bouton Partager) donne accès à une CAPA
  // précise en plus des règles normales — jamais une restriction, uniquement un octroi
  // supplémentaire. Calculé pour tous les rôles non-admin.
  const sharedIds =
    req.userRole === 'admin'
      ? new Set()
      : await getSharedResourceIds({ tenantId: req.tenantId, resourceType: 'capa', userId: req.user.id, userRole: req.userRole });

  const { data, error } = await query;

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les CAPA.' });
  }

  if (req.userRole === 'admin') {
    return res.json(data);
  }

  // Catégorie restreinte (voir Paramètres > Catégories CAPA) : filterViewableByCategory laisse
  // passer toute CAPA dont la catégorie n'est PAS restreinte (ou sans catégorie) — visible par
  // tous dans ce cas. Sur une catégorie explicitement restreinte, seule la permission de
  // catégorie (ou un partage individuel) donne accès, quel que soit le rôle ou l'assignation.
  const categoryViewableIds = new Set(
    (await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data })).map((c) => c.id)
  );
  const visible = data.filter((capa) => sharedIds.has(capa.id) || categoryViewableIds.has(capa.id));

  res.json(visible);
});

// GET /api/capas/:id — détail avec commentaires de suivi
router.get('/:id', async (req, res) => {
  // qqoqccp_analysis!capas_qqoqccp_analysis_id_fkey : deux FK existent entre capas et
  // qqoqccp_analyses (voir B1), PostgREST refuse sinon l'embed (ambigu). many-to-one via
  // capas.qqoqccp_analysis_id = "L'analyse à l'origine de cette CAPA", objet singulier.
  const { data: capa, error } = await supabase
    .from('capas')
    .select(
      `${CAPA_SELECT}, qqoqccp_analysis:qqoqccp_analyses!capas_qqoqccp_analysis_id_fkey(id, title, ai_synthesis), pdca_project:pdca_projects!capas_pdca_project_id_fkey(id, title, status)`
    )
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !capa) {
    return res.status(404).json({ error: 'CAPA introuvable.' });
  }

  // Même règle que GET / (liste) : visible par tout le tenant, sauf catégorie restreinte
  // (voir Paramètres > Catégories) ou partage individuel qui en lève l'accès.
  if (req.userRole !== 'admin') {
    const shared = await isSharedWithUser({
      tenantId: req.tenantId,
      resourceType: 'capa',
      resourceId: capa.id,
      userId: req.user.id,
      userRole: req.userRole,
    });
    if (!shared) {
      const categoryAllowed = await hasGenericCategoryPermission({
        tenantId: req.tenantId,
        userId: req.user.id,
        userRole: req.userRole,
        categoryId: capa.category_id,
        permission: 'view',
      });
      if (!categoryAllowed) {
        return res.status(404).json({ error: 'CAPA introuvable.' });
      }
    }
  }

  const { data: comments, error: commentsError } = await supabase
    .from('capa_comments')
    .select('*, author:users(id, full_name)')
    .eq('capa_id', capa.id)
    .order('created_at', { ascending: true });

  if (commentsError) {
    return res.status(500).json({ error: 'Impossible de récupérer les commentaires.' });
  }

  // Traçabilité inverse : procedure_capa_links pointe de la procédure vers ce CAPA (créé et
  // géré depuis routes/procedures.js#link-capa), même principe que linked_capas sur GET
  // /api/documents/:id mais dans l'autre sens.
  const { data: procedureLinks, error: procedureLinksError } = await supabase
    .from('procedure_capa_links')
    .select('procedure:procedures(id, number, title, status)')
    .eq('tenant_id', req.tenantId)
    .eq('capa_id', capa.id);

  if (procedureLinksError) {
    return res.status(500).json({ error: 'Impossible de récupérer les procédures liées.' });
  }

  // Tâches de suivi créées depuis cette CAPA (voir POST /:id/create-task) — une CAPA peut se
  // décomposer en plusieurs tâches, contrairement aux liens *_id 1:1 : simple requête filtrée
  // par capa_id, pas de colonne réciproque sur capas (voir schema.sql).
  const { data: linkedTasks, error: linkedTasksError } = await supabase
    .from('tasks')
    .select('id, title, due_date, status')
    .eq('tenant_id', req.tenantId)
    .eq('capa_id', capa.id)
    .order('due_date', { ascending: true });

  if (linkedTasksError) {
    return res.status(500).json({ error: 'Impossible de récupérer les tâches liées.' });
  }

  // is_private_to_me : évite au frontend de comparer capa.category.owner_user_id à
  // l'utilisateur courant lui-même (source d'un vrai bug de course, currentUser et cette
  // requête chargeant en parallèle et pas forcément dans le même ordre) — voir
  // hasGenericCategoryPermission pour le même raisonnement côté can_edit sur les documents.
  res.json({
    ...capa,
    comments,
    linked_procedures: procedureLinks.map((link) => link.procedure),
    linked_tasks: linkedTasks,
    is_private_to_me: capa.category?.owner_user_id === req.user.id,
  });
});

// GET /api/capas/:id/pdf — fiche imprimable d'une CAPA (voir services/capaPdf.js). Chemin à
// deux segments : ne rentre jamais en conflit avec GET /:id ci-dessus, même principe que
// /:id/pdf dans procedures.js/qqoqccp.js. Même règle de visibilité que GET /:id (catégorie
// restreinte ou partage individuel).
router.get('/:id/pdf', async (req, res) => {
  const { data: capa, error } = await supabase.from('capas').select(CAPA_SELECT).eq('tenant_id', req.tenantId).eq('id', req.params.id).single();

  if (error || !capa) {
    return res.status(404).json({ error: 'CAPA introuvable.' });
  }

  if (req.userRole !== 'admin') {
    const shared = await isSharedWithUser({
      tenantId: req.tenantId,
      resourceType: 'capa',
      resourceId: capa.id,
      userId: req.user.id,
      userRole: req.userRole,
    });
    if (!shared) {
      const categoryAllowed = await hasGenericCategoryPermission({
        tenantId: req.tenantId,
        userId: req.user.id,
        userRole: req.userRole,
        categoryId: capa.category_id,
        permission: 'view',
      });
      if (!categoryAllowed) {
        return res.status(404).json({ error: 'CAPA introuvable.' });
      }
    }
  }

  const { data: tenant } = await supabase.from('tenants').select('name, logo_url').eq('id', req.tenantId).single();
  const tenantLogo = await fetchTenantLogoBuffer(tenant?.logo_url);
  const pdfBuffer = await buildCapaPdf({ tenantName: tenant?.name, tenantLogo, capa });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${capa.number || capa.id}.pdf"`);
  res.send(pdfBuffer);
});

// POST /api/capas — création, numérotation automatique CAPA-{année}-{seq}
router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('description').optional({ values: 'falsy' }).trim(),
    body('origin').optional({ values: 'falsy' }).trim(),
    body('ref_document').optional({ values: 'falsy' }).isUUID().withMessage('Document de référence invalide.'),
    body('severity').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Gravité invalide.'),
    body('priority').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Priorité invalide.'),
    body('assigned_to').optional({ values: 'falsy' }).isUUID().withMessage('Utilisateur assigné invalide.'),
    body('due_date').optional({ values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
    body('root_cause').optional({ values: 'falsy' }).trim(),
    body('corrective_action').optional({ values: 'falsy' }).trim(),
    body('preventive_action').optional({ values: 'falsy' }).trim(),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
    body('qqoqccp_analysis_id').optional({ values: 'falsy' }).isUUID().withMessage('Analyse QQOQCCP invalide.'),
  ],
  requireValidCategoryId('capa'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      service_id: serviceId,
      description,
      origin,
      ref_document: refDocument,
      severity,
      priority,
      assigned_to: assignedTo,
      due_date: dueDate,
      root_cause: rootCause,
      corrective_action: correctiveAction,
      preventive_action: preventiveAction,
      category_id: categoryId,
      qqoqccp_analysis_id: qqoqccpAnalysisId,
    } = req.body;

    // Un member peut ouvrir une CAPA mais elle lui est toujours auto-assignée : on ignore
    // toute valeur d'assigned_to reçue du corps de la requête pour ce rôle, sans faire
    // confiance au frontend. admin/manager gardent le comportement d'origine.
    const finalAssignedTo = req.userRole === 'member' ? req.user.id : assignedTo || null;

    // Raccourci "Structurer la cause avec QQOQCCP" depuis NewCapaModal (Capas.jsx) : l'analyse
    // a déjà été créée par le panneau embarqué, on vérifie juste qu'elle appartient au tenant
    // avant de la lier — même validation de périmètre que les autres routes create-capa sur
    // leur ressource source.
    let qqoqccpAnalysis = null;
    if (qqoqccpAnalysisId) {
      const { data: analysis, error: analysisError } = await supabase
        .from('qqoqccp_analyses')
        .select('id, title')
        .eq('tenant_id', req.tenantId)
        .eq('id', qqoqccpAnalysisId)
        .single();
      if (analysisError || !analysis) {
        return res.status(404).json({ error: 'Analyse QQOQCCP introuvable.' });
      }
      qqoqccpAnalysis = analysis;
    }

    const { data, error } = await supabase
      .from('capas')
      .insert({
        tenant_id: req.tenantId,
        title,
        service_id: serviceId || null,
        description: description || null,
        // Ne renseigne l'origine automatiquement que si l'utilisateur n'a rien tapé lui-même —
        // jamais écraser un texte déjà saisi à la main.
        origin: origin || (qqoqccpAnalysis ? `Analyse QQOQCCP — ${qqoqccpAnalysis.title}` : null),
        ref_document: refDocument || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: finalAssignedTo,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        category_id: categoryId || null,
        qqoqccp_analysis_id: qqoqccpAnalysis?.id || null,
        created_by: req.user.id,
      })
      .select(CAPA_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la CAPA.' });
    }

    notifyCapaAssigned(req.tenantId, data).catch((err) =>
      console.error("Échec de la notification d'assignation CAPA :", err.message)
    );

    if (qqoqccpAnalysis) {
      const { error: linkError } = await supabase
        .from('qqoqccp_analyses')
        .update({ linked_capa_id: data.id, status: 'validated' })
        .eq('tenant_id', req.tenantId)
        .eq('id', qqoqccpAnalysis.id);
      if (linkError) {
        console.error("Échec de la mise à jour de l'analyse QQOQCCP après création de la CAPA :", linkError.message);
      }
    }

    res.status(201).json(data);
  }
);

// PATCH /api/capas/bulk-category — déplace plusieurs CAPA d'un coup vers une catégorie (ou
// vers aucune, category_id absent/vide). Placée avant PATCH /:id : sinon "bulk-category" serait
// capturé comme un id, même raison que priority-delays/report ailleurs dans ce fichier.
// Réservé admin/manager, comme le reste des actions de gestion en masse de ce module.
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une CAPA.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('capa'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('capas')
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

// PATCH /api/capas/:id — mise à jour des champs de suivi (statut, priorité, gravité,
// assignation, échéance, description, analyse des causes, actions, vérification d'efficacité...)
// Réservé à admin/manager : un member peut ouvrir une CAPA mais ne peut plus la modifier une
// fois créée, même si elle lui est assignée — seul le commentaire de suivi lui reste ouvert
// (POST /:id/comments, non restreint).
router.patch(
  '/:id',
  (req, res, next) => {
    if (req.userRole === 'member') {
      return res.status(403).json({
        error: 'Seuls les administrateurs et managers peuvent modifier une CAPA après sa création.',
      });
    }
    next();
  },
  [
    body('status').optional({ values: 'falsy' }).isIn(CAPA_STATUSES).withMessage('Statut invalide.'),
    body('priority').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Priorité invalide.'),
    body('severity').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Gravité invalide.'),
    body('assigned_to').optional({ values: 'falsy' }).isUUID().withMessage('Utilisateur assigné invalide.'),
    body('due_date').optional({ values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('description').optional({ values: 'falsy' }).trim(),
    body('root_cause').optional({ values: 'falsy' }).trim(),
    body('corrective_action').optional({ values: 'falsy' }).trim(),
    body('preventive_action').optional({ values: 'falsy' }).trim(),
    body('effectiveness_verified').optional({ nullable: true }).isBoolean().withMessage('Valeur invalide.'),
    body('effectiveness_notes').optional({ values: 'falsy' }).trim(),
    body('comment').optional({ values: 'falsy' }).trim(),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('capa'),
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
    // category_id est une colonne uuid : une chaîne vide (remise à "Tout le monde") doit
    // devenir null, sinon Postgres la rejette comme uuid invalide et l'update entier échoue,
    // faussement rapporté comme "CAPA introuvable" par le bloc error ci-dessous.
    if ('category_id' in update) update.category_id = update.category_id || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    if ('effectiveness_verified' in update && update.effectiveness_verified !== null) {
      // Un verdict d'efficacité (true ou false) sans justification écrite ne tient pas en audit —
      // indépendant du bloc de clôture ci-dessous, qui ne se déclenche que sur status==='closed' :
      // ici on couvre aussi le cas où la vérification est enregistrée sans toucher au statut dans
      // la même requête (voir CapaDetail.jsx#handleSaveEffectiveness, qui envoie les deux champs
      // ensemble mais jamais le statut).
      let effectivenessNotes = update.effectiveness_notes;
      if (effectivenessNotes === undefined) {
        const { data: existing, error: fetchError } = await supabase
          .from('capas')
          .select('effectiveness_notes')
          .eq('tenant_id', req.tenantId)
          .eq('id', req.params.id)
          .single();

        if (fetchError || !existing) {
          return res.status(404).json({ error: 'CAPA introuvable.' });
        }
        effectivenessNotes = existing.effectiveness_notes;
      }

      if (!effectivenessNotes) {
        return res
          .status(400)
          .json({ error: "Merci de justifier le résultat de la vérification d'efficacité par un commentaire." });
      }
    }

    if (update.status === 'closed') {
      // Le statut "En vérification" (pending_verification) n'a de sens que si la clôture est
      // réellement subordonnée à une vérification d'efficacité positive — sinon rien n'empêchait
      // jusqu'ici de clôturer directement depuis "Ouverte", sans action corrective ni
      // vérification, ce qui vide de son sens la clause 10.2.1(f) de l'ISO 9001 ("vérifier
      // l'efficacité de toute action corrective entreprise"). Les deux champs peuvent arriver
      // soit dans CETTE requête (effectiveness_verified et corrective_action patchés en même
      // temps que status), soit avoir déjà été enregistrés avant — d'où la relecture de la ligne
      // existante quand l'un des deux n'est pas fourni ici.
      let effectivenessVerified = update.effectiveness_verified;
      let correctiveAction = update.corrective_action;

      if (effectivenessVerified === undefined || correctiveAction === undefined) {
        const { data: existing, error: fetchError } = await supabase
          .from('capas')
          .select('effectiveness_verified, corrective_action')
          .eq('tenant_id', req.tenantId)
          .eq('id', req.params.id)
          .single();

        if (fetchError || !existing) {
          return res.status(404).json({ error: 'CAPA introuvable.' });
        }
        if (effectivenessVerified === undefined) effectivenessVerified = existing.effectiveness_verified;
        if (correctiveAction === undefined) correctiveAction = existing.corrective_action;
      }

      if (!correctiveAction) {
        return res.status(400).json({ error: 'Impossible de clôturer une CAPA sans action corrective renseignée.' });
      }
      if (effectivenessVerified !== true) {
        return res
          .status(400)
          .json({ error: "Impossible de clôturer une CAPA dont l'efficacité de l'action corrective n'a pas été vérifiée." });
      }

      update.closed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('capas')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(CAPA_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'CAPA introuvable.' });
    }

    if (update.assigned_to) {
      notifyCapaAssigned(req.tenantId, data).catch((err) =>
        console.error("Échec de la notification d'assignation CAPA :", err.message)
      );
    }

    res.json(data);
  }
);

// POST /api/capas/:id/create-task — crée une tâche de suivi (module Planning) rattachée à cette
// CAPA. Une CAPA peut se décomposer en plusieurs tâches, chacune avec son propre responsable/
// échéance — contrairement au champ texte unique corrective_action. Volontairement minimal
// (titre + échéance) : l'édition complète (assigné, priorité, checklist, récurrence) se fait
// depuis Planning.jsx une fois la tâche créée, pas ici. Même garde que PATCH /:id ci-dessus : un
// member ne peut pas prolonger une CAPA après sa création.
router.post(
  '/:id/create-task',
  (req, res, next) => {
    if (req.userRole === 'member') {
      return res.status(403).json({
        error: 'Seuls les administrateurs et managers peuvent modifier une CAPA après sa création.',
      });
    }
    next();
  },
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('due_date').isISO8601().withMessage('Échéance invalide.'),
  ],
  async (req, res) => {
    const { data: capa, error: fetchError } = await supabase
      .from('capas')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !capa) {
      return res.status(404).json({ error: 'CAPA introuvable.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        tenant_id: req.tenantId,
        title: req.body.title,
        due_date: req.body.due_date,
        capa_id: capa.id,
        created_by: req.user.id,
      })
      .select('id, title, due_date, status')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la tâche.' });
    }

    res.status(201).json(data);
  }
);

// POST /api/capas/:id/create-pdca — lance un nouveau projet PDCA depuis cette CAPA et lie les
// deux dans les deux sens. Miroir exact de POST /api/pdca/:id/create-capa (routes/pdca.js), en
// sens inverse : une CAPA qui appelle un suivi plus structuré (plusieurs étapes) peut se
// prolonger en cycle Plan-Do-Check-Act plutôt que de rester un simple champ texte
// corrective_action/preventive_action. Pas de garde "déjà lié" ici non plus, par cohérence avec
// l'autre sens qui n'en a pas — un second appel écrase simplement l'ancien lien.
router.post(
  '/:id/create-pdca',
  (req, res, next) => {
    if (req.userRole === 'member') {
      return res.status(403).json({
        error: 'Seuls les administrateurs et managers peuvent modifier une CAPA après sa création.',
      });
    }
    next();
  },
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('target_date').optional({ values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
  ],
  async (req, res) => {
    const { data: capa, error: fetchError } = await supabase
      .from('capas')
      .select('id, number, title, service_id, description, corrective_action, preventive_action')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !capa) {
      return res.status(404).json({ error: 'CAPA introuvable.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    // plan_content par défaut : ce qui a déjà été décidé côté CAPA (actions corrective/
    // préventive), pour ne pas faire retaper la même chose dans le cycle PDCA — repli sur
    // description si aucune des deux actions n'est encore renseignée.
    const defaultPlanContent = [capa.corrective_action, capa.preventive_action].filter(Boolean).join('\n\n') || capa.description || null;

    const { data: pdca, error: pdcaError } = await supabase
      .from('pdca_projects')
      .insert({
        tenant_id: req.tenantId,
        title: req.body.title,
        description: `CAPA ${capa.number} — ${capa.title}`,
        service_id: capa.service_id || null,
        target_date: req.body.target_date || null,
        plan_content: defaultPlanContent,
        linked_capa_id: capa.id,
        created_by: req.user.id,
      })
      .select('id, title, status')
      .single();

    if (pdcaError) {
      return res.status(500).json({ error: 'Erreur lors de la création du projet PDCA.' });
    }

    const { error: linkError } = await supabase
      .from('capas')
      .update({ pdca_project_id: pdca.id })
      .eq('tenant_id', req.tenantId)
      .eq('id', capa.id);

    if (linkError) {
      console.error('Échec de la mise à jour de la CAPA après création du projet PDCA :', linkError.message);
    }

    res.status(201).json(pdca);
  }
);

// DELETE /api/capas/:id — supprime une CAPA (admin uniquement)
// DELETE /api/capas/bulk — suppression en masse. Placée avant DELETE /:id pour ne pas être
// capturée comme un id, même convention que /bulk-category.
router.delete(
  '/bulk',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une CAPA.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { error, count } = await supabase
      .from('capas')
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
  const { data, error } = await supabase
    .from('capas')
    .delete()
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .select('id')
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'CAPA introuvable.' });
  }

  res.status(204).end();
});

// POST /api/capas/:id/comments — ajoute un commentaire de suivi horodaté
router.post(
  '/:id/comments',
  [body('comment').trim().notEmpty().withMessage('Le commentaire ne peut pas être vide.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: capa, error: capaError } = await supabase
      .from('capas')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (capaError || !capa) {
      return res.status(404).json({ error: 'CAPA introuvable.' });
    }

    const { data, error } = await supabase
      .from('capa_comments')
      .insert({
        tenant_id: req.tenantId,
        capa_id: capa.id,
        user_id: req.user.id,
        comment: req.body.comment,
      })
      .select('*, author:users(id, full_name)')
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de l'ajout du commentaire." });
    }

    res.status(201).json(data);
  }
);

export default router;
