import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

const FROM_ADDRESS = process.env.EMAIL_FROM || 'QMS SaaS <onboarding@resend.dev>';
// Le "from" d'un envoi Gmail (API ou SMTP) doit correspondre au compte authentifié, sinon
// Gmail le rejette ou le réécrit — distinct de FROM_ADDRESS, pensé pour Resend.
const GMAIL_FROM_ADDRESS = process.env.MAIL_USER ? `QMS SaaS <${process.env.MAIL_USER}>` : FROM_ADDRESS;

const hasGmailApiCreds = Boolean(
  process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REFRESH_TOKEN
);
const hasResend = Boolean(process.env.RESEND_API_KEY);
const hasGmailSmtp = Boolean(process.env.MAIL_USER && process.env.MAIL_PASS);

// Résolution du transport — priorité automatique, sauf override explicite via EMAIL_TRANSPORT :
// 1. Gmail API (HTTPS, googleapis) — jamais bloqué par un hébergeur, contrairement au SMTP.
//    Réutilise le même identifiant OAuth que la sauvegarde Google Drive (un seul refresh
//    token, autorisé avec les scopes drive + gmail.send combinés).
// 2. Resend (HTTPS) — nécessite un domaine vérifié sur resend.com/domains pour sortir du mode
//    sandbox (sinon limité à l'adresse du compte).
// 3. SMTP Gmail — fonctionne en local, mais bloqué en sortie par la plupart des hébergeurs
//    cloud (constaté sur Render : les ports 587 et 465 restent tous les deux bloqués).
// 'local' (Mailpit, stack Supabase locale) ne se déclenche jamais automatiquement — seulement
// via EMAIL_TRANSPORT=local, pour ne pas solliciter de vraies boîtes pendant des tests répétés.
function resolveTransportMode() {
  if (process.env.EMAIL_TRANSPORT) return process.env.EMAIL_TRANSPORT;
  if (hasGmailApiCreds) return 'gmail-api';
  if (hasResend) return 'resend';
  if (hasGmailSmtp) return 'gmail';
  return 'resend';
}

const transportMode = resolveTransportMode();

const resend = hasResend ? new Resend(process.env.RESEND_API_KEY) : null;

const gmailSmtpTransport =
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

let gmailApiClient = null;
function getGmailApiClient() {
  if (gmailApiClient) return gmailApiClient;
  const auth = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  gmailApiClient = google.gmail({ version: 'v1', auth });
  return gmailApiClient;
}

// MailComposer construit le MIME (nodemailer sait le faire sans envoyer via SMTP) ; l'API
// Gmail attend ce MIME encodé en base64url comme corps de la requête.
async function sendViaGmailApi(to, subject, htmlBody) {
  const rawBuffer = await new Promise((resolve, reject) => {
    new MailComposer({ from: GMAIL_FROM_ADDRESS, to, subject, html: htmlBody }).compile().build((err, msg) => {
      if (err) reject(err);
      else resolve(msg);
    });
  });

  const gmail = getGmailApiClient();
  const sent = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: rawBuffer.toString('base64url') },
  });

  return { id: sent.data.id };
}

// Fonction générique d'envoi — les prochains chantiers (rappels planifiés, préférences
// utilisateur) construisent le HTML via renderTemplate() puis appellent celle-ci.
export async function sendEmail(to, subject, htmlBody) {
  // La suite de tests n'a pas de Mailpit ni de service externe fiable à disposition ; on
  // court-circuite l'envoi plutôt que d'en dépendre pendant les tests.
  if (process.env.NODE_ENV === 'test') {
    return { id: 'test-mode-skipped' };
  }

  if (transportMode === 'gmail-api') {
    return sendViaGmailApi(to, subject, htmlBody);
  }

  if (gmailSmtpTransport) {
    const info = await gmailSmtpTransport.sendMail({ from: GMAIL_FROM_ADDRESS, to, subject, html: htmlBody });
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
