import { formatReviewDate, ACTION_STATUS_LABELS } from './managementReviewContent.js';

// Contenu des emails de revue de direction : convocation (avec ordre du jour et invitation calendrier .ics) et
// envoi du compte rendu validé.

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

const paragraph = (text) => `<p style="margin: 0 0 14px; font-size: 14px; color: #334155; line-height: 1.5">${escapeHtml(text).replace(/\n/g, '<br />')}</p>`;
const subheading = (text) => `<h2 style="margin: 18px 0 6px; font-size: 14px; color: #0f172a">${escapeHtml(text)}</h2>`;
const list = (items, ordered = false) =>
  `<${ordered ? 'ol' : 'ul'} style="margin: 0 0 14px; padding-left: 20px; font-size: 14px; color: #334155; line-height: 1.6">${items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('')}</${ordered ? 'ol' : 'ul'}>`;

// Ordre du jour type d'une revue de direction (ISO 9001 §9.3.2 a à f), complété de ce que la revue connaît
// (revue précédente, période analysée).
export function buildAgenda({ review, previousReview }) {
  const openPrevious = previousReview ? previousReview.actions.filter((action) => !['done', 'cancelled'].includes(action.effective_status)).length : 0;
  return [
    previousReview
      ? `Suivi des actions de la revue précédente (${previousReview.title} : ${previousReview.actions.length} action(s), ${openPrevious} non soldée(s))`
      : 'Suivi des actions de la revue précédente',
    "Évolution des enjeux externes et internes pertinents pour le système de management de la qualité",
    `Performance du système${review.period_start && review.period_end ? ` sur la période du ${formatReviewDate(review.period_start)} au ${formatReviewDate(review.period_end)}` : ''} : satisfaction client, objectifs et indicateurs, audits, non-conformités et actions correctives, sorties non conformes, fournisseurs, accidents, compétences`,
    'Adéquation des ressources',
    'Efficacité des actions mises en œuvre face aux risques et opportunités',
    "Opportunités d'amélioration et décisions",
  ];
}

// Invitation calendrier (RFC 5545). Sans heure : événement sur la journée ; avec heure : heure locale « flottante »
// (sans fuseau), interprétée dans le fuseau de chacun — une revue se tient à un endroit précis, pas à un instant UTC.
export function buildIcs({ review, meetingTime, location, description, tenantName }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const compactDate = review.review_date.replace(/-/g, '');
  const escapeIcs = (text) => String(text ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//QMS SaaS//Revue de direction//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT', `UID:management-review-${review.id}@qms-saas`, `DTSTAMP:${stamp}`];

  if (meetingTime) {
    const [hours, minutes] = meetingTime.split(':').map(Number);
    const end = new Date(Date.UTC(2000, 0, 1, hours, minutes));
    end.setUTCHours(end.getUTCHours() + 2);
    const pad = (n) => String(n).padStart(2, '0');
    lines.push(`DTSTART:${compactDate}T${pad(hours)}${pad(minutes)}00`, `DTEND:${compactDate}T${pad(end.getUTCHours())}${pad(end.getUTCMinutes())}00`);
  } else {
    const nextDay = new Date(`${review.review_date}T12:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    lines.push(`DTSTART;VALUE=DATE:${compactDate}`, `DTEND;VALUE=DATE:${nextDay.toISOString().slice(0, 10).replace(/-/g, '')}`);
  }
  lines.push(`SUMMARY:${escapeIcs(`Revue de direction — ${review.title}`)}`);
  if (location) lines.push(`LOCATION:${escapeIcs(location)}`);
  lines.push(`DESCRIPTION:${escapeIcs(description)}`, `ORGANIZER;CN=${escapeIcs(tenantName || 'QMS SaaS')}:mailto:noreply@qms-saas.invalid`, 'END:VEVENT', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

export function buildConvocationBody({ review, previousReview, meetingTime, location, message, recipientName }) {
  const details = [
    `Date : ${formatReviewDate(review.review_date)}${meetingTime ? ` à ${meetingTime}` : ''}`,
    ...(location ? [`Lieu : ${location}`] : []),
    ...(review.participants ? [`Participants : ${review.participants}`] : []),
  ];
  return [
    paragraph(`Bonjour ${recipientName || ''},`.replace(' ,', ',')),
    paragraph(`Vous êtes convoqué(e) à la revue de direction « ${review.title} ».`),
    list(details),
    ...(message ? [paragraph(message)] : []),
    subheading('Ordre du jour'),
    list(buildAgenda({ review, previousReview }), true),
    paragraph("Une invitation calendrier est jointe à ce message. Les éléments d'entrée chiffrés seront présentés en séance."),
  ].join('');
}

export function buildMinutesBody({ review, recipientName, message }) {
  const decisions = review.actions.map((action) => {
    const owner = action.owner_user?.full_name ? ` — ${action.owner_user.full_name}` : '';
    const due = action.due_date ? `, échéance ${formatReviewDate(action.due_date)}` : '';
    return `${action.description}${owner}${due} (${ACTION_STATUS_LABELS[action.effective_status || action.status] || action.status})`;
  });
  return [
    paragraph(`Bonjour ${recipientName || ''},`.replace(' ,', ',')),
    paragraph(`Le compte rendu de la revue de direction « ${review.title} » du ${formatReviewDate(review.review_date)} est joint à ce message (PDF). Il a été validé et signé par la direction.`),
    ...(message ? [paragraph(message)] : []),
    ...(decisions.length > 0 ? [subheading('Actions décidées'), list(decisions)] : []),
  ].join('');
}
