import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { admin, createTenant } from '../test-utils/tenant.js';
import * as groq from '../services/groq.js';
import { getAiQuota } from '../services/aiQuota.js';

const tenants = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const tenant of tenants.splice(0)) await tenant.cleanup();
});

it('disables guide assistance across tenants, roles and AI settings without spending quota', async () => {
  const generate = vi.spyOn(groq, 'generateProblemGuideRecommendations');
  for (const enabled of [true, false]) {
    const tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    tenants.push(tenant);
    const { error } = await admin.from('tenants').update({ ai_modules: { problem_guide: enabled } }).eq('id', tenant.tenantId);
    if (error) throw error;
    for (const user of [tenant.admin, ...tenant.users]) {
      for (const query of ['produit périmé', 'situation organisationnelle inexpliquée']) {
        const result = await request(app).post('/api/ai/problem-guide-search')
          .set('Authorization', `Bearer ${user.token}`).send({ query });
        expect(result.status).toBe(403);
        expect(result.body).toMatchObject({ code: 'AI_MODULE_DISABLED', module: 'problem_guide' });
      }
      expect((await getAiQuota(tenant.tenantId, user.id)).tenant).toMatchObject({ used: 0, pending: 0 });
    }
  }
  expect(generate).not.toHaveBeenCalled();
});
