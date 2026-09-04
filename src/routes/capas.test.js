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

describe('GET /api/capas/:id/pdf', () => {
  it('génère un PDF valide avec le contenu de la CAPA', async () => {
    tenant = await createTenant();
    const created = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA à exporter', description: 'Description de test', root_cause: 'Cause racine de test' });
    expect(created.status).toBe(201);

    const res = await request(app)
      .get(`/api/capas/${created.body.id}/pdf`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const buffer = Buffer.from(res.body);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('404 sur une CAPA d’un autre tenant, et sur une catégorie restreinte sans permission', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const otherTenant = await createTenant();
    try {
      const categoryRes = await request(app)
        .post('/api/module-categories')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ resource_type: 'capa', name: 'Restreinte', is_restricted: true });

      const created = await request(app)
        .post('/api/capas')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ title: 'CAPA restreinte', category_id: categoryRes.body.id });
      expect(created.status).toBe(201);

      const foreignAttempt = await request(app)
        .get(`/api/capas/${created.body.id}/pdf`)
        .set('Authorization', `Bearer ${otherTenant.admin.token}`);
      expect(foreignAttempt.status).toBe(404);

      const restrictedAttempt = await request(app)
        .get(`/api/capas/${created.body.id}/pdf`)
        .set('Authorization', `Bearer ${manager.token}`);
      expect(restrictedAttempt.status).toBe(404);
    } finally {
      await otherTenant.cleanup();
    }
  });
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
    // Régression : service_id doit être résolu en {id, name} dans la réponse (voir
    // CAPA_SELECT dans capas.js) — sans quoi la liste/le formulaire d'édition affichent un
    // service vide malgré service_id correctement enregistré.
    expect(ok.body.service).toEqual({ id: service.body.id, name: 'Qualité' });

    const bad = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA service invalide', service_id: 'not-a-uuid' });
    expect(bad.status).toBe(400);
  });
});

describe('service_id : résolution en {id, name} et modification via GET/PATCH', () => {
  it('GET /api/capas et GET /api/capas/:id renvoient service résolu, null si aucun service', async () => {
    tenant = await createTenant();
    const service = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Logistique' });

    const withService = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Avec service', service_id: service.body.id });
    const withoutService = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Sans service' });

    const list = await request(app).get('/api/capas').set('Authorization', `Bearer ${tenant.admin.token}`);
    const listedWithService = list.body.find((c) => c.id === withService.body.id);
    const listedWithoutService = list.body.find((c) => c.id === withoutService.body.id);
    expect(listedWithService.service).toEqual({ id: service.body.id, name: 'Logistique' });
    expect(listedWithoutService.service).toBeNull();

    const detail = await request(app)
      .get(`/api/capas/${withService.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.service).toEqual({ id: service.body.id, name: 'Logistique' });
  });

  it('PATCH service_id met à jour, résout le nouveau service, et permet de le retirer', async () => {
    tenant = await createTenant();
    const serviceA = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Service A' });
    const serviceB = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Service B' });

    const capa = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA', service_id: serviceA.body.id });

    const patched = await request(app)
      .patch(`/api/capas/${capa.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ service_id: serviceB.body.id });
    expect(patched.status).toBe(200);
    expect(patched.body.service).toEqual({ id: serviceB.body.id, name: 'Service B' });

    const cleared = await request(app)
      .patch(`/api/capas/${capa.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ service_id: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.service_id).toBeNull();
    expect(cleared.body.service).toBeNull();
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
  it('un member voit toutes les CAPA du tenant par défaut (même modèle que les Documents), pas seulement les siennes', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;

    await request(app).post('/api/capas').set('Authorization', `Bearer ${memberA.token}`).send({ title: 'Capa A' });
    await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Capa B', assigned_to: memberB.id });

    const listA = await request(app).get('/api/capas').set('Authorization', `Bearer ${memberA.token}`);
    expect(listA.body).toHaveLength(2);

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
