import { supabase } from './supabase.js';
import { sendEmail } from './email.js';
import { renderTemplate } from './renderTemplate.js';

const DEFAULT_PREFERENCES = {
  email_documents_to_review: true,
  email_capa_overdue: true,
  email_training_renewal: true,
  email_approval_requests: true,
  email_procedure_review: true,
  digest_frequency: 'daily',
};

export async function getUserEmail(userId) {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data?.user?.email) return null;
  return data.user.email;
}

export async function getUserFullName(userId) {
  const { data } = await supabase.from('users').select('full_name').eq('id', userId).single();
  return data?.full_name || 'Utilisateur';
}

// Si l'utilisateur n'a jamais ouvert la page Paramètres > Notifications, aucune ligne
// n'existe encore : on applique les mêmes défauts que la route GET (tout activé, quotidien).
export async function getNotificationPreferences(userId) {
  const { data, error } = await supabase
    .from('user_notification_preferences')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) return DEFAULT_PREFERENCES;
  return data;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Journalise l'envoi dans notification_log ; la contrainte unique (user_id, notification_type,
// reference_id, sent_date) empêche physiquement un doublon le même jour pour la même alerte.
// Renvoie false si l'alerte a déjà été envoyée aujourd'hui (auquel cas il ne faut pas ré-envoyer).
export async function markNotificationSent({ tenantId, userId, notificationType, referenceId }) {
  const { error } = await supabase.from('notification_log').insert({
    tenant_id: tenantId,
    user_id: userId,
    notification_type: notificationType,
    reference_id: referenceId,
    sent_date: todayIso(),
  });

  if (!error) return true;
  if (error.code === '23505') return false;
  console.error(`[notifications] Échec de journalisation (${notificationType}) :`, error.message);
  return false;
}

// Notification visible dans l'app (cloche) — créée indépendamment du succès de l'email,
// et même si l'utilisateur n'a pas d'adresse email exploitable.
export async function createInAppNotification({ tenantId, userId, type, title, message, link }) {
  const { error } = await supabase.from('notifications').insert({
    tenant_id: tenantId,
    user_id: userId,
    type,
    title,
    message: message || null,
    link: link || null,
  });

  if (error) {
    console.error(`[notifications] Échec de création de la notification in-app (${type}) :`, error.message);
  }
}

// Envoi immédiat (assignation CAPA, demande d'approbation) : ne dépend pas de digest_frequency
// (ces évènements n'attendent jamais le batch quotidien), seulement de l'interrupteur on/off
// et de la déduplication du jour. Crée toujours la notification in-app ; l'email est en plus,
// tenté seulement si une adresse est disponible.
export async function sendImmediateNotification({
  tenantId,
  userId,
  prefField,
  notificationType,
  referenceId,
  templateName,
  subject,
  variables,
  notificationTitle,
  notificationMessage,
  notificationLink,
}) {
  const preferences = await getNotificationPreferences(userId);
  if (!preferences[prefField]) return;

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
    console.error(`[notifications] Échec de l'envoi immédiat (${notificationType}) :`, err.message);
  }
}
