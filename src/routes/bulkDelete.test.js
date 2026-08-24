import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

// Un module par ligne : chemin de la ressource, corps minimal valide pour la créer, libellé
// pour les messages d'assertion. Le même comportement (admin/manager only, tenant-scoped,
// silencieux sur un id d'un autre tenant) est attendu partout — voir chaque route.js pour le
// détail (DELETE /bulk, placée avant DELETE /:id).
const MODULES = [
  { path: 'capas', table: 'capas', label: 'CAPA', body: () => ({ title: 'CAPA de test' }) },
  {
    path: 'complaints',
    table: 'complaints',
    label: 'réclamation',
    body: () => ({ customer_name: 'Client Test', received_date: '2026-01-15', description: 'Réclamation de test' }),
  },
  { path: 'qqoqccp', table: 'qqoqccp_analyses', label: 'analyse QQOQCCP', body: () => ({ title: 'Analyse de test' }) },
  { path: 'suppliers', table: 'suppliers', label: 'fournisseur', body: () => ({ name: 'Fournisseur de test' }) },
  { path: 'trainings', table: 'trainings', label: 'formation', body: () => ({ title: 'Formation de test' }) },
  {
    path: 'management-reviews',
    table: 'management_reviews',
    label: 'revue de direction',
    body: () => ({ title: 'Revue de test', review_date: '2026-01-15' }),
  },
  { path: 'audits', table: 'audits', label: 'audit', body: () => ({ title: 'Audit de test', planned_date: '2026-02-01' }) },
  { path: 'risks', table: 'risks', label: 'risque', body: () => ({ title: 'Risque de test', likelihood: 3, impact: 3 }) },
  { path: 'kpis', table: 'kpis', label: 'KPI', body: () => ({ name: 'KPI de test' }) },
];

describe.each(MODULES)('DELETE /api/$path/bulk', ({ path, table, label, body }) => {
  it(`un admin peut supprimer plusieurs ${label}(s) d'un coup`, async () => {
    tenant = await createTenant();
    const a = await request(app).post(`/api/${path}`).set('Authorization', `Bearer ${tenant.admin.token}`).send(body());
    const b = await request(app).post(`/api/${path}`).set('Authorization', `Bearer ${tenant.admin.token}`).send(body());
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const res = await request(app)
      .delete(`/api/${path}/bulk`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [a.body.id, b.body.id] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);

    const { data: stillInDb } = await admin.from(table).select('id').in('id', [a.body.id, b.body.id]);
    expect(stillInDb).toHaveLength(0);
  });

  it(`un member ne peut pas supprimer des ${label}(s) en masse`, async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const created = await request(app).post(`/api/${path}`).set('Authorization', `Bearer ${tenant.admin.token}`).send(body());
    expect(created.status).toBe(201);

    const res = await request(app)
      .delete(`/api/${path}/bulk`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [created.body.id] });
    expect(res.status).toBe(403);
  });

  it('rejette une suppression en masse sans id sélectionné', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .delete(`/api/${path}/bulk`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [] });
    expect(res.status).toBe(400);
  });

  it("un id d'un autre tenant est silencieusement ignoré (jamais supprimé malgré la requête)", async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      const otherItem = await request(app)
        .post(`/api/${path}`)
        .set('Authorization', `Bearer ${otherTenant.admin.token}`)
        .send(body());
      expect(otherItem.status).toBe(201);

      const res = await request(app)
        .delete(`/api/${path}/bulk`)
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ ids: [otherItem.body.id] });
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(0);

      const { data: stillThere } = await admin.from(table).select('id').eq('id', otherItem.body.id).maybeSingle();
      expect(stillThere).not.toBeNull();
    } finally {
      await otherTenant.cleanup();
    }
  });
});

describe('DELETE /api/tasks/bulk — un member ne supprime que ses propres tâches', () => {
  it("supprime les tâches d'un member qui les a créées, ignore silencieusement celles des autres", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;

    const ownTask = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${memberA.token}`)
      .send({ title: 'Tâche de memberA', due_date: '2026-03-01' });
    const othersTask = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${memberB.token}`)
      .send({ title: 'Tâche de memberB', due_date: '2026-03-01' });
    expect(ownTask.status).toBe(201);
    expect(othersTask.status).toBe(201);

    const res = await request(app)
      .delete('/api/tasks/bulk')
      .set('Authorization', `Bearer ${memberA.token}`)
      .send({ ids: [ownTask.body.id, othersTask.body.id] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);

    const getOwn = await request(app).get(`/api/tasks`).set('Authorization', `Bearer ${tenant.admin.token}`);
    const remainingIds = getOwn.body.map((t) => t.id);
    expect(remainingIds).not.toContain(ownTask.body.id);
    expect(remainingIds).toContain(othersTask.body.id);
  });

  it('un admin/manager peut supprimer les tâches de tout le monde', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const memberTask = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ title: 'Tâche de member', due_date: '2026-03-01' });
    expect(memberTask.status).toBe(201);

    const res = await request(app)
      .delete('/api/tasks/bulk')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [memberTask.body.id] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
  });
});
