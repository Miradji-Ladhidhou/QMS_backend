import { describe, it, expect } from 'vitest';
import { runWithRequestContext, getRequestContext } from './requestContext.js';

describe('requestContext', () => {
  it('getRequestContext() renvoie {} hors de tout contexte établi', () => {
    expect(getRequestContext()).toEqual({});
  });

  it('runWithRequestContext établit le contexte pour toute la suite synchrone ET asynchrone de callback()', async () => {
    const result = await runWithRequestContext({ tenantId: 't-1', userId: 'u-1' }, async () => {
      expect(getRequestContext()).toEqual({ tenantId: 't-1', userId: 'u-1' });
      // Traverse un await : l'AsyncLocalStorage doit rester actif après une reprise asynchrone,
      // pas seulement dans la portion synchrone du callback.
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(getRequestContext()).toEqual({ tenantId: 't-1', userId: 'u-1' });
      return 'done';
    });
    expect(result).toBe('done');
    // Le contexte ne fuite jamais après la fin de callback().
    expect(getRequestContext()).toEqual({});
  });

  it('deux contextes imbriqués/concurrents ne se mélangent jamais (isolation par exécution asynchrone)', async () => {
    const [a, b] = await Promise.all([
      runWithRequestContext({ tenantId: 'a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return getRequestContext().tenantId;
      }),
      runWithRequestContext({ tenantId: 'b' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getRequestContext().tenantId;
      }),
    ]);
    expect(a).toBe('a');
    expect(b).toBe('b');
  });
});
