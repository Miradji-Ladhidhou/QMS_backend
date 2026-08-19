import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

// POST /api/ai/capa-suggestion appelle Groq en direct : comme pour POST /qqoqccp/:id/generate,
// aucun test automatisé ne couvre le chemin qui appelle réellement l'IA (vérifié manuellement
// via curl/Playwright). On couvre ici uniquement l'authentification et la validation d'entrée,
// qui ne nécessitent pas d'appel réseau.
describe('POST /api/ai/capa-suggestion — authentification et validation', () => {
  it('401 sans authentification', async () => {
    const res = await request(app).post('/api/ai/capa-suggestion').send({ context: 'Un contexte suffisamment long.' });
    expect(res.status).toBe(401);
  });

  it('400 si le contexte est trop court, pour tout rôle (aucune restriction de rôle sur cette route)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const res = await request(app)
      .post('/api/ai/capa-suggestion')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ context: 'court' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});
