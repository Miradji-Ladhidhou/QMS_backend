import { supabase } from './supabase.js';

// Le poste (job_title) est un texte libre saisi sur les comptes et sur le personnel sans compte ; une formation
// obligatoire pour un poste (trainings.required_job_titles) le retrouve sans tenir compte de la casse ni des
// espaces. Ce module recense les postes déjà utilisés pour les proposer à la saisie (une seule graphie par poste,
// donc moins de doublons du type « Cariste » / « cariste ») et dit combien de formations chacun rend obligatoires.

export const normalizeJobTitle = (title) => String(title || '').trim().toLowerCase();

// Postes du tenant : [{ title, people, trainings: [{ id, title }] }] triés par nom. `title` = la graphie la plus
// utilisée (à égalité, la première rencontrée). `general_trainings` = formations sans restriction de poste (elles
// concernent tout le monde).
export async function fetchJobTitles(tenantId) {
  const [{ data: users }, { data: employees }, { data: trainings }] = await Promise.all([
    supabase.from('users').select('job_title').eq('tenant_id', tenantId).not('job_title', 'is', null),
    supabase.from('employees').select('job_title').eq('tenant_id', tenantId).eq('is_active', true).not('job_title', 'is', null),
    supabase.from('trainings').select('id, title, required_job_titles').eq('tenant_id', tenantId),
  ]);

  const entries = new Map(); // clé normalisée -> { spellings: Map(graphie -> nombre), people, trainings: [] }
  const entryFor = (title) => {
    const key = normalizeJobTitle(title);
    if (!key) return null;
    if (!entries.has(key)) entries.set(key, { spellings: new Map(), people: 0, trainings: [] });
    return entries.get(key);
  };

  for (const row of [...(users || []), ...(employees || [])]) {
    const entry = entryFor(row.job_title);
    if (!entry) continue;
    const spelling = row.job_title.trim();
    entry.spellings.set(spelling, (entry.spellings.get(spelling) || 0) + 1);
    entry.people += 1;
  }

  const generalTrainings = [];
  for (const training of trainings || []) {
    const required = Array.isArray(training.required_job_titles) ? training.required_job_titles : [];
    if (required.length === 0) {
      generalTrainings.push({ id: training.id, title: training.title });
      continue;
    }
    for (const title of required) {
      const entry = entryFor(title);
      if (!entry) continue;
      const spelling = String(title).trim();
      if (!entry.spellings.has(spelling)) entry.spellings.set(spelling, 0);
      if (!entry.trainings.some((item) => item.id === training.id)) entry.trainings.push({ id: training.id, title: training.title });
    }
  }

  const jobTitles = [...entries.values()]
    .map((entry) => ({
      title: [...entry.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0],
      people: entry.people,
      trainings: entry.trainings.sort((a, b) => a.title.localeCompare(b.title, 'fr')),
    }))
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'));

  return { job_titles: jobTitles, general_trainings: generalTrainings.sort((a, b) => a.title.localeCompare(b.title, 'fr')) };
}
