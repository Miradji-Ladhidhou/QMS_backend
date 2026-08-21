import cron from 'node-cron';
import { supabase } from '../services/supabase.js';
import { refreshAccessTokenIfNeeded } from '../services/googleDrive.js';

// Rafraîchit préventivement chaque connexion Google Drive proche de l'expiration, pour que le
// prochain upload d'un tenant ne paie jamais la latence d'un aller-retour OAuth synchrone —
// refreshAccessTokenIfNeeded (documents.js) reste le filet de sécurité au moment de l'upload,
// ce job réduit juste la fréquence à laquelle ce filet doit réellement se déclencher. Aucun
// appel Drive n'est fait pour une connexion déjà valide : refreshAccessTokenIfNeeded se
// contente de la déchiffrer et de revenir immédiatement tant qu'il reste plus d'une minute
// avant expiration (voir googleDrive.js).
export async function runDriveTokenRefreshJob() {
  console.log(`[driveTokenRefreshJob] Démarrage — ${new Date().toISOString()}`);

  const { data: connections, error } = await supabase.from('google_drive_connections').select('*');
  if (error) {
    console.error('[driveTokenRefreshJob]', error.message);
    return;
  }

  for (const connection of connections) {
    try {
      await refreshAccessTokenIfNeeded(connection);
    } catch (err) {
      // Connexion révoquée ou refresh_token expiré côté Google : rien à faire ici, un tenant
      // ne doit jamais faire planter le traitement des autres. Le prochain upload de ce tenant
      // échouera avec le message clair déjà prévu (resolveTenantStorageProvider, documents.js).
      console.error(`[driveTokenRefreshJob] Échec pour le tenant ${connection.tenant_id} :`, err.message);
    }
  }

  console.log(`[driveTokenRefreshJob] Terminé — ${new Date().toISOString()}`);
}

// Toutes les 15 minutes : largement sous la marge de sécurité de refreshAccessTokenIfNeeded
// (1 minute) et la durée de vie typique d'un access_token Google (~1h) — un token n'est donc
// jamais qu'à quelques minutes d'avoir été vérifié quand un upload en a besoin.
export function scheduleDriveTokenRefreshJob() {
  cron.schedule('*/15 * * * *', () => {
    runDriveTokenRefreshJob().catch((err) => console.error('[driveTokenRefreshJob] Échec :', err.message));
  });
  console.log('[driveTokenRefreshJob] Planifié toutes les 15 minutes.');
}
