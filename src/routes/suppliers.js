import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';
import {
  CRITERIA,
  documentState,
  evaluationState,
  isMoreLenient,
  loadSupplierSettings,
  mergeSettings,
  nextEvaluationDate as computeNextEvaluationDate,
  suggestDecision,
  validateSettingsInput,
  weightedScore,
} from '../services/supplierPolicy.js';
import { buildSuppliersSummary, scoreOf } from '../services/supplierSummary.js';
import { safeStorageContentType } from '../services/tenantStorage.js';
import { fetchTenantLogoBuffer } from '../services/tenantLogo.js';
import { buildSupplierPdf } from '../services/supplierPdf.js';
import { buildSupplierWord } from '../services/supplierWord.js';

const router = Router();

// Certificats et pièces : le fichier est facultatif (une référence et une date d'expiration suffisent à suivre un
// certificat) ; 15 Mo au plus, stocké dans le bucket des documents sous un chemin propre à l'entreprise et au fournisseur.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 }, defParamCharset: 'utf8' });
const STORAGE_BUCKET = 'qms-documents';
const DOCUMENT_KINDS = ['quality_certificate', 'food_safety_certificate', 'sanitary_approval', 'insurance', 'contract', 'other'];
const DOCUMENT_SELECT =
  'id, kind, title, reference, issuer, issued_on, expires_on, notes, file_name, file_path, created_at, updated_at, uploaded_by_user:users!supplier_documents_uploaded_by_fkey(id, full_name)';

// Le chemin de stockage ne quitte jamais le serveur : le client sait seulement qu'un fichier existe (`has_file`).
function presentDocument(document) {
  // eslint-disable-next-line no-unused-vars
  const { file_path: filePath, ...rest } = document;
  return { ...rest, has_file: Boolean(filePath), state: documentState(document.expires_on) };
}

const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];
const SUPPLIER_STATUSES = ['active', 'inactive', 'suspended'];
const EVALUATION_DECISIONS = ['maintained', 'under_watch', 'to_replace'];

router.use(requireAuth);
router.use(requireMenuVisible('suppliers'));

// L'alias de la relation module_categories est "folder", pas "category" : `suppliers` a sa
// propre colonne texte historique `category` (le type de fournisseur, ex. "Matières premières")
// — l'aliaser en "category" écraserait cette colonne dans le JSON renvoyé par PostgREST (deux
// clés identiques dans le même select, la dernière gagne), rendant le texte libre inaccessible
// et cassant l'affichage (un objet rendu là où le frontend attend une chaîne).
const SUPPLIER_SELECT =
  '*, service:services(id, name), owner_user:users!suppliers_owner_fkey(id, full_name), folder:categories(id, name, color, is_restricted, owner_user_id)';

// GET /api/suppliers — liste tenant-wide par défaut (transparence, comme audits/risks : un
// fournisseur n'est "possédé" par personne en particulier), sauf catégorie restreinte
// explicitement créée par l'admin (voir Paramètres > Catégories modules) — opt-in, ne change
// rien tant qu'aucune catégorie fournisseur n'est marquée restreinte.
router.get('/', async (req, res) => {
  let query = supabase.from('suppliers').select(SUPPLIER_SELECT).eq('tenant_id', req.tenantId).order('name', { ascending: true });

  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.service_id) query = query.eq('service_id', req.query.service_id);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les fournisseurs.' });
  }

  if (req.userRole === 'admin') {
    return res.json(data);
  }

  const viewable = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data, categoryKey: 'folder' });
  res.json(viewable);
});

// GET /api/suppliers/settings — réglages de l'évaluation des fournisseurs de l'entreprise (fréquence selon la
// criticité, seuils de décision, poids des critères), fusionnés avec les valeurs par défaut.
router.get('/settings', async (req, res) => {
  res.json(await loadSupplierSettings(supabase, req.tenantId));
});

