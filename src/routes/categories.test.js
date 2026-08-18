import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';

// Régression : POST/PUT/DELETE /api/categories n'avaient historiquement AUCUNE protection
// de rôle — n'importe quel membre pouvait créer, reconfigurer ou supprimer une catégorie de
// documents (voir finding "Routes de configuration" de l'audit produit). Ces tests
// verrouillent ce comportement pour de bon.

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

describe('Catégories de documents — écriture réservée à admin', () => {
  it('member et manager bloqués sur la création', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }] });

    for (const user of tenant.users) {
      const res = await request(app)
        .post('/api/categories')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ name: 'Catégorie interdite' });
      expect(res.status).toBe(403);
    }
  });

  it('member bloqué sur la mise à jour et la suppression', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const created = await request(app)
      .post('/api/categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Catégorie test' });
    expect(created.status).toBe(201);

    const update = await request(app)
      .put(`/api/categories/${created.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: 'Renommée par un member' });
    expect(update.status).toBe(403);

    const del = await request(app)
      .delete(`/api/categories/${created.body.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(del.status).toBe(403);
  });

  it('admin peut créer, modifier et supprimer normalement', async () => {
    tenant = await createTenant();

    const created = await request(app)
      .post('/api/categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Catégorie admin' });
    expect(created.status).toBe(201);

    const update = await request(app)
      .put(`/api/categories/${created.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Catégorie renommée' });
    expect(update.status).toBe(200);
    expect(update.body.name).toBe('Catégorie renommée');

    const del = await request(app)
      .delete(`/api/categories/${created.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(del.status).toBe(204);
  });

  it('la lecture reste ouverte à tous les rôles', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    await request(app)
      .post('/api/categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Catégorie visible' });

    const res = await request(app).get('/api/categories').set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(200);
    expect(res.body.some((c) => c.name === 'Catégorie visible')).toBe(true);
  });
});
