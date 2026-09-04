import { supabase } from './supabase.js';

// Photo chiffrée de l'état du SMQ, tenant-wide (pas de scope par service : une revue de
// direction concerne l'entreprise dans son ensemble) — utilisée pour figer le snapshot d'une
// revue de direction à sa clôture (voir schema.sql, management_reviews.snapshot) sans dépendre
// des fonctions de dashboard.js (qui, elles, gèrent le scope par service/rôle, un besoin
// différent). Volontairement indépendante plutôt que réutilisée : coupler ce module à
// dashboard.js risquerait de casser une route déjà testée pour un besoin qui n'est pas le sien.
const RENEWAL_WINDOW_DAYS = 60;
const DOCUMENT_REVIEW_WINDOW_DAYS = 30;

function isoDateInDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function countCapasByStatus(tenantId) {
  const { data, error } = await supabase.from('capas').select('status').eq('tenant_id', tenantId);
  const counts = { open: 0, in_progress: 0, pending_verification: 0, closed: 0, overdue: 0 };
  if (error || !data) return counts;
  for (const capa of data) {
    if (capa.status in counts) counts[capa.status] += 1;
  }
  return counts;
}

async function countAuditsByStatus(tenantId) {
  const { data, error } = await supabase.from('audits').select('status').eq('tenant_id', tenantId);
  const counts = { planned: 0, in_progress: 0, completed: 0, closed: 0 };
  if (error || !data) return counts;
  for (const audit of data) {
    if (audit.status in counts) counts[audit.status] += 1;
  }
  return counts;
}

async function countDocumentsToReview(tenantId) {
  const threshold = isoDateInDays(DOCUMENT_REVIEW_WINDOW_DAYS);
  const { count, error } = await supabase
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .not('review_date', 'is', null)
    .lte('review_date', threshold);
  return error ? 0 : count || 0;
}

// Même logique de déduplication (dernier enregistrement par formation/personne) que
// dashboard.js/planningItems.js — dupliquée ici plutôt qu'importée, ce module reste
// volontairement autonome (voir commentaire en tête de fichier).
async function countTrainingsToRenew(tenantId) {
  const { data, error } = await supabase
    .from('training_records')
    .select('training_id, user_id, employee_id, completed_at, next_due_date')
    .eq('tenant_id', tenantId);
  if (error || !data) return 0;

  const latestByPair = new Map();
  for (const record of data) {
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
    if (record.next_due_date && record.next_due_date <= threshold) count += 1;
  }
  return count;
}

// Même fenêtre que routes/dashboard.js#KPI_RECENT_WINDOW, Kpis.jsx et kpiReportPdf.js : le
// statut hors objectif reflète les relevés RÉCENTS, jamais toute la vie du KPI — sinon
// l'instantané d'une revue de direction pourrait contredire ce que montre l'app elle-même.
const KPI_RECENT_WINDOW = 6;

// Miroir de getKpiStatus (frontend/src/lib/kpiStatus.js), déjà dupliqué dans
// kpiReportPdf.js et dashboard.js pour la même raison.
async function countOffTargetKpis(tenantId) {
  const { data, error } = await supabase
    .from('kpis')
    .select('id, target, target_direction, records:kpi_records(period_date, value)')
    .eq('tenant_id', tenantId);
  if (error || !data) return 0;

  let count = 0;
  for (const kpi of data) {
    if (kpi.target === null || kpi.target === undefined || kpi.records.length === 0) continue;
    const recentValues = [...kpi.records]
      .sort((a, b) => (a.period_date < b.period_date ? -1 : 1))
      .slice(-KPI_RECENT_WINDOW)
      .map((r) => r.value);
    const average = recentValues.reduce((sum, value) => sum + value, 0) / recentValues.length;
    const meetsTarget = kpi.target_direction === 'max' ? average <= kpi.target : average >= kpi.target;
    if (!meetsTarget) count += 1;
  }
  return count;
}

export async function buildQmsSnapshot(tenantId) {
  const [capas, audits, documentsToReview, trainingsToRenew, kpisOffTarget] = await Promise.all([
    countCapasByStatus(tenantId),
    countAuditsByStatus(tenantId),
    countDocumentsToReview(tenantId),
    countTrainingsToRenew(tenantId),
    countOffTargetKpis(tenantId),
  ]);

  return {
    generated_at: new Date().toISOString(),
    capas,
    audits,
    documents: { to_review: documentsToReview },
    trainings: { to_renew: trainingsToRenew },
    kpis: { off_target: kpisOffTarget },
  };
}
