import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { parseServiceIdsParam, fetchServiceUserIds, resolveServiceScope } from '../services/serviceScope.js';
import {
  fetchCapaItems,
  fetchDocumentItems,
  fetchTrainingItems,
  fetchTaskItems,
  fetchAuditItems,
  fetchComplaintItems,
  fetchRiskItems,
  fetchSupplierItems,
} from '../services/planningItems.js';
import { filterViewableByCategory } from '../middleware/genericCategoryPermissions.js';
import { filterViewableDocuments } from '../middleware/documentPermissions.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';

const router = Router();

// Mêmes fenêtres que documents.js (/alerts) et trainings.js (/upcoming-renewals), pour
// rester cohérent avec les indicateurs déjà affichés ailleurs dans l'application.
const RENEWAL_WINDOW_DAYS = 60;
const DOCUMENT_REVIEW_WINDOW_DAYS = 30;

router.use(requireAuth);
router.use(requireMenuVisible('dashboard'));

function isoDateInDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function countCapasByStatus(capas) {
  const counts = { open: 0, in_progress: 0, overdue: 0, closed: 0 };
  for (const capa of capas) {
    if (capa.status in counts) {
      counts[capa.status] += 1;
    }
  }
  return counts;
}

// userIds === null : pas de filtre (tout le tenant). userIds === [] : filtre vide (aucun
// utilisateur concerné, ex. manager sans service) — on court-circuite plutôt que d'envoyer
// un .in() vide dont le comportement varie selon le client.
async function countTrainingsToRenew(tenantId, userIds) {
  if (userIds && userIds.length === 0) return 0;

  let recordsQuery = supabase
    .from('training_records')
    .select('training_id, user_id, employee_id, completed_at, next_due_date')
    .eq('tenant_id', tenantId);

  if (userIds) {
    recordsQuery = recordsQuery.in('user_id', userIds);
  }

  const { data, error } = await recordsQuery;
  if (error || !data) return 0;

  const latestByPair = new Map();
  for (const record of data) {
    // employee_id en repli : sans lui, plusieurs salariés sans compte (user_id null)
    // s'écraseraient tous sur la même clé "training:null" et fausseraient le compte.
    const personKey = record.user_id ? `u:${record.user_id}` : `e:${record.employee_id}`;
    const key = `${record.training_id}:${personKey}`;
    const existing = latestByPair.get(key);
    if (!existing || record.completed_at > existing.completed_at) {
      latestByPair.set(key, record);
    }
  }

  const threshold = isoDateInDays(RENEWAL_WINDOW_DAYS);
  let count = 0;
  for (const record of latestByPair.values()) {
    if (record.next_due_date && record.next_due_date <= threshold) {
      count += 1;
    }
  }
  return count;
}

async function countDocumentsToReview(tenantId) {
  const threshold = isoDateInDays(DOCUMENT_REVIEW_WINDOW_DAYS);
  const { count, error } = await supabase
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .not('review_date', 'is', null)
    .lte('review_date', threshold);

  if (error) return 0;
  return count || 0;
}

// Miroir de getKpiStatus (frontend/src/lib/kpiStatus.js, dupliqué aussi dans
// kpiReportPdf.js) : un KPI est "hors objectif" si la moyenne de ses relevés ne respecte pas
// le sens de l'objectif (target_direction). Pas de service_id sur les KPI (voir schema.sql) :
// toujours tout le tenant, jamais scopé — comme documents.to_review. `preview` renvoie jusqu'à
// 3 KPI hors objectif avec leurs derniers points (mini-courbe côté dashboard) plutôt qu'un
// simple chiffre — même dataset déjà chargé pour calculer la moyenne, aucune requête en plus.
async function computeKpiSummary(tenantId) {
  const { data: kpis, error } = await supabase
    .from('kpis')
    .select('id, name, unit, target, target_direction, records:kpi_records(period_date, value)')
    .eq('tenant_id', tenantId);

  if (error || !kpis) return { offTarget: 0, preview: [] };

  const offTargetKpis = [];
  for (const kpi of kpis) {
    if (kpi.target === null || kpi.target === undefined || kpi.records.length === 0) continue;
    const average = kpi.records.reduce((sum, record) => sum + record.value, 0) / kpi.records.length;
    const meetsTarget = kpi.target_direction === 'max' ? average <= kpi.target : average >= kpi.target;
    if (!meetsTarget) {
      const sortedValues = [...kpi.records].sort((a, b) => (a.period_date < b.period_date ? -1 : 1)).map((r) => r.value);
      offTargetKpis.push({
        id: kpi.id,
        name: kpi.name,
        unit: kpi.unit,
        average: Number(average.toFixed(2)),
        sparkline: sortedValues.slice(-8),
      });
    }
  }

  return { offTarget: offTargetKpis.length, preview: offTargetKpis.slice(0, 3) };
}

