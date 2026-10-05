import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { admin, createTenant } from '../test-utils/tenant.js';
import * as groq from '../services/groq.js';
import { getAiQuota } from '../services/aiQuota.js';

const tenants = [];
async function fixture(extraUsers = []) {
  const tenant = await createTenant({ extraUsers });
  tenants.push(tenant);
  return tenant;
}
const search = (token, query) => request(app).post('/api/ai/problem-guide-search')
  .set('Authorization', `Bearer ${token}`).send({ query });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const tenant of tenants.splice(0)) await tenant.cleanup();
});

it('uses local concepts with real authentication and no quota consumption', async () => {
  const tenant = await fixture();
  const generate = vi.spyOn(groq, 'generateProblemGuideRecommendations');
  for (const query of ['produit périmé', 'produit expiré', 'DLC dépassée', 'client mécontent', 'erreur de préparation']) {
    const response = await search(tenant.admin.token, query);
    expect(response.status).toBe(200);
    expect(response.body.recommendations.length).toBeGreaterThan(0);
  }
  expect(generate).not.toHaveBeenCalled();
  expect((await getAiQuota(tenant.tenantId, tenant.admin.id)).tenant).toMatchObject({ used: 0, pending: 0 });
});

it('reserves and settles the guide quota, including disabled assistance and refunded failures', async () => {
  const tenant = await fixture();
  const generate = vi.spyOn(groq, 'generateProblemGuideRecommendations')
    .mockResolvedValue({ recommendations: [{ id: 'risks', score: 100 }] });
  expect((await search(tenant.admin.token, 'situation organisationnelle inexpliquée')).status).toBe(200);
  expect((await getAiQuota(tenant.tenantId, tenant.admin.id)).tenant).toMatchObject({ used: 1, pending: 0 });
  generate.mockResolvedValue({ recommendations: [{ id: 'ishikawa', score: 100 }] });
  expect((await search(tenant.admin.token, 'autre souci inexpliqué')).status).toBe(503);
  expect((await getAiQuota(tenant.tenantId, tenant.admin.id)).tenant).toMatchObject({ used: 1, pending: 0 });
  const { error } = await admin.from('tenants').update({ ai_modules: { problem_guide: false } }).eq('id', tenant.tenantId);
  if (error) throw error;
  expect((await search(tenant.admin.token, 'situation inexpliquée')).status).toBe(403);
  expect(generate).toHaveBeenCalledTimes(2);
});

it('limits provider context by tenant modules, role and per-user overrides', async () => {
  const restricted = await fixture([{ role: 'member' }]);
  const other = await fixture();
  const member = restricted.users[0];
  const { error } = await admin.from('tenants').update({ app_modules: { capas: false } }).eq('id', restricted.tenantId);
  if (error) throw error;
  const settings = await request(app).patch('/api/tenant/menu-settings')
    .set('Authorization', `Bearer ${restricted.admin.token}`)
    .send({ role_hidden_items: { member: ['complaints', 'employees'] }, user_overrides: { [member.id]: { haccp: false } } });
  expect(settings.status).toBe(200);
  const generate = vi.spyOn(groq, 'generateProblemGuideRecommendations')
    .mockResolvedValue({ recommendations: [{ id: 'risks', score: 100 }] });
  expect((await search(member.token, 'situation inexpliquée')).status).toBe(200);
  const restrictedIds = generate.mock.calls[0][1].map(({ id }) => id);
  for (const id of ['capas', 'complaints', 'haccp', 'employees']) expect(restrictedIds).not.toContain(id);
  expect((await search(other.admin.token, 'situation inexpliquée')).status).toBe(200);
  const otherIds = generate.mock.calls[1][1].map(({ id }) => id);
  for (const id of ['capas', 'complaints', 'haccp', 'employees']) expect(otherIds).toContain(id);
});
