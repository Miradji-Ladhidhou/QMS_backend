import cron from 'node-cron';
import { runDatabaseBackup, cleanupOldBackups } from '../services/backupService.js';
import { withJobRunTracking } from '../services/jobRunTracker.js';

// Exportée (même convention que les autres jobs, voir notificationJob.js) pour pouvoir être
// appelée manuellement : node -e "import('./src/jobs/backupJob.js').then(m => m.runBackupJob())"
export async function runBackupJob() {
  const backup = await runDatabaseBackup();
  console.log(`[backupJob] Sauvegarde créée : ${backup.filename} (${backup.sizeBytes} octets)`);
  const cleanup = cleanupOldBackups();
  if (cleanup.deleted.length > 0) {
    console.log(`[backupJob] ${cleanup.deleted.length} sauvegarde(s) expirée(s) supprimée(s).`);
  }
  return { summary: `Sauvegarde créée : ${backup.filename} (${backup.sizeBytes} octets).` };
}

// Sauvegarde locale quotidienne à 2h — la copie sur Google Drive reste une action manuelle
// (bouton dédié dans /super-admin), pour ne pas dépendre d'une API externe dans un job planifié.
export function scheduleBackupJob() {
  cron.schedule('0 2 * * *', () => {
    withJobRunTracking('backupJob', runBackupJob).catch((err) => console.error('[backupJob] Échec de la sauvegarde automatique :', err.message));
  });
  console.log('[backupJob] Sauvegarde automatique planifiée tous les jours à 2h00.');
}
