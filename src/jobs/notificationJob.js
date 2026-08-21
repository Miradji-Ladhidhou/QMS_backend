import cron from 'node-cron';
import { supabase } from '../services/supabase.js';
import { sendEmail } from '../services/email.js';
import { renderTemplate } from '../services/renderTemplate.js';
import {
  getUserEmail,
  getUserFullName,
  getNotificationPreferences,
  markNotificationSent,
  createInAppNotification,
} from '../services/notificationHelpers.js';

const REVIEW_WINDOW_DAYS = 30;
const CAPA_WINDOW_DAYS = 7;
const TRAINING_WINDOW_DAYS = 60;

function addDaysIso(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

// Le job ne tourne qu'une fois par jour : pour "weekly", on n'envoie que le lundi
// (les alertes du jour tiennent lieu d'"accumulation" de la semaine écoulée).
function isMonday() {
  return new Date().getDay() === 1;
}

async function getTenants() {
  const { data, error } = await supabase.from('tenants').select('id');
  if (error) throw new Error(`Impossible de récupérer les tenants : ${error.message}`);
  return data;
}

// Documents à réviser sous 30 jours — même fenêtre que GET /api/documents/alerts.
export async function getDocumentAlerts(tenantId) {
  const { data, error } = await supabase
    .from('documents')
    .select('id, number, title, review_date, created_by')
    .eq('tenant_id', tenantId)
    .not('review_date', 'is', null)
    .not('created_by', 'is', null)
    .lte('review_date', addDaysIso(REVIEW_WINDOW_DAYS));

  if (error) throw new Error(`Alertes documents : ${error.message}`);
  return data;
}

// CAPA en retard ou à échéance sous 7 jours, avec un responsable assigné.
export async function getCapaAlerts(tenantId) {
  const { data, error } = await supabase
    .from('capas')
    .select('id, number, title, due_date, status, assigned_to')
    .eq('tenant_id', tenantId)
    .not('due_date', 'is', null)
    .not('assigned_to', 'is', null)
    .not('status', 'eq', 'closed')
    .lte('due_date', addDaysIso(CAPA_WINDOW_DAYS));

  if (error) throw new Error(`Alertes CAPA : ${error.message}`);
  return data;
}

// Formations à renouveler sous 60 jours, à partir du dernier enregistrement par
// couple (formation, utilisateur) — même logique que GET /api/trainings/upcoming-renewals.
export async function getTrainingAlerts(tenantId) {
  const [{ data: records, error }, { data: exemptUsers, error: exemptError }] = await Promise.all([
    supabase
      .from('training_records')
      .select('training_id, user_id, completed_at, next_due_date, training:trainings(id, title)')
      .eq('tenant_id', tenantId)
      .not('next_due_date', 'is', null),
    supabase.from('users').select('id').eq('tenant_id', tenantId).eq('training_exempt', true),
  ]);

  if (error) throw new Error(`Alertes formations : ${error.message}`);
  if (exemptError) throw new Error(`Alertes formations : ${exemptError.message}`);

  const exemptUserIds = new Set((exemptUsers || []).map((user) => user.id));

  const latestByPair = new Map();
  for (const record of records) {
    if (record.user_id && exemptUserIds.has(record.user_id)) continue;
    const key = `${record.training_id}:${record.user_id}`;
    const existing = latestByPair.get(key);
    if (!existing || record.completed_at > existing.completed_at) {
      latestByPair.set(key, record);
    }
  }

  const windowEnd = addDaysIso(TRAINING_WINDOW_DAYS);
  return [...latestByPair.values()].filter((record) => record.next_due_date <= windowEnd);
}

// Envoie (ou pas) une alerte du batch quotidien pour un utilisateur donné :
// respecte l'interrupteur on/off, la fréquence choisie (weekly = lundi uniquement),
// et la déduplication du jour via notification_log.
async function maybeSendDigestItem({
  tenantId,
  userId,
  prefField,
  notificationType,
  referenceId,
  templateName,
  subject,
  variables,
  weeklyRunToday,
  notificationTitle,
  notificationMessage,
  notificationLink,
}) {
  const preferences = await getNotificationPreferences(userId);
  if (!preferences[prefField]) return;
  if (preferences.digest_frequency === 'weekly' && !weeklyRunToday) return;

  const shouldSend = await markNotificationSent({ tenantId, userId, notificationType, referenceId });
  if (!shouldSend) return;

  await createInAppNotification({
    tenantId,
    userId,
    type: notificationType,
    title: notificationTitle,
    message: notificationMessage,
    link: notificationLink,
  });

  const email = await getUserEmail(userId);
  if (!email) return;

  const fullName = await getUserFullName(userId);
  const html = renderTemplate(templateName, { userName: fullName, ...variables });

  try {
    await sendEmail(email, subject, html);
  } catch (err) {
    console.error(`[notificationJob] Échec de l'envoi (${notificationType}) :`, err.message);
  }
}

async function processTenant(tenantId) {
  const weeklyRunToday = isMonday();
  const frontendUrl = process.env.FRONTEND_URL;

  const [documentAlerts, capaAlerts, trainingAlerts] = await Promise.all([
    getDocumentAlerts(tenantId),
    getCapaAlerts(tenantId),
    getTrainingAlerts(tenantId),
  ]);

  for (const doc of documentAlerts) {
    await maybeSendDigestItem({
      tenantId,
      userId: doc.created_by,
      prefField: 'email_documents_to_review',
      notificationType: 'document_to_review',
      referenceId: doc.id,
      templateName: 'documentToReview',
      subject: `Document à réviser : ${doc.number}`,
      variables: {
        documentNumber: doc.number,
        documentTitle: doc.title,
        reviewDate: doc.review_date,
        documentUrl: `${frontendUrl}/documents/${doc.id}`,
      },
      weeklyRunToday,
      notificationTitle: 'Document à réviser',
      notificationMessage: `${doc.number} — ${doc.title}`,
      notificationLink: `/documents/${doc.id}`,
    });
  }

  for (const capa of capaAlerts) {
    await maybeSendDigestItem({
      tenantId,
      userId: capa.assigned_to,
      prefField: 'email_capa_overdue',
      notificationType: 'capa_overdue',
      referenceId: capa.id,
      templateName: 'capaOverdue',
      subject: `CAPA à traiter : ${capa.number}`,
      variables: {
        capaNumber: capa.number,
        capaTitle: capa.title,
        dueDate: capa.due_date,
        capaUrl: `${frontendUrl}/capas/${capa.id}`,
      },
      weeklyRunToday,
      notificationTitle: 'CAPA à traiter',
      notificationMessage: `${capa.number} — ${capa.title}`,
      notificationLink: `/capas/${capa.id}`,
    });
  }

  for (const record of trainingAlerts) {
    await maybeSendDigestItem({
      tenantId,
      userId: record.user_id,
      prefField: 'email_training_renewal',
      notificationType: 'training_renewal',
      referenceId: record.training_id,
      templateName: 'trainingRenewal',
      subject: `Formation à renouveler : ${record.training?.title || ''}`,
      variables: {
        trainingTitle: record.training?.title || '',
        dueDate: record.next_due_date,
        trainingUrl: `${frontendUrl}/trainings`,
      },
      weeklyRunToday,
      notificationTitle: 'Formation à renouveler',
      notificationMessage: record.training?.title || '',
      notificationLink: '/trainings',
    });
  }
}

// Exportée pour pouvoir être appelée manuellement (voir README / instructions de test) sans
// attendre 8h00 : node -e "import('./src/jobs/notificationJob.js').then(m => m.runNotificationJob())"
export async function runNotificationJob() {
  console.log(`[notificationJob] Démarrage — ${new Date().toISOString()}`);

  let tenants;
  try {
    tenants = await getTenants();
  } catch (err) {
    console.error('[notificationJob]', err.message);
    return;
  }

  for (const tenant of tenants) {
    try {
      await processTenant(tenant.id);
    } catch (err) {
      console.error(`[notificationJob] Erreur pour le tenant ${tenant.id} :`, err.message);
    }
  }

  console.log(`[notificationJob] Terminé — ${new Date().toISOString()}`);
}

export function scheduleNotificationJob() {
  cron.schedule('0 8 * * *', () => {
    runNotificationJob().catch((err) => console.error('[notificationJob] Échec :', err.message));
  });
  console.log('[notificationJob] Planifié tous les jours à 8h00.');
}
