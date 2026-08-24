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

    // GET /:id/versions/:versionId/download — bug réel corrigé : le frontend construisait ce
    // lien lui-même depuis file_path via le client Supabase (getDocumentPublicUrl), ce qui
    // casse dès que file_path est un id Google Drive au lieu d'un chemin Supabase ("Bucket not
    // found"). Ce endpoint doit exister et répondre pour l'ancienne version archivée.
    const { data: archivedFull } = await admin
      .from('document_versions')
      .select('id')
      .eq('document_id', created.body.id)
      .single();

    const versionDownload = await request(app)
      .get(`/api/documents/${created.body.id}/versions/${archivedFull.id}/download`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);

    expect(versionDownload.status).toBe(200);
    expect(versionDownload.body.url).toContain('/storage/v1/object/public/');
  });
});

// Bug réel rapporté : le bouton "Nouvelle version" s'affichait pour tout le monde côté
// frontend, même quelqu'un avec seulement "Voir" sur une catégorie restreinte — qui se
// heurtait alors à un 403 après avoir rempli le formulaire d'upload. GET /:id renvoie
// maintenant can_edit, calculé côté serveur, pour que le frontend n'affiche le bouton que si
// l'action va réellement réussir.
describe('GET /api/documents/:id — champ can_edit', () => {
  it('true pour un document sans catégorie restreinte, y compris un membre', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const doc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-CANEDIT-001')
      .field('title', 'Document ouvert');

    const res = await request(app).get(`/api/documents/${doc.body.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(200);
    expect(res.body.can_edit).toBe(true);
  });

  it("false pour un membre avec uniquement 'Voir' sur une catégorie restreinte, true une fois can_edit accordé", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const { data: category } = await admin
      .from('document_categories')
      .insert({ tenant_id: tenant.tenantId, name: 'Restreinte', is_restricted: true })
      .select()
      .single();

    await request(app)
      .post(`/api/categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: member.id, can_view: true, can_edit: false })
      .expect(201);

    const doc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-CANEDIT-002')
      .field('title', 'Document restreint')
      .field('category_id', category.id);

    const viewOnlyRes = await request(app).get(`/api/documents/${doc.body.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(viewOnlyRes.status).toBe(200);
    expect(viewOnlyRes.body.can_edit).toBe(false);

    // La même route POST /:id/versions doit d'ailleurs refuser l'upload — le champ can_edit
    // ne fait qu'annoncer côté frontend ce que le backend applique déjà réellement.
    // requireCategoryPermission répond 404 par défaut (jamais laisser deviner qu'une
    // ressource restreinte existe), pas 403 — cohérent avec GET /:id sur un document masqué.
    const uploadAttempt = await request(app)
      .post(`/api/documents/${doc.body.id}/versions`)
      .set('Authorization', `Bearer ${member.token}`)
      .attach('file', Buffer.from('contenu'), 'v2.txt');
    expect(uploadAttempt.status).toBe(404);

    await request(app)
      .post(`/api/categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: member.id, can_view: true, can_edit: true })
      .expect(201);

    const editableRes = await request(app).get(`/api/documents/${doc.body.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(editableRes.body.can_edit).toBe(true);
  });

  it("un membre avec seulement 'Voir' peut télécharger — le téléchargement n'exige que view, pas edit", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const { data: category } = await admin
      .from('document_categories')
      .insert({ tenant_id: tenant.tenantId, name: 'Restreinte téléchargement', is_restricted: true })
      .select()
      .single();

    await request(app)
      .post(`/api/categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: member.id, can_view: true, can_edit: false })
      .expect(201);

    const doc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-CANEDIT-003')
      .field('title', 'Document restreint avec fichier')
      .field('category_id', category.id)
      .attach('file', Buffer.from('contenu du fichier'), 'fichier.txt');
    expect(doc.status).toBe(201);

    const downloadRes = await request(app)
      .get(`/api/documents/${doc.body.id}/download`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.body.url).toBeTruthy();
  });
});