// Actifs uniquement (voir haccp_plans.status) — jamais de notion de "en retard" pour un plan
// HACCP (pas d'échéance individuelle comme une CAPA/un document), contrairement aux autres
// widgets du dashboard. Scopé par service_id comme les autres outils dotés de ce champ.
async function countActiveHaccpPlans(tenantId, serviceIds) {
  let query = supabase.from('haccp_plans').select('status').eq('tenant_id', tenantId);
  if (serviceIds) query = query.in('service_id', serviceIds);

  const { data, error } = await query;
  if (error || !data) return 0;
  return data.filter((plan) => plan.status === 'active').length;
}

// Total "en retard" tous outils confondus (CAPA + documents + formations + tâches), en
// réutilisant les mêmes fonctions que /api/planning pour ne jamais afficher un chiffre qui
// contredirait le détail donné par la page Planning — voir services/planningItems.js.
function countOverdueItems(itemLists) {
  return itemLists.flat().filter((item) => item.is_overdue).length;
}

// Même principe pour les widgets par outil (audits/réclamations/risques/fournisseurs) :
// "active" = déjà filtré par la fonction fetchXItems correspondante (non clôturé/résolu avec
// une échéance), "overdue" = le sous-ensemble en retard — mêmes items que ceux listés dans
// /api/planning pour cet outil, jamais un chiffre recalculé indépendamment.
function countActiveAndOverdue(items) {
  return { active: items.length, overdue: items.filter((item) => item.is_overdue).length };
}

// Revues de direction non closes ("draft" = pas encore passée en "completed", voir
// schema.sql). Pas de service_id sur management_reviews : toujours tout le tenant, jamais
// scopé par service — comme documents/kpis. Pas de fetchManagementReviewItems dans
// planningItems.js (une revue de direction n'a pas d'échéance individuelle exploitée par le
// planning), donc une requête dédiée ici plutôt qu'une réutilisation.
async function countManagementReviewsDraft(tenantId) {
  const { count, error } = await supabase
    .from('management_reviews')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'draft');

  if (error) return 0;
  return count || 0;
}

