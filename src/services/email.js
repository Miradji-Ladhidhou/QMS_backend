import { Resend } from 'resend';
import nodemailer from 'nodemailer';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_ADDRESS = process.env.EMAIL_FROM || 'QMS SaaS <onboarding@resend.dev>';
// Le "from" d'un envoi Gmail SMTP doit correspondre au compte authentifié, sinon Gmail le
// rejette ou le réécrit — distinct de FROM_ADDRESS, pensé pour Resend.
const GMAIL_FROM_ADDRESS = process.env.MAIL_USER ? `QMS SaaS <${process.env.MAIL_USER}>` : FROM_ADDRESS;

// Transport d'email — 'gmail' (SMTP Gmail, MAIL_USER/MAIL_PASS) est le défaut : il envoie vers
// n'importe quel destinataire réel sans configuration supplémentaire. 'resend' reste disponible
// mais son mode sandbox refuse tout envoi hors de l'adresse du compte tant qu'aucun domaine n'est
// vérifié sur resend.com/domains. 'local' route vers Mailpit (stack Supabase locale, port SMTP
// 54325, consultable sur http://127.0.0.1:54324) — aucun envoi réel, pratique pour ne pas
// solliciter de vraies boîtes pendant des tests répétés.
const transportMode = process.env.EMAIL_TRANSPORT || 'gmail';

const gmailTransport =
  transportMode === 'gmail'
    ? nodemailer.createTransport({
        host: process.env.MAIL_HOST || 'smtp.gmail.com',
        port: Number(process.env.MAIL_PORT) || 587,
        secure: process.env.MAIL_SECURE === 'true',
        auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
      })
    : null;

const localTransport =
  transportMode === 'local'
    ? nodemailer.createTransport({ host: '127.0.0.1', port: 54325, secure: false, ignoreTLS: true })
    : null;

// Fonction générique d'envoi — les prochains chantiers (rappels planifiés, préférences
// utilisateur) construisent le HTML via renderTemplate() puis appellent celle-ci.
export async function sendEmail(to, subject, htmlBody) {
  // La suite de tests n'a pas de Mailpit ni de SMTP fiable à disposition ; on court-circuite
  // l'envoi plutôt que de dépendre du réseau/d'un service externe pendant les tests.
  if (process.env.NODE_ENV === 'test') {
    return { id: 'test-mode-skipped' };
  }

  if (gmailTransport) {
    const info = await gmailTransport.sendMail({ from: GMAIL_FROM_ADDRESS, to, subject, html: htmlBody });
    return { id: info.messageId };
  }

  if (localTransport) {
    const info = await localTransport.sendMail({ from: FROM_ADDRESS, to, subject, html: htmlBody });
    return { id: info.messageId };
  }

  if (!resend) {
    throw new Error("RESEND_API_KEY manquant : impossible d'envoyer un email.");
  }

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject,
    html: htmlBody,
  });

  if (error) {
    throw new Error(`Échec de l'envoi de l'email : ${error.message}`);
  }

  return data;
}
