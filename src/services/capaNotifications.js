import { sendImmediateNotification } from './notificationHelpers.js';

// Notification immédiate (n'attend pas le batch quotidien) quand une CAPA est assignée.
// Réutilise le toggle "email_capa_overdue" : le modèle de préférences (Chantier 3.2) n'a
// pas de case dédiée "assignation", et c'est la plus proche sémantiquement.
// Partagée par capas.js (POST/PATCH) et qqoqccp.js (POST /:id/create-capa) — déplacée ici
// plutôt que dupliquée, les deux points de création d'une CAPA assignée doivent notifier
// de la même façon.
export async function notifyCapaAssigned(tenantId, capa) {
  if (!capa.assigned_to) return;

  await sendImmediateNotification({
    tenantId,
    userId: capa.assigned_to,
    prefField: 'email_capa_overdue',
    notificationType: 'capa_assigned',
    referenceId: capa.id,
    templateName: 'capaOverdue',
    subject: `Une CAPA vous a été assignée : ${capa.number}`,
    variables: {
      capaNumber: capa.number,
      capaTitle: capa.title,
      dueDate: capa.due_date || '—',
      capaUrl: `${process.env.FRONTEND_URL}/capas/${capa.id}`,
    },
    notificationTitle: 'CAPA assignée',
    notificationMessage: `${capa.number} — ${capa.title}`,
    notificationLink: `/capas/${capa.id}`,
  });
}