// Métriques tenant entier (aucun filtre de service, vision "admin"), sans dépendre d'un
// utilisateur précis — réutilisée par la route pour la vue par défaut (serviceIds === null,
// voir plus bas) ET par dashboardSnapshotJob.js (aucun req.user disponible dans un job planifié).
// userRole: 'admin' fait passer filterViewableByCategory en accès total (comportement voulu :
// un instantané doit refléter la vérité tenant entier, pas la vue d'un manager en particulier).
async function computeTenantMetrics(tenantId) {
  const scopeUser = { userId: null, userRole: 'admin' };

  const { data: rawCapas, error: capasError } = await supabase
    .from('capas')
    .select('status, category_id, category:categories(id, is_restricted)')
    .eq('tenant_id', tenantId);
  if (capasError) throw new Error('Impossible de récupérer les CAPA.');
  const capas = await filterViewableByCategory({ ...scopeUser, items: rawCapas });

  const documentsToReview = await countDocumentsToReview(tenantId);
  const trainingsToRenew = await countTrainingsToRenew(tenantId, null);
  const kpiSummary = await computeKpiSummary(tenantId);
  const managementReviewsDraft = await countManagementReviewsDraft(tenantId);
  const haccpActivePlans = await countActiveHaccpPlans(tenantId, null);

  const [capaItems, documentItems, trainingItems, taskItems, auditItems, complaintItems, riskItems, supplierItems] = await Promise.all([
    fetchCapaItems(tenantId, { serviceIds: null, ...scopeUser }),
    fetchDocumentItems(tenantId),
    fetchTrainingItems(tenantId, { userIds: null }),
    fetchTaskItems(tenantId, scopeUser),
    fetchAuditItems(tenantId, { serviceIds: null, ...scopeUser }),
    fetchComplaintItems(tenantId, { serviceIds: null, ...scopeUser }),
    fetchRiskItems(tenantId, { serviceIds: null, ...scopeUser }),
    fetchSupplierItems(tenantId, { serviceIds: null, ...scopeUser }),
  ]);
  const overdueTotal = countOverdueItems([
    capaItems,
    documentItems,
    trainingItems,
    taskItems,
    auditItems,
    complaintItems,
    riskItems,
    supplierItems,
  ]);

  return {
    capas: countCapasByStatus(capas),
    documents: { to_review: documentsToReview },
    trainings: { to_renew: trainingsToRenew },
    kpis: { off_target: kpiSummary.offTarget, preview: kpiSummary.preview },
    audits: countActiveAndOverdue(auditItems),
    complaints: countActiveAndOverdue(complaintItems),
    risks: countActiveAndOverdue(riskItems),
    suppliers: countActiveAndOverdue(supplierItems),
    management_reviews: { draft: managementReviewsDraft },
    haccp: { active_plans: haccpActivePlans },
    overdue: { total: overdueTotal },
  };
}

// Delta simple entre deux objets de métriques (même forme que computeTenantMetrics), aplati en
// clés jointes par "." pour rester lisible côté frontend sans imbrication à reproduire
// manuellement (ex. "capas.open": 3, "audits.active": -1). Ignore les tableaux (kpis.preview) :
// une tendance n'a de sens que sur un nombre.
function diffMetrics(current, previous) {
  const trends = {};
  for (const [group, values] of Object.entries(current)) {
    if (typeof values !== 'object' || values === null || Array.isArray(values)) continue;
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'number') continue;
      const previousValue = previous?.[group]?.[key];
      if (typeof previousValue !== 'number') continue;
      trends[`${group}.${key}`] = value - previousValue;
    }
  }
  return trends;
}

export { computeTenantMetrics };

