import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_ADDRESS = process.env.EMAIL_FROM || 'QMS SaaS <onboarding@resend.dev>';

// Fonction générique d'envoi — les prochains chantiers (rappels planifiés, préférences
// utilisateur) construisent le HTML via renderTemplate() puis appellent celle-ci.
export async function sendEmail(to, subject, htmlBody) {
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
