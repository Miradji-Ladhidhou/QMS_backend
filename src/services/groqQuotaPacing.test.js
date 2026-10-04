import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fitGroqCompletionBudget, groqTokenBudget, reserveGroqCall } from './groqQuota.js';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), sleep: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.sleep }));
const limits = { requests_minute: 30, requests_day: 1000, tokens_minute: 8000, tokens_day: 200000 };
const usage = { requests_minute: 2, requests_day: 2, tokens_minute: 7900, tokens_day: 7900 };
const blocked = (scope = 'tokens_minute', overrides = {}) => ({
  data: { allowed: false, scope, quota: { limits, usage: { ...usage, ...overrides } } }, error: null,
});
let now;
beforeEach(() => {
  now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  mocks.sleep.mockImplementation(async (ms) => { now += ms; });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it('fits both input and output within 8000 and rejects contexts with no room for valid output', () => {
  for (const length of [1, 3000, 5000, 6000]) {
    const system = 'a'.repeat(length);
    const budget = fitGroqCompletionBudget(system, 'input', 4096, 8000);
    expect(budget).toBeGreaterThanOrEqual(512);
    expect(groqTokenBudget(system, 'input', budget)).toBeLessThanOrEqual(8000);
    expect(budget).toBeLessThanOrEqual(4096);
  }
  expect(fitGroqCompletionBudget('a'.repeat(7500), '', 2048, 8000)).toBeNull();
  expect(fitGroqCompletionBudget('a', 'b', 2048, null)).toBe(2048);
});

it('waits and atomically rechecks a minute limit before obtaining one reservation', async () => {
  mocks.rpc.mockResolvedValueOnce(blocked()).mockResolvedValueOnce({
    data: { allowed: true, call_id: 'reserved' }, error: null,
  });
  expect(await reserveGroqCall('model', 2000, { waitForMinute: true })).toBe('reserved');
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
  expect(mocks.sleep).toHaveBeenCalledWith(2000);
});

it.each([
  ['tokens_day', {}],
  ['tokens_minute', { tokens_day: 199999 }],
  ['requests_minute', { requests_day: 1000 }],
])('does not wait for exhausted daily limits even when the minute is full (%s)', async (scope, overrides) => {
  mocks.rpc.mockResolvedValue(blocked(scope, overrides));
  await expect(reserveGroqCall('model', 2000, { waitForMinute: true })).rejects.toThrow('Aucun appel envoyé');
  expect(mocks.sleep).not.toHaveBeenCalled();
});

it('does not wait for a budget that can never fit in a minute', async () => {
  mocks.rpc.mockResolvedValue(blocked());
  await expect(reserveGroqCall('model', 8001, { waitForMinute: true })).rejects.toThrow('Aucun appel envoyé');
  expect(mocks.sleep).not.toHaveBeenCalled();
});

it('bounds minute pacing to 65 seconds instead of waiting forever', async () => {
  mocks.rpc.mockResolvedValue(blocked());
  await expect(reserveGroqCall('model', 2000, { waitForMinute: true })).rejects.toThrow('Aucun appel envoyé');
  expect(now).toBe(65000);
  expect(mocks.rpc).toHaveBeenCalledTimes(34);
});
