import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
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

const router = Router();

// Mêmes fenêtres que documents.js (/alerts) et trainings.js (/upcoming-renewals), pour
// rester cohérent avec les indicateurs déjà affichés ailleurs dans l'application.
const RENEWAL_WINDOW_DAYS = 60;
const DOCUMENT_REVIEW_WINDOW_DAYS = 30;

router.use(requireAuth);

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
    });
  }

  // admin / manager : détermine le(s) service(s) à filtrer — null signifie "tout le tenant".
  const serviceIds = await resolveServiceScope({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    requestedServiceIds,
  });

  let capas = [];
  if (!serviceIds || serviceIds.length > 0) {
    let capasQuery = supabase.from('capas').select('status, category_id, category:categories(id, is_restricted)').eq('tenant_id', req.tenantId);
    if (serviceIds) {
      capasQuery = capasQuery.in('service_id', serviceIds);
    }
    const { data, error } = await capasQuery;
    if (error) {
      return res.status(500).json({ error: 'Impossible de récupérer les statistiques.' });
    }
    // Même raisonnement que la branche member ci-dessus : un manager n'est plus exempté d'une
    // catégorie restreinte (voir capas.js), le compteur ne doit pas le contredire.
    capas = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  }

  // Les documents n'ont pas de service_id (voir schema.sql) : aucun filtrage possible,
  // le compte reste celui du tenant entier quel que soit service_id.
  const documentsToReview = await countDocumentsToReview(req.tenantId);

  const trainingUserIds = serviceIds ? await fetchServiceUserIds(req.tenantId, serviceIds) : null;
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

  res.json({
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
  });
});

export default router;
