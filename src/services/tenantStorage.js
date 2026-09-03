import { supabase } from './supabase.js';
import { refreshAccessTokenIfNeeded } from './googleDrive.js';

// Un navigateur choisit comment traiter un fichier téléchargé selon son content-type déclaré,
// pas son extension : un fichier HTML/SVG/JS uploadé avec ce content-type s'ouvrirait et
// s'exécuterait dans le navigateur au lieu de se télécharger — XSS stocké. On neutralise
// seulement ces types "actifs" en les stockant comme flux binaire générique (toujours
// téléchargé, jamais rendu/exécuté), sans bloquer l'upload lui-même. Même liste que
// routes/documents.js#ACTIVE_CONTENT_TYPES, extraite ici pour être réutilisée par tout upload
// de fichier tenant (voir routes/procedures.js — pièce jointe de version).
const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
]);

export function safeStorageContentType(mimetype) {
  return ACTIVE_CONTENT_TYPES.has(mimetype) ? 'application/octet-stream' : mimetype;
}

// Résout où un nouvel upload doit atterrir pour ce tenant. Ne retombe JAMAIS silencieusement
// sur Supabase si Google Drive est activé mais inutilisable (connexion révoquée, refresh en
// échec) : un repli silencieux disperserait les fichiers entre deux stockages sans que
// personne ne le remarque avant longtemps. err.driveConnectionError marque cette erreur pour
// que l'appelant renvoie un message actionnable ("reconnectez-vous") plutôt qu'un 500 générique.
// Extrait de routes/documents.js (module Documents) pour être réutilisé tel quel par tout
// module qui a besoin d'uploader un fichier vers le Drive du tenant (voir routes/procedures.js
// — pièce jointe de version), plutôt que de dupliquer cette logique sensible (rafraîchissement
// de token, invariant "jamais de repli silencieux").
export async function resolveTenantStorageProvider(tenantId) {
  const { data: settings } = await supabase
    .from('tenant_storage_settings')
    .select('storage_provider')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!settings || settings.storage_provider !== 'google_drive') {
    return { provider: 'supabase' };
  }

  const { data: connection, error } = await supabase
    .from('google_drive_connections')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error || !connection) {
    const err = new Error(
      "Google Drive est activé pour votre entreprise mais aucune connexion n'a été trouvée — reconnectez-vous depuis Paramètres > Documents."
    );
    err.driveConnectionError = true;
    throw err;
  }

  try {
    const accessToken = await refreshAccessTokenIfNeeded(connection);
    return { provider: 'google_drive', connection, accessToken };
  } catch (refreshError) {
    console.error('Échec du rafraîchissement du token Google Drive (upload) :', refreshError.message);
    const err = new Error(
      'La connexion Google Drive a expiré ou a été révoquée — reconnectez-vous depuis Paramètres > Documents.'
    );
    err.driveConnectionError = true;
    throw err;
  }
}
