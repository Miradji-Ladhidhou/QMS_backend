import { expect, it } from 'vitest';
import { mergeGuideSearch, prepareProblemGuideSearch, validateProblemGuideResponse } from './problemGuide.js';
import { APP_MODULES } from './appModules.js';

it.each(['produit périmé', 'produit expiré', 'DLC dépassée', 'client mécontent', 'erreur de préparation'])(
  'handles %s locally on the server without reserving quota', (query) => {
    const search = prepareProblemGuideSearch(query, new Set(APP_MODULES));
    expect(search.needsFallback).toBe(false);
    expect(search.local.length).toBeGreaterThan(0);
  },
);

it('derives its entire catalog from the server-side allowlist', () => {
  const search = prepareProblemGuideSearch('situation ambiguë', new Set(['risks', 'invented']));
  expect(search.modules.map(({ id }) => id)).toEqual(['risks']);
  expect(search.needsFallback).toBe(true);
  expect(prepareProblemGuideSearch('situation ambiguë', new Set()).needsFallback).toBe(false);
});

it.each([
  null, {}, { recommendations: 'risks' },
  { recommendations: [{ id: 'ishikawa', score: 100 }] },
  { recommendations: [{ id: 'complaints', score: 100 }] },
  { recommendations: [{ id: 'risks', score: '100' }] },
  { recommendations: [{ id: 'risks', score: 121 }] },
  { recommendations: Array.from({ length: 7 }, () => ({ id: 'risks', score: 100 })) },
])('rejects invalid or unauthorized provider output %j', (response) => {
  expect(() => validateProblemGuideResponse(response, [{ id: 'risks' }])).toThrow();
});

it('removes duplicates and rechecks current permissions after generation', () => {
  const response = validateProblemGuideResponse({ recommendations: [
    { id: 'risks', score: 90 }, { id: 'risks', score: 100 }, { id: 'capas', score: 110 },
  ] }, [{ id: 'risks' }, { id: 'capas' }]);
  expect(mergeGuideSearch([], response, { visibleMenuKeys: ['risks'] })).toEqual([{ id: 'risks', score: 100 }]);
});
