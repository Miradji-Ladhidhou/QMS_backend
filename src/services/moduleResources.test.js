import { describe, expect, it } from 'vitest';
import { DEFAULT_RESOURCE_GROUPS } from './moduleResourceDefaults.js';
import { readResourceCatalog, validateResourceGroups } from './moduleResources.js';

const copyGroups = () => structuredClone(DEFAULT_RESOURCE_GROUPS);

describe('Catalogue des liens utiles', () => {
  it('couvre les 21 modules avec deux liens initiaux par rubrique', () => {
    const expected = [
      'dashboard', 'planning', 'documents', 'capas', 'complaints', 'trainings', 'kpis',
      'qqoqccp', 'audits', 'risks', 'haccp', 'suppliers', 'management-reviews',
      'procedures', 'accidents', 'pdca', 'nonconforming-outputs', 'customer-satisfaction',
      'my-approvals', 'services', 'employees',
    ];
    const modules = DEFAULT_RESOURCE_GROUPS.flatMap((group) => group.modules);
    expect([...modules].sort()).toEqual(expected.sort());
    expect(new Set(modules).size).toBe(21);
    expect(DEFAULT_RESOURCE_GROUPS.every((group) => group.resources.length === 2)).toBe(true);
    expect(validateResourceGroups(copyGroups()).error).toBeUndefined();
  });

  it('accepte une rubrique vide et normalise les champs sans modifier les métadonnées', () => {
    const groups = copyGroups();
    groups[0].title = 'Titre arbitraire';
    groups[0].modules = ['inconnu'];
    groups[0].resources = [{ label: ' Exemple ', source: ' Source ', url: ' https://example.com ' }];
    groups[1].resources = [];
    const result = validateResourceGroups(groups);
    expect(result.error).toBeUndefined();
    expect(result.groups[0].title).toBe(DEFAULT_RESOURCE_GROUPS[0].title);
    expect(result.groups[0].modules).toEqual(DEFAULT_RESOURCE_GROUPS[0].modules);
    expect(result.groups[0].resources[0]).toEqual({ label: 'Exemple', source: 'Source', url: 'https://example.com/' });
    expect(result.groups[1].resources).toEqual([]);
  });

  it.each([
    'javascript:alert(1)', 'data:text/html,test', 'http://example.com', 'https://user:pass@example.com',
    '/relative', 'https://localhost', 'https://exa mple.com', 'https://example.com/\npath',
  ])('refuse une adresse dangereuse ou invalide : %s', (url) => {
    const groups = copyGroups();
    groups[0].resources[0].url = url;
    expect(validateResourceGroups(groups).error).toBeTruthy();
  });

  it('refuse les rubriques manquantes, les doublons et les champs vides ou trop longs', () => {
    expect(validateResourceGroups(null).error).toBeTruthy();
    expect(validateResourceGroups(copyGroups().slice(1)).error).toBeTruthy();
    for (const mutate of [
      (groups) => { groups[1] = groups[0]; },
      (groups) => { groups[0].resources.push(groups[0].resources[0]); },
      (groups) => { groups[0].resources[0].label = ' '; },
      (groups) => { groups[0].resources[0].source = 'a'.repeat(201); },
      (groups) => { groups[0].resources[0].url = `https://example.com/${'a'.repeat(2048)}`; },
      (groups) => { groups[0].resources = Array(51).fill(groups[0].resources[0]); },
      (groups) => { groups[0].resources = [null]; },
    ]) {
      const groups = copyGroups();
      mutate(groups);
      expect(validateResourceGroups(groups).error).toBeTruthy();
    }
  });

  it('utilise le catalogue initial seulement si aucun réglage n’a encore été publié', async () => {
    const database = (response) => ({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => response }) }) }),
    });
    expect(await readResourceCatalog(database({ data: null, error: null })))
      .toEqual({ groups: DEFAULT_RESOURCE_GROUPS, updated_at: null });
    await expect(readResourceCatalog(database({ data: null, error: { message: 'database unavailable' } })))
      .rejects.toThrow('Impossible de charger');
    await expect(readResourceCatalog(database({ data: { value: { groups: [] } }, error: null })))
      .rejects.toThrow('enregistré invalide');
  });
});
