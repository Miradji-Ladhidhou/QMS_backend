import { supabase } from './supabase.js';

const LOGO_BUCKET = 'tenant-logos';

// Récupère les octets du logo pour l'incruster dans un PDF (pdfkit prend un buffer ou un
// chemin de fichier, jamais une URL publique) — retourne null si aucun logo n'est configuré
// ou si le téléchargement échoue, pour que l'appelant se rabatte simplement sur l'en-tête
// texte seul plutôt que de faire échouer toute la génération du rapport.
export async function fetchTenantLogoBuffer(logoPath) {
  if (!logoPath) return null;

  const { data, error } = await supabase.storage.from(LOGO_BUCKET).download(logoPath);
  if (error || !data) return null;

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