// GET /api/dashboard/stats — indicateurs agrégés {capas, documents, trainings, kpis, audits,
// complaints, risks, suppliers, management_reviews, haccp, overdue}, filtrage par service selon
// le rôle. ?service_id= accepte une ou plusieurs valeurs (répéter le paramètre :
// ?service_id=a&service_id=b), pour le sélecteur multi-services du dashboard.
// - admin : tout le tenant par défaut, filtrable ponctuellement via ?service_id=
// - manager : filtré automatiquement sur ses services (table user_services, prompt B2) si
//   aucun service_id n'est fourni ; un/des service_id explicites hors périmètre sont
//   autorisés (vue élargie ponctuelle) sans changer son filtrage par défaut aux prochains
//   appels — rien n'est mémorisé côté serveur, chaque appel est indépendant
// - member : uniquement ses propres CAPA/formations/audits (en tant qu'auditeur)/
//   réclamations (assignées)/risques (dont il est responsable), jamais de vue tenant ou
//   service (service_id est ignoré) ; documents.to_review, kpis.off_target,
//   suppliers.active/overdue et management_reviews.draft restent à 0 pour ce rôle — ces 4
//   outils n'ont pas de porteur individuel dans le schéma, pas de métrique personnelle à
//   calculer ici (mêmes widgets masqués côté frontend pour member)
router.get('/stats', async (req, res) => {
  const requestedServiceIds = parseServiceIdsParam(req.query.service_id);
  if (!requestedServiceIds) {
    return res.status(400).json({ error: 'Service invalide.' });
  }

  if (req.userRole === 'member') {
    const { data: rawCapas, error: capasError } = await supabase
      .from('capas')
      .select('status, category_id, category:categories(id, is_restricted)')
      .eq('tenant_id', req.tenantId)
      .eq('assigned_to', req.user.id);

    if (capasError) {
      return res.status(500).json({ error: 'Impossible de récupérer les statistiques.' });
    }

    // Une catégorie restreinte reste un vrai gate même pour l'assigné (voir capas.js) : sans ce
    // filtre, le compteur "mes CAPA" du dashboard afficherait un total supérieur à ce que la
    // liste elle-même montre, pour une CAPA assignée mais dont la catégorie a été refusée.
    const capas = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: rawCapas });

    const trainingsToRenew = await countTrainingsToRenew(req.tenantId, [req.user.id]);

    const [capaItems, trainingItems, taskItems, auditItems, complaintItems, riskItems] = await Promise.all([
      fetchCapaItems(req.tenantId, { assignedTo: req.user.id, userId: req.user.id, userRole: req.userRole }),
      fetchTrainingItems(req.tenantId, { userId: req.user.id }),
      fetchTaskItems(req.tenantId, { personalUserId: req.user.id, userId: req.user.id, userRole: req.userRole }),
      fetchAuditItems(req.tenantId, { leadAuditorId: req.user.id, userId: req.user.id, userRole: req.userRole }),
      fetchComplaintItems(req.tenantId, { assignedTo: req.user.id, userId: req.user.id, userRole: req.userRole }),
      fetchRiskItems(req.tenantId, { ownerId: req.user.id, userId: req.user.id, userRole: req.userRole }),
    ]);
    const overdueTotal = countOverdueItems([capaItems, trainingItems, taskItems, auditItems, complaintItems, riskItems]);

    return res.json({
      capas: countCapasByStatus(capas),
      documents: { to_review: 0 },
      trainings: { to_renew: trainingsToRenew },
      // Pas de vue personnelle pour les KPI (pas de porteur individuel, comme documents) :
      // 0 forcé ici, le widget correspondant reste masqué pour member côté frontend.
      kpis: { off_target: 0, preview: [] },
      // Audits/réclamations/risques : un member peut être personnellement auditeur/assigné/
      // responsable (voir fetchAuditItems/fetchComplaintItems/fetchRiskItems ci-dessus), donc
      // ces compteurs ont un sens même pour ce rôle — contrairement à documents/kpis.
      audits: countActiveAndOverdue(auditItems),
      complaints: countActiveAndOverdue(complaintItems),
      risks: countActiveAndOverdue(riskItems),
      // Fournisseurs/revues de direction/HACCP : pas de porteur individuel (comme
      // documents/kpis) — 0 forcé, widgets masqués pour member côté frontend.
      suppliers: { active: 0, overdue: 0 },
      management_reviews: { draft: 0 },
      haccp: { active_plans: 0 },
      overdue: { total: overdueTotal },
      // Pas de tendances pour member : la vue personnelle ne correspond à aucun instantané
      // (toujours tenant entier, voir computeTenantMetrics/dashboardSnapshotJob.js).
      trends: null,
    });
  }

  // admin / manager : détermine le(s) service(s) à filtrer — null signifie "tout le tenant".
  const serviceIds = await resolveServiceScope({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    requestedServiceIds,
  });

  let metrics;

  if (serviceIds === null) {
    // Vue non filtrée : entièrement calculée par computeTenantMetrics, réutilisée telle
    // quelle (même fonction que dashboardSnapshotJob.js) plutôt que dupliquée ici.
    try {
      metrics = await computeTenantMetrics(req.tenantId);
    } catch {
      return res.status(500).json({ error: 'Impossible de récupérer les statistiques.' });
    }
  } else {
    let capas = [];
    if (serviceIds.length > 0) {
      const { data, error } = await supabase
        .from('capas')
        .select('status, category_id, category:categories(id, is_restricted)')
        .eq('tenant_id', req.tenantId)
        .in('service_id', serviceIds);
      if (error) {
        return res.status(500).json({ error: 'Impossible de récupérer les statistiques.' });
      }
      // Même raisonnement que la branche member ci-dessus : un manager n'est plus exempté
      // d'une catégorie restreinte (voir capas.js), le compteur ne doit pas le contredire.
      capas = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
    }

    // Les documents n'ont pas de service_id (voir schema.sql) : aucun filtrage possible,
    // le compte reste celui du tenant entier quel que soit service_id.
    const documentsToReview = await countDocumentsToReview(req.tenantId);

    const trainingUserIds = await fetchServiceUserIds(req.tenantId, serviceIds);
    const trainingsToRenew = await countTrainingsToRenew(req.tenantId, trainingUserIds);
    const kpiSummary = await computeKpiSummary(req.tenantId);
    const managementReviewsDraft = await countManagementReviewsDraft(req.tenantId);
    const haccpActivePlans = await countActiveHaccpPlans(req.tenantId, serviceIds);

    const [capaItems, documentItems, trainingItems, taskItems, auditItems, complaintItems, riskItems, supplierItems] = await Promise.all([
      fetchCapaItems(req.tenantId, { serviceIds, userId: req.user.id, userRole: req.userRole }),
      fetchDocumentItems(req.tenantId),
      fetchTrainingItems(req.tenantId, { userIds: trainingUserIds }),
      fetchTaskItems(req.tenantId, { userId: req.user.id, userRole: req.userRole }),
      fetchAuditItems(req.tenantId, { serviceIds, userId: req.user.id, userRole: req.userRole }),
      fetchComplaintItems(req.tenantId, { serviceIds, userId: req.user.id, userRole: req.userRole }),
      fetchRiskItems(req.tenantId, { serviceIds, userId: req.user.id, userRole: req.userRole }),
      fetchSupplierItems(req.tenantId, { serviceIds, userId: req.user.id, userRole: req.userRole }),
    ]);
    const overdueTotal = countOverdueItems([
      capaItems,
      documentItems,
      trainingItems,
      taskItems,
      auditItems,
      complaintItems,
      riskItems,
      supplierItems,
    ]);

    metrics = {
      capas: countCapasByStatus(capas),
      documents: { to_review: documentsToReview },
      trainings: { to_renew: trainingsToRenew },
      kpis: { off_target: kpiSummary.offTarget, preview: kpiSummary.preview },
      audits: countActiveAndOverdue(auditItems),
      complaints: countActiveAndOverdue(complaintItems),
      risks: countActiveAndOverdue(riskItems),
      suppliers: countActiveAndOverdue(supplierItems),
      management_reviews: { draft: managementReviewsDraft },
      haccp: { active_plans: haccpActivePlans },
      overdue: { total: overdueTotal },
    };
  }

  // Tendances : uniquement sur la vue non filtrée (les instantanés sont toujours tenant
  // entier, voir dashboard_metric_snapshots) — l'instantané le plus proche d'il y a 30 jours,
  // sans exiger exactement 30 jours pile (order by + limit 1 prend le plus récent avant ce
  // seuil). null tant qu'aucun instantané assez ancien n'existe (les 30 premiers jours après
  // la mise en place du job planifié).
  let trends = null;
  if (serviceIds === null) {
    const cutoff = isoDateInDays(-30);
    const { data: snapshot } = await supabase
      .from('dashboard_metric_snapshots')
      .select('metrics')
      .eq('tenant_id', req.tenantId)
      .lte('snapshot_date', cutoff)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (snapshot) trends = diffMetrics(metrics, snapshot.metrics);
  }

  res.json({ ...metrics, trends });
});

