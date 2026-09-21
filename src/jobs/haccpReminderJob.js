import cron from 'node-cron';
import { supabase } from '../services/supabase.js';
import { withJobRunTracking } from '../services/jobRunTracker.js';
import { sendImmediateNotification } from '../services/notificationHelpers.js';
import { fetchCcpStatuses, isWithinReminderHours } from '../services/haccpMonitoring.js';

// Rappel « relevé HACCP en retard » : chaque heure, pour chaque entreprise dont l'heure locale est dans la fenêtre
// de travail, les CCP des plans actifs dont le prochain relevé aurait dû être fait préviennent leur responsable
// (à défaut l'auteur du plan). Une notification par personne, par CCP et par jour (voir notification_log) : un
// relevé oublié se signale dès qu'il est en retard, sans harceler ensuite. Les dérives répétées, elles, sont
// signalées à l'enregistrement du relevé (routes/haccp.js).

// CCP en retard de relevé, avec la personne à prévenir. Exportée pour les tests.
export async function getOverdueReadingAlerts(tenantId, now = new Date()) {
  const ccps = await fetchCcpStatuses(tenantId, { activeOnly: true, now });
  return ccps
    .filter((ccp) => ccp.monitoring_state === 'overdue')
    .map((ccp) => ({ ccp, user_id: ccp.monitoring_responsible || ccp.plan.created_by }))
    .filter((alert) => alert.user_id);
}

function describeDelay(hours) {
  if (hours < 1) return 'moins d’une heure';
  const rounded = Math.round(hours);
  return `${rounded} heure${rounded > 1 ? 's' : ''}`;
}

export async function runHaccpReminderJob(now = new Date()) {
  const { data: tenants, error } = await supabase.from('tenants').select('id, timezone');
  if (error) throw new Error(`Impossible de récupérer les tenants : ${error.message}`);

  let sent = 0;
  for (const tenant of tenants) {
    if (!isWithinReminderHours(now, tenant.timezone)) continue;
    try {
      for (const { ccp, user_id: userId } of await getOverdueReadingAlerts(tenant.id, now)) {
        const label = ccp.ccp_number ? `CCP ${ccp.ccp_number}` : 'Point critique';
        const delay = describeDelay(ccp.overdue_hours);
        await sendImmediateNotification({
          tenantId: tenant.id,
          userId,
          prefField: 'email_haccp_alerts',
          notificationType: 'haccp_reading_overdue',
          referenceId: ccp.id,
          templateName: 'haccpAlert',
          subject: `HACCP : relevé en retard — ${label}`,
          variables: {
            heading: 'Relevé HACCP en retard',
            message: `Le relevé du ${label} (« ${ccp.hazard_description} », plan « ${ccp.plan.title} ») est en retard de ${delay}${ccp.monitoring_frequency ? ` (fréquence : ${ccp.monitoring_frequency})` : ''}.`,
            buttonLabel: 'Saisir le relevé',
            url: `${process.env.FRONTEND_URL}/haccp/today`,
          },
          notificationTitle: 'Relevé HACCP en retard',
          notificationMessage: `${label} — ${ccp.plan.title} (${delay} de retard)`,
          notificationLink: '/haccp/today',
        });
        sent += 1;
      }
    } catch (err) {
      console.error(`[haccpReminderJob] Erreur pour le tenant ${tenant.id} :`, err.message);
    }
  }
  console.log(`[haccpReminderJob] ${sent} rappel(s) traité(s).`);
  return { ok: tenants.length, total: tenants.length, sent };
}

// Toutes les heures, à la 5e minute (après les relevés faits « à l'heure pile »).
export function scheduleHaccpReminderJob() {
  cron.schedule('5 * * * *', () => {
    withJobRunTracking('haccpReminderJob', () => runHaccpReminderJob()).catch((err) => console.error('[haccpReminderJob] Échec :', err.message));
  });
  console.log('[haccpReminderJob] Rappels de relevé HACCP planifiés toutes les heures.');
}
