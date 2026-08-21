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

// Prompt B3 : l'upload doit basculer sur Google Drive UNIQUEMENT si tenant_storage_settings
// vaut 'google_drive' pour ce tenant. Un tenant tout neuf n'a aucune ligne dans cette table
// (comportement par défaut, voir schema.sql) — ces tests verrouillent qu'il continue d'uploader
// sur Supabase exactement comme avant B3, sans aucun changement observable.
describe('Upload de fichier — repli Supabase par défaut (aucun Google Drive configuré)', () => {
  it("POST /api/documents avec un fichier : storage_provider reste null (Supabase), comportement inchangé", async () => {
    tenant = await createTenant();

    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-B3-001')
      .field('title', 'Document avec fichier')
      .attach('file', Buffer.from('contenu de test'), 'test.txt');

    expect(res.status).toBe(201);
    expect(res.body.storage_provider).toBeNull();
    expect(res.body.file_path).toBe(`${tenant.tenantId}/${res.body.id}/test.txt`);

    const download = await request(app)
      .get(`/api/documents/${res.body.id}/download`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);

    expect(download.status).toBe(200);
    expect(download.body.url).toContain('/storage/v1/object/public/');
  });

  it("POST /api/documents/:id/versions : l'ancienne version archivée garde son storage_provider (null), la nouvelle aussi", async () => {
    tenant = await createTenant();

    const created = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-B3-002')
      .field('title', 'Document versionné')
      .attach('file', Buffer.from('v1'), 'v1.txt');

    const versioned = await request(app)
      .post(`/api/documents/${created.body.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', Buffer.from('v2'), 'v2.txt');

    expect(versioned.status).toBe(201);
    expect(versioned.body.storage_provider).toBeNull();

    const { data: archived } = await admin
      .from('document_versions')
      .select('storage_provider')
      .eq('document_id', created.body.id)
      .single();
    expect(archived.storage_provider).toBeNull();
  });
});
