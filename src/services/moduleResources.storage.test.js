import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { supabase } from './supabase.js';
import { DEFAULT_RESOURCE_GROUPS } from './moduleResourceDefaults.js';
import { readResourceCatalog, validateResourceGroups, writeResourceCatalog } from './moduleResources.js';

it('conserve les liens en base et refuse les versions périmées sans toucher au catalogue actif', async () => {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(process.env.SUPABASE_URL || '')) {
    throw new Error('Ce test de persistance nécessite une base Supabase locale.');
  }
  const key = `test_useful_links_${randomUUID()}`;
  try {
    const initial = await readResourceCatalog(supabase, key);
    expect(initial.updated_at).toBeNull();
    const groups = structuredClone(DEFAULT_RESOURCE_GROUPS);
    groups[0].resources.push({ label: 'Lien de test', source: 'Exemple', url: 'https://example.com/test' });
    const normalized = validateResourceGroups(groups).groups;
    const created = await writeResourceCatalog(supabase, { groups: normalized, updatedAt: null, actorId: null }, key);
    expect(created.error).toBeNull();
    const reloaded = await readResourceCatalog(supabase, key);
    expect(reloaded.groups[0].resources.at(-1).label).toBe('Lien de test');

    const duplicate = await writeResourceCatalog(supabase, { groups: normalized, updatedAt: null, actorId: null }, key);
    expect(duplicate.error.code).toBe('23505');

    reloaded.groups[0].resources.at(-1).label = 'Lien modifié';
    const modified = await writeResourceCatalog(supabase, {
      groups: reloaded.groups, updatedAt: reloaded.updated_at, actorId: null,
    }, key);
    expect(modified.error).toBeNull();
    expect(modified.data).not.toBeNull();
    const stale = await writeResourceCatalog(supabase, {
      groups: normalized, updatedAt: reloaded.updated_at, actorId: null,
    }, key);
    expect(stale.error).toBeNull();
    expect(stale.data).toBeNull();
    expect((await readResourceCatalog(supabase, key)).groups[0].resources.at(-1).label).toBe('Lien modifié');

    const current = await readResourceCatalog(supabase, key);
    current.groups[0].resources = [];
    const removed = await writeResourceCatalog(supabase, {
      groups: current.groups, updatedAt: current.updated_at, actorId: null,
    }, key);
    expect(removed.error).toBeNull();
    expect((await readResourceCatalog(supabase, key)).groups[0].resources).toEqual([]);
  } finally {
    const { error } = await supabase.from('platform_settings').delete().eq('key', key);
    if (error) throw new Error(`Impossible de nettoyer le réglage de test : ${error.message}`);
  }
});
