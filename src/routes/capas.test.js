import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';

// Tests d'intégration réels : contre l'instance Supabase/Postgres locale (voir le garde-fou
// dans test-utils/tenant.js), pas de mocks. Chaque test crée son propre tenant jetable.

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

describe('POST /api/capas', () => {
  it('un member peut créer une CAPA, auto-assignée à lui-même quelle que soit la valeur envoyée', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const res = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ title: 'CAPA du member', assigned_to: tenant.admin.id });

    expect(res.status).toBe(201);
    expect(res.body.assigned_to).toBe(member.id);
  });

  it('un admin garde le contrôle de assigned_to', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const res = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA assignée par admin', assigned_to: member.id });

    expect(res.status).toBe(201);
    expect(res.body.assigned_to).toBe(member.id);
  });

  it('accepte un service_id valide et le rejette si invalide', async () => {
    tenant = await createTenant();
    const service = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Qualité' });

    const ok = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA avec service', service_id: service.body.id });
    expect(ok.status).toBe(201);
    expect(ok.body.service_id).toBe(service.body.id);

    const bad = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA service invalide', service_id: 'not-a-uuid' });
    expect(bad.status).toBe(400);
  });
});

describe('PATCH /api/capas/:id', () => {
  it('refuse un member même sur sa propre CAPA, avec le message exact', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const created = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ title: 'CAPA du member' });

    const res = await request(app)
      .patch(`/api/capas/${created.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ description: 'tentative de modification' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Seuls les administrateurs et managers peuvent modifier une CAPA après sa création.');
  });

  it('autorise un manager à modifier n’importe quelle CAPA', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const created = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA à modifier' });

    const res = await request(app)
      .patch(`/api/capas/${created.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ description: 'modifié par le manager' });

    expect(res.status).toBe(200);
    expect(res.body.description).toBe('modifié par le manager');
  });
});

describe('POST /api/capas/:id/comments', () => {
  it('reste ouvert à un member, seule contribution autorisée après création', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const created = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ title: 'CAPA commentée' });

    const res = await request(app)
      .post(`/api/capas/${created.body.id}/comments`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ comment: 'Un commentaire de suivi' });

    expect(res.status).toBe(201);
    expect(res.body.comment).toBe('Un commentaire de suivi');
  });
});

describe('GET /api/capas', () => {
  it('un member ne voit que ses propres CAPA assignées, pas celles du tenant', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;

    await request(app).post('/api/capas').set('Authorization', `Bearer ${memberA.token}`).send({ title: 'Capa A' });
    await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Capa B', assigned_to: memberB.id });

    const listA = await request(app).get('/api/capas').set('Authorization', `Bearer ${memberA.token}`);
    expect(listA.body).toHaveLength(1);
    expect(listA.body[0].title).toBe('Capa A');

    const listAdmin = await request(app).get('/api/capas').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(listAdmin.body).toHaveLength(2);
  });
});

describe('PUT /api/capas/priority-delays', () => {
  it('réservé à admin — manager et member reçoivent 403', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }] });
    const payload = { critical: 10, high: 20, medium: 30, low: 40 };

    for (const user of tenant.users) {
      const res = await request(app)
        .put('/api/capas/priority-delays')
        .set('Authorization', `Bearer ${user.token}`)
        .send(payload);
      expect(res.status).toBe(403);
    }

    const adminRes = await request(app)
      .put('/api/capas/priority-delays')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send(payload);
    expect(adminRes.status).toBe(200);
  });
});

describe('DELETE /api/capas/:id', () => {
  it('member bloqué, admin/manager autorisés, CAPA réellement supprimée', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const created = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA à supprimer' });

    const blocked = await request(app)
      .delete(`/api/capas/${created.body.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(blocked.status).toBe(403);

    const deleted = await request(app)
      .delete(`/api/capas/${created.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(deleted.status).toBe(204);

    const { data } = await admin.from('capas').select('id').eq('id', created.body.id).maybeSingle();
    expect(data).toBeNull();
  });
});
