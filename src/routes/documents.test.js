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

// Régression réelle (rapportée en usage) : document_audit_log.document_id/tenant_id/user_id
// ont perdu leurs clés étrangères (voir incomplete-routes, pour que le journal survive à la
// suppression de ce qu'il documente) — ce qui a cassé l'embed PostgREST implicite
// `user:users(...)` de GET /:id/audit-log (PGRST200, 500 en production). Corrigé par une
// jointure manuelle ; ces tests verrouillent le comportement pour de bon.
describe('GET /api/documents/:id/audit-log', () => {
  async function createCategory(tenantId, name) {
    const { data } = await admin.from('document_categories').insert({ tenant_id: tenantId, name }).select().single();
    return data.id;
  }

  it('renvoie 200 avec le nom de l’auteur résolu, pas un embed PostgREST cassé', async () => {
    tenant = await createTenant();
    const categoryId = await createCategory(tenant.tenantId, 'Cat');

    const doc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-001')
      .field('title', 'Document de test')
      .field('category_id', categoryId);
    expect(doc.status).toBe(201);

    await request(app)
      .patch(`/api/documents/${doc.body.id}/status`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'in_review' });

    const res = await request(app)
      .get(`/api/documents/${doc.body.id}/audit-log`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].user).toEqual({ id: tenant.admin.id, full_name: 'Test Admin' });
  });

  it('survit à la suppression du compte de l’auteur : user devient null, pas d’erreur', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'admin' }] });
    const secondAdmin = tenant.users[0];
    const categoryId = await createCategory(tenant.tenantId, 'Cat');

    const doc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${secondAdmin.token}`)
      .field('number', 'DOC-002')
      .field('title', 'Document auteur supprimé')
      .field('category_id', categoryId);

    await request(app)
      .patch(`/api/documents/${doc.body.id}/status`)
      .set('Authorization', `Bearer ${secondAdmin.token}`)
      .send({ status: 'in_review' });

    // Désactivation puis suppression complète du compte auteur (comme le ferait un vrai
    // départ d'utilisateur), sans passer par le tenant entier pour rester ciblé.
    await admin.from('users').delete().eq('id', secondAdmin.id);
    await admin.auth.admin.deleteUser(secondAdmin.id);

    const res = await request(app)
      .get(`/api/documents/${doc.body.id}/audit-log`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);

    expect(res.status).toBe(200);
    const entry = res.body.find((row) => row.action === 'status_changed_manually');
    expect(entry.user).toBeNull();
    expect(entry.user_id).toBe(secondAdmin.id);
  });
});
