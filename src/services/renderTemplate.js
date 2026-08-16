import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

// Remplace les {{placeholders}} d'un template HTML par les valeurs fournies.
// Pas de moteur de template externe : les emails sont peu nombreux et le besoin
// se limite à de l'interpolation simple.
export function renderTemplate(templateName, variables = {}) {
  const filePath = join(TEMPLATES_DIR, `${templateName}.html`);
  let html = readFileSync(filePath, 'utf-8');

  for (const [key, value] of Object.entries(variables)) {
    html = html.replaceAll(`{{${key}}}`, value ?? '');
  }

  return html;
}
