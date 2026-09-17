import { supabase } from './supabase.js';

// Enveloppe une exécution planifiée (voir jobs/*.js) et l'enregistre dans job_runs, pour que
// Super Admin sache si une tâche a échoué SANS éplucher les logs bruts de l'hébergeur (voir
// SystemTab côté frontend, routes/superAdmin.js#GET /job-runs). N'instrumente que
// scheduleXJob() — jamais runXJob() lui-même, appelé aussi par les tests et les invocations
// manuelles (voir les commentaires "node -e ..." dans chaque job), qui ne doivent jamais
// polluer cet historique.
//
// Transparent : ne change jamais ce que fn() retourne, ne avale jamais son erreur (toujours
// relancée après enregistrement) — le comportement existant de chaque scheduleXJob()
// (.catch(err => console.error(...))) reste identique, cette fonction s'insère juste avant.
//
// Un souci d'écriture dans job_runs (table absente en local avant migration, réseau...) ne doit
// jamais empêcher la tâche elle-même de s'exécuter ni faire perdre son résultat : chaque accès
// à job_runs est best-effort, entouré de son propre try/catch.
export async function withJobRunTracking(jobName, fn) {
  const startedAt = new Date();
  let runId = null;
  try {
    const { data } = await supabase
      .from('job_runs')
      .insert({ job_name: jobName, started_at: startedAt.toISOString(), status: 'running' })
      .select('id')
      .single();
    runId = data?.id ?? null;
  } catch (err) {
    console.error(`[jobRunTracker] Impossible d'enregistrer le démarrage de ${jobName} :`, err.message);
  }

  try {
    const result = await fn();
    if (runId) {
      try {
        await supabase
          .from('job_runs')
          .update({ finished_at: new Date().toISOString(), status: statusOf(result), summary: summarizeResult(result) })
          .eq('id', runId);
      } catch (err) {
        console.error(`[jobRunTracker] Impossible d'enregistrer la fin de ${jobName} :`, err.message);
      }
    }
    return result;
  } catch (err) {
    if (runId) {
      try {
        await supabase.from('job_runs').update({ finished_at: new Date().toISOString(), status: 'failed', error: err.message }).eq('id', runId);
      } catch (updateErr) {
        console.error(`[jobRunTracker] Impossible d'enregistrer l'échec de ${jobName} :`, updateErr.message);
      }
    }
    throw err;
  }
}

// 'partial' : le job n'a PAS levé d'exception (design "best-effort" assumé par chaque job — un
// tenant/une connexion en échec n'empêche jamais les suivants), mais tout n'a pas pu être
// traité. Distinct de 'failed' (le job entier a planté) : un support qui voit "partial" sait
// qu'il faut regarder le détail (quel tenant/quelle connexion), pas redémarrer le job.
function statusOf(result) {
  if (result && typeof result.ok === 'number' && typeof result.total === 'number' && result.ok < result.total) {
    return 'partial';
  }
  return 'success';
}

// Résumé générique : soit un texte fourni explicitement par le job (result.summary — utile pour
// un job qui ne traite pas une collection, voir backupJob.js), soit un compte { ok, total }
// d'éléments traités avec succès (convention suivie par la plupart des jobs, voir
// moduleKpiJob.js, dashboardSnapshotJob.js). Un job qui ne renvoie rien (undefined) obtient
// simplement un résumé vide — pas une erreur, ce n'est pas ce champ qui détermine le statut
// 'success'/'failed'/'partial' (voir statusOf ci-dessus).
function summarizeResult(result) {
  if (result && typeof result.summary === 'string') return result.summary;
  if (result && typeof result.ok === 'number' && typeof result.total === 'number') {
    return `${result.ok}/${result.total} traité(s) avec succès.`;
  }
  if (typeof result === 'string') return result;
  return null;
}
