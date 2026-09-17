import { describe, it, expect, afterEach } from 'vitest';
import { admin } from '../test-utils/tenant.js';
import { withJobRunTracking } from './jobRunTracker.js';

// job_runs n'a pas de tenant_id (table plateforme) : le nettoyage se fait par job_name, pas par
// tenant comme le reste de la suite — chaque test utilise un nom de job unique pour ne jamais
// interférer avec un autre test lancé en parallèle (voir la suite complète, déjà connue pour
// exécuter plusieurs fichiers de front simultanément).
const cleanupJobNames = [];

afterEach(async () => {
  if (cleanupJobNames.length) {
    await admin.from('job_runs').delete().in('job_name', cleanupJobNames);
    cleanupJobNames.length = 0;
  }
});

function uniqueJobName(base) {
  const name = `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  cleanupJobNames.push(name);
  return name;
}

async function latestRun(jobName) {
  const { data } = await admin.from('job_runs').select('*').eq('job_name', jobName).order('started_at', { ascending: false }).limit(1).single();
  return data;
}

describe('withJobRunTracking', () => {
  it('enregistre un run réussi (ok === total) avec un résumé, et renvoie le résultat de fn tel quel', async () => {
    const jobName = uniqueJobName('test-success');
    const result = await withJobRunTracking(jobName, async () => ({ ok: 5, total: 5 }));
    expect(result).toEqual({ ok: 5, total: 5 });

    const run = await latestRun(jobName);
    expect(run.status).toBe('success');
    expect(run.summary).toBe('5/5 traité(s) avec succès.');
    expect(run.finished_at).not.toBeNull();
    expect(run.error).toBeNull();
  });

  it('enregistre un run partiel (ok < total) sans lever d’exception', async () => {
    const jobName = uniqueJobName('test-partial');
    await withJobRunTracking(jobName, async () => ({ ok: 3, total: 5 }));

    const run = await latestRun(jobName);
    expect(run.status).toBe('partial');
    expect(run.summary).toBe('3/5 traité(s) avec succès.');
  });

  it('enregistre un run en échec avec le message d’erreur, et relance l’exception vers l’appelant', async () => {
    const jobName = uniqueJobName('test-failed');
    await expect(
      withJobRunTracking(jobName, async () => {
        throw new Error('Panne simulée du service externe');
      })
    ).rejects.toThrow('Panne simulée du service externe');

    const run = await latestRun(jobName);
    expect(run.status).toBe('failed');
    expect(run.error).toBe('Panne simulée du service externe');
    expect(run.finished_at).not.toBeNull();
  });

  it('accepte un résumé personnalisé (result.summary) plutôt que le format { ok, total }', async () => {
    const jobName = uniqueJobName('test-custom-summary');
    await withJobRunTracking(jobName, async () => ({ summary: 'Sauvegarde créée : backup-2026.sql (1234 octets).' }));

    const run = await latestRun(jobName);
    expect(run.status).toBe('success');
    expect(run.summary).toBe('Sauvegarde créée : backup-2026.sql (1234 octets).');
  });

  it('un job sans valeur de retour est quand même enregistré comme réussi, avec un résumé vide', async () => {
    const jobName = uniqueJobName('test-void');
    await withJobRunTracking(jobName, async () => undefined);

    const run = await latestRun(jobName);
    expect(run.status).toBe('success');
    expect(run.summary).toBeNull();
  });
});
