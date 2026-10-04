import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createClient } from '@supabase/supabase-js';
import app from '../app.js';
import { admin, createTenant } from '../test-utils/tenant.js';
import { finishGroqCall, getGroqQuota, groqTokenBudget, reserveGroqCall } from './groqQuota.js';

const unlimited = { requests_minute: null, requests_day: null, tokens_minute: null, tokens_day: null };
let originalLimits;
let tenant;
const callIds = [];
async function configure(value) {
  const { error } = await admin.from('platform_settings').update({ value }).eq('key', 'groq_limits');
  if (error) throw error;
}
async function reserve(tokens) {
  const id = await reserveGroqCall('test-model', tokens);
  callIds.push(id);
  return id;
}
beforeEach(async () => {
  const { data, error } = await admin.from('platform_settings').select('value').eq('key', 'groq_limits').single();
  if (error) throw error;
  originalLimits = data.value;
  await configure(unlimited);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (callIds.length) {
    const { error } = await admin.from('groq_quota_calls').delete().in('id', callIds.splice(0));
    if (error) throw error;
  }
  await configure(originalLimits);
  if (tenant) { await tenant.cleanup(); tenant = undefined; }
});

describe('Plafonds globaux Groq', () => {
  it('réserve les octets UTF-8, la marge et le budget de sortie sans afficher de clé', async () => {
    expect(groqTokenBudget('é', 'abc', 8192)).toBe(2 + 3 + 1024 + 8192);
    const snapshot = await getGroqQuota();
    expect(snapshot.limits).toEqual(unlimited);
    expect(snapshot.model).toBe(process.env.GROQ_MODEL || 'openai/gpt-oss-120b');
    expect(snapshot).not.toHaveProperty('apiKey');
  });

  it('compte les requêtes et remplace le budget réservé par les tokens déclarés sans double comptage', async () => {
    const before = await getGroqQuota();
    const id = await reserve(100);
    const pending = await getGroqQuota();
    expect(pending.usage.requests_day).toBe(before.usage.requests_day + 1);
    expect(pending.usage.tokens_day).toBe(before.usage.tokens_day + 100);
    await finishGroqCall(id, { total_tokens: 25 });
    await finishGroqCall(id, { total_tokens: 30 });
    expect((await getGroqQuota()).usage.tokens_day).toBe(before.usage.tokens_day + 25);
  });

  it('conserve le budget estimé lors des échecs sans consommation connue', async () => {
    const before = await getGroqQuota();
    const id = await reserve(100);
    await finishGroqCall(id, null);
    const after = await getGroqQuota();
    expect(after.usage.tokens_day).toBe(before.usage.tokens_day + 100);
    expect(after.usage.estimated_calls).toBe(before.usage.estimated_calls + 1);
  });

  it.each(['requests_minute', 'requests_day', 'tokens_minute', 'tokens_day'])('bloque le plafond %s avant tout appel', async (key) => {
    const before = await getGroqQuota();
    const amount = key.startsWith('tokens') ? 100 : 1;
    await configure({ ...unlimited, [key]: before.usage[key] + amount });
    const id = await reserve(100);
    await expect(reserve(100)).rejects.toThrow('Aucun appel envoyé');
    await finishGroqCall(id, { total_tokens: 100 });
    expect((await getGroqQuota()).limits[key]).toBe(before.usage[key] + amount);
  });

  it('sérialise les réservations simultanées de plusieurs entreprises', async () => {
    const before = await getGroqQuota();
    await configure({ ...unlimited, requests_day: before.usage.requests_day + 3 });
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => reserve(100)));
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(3);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(5);
  });

  it('retient les appels en cours anciens mais libère les fenêtres des appels terminés', async () => {
    const before = await getGroqQuota();
    const pending = await reserve(100);
    const done = await reserve(200);
    await finishGroqCall(done, { total_tokens: 20 });
    const a = await admin.from('groq_quota_calls').update({ created_at: '2000-01-01T00:00:00Z' }).eq('id', pending);
    const b = await admin.from('groq_quota_calls').update({ created_at: '2000-01-01T00:00:00Z', finished_at: '2000-01-01T00:00:00Z' }).eq('id', done);
    if (a.error || b.error) throw a.error || b.error;
    expect((await getGroqQuota()).usage.tokens_day).toBe(before.usage.tokens_day + 100);
    expect((await getGroqQuota()).usage.requests_day).toBe(before.usage.requests_day + 1);
  });

  it('réserve les réglages au super-admin et interdit les RPC et modifications client directes', async () => {
    tenant = await createTenant();
    const endpoint = '/api/ai-quota/groq';
    expect((await request(app).get(endpoint).set('Authorization', `Bearer ${tenant.admin.token}`)).status).toBe(403);
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${tenant.admin.token}` } },
    });
    const rpc = await client.rpc('reserve_groq_call', { p_model: 'test', p_token_budget: 100 });
    expect(rpc.error?.code).toBe('42501');
    const update = await client.from('platform_settings').update({ value: { ...unlimited, tokens_day: 0 } }).eq('key', 'groq_limits');
    expect(update.error?.code).toBe('42501');
    const elevated = await admin.from('users').update({ is_super_admin: true }).eq('id', tenant.admin.id);
    if (elevated.error) throw elevated.error;
    const patch = (body) => request(app).patch(endpoint).set('Authorization', `Bearer ${tenant.admin.token}`).send(body);
    expect((await patch({ ...unlimited, tokens_day: 50000 })).status).toBe(200);
    for (const bad of [{}, { ...unlimited, tokens_day: -1 }, { ...unlimited, tokens_day: '100' }, { ...unlimited, extra: 1 }]) {
      expect((await patch(bad)).status).toBe(400);
    }
    expect((await request(app).get(endpoint).set('Authorization', `Bearer ${tenant.admin.token}`)).body.limits.tokens_day).toBe(50000);
  });
});