// PATCH /api/suppliers/settings — admin uniquement. Corps complet (voir validateSettingsInput) : ces réglages
// s'appliquent aux évaluations à venir, jamais aux évaluations passées (leurs poids sont conservés avec elles).
router.patch('/settings', requireRole('admin'), async (req, res) => {
  const result = validateSettingsInput(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const { error } = await supabase.from('tenants').update({ supplier_settings: result.settings }).eq('id', req.tenantId);
  if (error) return res.status(500).json({ error: "Impossible d'enregistrer les réglages." });
  res.json(result.settings);
});

// GET /api/suppliers/summary — tableau de synthèse : note et décision les plus récentes de chaque fournisseur,
// évaluations en retard, fournisseurs critiques jamais évalués, surveillance qui dure, certificats échus ou qui expirent.
router.get('/summary', async (req, res) => {
  try {
    res.json(await buildSuppliersSummary({ tenantId: req.tenantId, viewer: { userId: req.user.id, userRole: req.userRole } }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/suppliers/:id — détail avec l'historique de ses évaluations, CAPA liée résolue.
router.get('/:id', async (req, res) => {
  const { data: supplier, error } = await supabase
    .from('suppliers')
    .select(SUPPLIER_SELECT)
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !supplier) {
    return res.status(404).json({ error: 'Fournisseur introuvable.' });
  }

  if (req.userRole !== 'admin') {
    const categoryAllowed = await hasGenericCategoryPermission({
      tenantId: req.tenantId,
      userId: req.user.id,
      userRole: req.userRole,
      categoryId: supplier.category_id,
      permission: 'view',
    });
    if (!categoryAllowed) {
      return res.status(404).json({ error: 'Fournisseur introuvable.' });
    }
  }

  const { data: evaluations, error: evaluationsError } = await supabase
    .from('supplier_evaluations')
    .select(
      '*, evaluator:users!supplier_evaluations_evaluated_by_fkey(id, full_name), linked_capa:capas!supplier_evaluations_linked_capa_id_fkey(id, number, title, status)'
    )
    .eq('tenant_id', req.tenantId)
    .eq('supplier_id', supplier.id)
    .order('evaluation_date', { ascending: false });

  if (evaluationsError) {
    return res.status(500).json({ error: 'Impossible de récupérer les évaluations de ce fournisseur.' });
  }

  const settings = await loadSupplierSettings(supabase, req.tenantId);
  const { data: documents } = await supabase.from('supplier_documents').select(DOCUMENT_SELECT).eq('tenant_id', req.tenantId).eq('supplier_id', supplier.id).order('expires_on', { ascending: true, nullsFirst: false });

  res.json({
    ...supplier,
    // `score` : la note affichée d'une évaluation — pondérée quand elle l'a été (poids conservés avec elle), sinon la moyenne d'origine.
    evaluations: evaluations.map((evaluation) => ({ ...evaluation, score: scoreOf(evaluation) })),
    documents: (documents || []).map(presentDocument),
    evaluation_state: evaluationState({ next_evaluation_date: supplier.next_evaluation_date, evaluationCount: evaluations.length }),
    policy: {
      thresholds: settings.thresholds,
      weights: settings.weights[supplier.criticality],
      frequency_months: settings.frequency_months[supplier.criticality],
      auto_suspend_on_replace: settings.auto_suspend_on_replace,
    },
    is_private_to_me: supplier.folder?.owner_user_id === req.user.id,
  });
});

// POST /api/suppliers — admin/manager uniquement : la gestion du référentiel fournisseurs est
// une activité de pilotage, comme Services/Personnel (services.js/employees.js).
router.post(
  '/',
  requireRole('admin', 'manager'),
  [
    body('name').trim().notEmpty().withMessage('Le nom du fournisseur est requis.'),
    body('category').optional({ values: 'falsy' }).trim(),
    body('contact_name').optional({ values: 'falsy' }).trim(),
    body('contact_email').optional({ values: 'falsy' }).trim(),
    body('contact_phone').optional({ values: 'falsy' }).trim(),
    body('criticality').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Criticité invalide.'),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('owner').optional({ values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
    body('next_evaluation_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date de revue invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('supplier'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      name,
      category,
      contact_name: contactName,
      contact_email: contactEmail,
      contact_phone: contactPhone,
      criticality,
      service_id: serviceId,
      owner,
      next_evaluation_date: nextEvaluationDate,
      category_id: categoryId,
    } = req.body;

    const { data, error } = await supabase
      .from('suppliers')
      .insert({
        tenant_id: req.tenantId,
        name,
        category: category || null,
        contact_name: contactName || null,
        contact_email: contactEmail || null,
        contact_phone: contactPhone || null,
        criticality: criticality || undefined,
        service_id: serviceId || null,
        owner: owner || null,
        next_evaluation_date: nextEvaluationDate || null,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select(SUPPLIER_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création du fournisseur.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/suppliers/bulk-category — déplace plusieurs fournisseurs d'un coup vers une
// catégorie. Placée avant PATCH /:id pour ne pas être capturée comme un id.
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un fournisseur.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('supplier'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('suppliers')
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

// PATCH /api/suppliers/:id — admin/manager uniquement.
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('name').optional().trim().notEmpty().withMessage('Le nom ne peut pas être vide.'),
    body('category').optional({ values: 'falsy' }).trim(),
    body('contact_name').optional({ values: 'falsy' }).trim(),
    body('contact_email').optional({ values: 'falsy' }).trim(),
    body('contact_phone').optional({ values: 'falsy' }).trim(),
    body('criticality').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Criticité invalide.'),
    body('status').optional().isIn(SUPPLIER_STATUSES).withMessage('Statut invalide.'),
    body('service_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('owner').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
    body('next_evaluation_date').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Date de revue invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('supplier'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of ['name', 'category', 'contact_name', 'contact_email', 'contact_phone', 'criticality', 'status', 'next_evaluation_date']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('service_id' in req.body) update.service_id = req.body.service_id || null;
    if ('owner' in req.body) update.owner = req.body.owner || null;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    // Changer la criticité change le rythme d'évaluation : la prochaine date se recalcule depuis la dernière
    // évaluation (sauf si cette même requête fixe la date à la main).
    if (update.criticality && !('next_evaluation_date' in req.body)) {
      const { data: last } = await supabase
        .from('supplier_evaluations')
        .select('evaluation_date')
        .eq('tenant_id', req.tenantId)
        .eq('supplier_id', req.params.id)
        .order('evaluation_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (last) update.next_evaluation_date = computeNextEvaluationDate(last.evaluation_date, update.criticality, await loadSupplierSettings(supabase, req.tenantId));
    }

    const { data, error } = await supabase
      .from('suppliers')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(SUPPLIER_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Fournisseur introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/suppliers/:id — admin/manager uniquement. Cascade sur les évaluations (voir
// schema.sql) ; les CAPA déjà créées à partir d'une évaluation survivent
// (supplier_evaluation_id passe à null, on delete set null).
// DELETE /api/suppliers/bulk — suppression en masse. Placée avant DELETE /:id pour ne pas
// être capturée comme un id, même convention que /bulk-category.
router.delete(
  '/bulk',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un fournisseur.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { error, count } = await supabase
      .from('suppliers')
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
  const { error, count } = await supabase.from('suppliers').delete({ count: 'exact' }).eq('tenant_id', req.tenantId).eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du fournisseur.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Fournisseur introuvable.' });
  }

  res.status(204).end();
});

async function resolveSupplier(req, res) {
  const { data: supplier, error } = await supabase
    .from('suppliers')
    .select('id, criticality, status')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.supplierId)
    .single();

  if (error || !supplier) {
    res.status(404).json({ error: 'Fournisseur introuvable.' });
    return null;
  }
  return supplier;
}

const EVALUATION_SELECT =
  '*, evaluator:users!supplier_evaluations_evaluated_by_fkey(id, full_name), linked_capa:capas!supplier_evaluations_linked_capa_id_fkey(id, number, title, status)';

// POST /api/suppliers/:supplierId/evaluations — admin/manager uniquement.
router.post(
  '/:supplierId/evaluations',
  requireRole('admin', 'manager'),
  [
    body('evaluation_date').isISO8601().withMessage("Date d'évaluation invalide."),
    body('quality_score').isInt({ min: 1, max: 5 }).withMessage('Note qualité invalide (1 à 5).'),
    body('delivery_score').isInt({ min: 1, max: 5 }).withMessage('Note délais invalide (1 à 5).'),
    body('price_score').isInt({ min: 1, max: 5 }).withMessage('Note prix invalide (1 à 5).'),
    body('responsiveness_score').isInt({ min: 1, max: 5 }).withMessage('Note réactivité invalide (1 à 5).'),
    body('decision').optional({ values: 'falsy' }).isIn(EVALUATION_DECISIONS).withMessage('Décision invalide.'),
    body('comment').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const supplier = await resolveSupplier(req, res);
    if (!supplier) return;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      evaluation_date: evaluationDate,
      quality_score: qualityScore,
      delivery_score: deliveryScore,
      price_score: priceScore,
      responsiveness_score: responsivenessScore,
      decision,
      comment,
    } = req.body;

    // Note pondérée d'après les poids de la criticité du fournisseur (réglages de l'entreprise) et décision que
    // l'application aurait proposée. Les poids en vigueur sont conservés avec l'évaluation : modifier les réglages
    // plus tard ne réécrit jamais l'historique.
    const settings = await loadSupplierSettings(supabase, req.tenantId);
    const weights = settings.weights[supplier.criticality];
    const weighted = weightedScore({ quality: qualityScore, delivery: deliveryScore, price: priceScore, responsiveness: responsivenessScore }, weights);
    const suggested = suggestDecision(weighted, settings.thresholds);
    const chosen = decision || 'maintained';

    // Une décision qui s'écarte de "maintenu" (sous surveillance / à remplacer) doit être
    // justifiée — sinon l'évaluation n'a aucune valeur de preuve pour la revue fournisseur
    // suivante. Même famille que le couple effectiveness_verified/notes sur les CAPA.
    if (chosen !== 'maintained' && !comment) {
      return res.status(400).json({ error: 'Justifiez cette décision par un commentaire.' });
    }
    // Idem pour une décision plus indulgente que celle proposée par les seuils (garder « maintenu » un fournisseur noté 1,8/5).
    if (isMoreLenient(chosen, suggested) && !comment) {
      return res.status(400).json({ error: `Cette décision est plus indulgente que celle proposée d'après la note (${weighted}/5) : justifiez-la par un commentaire.` });
    }

    const { data, error } = await supabase
      .from('supplier_evaluations')
      .insert({
        tenant_id: req.tenantId,
        supplier_id: supplier.id,
        evaluation_date: evaluationDate,
        quality_score: qualityScore,
        delivery_score: deliveryScore,
        price_score: priceScore,
        responsiveness_score: responsivenessScore,
        decision: decision || undefined,
        comment: comment || null,
        weighted_score: weighted,
        weights,
        suggested_decision: suggested,
        evaluated_by: req.user.id,
      })
      .select(EVALUATION_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de la création de l'évaluation." });
    }

    // Prochaine évaluation : datée depuis la dernière évaluation selon la criticité (et non plus saisie à la main) ;
    // « à remplacer » suspend le fournisseur si l'entreprise l'a choisi. Une évaluation antidatée (plus ancienne
    // que la dernière connue) ne change rien : elle complète l'historique sans rouvrir le suivi.
    const { data: newest } = await supabase
      .from('supplier_evaluations')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('supplier_id', supplier.id)
      .order('evaluation_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const supplierUpdate = {};
    if (newest?.id === data.id) {
      supplierUpdate.next_evaluation_date = computeNextEvaluationDate(String(evaluationDate).slice(0, 10), supplier.criticality, settings);
      if (chosen === 'to_replace' && settings.auto_suspend_on_replace && supplier.status === 'active') supplierUpdate.status = 'suspended';
      await supabase.from('suppliers').update(supplierUpdate).eq('tenant_id', req.tenantId).eq('id', supplier.id);
    }

    res.status(201).json({ ...data, score: weighted, supplier_update: supplierUpdate });
  }
);

// DELETE /api/suppliers/:supplierId/evaluations/:id — admin/manager uniquement. Pas de PATCH :
// une évaluation est un relevé daté (comme un training_record ou un kpi_record), on en ajoute
// une nouvelle plutôt que de réécrire l'historique.
router.delete('/:supplierId/evaluations/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('supplier_evaluations')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('supplier_id', req.params.supplierId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: "Erreur lors de la suppression de l'évaluation." });
  }
  if (!count) {
    return res.status(404).json({ error: 'Évaluation introuvable.' });
  }

  // La prochaine évaluation suivait l'évaluation supprimée : elle repart de la dernière évaluation restante.
  const [{ data: last }, { data: supplier }] = await Promise.all([
    supabase.from('supplier_evaluations').select('evaluation_date').eq('tenant_id', req.tenantId).eq('supplier_id', req.params.supplierId).order('evaluation_date', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('suppliers').select('criticality').eq('tenant_id', req.tenantId).eq('id', req.params.supplierId).maybeSingle(),
  ]);
  if (last && supplier) {
    await supabase
      .from('suppliers')
      .update({ next_evaluation_date: computeNextEvaluationDate(last.evaluation_date, supplier.criticality, await loadSupplierSettings(supabase, req.tenantId)) })
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.supplierId);
  }

  res.status(204).end();
});

// POST /api/suppliers/:supplierId/evaluations/:id/create-capa — crée une CAPA à partir d'une
// évaluation (typiquement quand decision = 'under_watch'/'to_replace') et lie les deux dans
// les deux sens. Même mécanique que les autres modules (audits/complaints/risks/reviews).
router.post(
  '/:supplierId/evaluations/:id/create-capa',
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
    const { data: evaluation, error: fetchError } = await supabase
      .from('supplier_evaluations')
      .select('id, supplier:suppliers(name)')
      .eq('tenant_id', req.tenantId)
      .eq('supplier_id', req.params.supplierId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !evaluation) {
      return res.status(404).json({ error: 'Évaluation introuvable.' });
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
        origin: `Évaluation fournisseur — ${evaluation.supplier?.name || ''}`,
        service_id: serviceId || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        supplier_evaluation_id: evaluation.id,
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
      .from('supplier_evaluations')
      .update({ linked_capa_id: capa.id })
      .eq('tenant_id', req.tenantId)
      .eq('id', evaluation.id);

    if (linkError) {
      console.error("Échec de la mise à jour de l'évaluation après création de la CAPA :", linkError.message);
    }

    res.status(201).json(capa);
  }
);

// --- Certificats et pièces d'un fournisseur --------------------------------------------------

// Fournisseur de l'entreprise, dans la vue de l'utilisateur (catégorie restreinte incluse) — `null` sinon.
async function findVisibleSupplier(req) {
  const { data } = await supabase.from('suppliers').select(SUPPLIER_SELECT).eq('tenant_id', req.tenantId).eq('id', req.params.id).maybeSingle();
  if (!data) return null;
  if (req.userRole === 'admin') return data;
  const allowed = await hasGenericCategoryPermission({ tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole, categoryId: data.category_id, permission: 'view' });
  return allowed ? data : null;
}

// Validateurs neufs à chaque appel (une chaîne express-validator se modifie en place : la version « partielle » du
// PATCH ne doit jamais rendre le titre facultatif à la création).
function documentValidators({ partial = false } = {}) {
  const title = body('title').trim().notEmpty().withMessage('Le titre est requis.').isLength({ max: 200 }).withMessage('Titre trop long (200 caractères maximum).');
  return [
    partial ? title.optional() : title,
    body('kind').optional({ values: 'falsy' }).isIn(DOCUMENT_KINDS).withMessage('Type de document invalide.'),
    body('reference').optional({ values: 'falsy' }).trim().isLength({ max: 100 }).withMessage('Référence trop longue (100 caractères maximum).'),
    body('issuer').optional({ values: 'falsy' }).trim().isLength({ max: 200 }).withMessage('Organisme trop long (200 caractères maximum).'),
    body('issued_on').optional({ values: 'falsy' }).isISO8601().withMessage('Date de délivrance invalide.'),
    body('expires_on').optional({ values: 'falsy' }).isISO8601().withMessage("Date d'expiration invalide."),
    body('notes').optional({ values: 'falsy' }).trim(),
  ];
}

async function storeDocumentFile(req, supplierId, file) {
  const safeName = file.originalname.replace(/[^\w.\-À-ÿ]+/g, '_').slice(-120);
  const path = `supplier-documents/${req.tenantId}/${supplierId}/${randomUUID()}-${safeName}`;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, file.buffer, { contentType: safeStorageContentType(file.mimetype), upsert: false });
  if (error) {
    console.error("Échec de l'upload d'un document fournisseur :", error);
    throw new Error("Échec de l'upload du fichier.");
  }
  return { file_path: path, file_name: file.originalname };
}

const removeStoredFile = (path) => (path ? supabase.storage.from(STORAGE_BUCKET).remove([path]).catch(() => {}) : Promise.resolve());

// POST /api/suppliers/:id/documents — ajoute un certificat ou une pièce (multipart : champs + fichier facultatif).
router.post('/:id/documents', requireRole('admin', 'manager'), upload.single('file'), documentValidators(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
  const supplier = await findVisibleSupplier(req);
  if (!supplier) return res.status(404).json({ error: 'Fournisseur introuvable.' });

  let file = {};
  if (req.file) {
    try {
      file = await storeDocumentFile(req, supplier.id, req.file);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  const { data, error } = await supabase
    .from('supplier_documents')
    .insert({
      tenant_id: req.tenantId,
      supplier_id: supplier.id,
      kind: req.body.kind || undefined,
      title: req.body.title,
      reference: req.body.reference || null,
      issuer: req.body.issuer || null,
      issued_on: req.body.issued_on || null,
      expires_on: req.body.expires_on || null,
      notes: req.body.notes || null,
      uploaded_by: req.user.id,
      ...file,
    })
    .select(DOCUMENT_SELECT)
    .single();
  if (error) {
    await removeStoredFile(file.file_path);
    return res.status(500).json({ error: 'Erreur lors de l’enregistrement du document.' });
  }
  res.status(201).json(presentDocument(data));
});

// PATCH /api/suppliers/:id/documents/:docId — métadonnées (titre, échéance...) ; le fichier a ses propres routes.
router.patch(
  '/:id/documents/:docId',
  requireRole('admin', 'manager'),
  documentValidators({ partial: true }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
    if (!(await findVisibleSupplier(req))) return res.status(404).json({ error: 'Fournisseur introuvable.' });

    const update = {};
    for (const field of ['kind', 'title', 'reference', 'issuer', 'issued_on', 'expires_on', 'notes']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('title' in update && !update.title) return res.status(400).json({ error: 'Le titre est requis.' });
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    if ('kind' in update && !update.kind) update.kind = 'other';

    const { data, error } = await supabase.from('supplier_documents').update(update).eq('tenant_id', req.tenantId).eq('supplier_id', req.params.id).eq('id', req.params.docId).select(DOCUMENT_SELECT).single();
    if (error || !data) return res.status(404).json({ error: 'Document introuvable.' });
    res.json(presentDocument(data));
  }
);

// PUT /api/suppliers/:id/documents/:docId/file — ajoute ou remplace le fichier (ex. certificat renouvelé).
router.put('/:id/documents/:docId/file', requireRole('admin', 'manager'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  if (!(await findVisibleSupplier(req))) return res.status(404).json({ error: 'Fournisseur introuvable.' });
  const { data: current } = await supabase.from('supplier_documents').select('id, file_path').eq('tenant_id', req.tenantId).eq('supplier_id', req.params.id).eq('id', req.params.docId).maybeSingle();
  if (!current) return res.status(404).json({ error: 'Document introuvable.' });

  let file;
  try {
    file = await storeDocumentFile(req, req.params.id, req.file);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const { data, error } = await supabase.from('supplier_documents').update(file).eq('id', current.id).select(DOCUMENT_SELECT).single();
  if (error) {
    await removeStoredFile(file.file_path);
    return res.status(500).json({ error: "Erreur lors de l'enregistrement du fichier." });
  }
  await removeStoredFile(current.file_path);
  res.json(presentDocument(data));
});

// GET /api/suppliers/:id/documents/:docId/download — lien de téléchargement à durée de vie courte (5 minutes).
router.get('/:id/documents/:docId/download', async (req, res) => {
  if (!(await findVisibleSupplier(req))) return res.status(404).json({ error: 'Fournisseur introuvable.' });
  const { data: document } = await supabase.from('supplier_documents').select('file_path, file_name').eq('tenant_id', req.tenantId).eq('supplier_id', req.params.id).eq('id', req.params.docId).maybeSingle();
  if (!document) return res.status(404).json({ error: 'Document introuvable.' });
  if (!document.file_path) return res.status(404).json({ error: 'Aucun fichier joint à ce document.' });
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(document.file_path, 300, { download: document.file_name || true });
  if (error || !data) return res.status(500).json({ error: 'Impossible de générer le lien de téléchargement.' });
  res.json({ url: data.signedUrl, file_name: document.file_name });
});

// DELETE /api/suppliers/:id/documents/:docId — supprime le document et son fichier.
router.delete('/:id/documents/:docId', requireRole('admin', 'manager'), async (req, res) => {
  if (!(await findVisibleSupplier(req))) return res.status(404).json({ error: 'Fournisseur introuvable.' });
  const { data: document } = await supabase.from('supplier_documents').select('id, file_path').eq('tenant_id', req.tenantId).eq('supplier_id', req.params.id).eq('id', req.params.docId).maybeSingle();
  if (!document) return res.status(404).json({ error: 'Document introuvable.' });
  const { error } = await supabase.from('supplier_documents').delete().eq('id', document.id);
  if (error) return res.status(500).json({ error: 'Erreur lors de la suppression du document.' });
  await removeStoredFile(document.file_path);
  res.status(204).end();
});

// --- Fiche imprimable ---------------------------------------------------------------------

async function loadSupplierExportData(req) {
  const supplier = await findVisibleSupplier(req);
  if (!supplier) return null;
  const [{ data: evaluations }, { data: documents }, settings, { data: tenant }] = await Promise.all([
    supabase
      .from('supplier_evaluations')
      .select(EVALUATION_SELECT)
      .eq('tenant_id', req.tenantId)
      .eq('supplier_id', supplier.id)
      .order('evaluation_date', { ascending: true })
      .order('created_at', { ascending: true }),
    supabase.from('supplier_documents').select(DOCUMENT_SELECT).eq('tenant_id', req.tenantId).eq('supplier_id', supplier.id).order('expires_on', { ascending: true, nullsFirst: false }),
    loadSupplierSettings(supabase, req.tenantId),
    supabase.from('tenants').select('name, logo_url, timezone').eq('id', req.tenantId).single(),
  ]);
  return {
    supplier,
    evaluations: (evaluations || []).map((evaluation) => ({ ...evaluation, score: scoreOf(evaluation) })),
    documents: (documents || []).map(presentDocument),
    policy: { thresholds: settings.thresholds, weights: settings.weights[supplier.criticality], frequency_months: settings.frequency_months[supplier.criticality] },
    tenantName: tenant?.name,
    tenantLogo: await fetchTenantLogoBuffer(tenant?.logo_url),
  };
}

const supplierFileName = (supplier, extension) => `fournisseur-${supplier.name.replace(/[^A-Za-z0-9À-ÿ_-]+/g, '_').slice(0, 60)}.${extension}`;

// GET /api/suppliers/:id/pdf et /word — fiche du fournisseur : identité, évaluations, évolution des notes, certificats.
router.get('/:id/pdf', async (req, res) => {
  const data = await loadSupplierExportData(req);
  if (!data) return res.status(404).json({ error: 'Fournisseur introuvable.' });
  const buffer = await buildSupplierPdf(data);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(supplierFileName(data.supplier, 'pdf'))}"`);
  res.send(buffer);
});

router.get('/:id/word', async (req, res) => {
  const data = await loadSupplierExportData(req);
  if (!data) return res.status(404).json({ error: 'Fournisseur introuvable.' });
  const buffer = await buildSupplierWord(data);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(supplierFileName(data.supplier, 'docx'))}"`);
  res.send(buffer);
});

export default router;
