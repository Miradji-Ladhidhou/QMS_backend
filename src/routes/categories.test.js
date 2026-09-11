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

  it('refuse la suppression si des documents sont rattachés (lever la restriction d’accès en silence serait dangereux), message clair', async () => {
    tenant = await createTenant();

    const category = await request(app)
      .post('/api/categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Catégorie restreinte', is_restricted: true });
    expect(category.status).toBe(201);

    const doc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-CAT-001')
      .field('title', 'Document catégorisé')
      .field('category_id', category.body.id);
    expect(doc.status).toBe(201);
    expect(doc.body.category_id).toBe(category.body.id);

    const blocked = await request(app)
      .delete(`/api/categories/${category.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('1 document');

    await request(app).delete(`/api/documents/${doc.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);

    const ok = await request(app)
      .delete(`/api/categories/${category.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(ok.status).toBe(204);
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

describe('Dossiers imbriqués (nesting)', () => {
  async function createCategory(token, body) {
    const res = await request(app).post('/api/categories').set('Authorization', `Bearer ${token}`).send(body);
    expect(res.status).toBe(201);
    return res.body;
  }

  it("GET / ne renvoie que les enfants directs — racine par défaut, sous-dossiers via parent_id", async () => {
    tenant = await createTenant();
    const root = await createCategory(tenant.admin.token, { name: 'Qualité' });
    const child = await createCategory(tenant.admin.token, { name: 'Fournisseurs', parent_id: root.id });

    const atRoot = await request(app).get('/api/categories').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(atRoot.body.map((c) => c.id)).toEqual([root.id]);

    const inRoot = await request(app)
      .get(`/api/categories?parent_id=${root.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(inRoot.body.map((c) => c.id)).toEqual([child.id]);
  });

  it('GET /:id/breadcrumb renvoie la chaîne racine → dossier (dossier inclus) ; 404 sur un id inconnu', async () => {
    tenant = await createTenant();
    const parent = await createCategory(tenant.admin.token, { name: 'Niveau 1' });
    const child = await createCategory(tenant.admin.token, { name: 'Niveau 2', parent_id: parent.id });

    const breadcrumb = await request(app)
      .get(`/api/categories/${child.id}/breadcrumb`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(breadcrumb.status).toBe(200);
    expect(breadcrumb.body.map((f) => f.name)).toEqual(['Niveau 1', 'Niveau 2']);

    const notFound = await request(app)
      .get('/api/categories/00000000-0000-0000-0000-000000000000/breadcrumb')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(notFound.status).toBe(404);
  });

  it('POST / rejette un parent_id inconnu ou appartenant à un autre tenant', async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      const badParent = await request(app)
        .post('/api/categories')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ name: 'Enfant', parent_id: '00000000-0000-0000-0000-000000000000' });
      expect(badParent.status).toBe(400);

      const otherTenantCategory = await createCategory(otherTenant.admin.token, { name: 'Ailleurs' });
      const crossTenant = await request(app)
        .post('/api/categories')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ name: 'Enfant', parent_id: otherTenantCategory.id });
      expect(crossTenant.status).toBe(400);
    } finally {
      await otherTenant.cleanup();
    }
  });

  it('PUT /:id (déplacement) : rejette de se parenter soi-même et de se déplacer dans un de ses sous-dossiers', async () => {
    tenant = await createTenant();
    const parent = await createCategory(tenant.admin.token, { name: 'Parent' });
    const child = await createCategory(tenant.admin.token, { name: 'Enfant', parent_id: parent.id });

    const selfParent = await request(app)
      .put(`/api/categories/${parent.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: parent.name, parent_id: parent.id });
    expect(selfParent.status).toBe(400);

    const intoOwnChild = await request(app)
      .put(`/api/categories/${parent.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: parent.name, parent_id: child.id });
    expect(intoOwnChild.status).toBe(400);
  });

  it('DELETE /:id bloqué si un document est rattaché à un SOUS-dossier, pas seulement au dossier ciblé', async () => {
    tenant = await createTenant();
    const parent = await createCategory(tenant.admin.token, { name: 'Parent avec sous-dossier' });
    const child = await createCategory(tenant.admin.token, { name: 'Enfant occupé', parent_id: parent.id });

    const doc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-NEST-001')
      .field('title', 'Document dans le sous-dossier')
      .field('category_id', child.id);
    expect(doc.status).toBe(201);

    const blocked = await request(app)
      .delete(`/api/categories/${parent.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('sous-dossiers');
  });
});