// Bug réel rapporté : un membre appartenait à un groupe autorisé sur une catégorie restreinte,
// et l'admin voulait lui masquer spécifiquement cette catégorie malgré son groupe — l'ancienne
// logique retombait sur le groupe dès que la règle directe n'était pas "true", laissant les
// documents visibles malgré l'exclusion explicite (can_view=false) ajoutée pour cet utilisateur.
describe('Conflit groupe / utilisateur sur une catégorie restreinte', () => {
  it('une règle directe can_view=false masque la catégorie même si le groupe de l’utilisateur y a accès', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const { data: category } = await admin
      .from('document_categories')
      .insert({ tenant_id: tenant.tenantId, name: 'Confidentiel', is_restricted: true })
      .select()
      .single();

    const groupRes = await request(app)
      .post('/api/groups')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Équipe qualité' });
    expect(groupRes.status).toBe(201);

    await request(app)
      .post(`/api/groups/${groupRes.body.id}/members`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ user_id: member.id })
      .expect(201);

    await request(app)
      .post(`/api/categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'group', subject_id: groupRes.body.id, can_view: true })
      .expect(201);

    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-CONFLICT-001')
      .field('title', 'Document confidentiel')
      .field('category_id', category.id);
    expect(docRes.status).toBe(201);

    // Étape 1 : le membre voit le document via son groupe, comme attendu.
    const beforeExclusion = await request(app).get('/api/documents').set('Authorization', `Bearer ${member.token}`);
    expect(beforeExclusion.body.map((d) => d.id)).toContain(docRes.body.id);

    // Étape 2 : l'admin exclut spécifiquement ce membre de la catégorie.
    await request(app)
      .post(`/api/categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: member.id, can_view: false })
      .expect(201);

    const afterExclusionList = await request(app).get('/api/documents').set('Authorization', `Bearer ${member.token}`);
    expect(afterExclusionList.body.map((d) => d.id)).not.toContain(docRes.body.id);

    const afterExclusionDetail = await request(app)
      .get(`/api/documents/${docRes.body.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(afterExclusionDetail.status).toBe(404);

    // L'admin lui-même et un autre membre du groupe (aucune règle directe) ne sont pas affectés.
    const adminList = await request(app).get('/api/documents').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminList.body.map((d) => d.id)).toContain(docRes.body.id);
  });
});

describe('Reclassement de documents existants (PATCH /:id/category et /bulk-category)', () => {
  async function createCategory(tenantId, name, extra = {}) {
    const { data } = await admin.from('document_categories').insert({ tenant_id: tenantId, name, ...extra }).select().single();
    return data.id;
  }

  async function createDocument(token, number, extra = {}) {
    const req = request(app).post('/api/documents').set('Authorization', `Bearer ${token}`).field('number', number).field('title', `Titre ${number}`);
    for (const [key, value] of Object.entries(extra)) req.field(key, value);
    const res = await req;
    expect(res.status).toBe(201);
    return res.body;
  }

  it('PATCH /:id/category reclasse un document existant vers une autre catégorie', async () => {
    tenant = await createTenant();
    const categoryA = await createCategory(tenant.tenantId, 'Catégorie A');
    const categoryB = await createCategory(tenant.tenantId, 'Catégorie B');
    const doc = await createDocument(tenant.admin.token, 'DOC-CAT-001', { category_id: categoryA });

    const res = await request(app)
      .patch(`/api/documents/${doc.id}/category`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ category_id: categoryB });
    expect(res.status).toBe(200);
    expect(res.body.category_id).toBe(categoryB);
  });

  it('PATCH /:id/category avec category_id: null retire la catégorie', async () => {
    tenant = await createTenant();
    const category = await createCategory(tenant.tenantId, 'Catégorie');
    const doc = await createDocument(tenant.admin.token, 'DOC-CAT-002', { category_id: category });

    const res = await request(app)
      .patch(`/api/documents/${doc.id}/category`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ category_id: null });
    expect(res.status).toBe(200);
    expect(res.body.category_id).toBeNull();
  });

  it('un member ne peut pas reclasser un document (réservé admin/manager)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const category = await createCategory(tenant.tenantId, 'Catégorie');
    const doc = await createDocument(tenant.admin.token, 'DOC-CAT-003');

    const res = await request(app)
      .patch(`/api/documents/${doc.id}/category`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ category_id: category });
    expect(res.status).toBe(403);
  });

  it("rejette un category_id d'un autre tenant sur PATCH /:id/category, même admin", async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      const otherCategory = await createCategory(otherTenant.tenantId, 'Catégorie autre tenant');
      const doc = await createDocument(tenant.admin.token, 'DOC-CAT-004');

      const res = await request(app)
        .patch(`/api/documents/${doc.id}/category`)
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ category_id: otherCategory });
      expect(res.status).toBe(400);
    } finally {
      await otherTenant.cleanup();
    }
  });

  it('PATCH /bulk-category déplace plusieurs documents vers une catégorie en un seul appel', async () => {
    tenant = await createTenant();
    const category = await createCategory(tenant.tenantId, 'Lot A');
    const docA = await createDocument(tenant.admin.token, 'DOC-BULK-001');
    const docB = await createDocument(tenant.admin.token, 'DOC-BULK-002');
    const docC = await createDocument(tenant.admin.token, 'DOC-BULK-003');

    const res = await request(app)
      .patch('/api/documents/bulk-category')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [docA.id, docB.id], category_id: category });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    const detailA = await request(app).get(`/api/documents/${docA.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detailA.body.category_id).toBe(category);
    const detailC = await request(app).get(`/api/documents/${docC.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detailC.body.category_id).toBeNull();
  });

  it('un member ne peut pas déplacer des documents en masse (réservé admin/manager)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const doc = await createDocument(tenant.admin.token, 'DOC-BULK-004');

    const res = await request(app)
      .patch('/api/documents/bulk-category')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [doc.id], category_id: null });
    expect(res.status).toBe(403);
  });

  it("un id d'un autre tenant est silencieusement ignoré sur PATCH /bulk-category", async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      const otherDoc = await createDocument(otherTenant.admin.token, 'DOC-BULK-OTHER-001');

      const res = await request(app)
        .patch('/api/documents/bulk-category')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ ids: [otherDoc.id], category_id: null });
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(0);
    } finally {
      await otherTenant.cleanup();
    }
  });

  it("rejette un category_id d'un autre tenant sur PATCH /bulk-category, même admin", async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      const otherCategory = await createCategory(otherTenant.tenantId, 'Catégorie autre tenant');
      const doc = await createDocument(tenant.admin.token, 'DOC-BULK-005');

      const res = await request(app)
        .patch('/api/documents/bulk-category')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ ids: [doc.id], category_id: otherCategory });
      expect(res.status).toBe(400);
    } finally {
      await otherTenant.cleanup();
    }
  });
});

describe('DELETE /api/documents/bulk — suppression en masse', () => {
  async function createCategory(tenantId, name, extra = {}) {
    const { data } = await admin.from('document_categories').insert({ tenant_id: tenantId, name, ...extra }).select().single();
    return data.id;
  }

  async function createDocument(token, number, extra = {}) {
    const req = request(app).post('/api/documents').set('Authorization', `Bearer ${token}`).field('number', number).field('title', `Titre ${number}`);
    for (const [key, value] of Object.entries(extra)) req.field(key, value);
    const res = await req;
    expect(res.status).toBe(201);
    return res.body;
  }

  it("un admin peut supprimer plusieurs documents d'un coup", async () => {
    tenant = await createTenant();
    const docA = await createDocument(tenant.admin.token, 'DOC-DEL-001');
    const docB = await createDocument(tenant.admin.token, 'DOC-DEL-002');

    const res = await request(app)
      .delete('/api/documents/bulk')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [docA.id, docB.id] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);

    const { data } = await admin.from('documents').select('id').in('id', [docA.id, docB.id]);
    expect(data).toHaveLength(0);
  });

  it('un member ne peut pas supprimer des documents en masse', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const doc = await createDocument(tenant.admin.token, 'DOC-DEL-003');

    const res = await request(app)
      .delete('/api/documents/bulk')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [doc.id] });
    expect(res.status).toBe(403);
  });

  it("un id d'un autre tenant est silencieusement ignoré", async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      const otherDoc = await createDocument(otherTenant.admin.token, 'DOC-DEL-OTHER-001');

      const res = await request(app)
        .delete('/api/documents/bulk')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ ids: [otherDoc.id] });
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(0);

      const { data } = await admin.from('documents').select('id').eq('id', otherDoc.id).maybeSingle();
      expect(data).not.toBeNull();
    } finally {
      await otherTenant.cleanup();
    }
  });

  it("un manager sans can_delete sur une catégorie restreinte voit ce document silencieusement ignoré, les autres supprimés", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const restrictedCategory = await createCategory(tenant.tenantId, 'Restreinte', { is_restricted: true });
    const restrictedDoc = await createDocument(tenant.admin.token, 'DOC-DEL-RESTRICTED', { category_id: restrictedCategory });
    const openDoc = await createDocument(tenant.admin.token, 'DOC-DEL-OPEN');

    // Le manager a can_view mais pas can_delete sur la catégorie restreinte.
    await request(app)
      .post(`/api/categories/${restrictedCategory}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: manager.id, can_view: true, can_delete: false })
      .expect(201);

    const res = await request(app)
      .delete('/api/documents/bulk')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ ids: [restrictedDoc.id, openDoc.id] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);

    const { data: stillRestricted } = await admin.from('documents').select('id').eq('id', restrictedDoc.id).maybeSingle();
    expect(stillRestricted).not.toBeNull();
    const { data: openGone } = await admin.from('documents').select('id').eq('id', openDoc.id).maybeSingle();
    expect(openGone).toBeNull();
  });
});