// 'created' si mis à jour dans la minute suivant sa création (jamais modifié depuis, à
// quelques secondes près), 'updated' sinon — pas un vrai verbe d'action par utilisateur (voir
// le contexte du plan : aucun journal d'actions unifié n'existe entre modules), juste de quoi
// distinguer visuellement une création d'une modification dans le flux.
function inferAction(item) {
  return new Date(item.updated_at) - new Date(item.created_at) < 60_000 ? 'created' : 'updated';
}

const RECENT_ACTIVITY_PER_MODULE = 8;
const RECENT_ACTIVITY_TOTAL = 8;

// GET /api/dashboard/recent-activity — les éléments les plus récemment créés/modifiés parmi
// CAPA/audits/réclamations/risques/documents/plans HACCP (les modules avec un titre lisible et
// un cycle de vie clair), tous rôles confondus dans la requête mais visibilité filtrée EXACTEMENT
// comme la liste de chaque module (filterViewableByCategory / filterViewableDocuments, mêmes
// fonctions que GET /api/capas, /api/documents, etc.) — jamais un raccourci qui montrerait plus
// que ce que l'utilisateur verrait sur la page de la liste elle-même. Réservé à admin/manager,
// comme le panneau "Filtrer par service" (un member n'a pas de vue d'ensemble de l'entreprise).
router.get('/recent-activity', requireRole('admin', 'manager'), async (req, res) => {
  const scopeUser = { userId: req.user.id, userRole: req.userRole };

  const [rawCapas, rawAudits, rawComplaints, rawRisks, rawDocuments, rawHaccpPlans] = await Promise.all([
    supabase
      .from('capas')
      .select('id, number, title, created_at, updated_at, category_id, category:categories(id, is_restricted)')
      .eq('tenant_id', req.tenantId)
      .order('updated_at', { ascending: false })
      .limit(RECENT_ACTIVITY_PER_MODULE),
    supabase
      .from('audits')
      .select('id, title, created_at, updated_at, category_id, category:categories(id, is_restricted)')
      .eq('tenant_id', req.tenantId)
      .order('updated_at', { ascending: false })
      .limit(RECENT_ACTIVITY_PER_MODULE),
    supabase
      .from('complaints')
      .select('id, customer_name, created_at, updated_at, category_id, category:categories(id, is_restricted)')
      .eq('tenant_id', req.tenantId)
      .order('updated_at', { ascending: false })
      .limit(RECENT_ACTIVITY_PER_MODULE),
    supabase
      .from('risks')
      .select('id, title, created_at, updated_at, category_id, category:categories(id, is_restricted)')
      .eq('tenant_id', req.tenantId)
      .order('updated_at', { ascending: false })
      .limit(RECENT_ACTIVITY_PER_MODULE),
    supabase
      .from('documents')
      .select('id, number, title, created_at, updated_at, category_id, category:document_categories(id, is_restricted)')
      .eq('tenant_id', req.tenantId)
      .order('updated_at', { ascending: false })
      .limit(RECENT_ACTIVITY_PER_MODULE),
    supabase
      .from('haccp_plans')
      .select('id, title, created_at, updated_at, category_id, category:categories(id, is_restricted)')
      .eq('tenant_id', req.tenantId)
      .order('updated_at', { ascending: false })
      .limit(RECENT_ACTIVITY_PER_MODULE),
  ]);

  const [capas, audits, complaints, risks, haccpPlans] = await Promise.all(
    [rawCapas, rawAudits, rawComplaints, rawRisks, rawHaccpPlans].map(({ data }) =>
      filterViewableByCategory({ ...scopeUser, items: data || [] })
    )
  );
  const documents = await filterViewableDocuments({
    tenantId: req.tenantId,
    ...scopeUser,
    documents: rawDocuments.data || [],
  });

  function toEntry(item, module, label, link) {
    return { module, id: item.id, label, link, timestamp: item.updated_at, action: inferAction(item) };
  }

  const items = [
    ...capas.map((item) => toEntry(item, 'capas', `${item.number ? `${item.number} — ` : ''}${item.title}`, `/capas/${item.id}`)),
    ...audits.map((item) => toEntry(item, 'audits', item.title, `/audits/${item.id}`)),
    ...complaints.map((item) => toEntry(item, 'complaints', `Réclamation — ${item.customer_name}`, `/complaints/${item.id}`)),
    ...risks.map((item) => toEntry(item, 'risks', item.title, `/risks/${item.id}`)),
    ...documents.map((item) => toEntry(item, 'documents', `${item.number} — ${item.title}`, `/documents/${item.id}`)),
    ...haccpPlans.map((item) => toEntry(item, 'haccp', item.title, `/haccp/${item.id}`)),
  ];

  items.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  res.json(items.slice(0, RECENT_ACTIVITY_TOTAL));
});

export default router;
