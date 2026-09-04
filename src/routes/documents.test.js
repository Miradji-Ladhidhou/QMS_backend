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

// Sans fréquence de révision configurée (ni sur le document, ni tenants.
// document_review_frequency_months), uploader une nouvelle version ne fait jamais avancer
// review_date (voir computeReviewDateUpdate) : un document déjà en retard le reste
// indéfiniment. Ce bouton comble ce trou en poussant explicitement review_date, quel que soit
// l'état de la fréquence.
describe('POST /api/documents/:id/mark-reviewed', () => {
  async function createDocument(token, number, extra = {}) {
    const req = request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .field('number', number)
      .field('title', `Titre ${number}`);
    for (const [key, value] of Object.entries(extra)) req.field(key, value);
    const res = await req;
    expect(res.status).toBe(201);
    return res.body;
  }

  it('pousse review_date, journalise l’action, et rejette une date invalide', async () => {
    tenant = await createTenant();
    const doc = await createDocument(tenant.admin.token, 'DOC-MR-001', { review_date: '2026-01-01' });

    const invalid = await request(app)
      .post(`/api/documents/${doc.id}/mark-reviewed`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ review_date: 'pas-une-date' });
    expect(invalid.status).toBe(400);

    const res = await request(app)
      .post(`/api/documents/${doc.id}/mark-reviewed`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ review_date: '2027-01-01' });
    expect(res.status).toBe(200);
    expect(res.body.review_date).toBe('2027-01-01');

    const auditLog = await request(app)
      .get(`/api/documents/${doc.id}/audit-log`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    const entry = auditLog.body.find((row) => row.action === 'marked_reviewed');
    expect(entry).toBeDefined();
    expect(entry.details).toEqual({ review_date: '2027-01-01' });
  });

  it('réservé admin/manager, respecte la permission de catégorie comme /metadata', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const doc = await createDocument(tenant.admin.token, 'DOC-MR-002');

    const res = await request(app)
      .post(`/api/documents/${doc.id}/mark-reviewed`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ review_date: '2027-01-01' });
    expect(res.status).toBe(403);
  });

  it('404 sur un document d’un autre tenant', async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      const doc = await createDocument(tenant.admin.token, 'DOC-MR-003');
      const res = await request(app)
        .post(`/api/documents/${doc.id}/mark-reviewed`)
        .set('Authorization', `Bearer ${otherTenant.admin.token}`)
        .send({ review_date: '2027-01-01' });
      expect(res.status).toBe(404);
    } finally {
      await otherTenant.cleanup();
    }
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

describe('POST /api/documents/:id/acknowledge — accusé de lecture', () => {
  async function createDocument(token, number, extra = {}) {
    const req = request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .field('number', number)
      .field('title', `Titre ${number}`);
    for (const [key, value] of Object.entries(extra)) req.field(key, value);
    const res = await req;
    expect(res.status).toBe(201);
    return res.body;
  }

  it('crée un accusé de lecture, reflété dans my_acknowledgment', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const doc = await createDocument(tenant.admin.token, 'DOC-ACK-001');

    const before = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(before.body.my_acknowledgment).toBeNull();

    const ack = await request(app)
      .post(`/api/documents/${doc.id}/acknowledge`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(ack.status).toBe(201);

    const after = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(after.body.my_acknowledgment).not.toBeNull();
    expect(after.body.my_acknowledgment.version).toBe(doc.version);
  });

  it('ré-acquitter la même version est idempotent (pas de doublon)', async () => {
    tenant = await createTenant();
    const doc = await createDocument(tenant.admin.token, 'DOC-ACK-002');

    await request(app).post(`/api/documents/${doc.id}/acknowledge`).set('Authorization', `Bearer ${tenant.admin.token}`).expect(201);
    await request(app).post(`/api/documents/${doc.id}/acknowledge`).set('Authorization', `Bearer ${tenant.admin.token}`).expect(201);

    const { data } = await admin.from('document_acknowledgments').select('id').eq('document_id', doc.id);
    expect(data).toHaveLength(1);
  });

  it('bumper la version remet my_acknowledgment à null pour tout le monde', async () => {
    tenant = await createTenant();
    const doc = await createDocument(tenant.admin.token, 'DOC-ACK-003');

    await request(app).post(`/api/documents/${doc.id}/acknowledge`).set('Authorization', `Bearer ${tenant.admin.token}`).expect(201);

    await request(app)
      .post(`/api/documents/${doc.id}/versions/bump`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(201);

    const res = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.body.my_acknowledgment).toBeNull();

    // L'historique de l'ancienne version reste intact.
    const { data } = await admin.from('document_acknowledgments').select('id').eq('document_id', doc.id);
    expect(data).toHaveLength(1);
  });

  it('404 pour un member sans accès à une catégorie restreinte', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const { data: category } = await admin
      .from('document_categories')
      .insert({ tenant_id: tenant.tenantId, name: 'Restreinte ack', is_restricted: true })
      .select()
      .single();
    const doc = await createDocument(tenant.admin.token, 'DOC-ACK-004', { category_id: category.id });

    const res = await request(app)
      .post(`/api/documents/${doc.id}/acknowledge`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/documents/:id/acknowledgments', () => {
  async function createDocument(token, number, extra = {}) {
    const req = request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .field('number', number)
      .field('title', `Titre ${number}`);
    for (const [key, value] of Object.entries(extra)) req.field(key, value);
    const res = await req;
    expect(res.status).toBe(201);
    return res.body;
  }

  it('403 pour un member', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const doc = await createDocument(tenant.admin.token, 'DOC-ACK-005');

    const res = await request(app)
      .get(`/api/documents/${doc.id}/acknowledgments`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(403);
  });

  it("liste acknowledged/pending pour un admin, un utilisateur désactivé n'apparaît pas dans pending", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;
    const doc = await createDocument(tenant.admin.token, 'DOC-ACK-006');

    await request(app).post(`/api/documents/${doc.id}/acknowledge`).set('Authorization', `Bearer ${memberA.token}`).expect(201);
    await admin.from('users').update({ is_active: false }).eq('id', memberB.id);

    const res = await request(app)
      .get(`/api/documents/${doc.id}/acknowledgments`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.acknowledged.map((a) => a.user_id)).toContain(memberA.id);
    expect(res.body.pending.map((u) => u.id)).not.toContain(memberB.id);
    expect(res.body.pending.map((u) => u.id)).not.toContain(memberA.id);
  });
});

describe('GET /api/documents/:id — champ linked_capas (traçabilité inverse)', () => {
  it('liste les CAPA qui référencent ce document via ref_document', async () => {
    tenant = await createTenant();

    const doc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-LINKCAPA-001')
      .field('title', 'Procédure référencée');

    const capa = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA liée', ref_document: doc.body.id });
    expect(capa.status).toBe(201);

    const res = await request(app).get(`/api/documents/${doc.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.linked_capas).toHaveLength(1);
    expect(res.body.linked_capas[0]).toMatchObject({ id: capa.body.id, title: 'CAPA liée' });
  });

  it("un member sans accès à la catégorie restreinte de la CAPA ne la voit pas dans linked_capas", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const { data: category } = await admin
      .from('categories')
      .insert({ tenant_id: tenant.tenantId, name: 'CAPA restreinte', resource_type: 'capa', is_restricted: true })
      .select()
      .single();

    const doc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-LINKCAPA-002')
      .field('title', 'Procédure référencée 2');

    await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA restreinte liée', ref_document: doc.body.id, category_id: category.id })
      .expect(201);

    const res = await request(app).get(`/api/documents/${doc.body.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(200);
    expect(res.body.linked_capas).toEqual([]);
  });
});

describe('GET /api/documents/:id/preview-url', () => {
  it('previewable:true avec une URL pour un PDF', async () => {
    tenant = await createTenant();

    const doc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-PREVIEW-001')
      .field('title', 'Procédure PDF')
      .attach('file', Buffer.from('%PDF-1.4 contenu factice'), 'procedure.pdf');
    expect(doc.status).toBe(201);

    const res = await request(app)
      .get(`/api/documents/${doc.body.id}/preview-url`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.previewable).toBe(true);
    expect(res.body.url).toBeTruthy();
  });

  it('previewable:false pour un type non prévisualisable (Word)', async () => {
    tenant = await createTenant();

    const doc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-PREVIEW-002')
      .field('title', 'Procédure Word')
      .attach('file', Buffer.from('contenu factice'), 'procedure.docx');
    expect(doc.status).toBe(201);

    const res = await request(app)
      .get(`/api/documents/${doc.body.id}/preview-url`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ previewable: false });
  });

  it('previewable:false sans fichier associé', async () => {
    tenant = await createTenant();

    const doc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-PREVIEW-003')
      .field('title', 'Sans fichier');
    expect(doc.status).toBe(201);

    const res = await request(app)
      .get(`/api/documents/${doc.body.id}/preview-url`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.previewable).toBe(false);
  });

  it("404 pour un member sans accès à une catégorie restreinte", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const { data: category } = await admin
      .from('document_categories')
      .insert({ tenant_id: tenant.tenantId, name: 'Restreinte aperçu', is_restricted: true })
      .select()
      .single();

    const doc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-PREVIEW-004')
      .field('title', 'Procédure restreinte')
      .field('category_id', category.id)
      .attach('file', Buffer.from('%PDF-1.4 contenu factice'), 'procedure.pdf');
    expect(doc.status).toBe(201);

    const res = await request(app)
      .get(`/api/documents/${doc.body.id}/preview-url`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(404);
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

// "Nouvelle version" et "Ajouter un document" sont deux boutons distincts côté frontend, qui
// doivent rester deux actions indépendantes côté backend : l'un ne doit jamais changer l'autre
// (voir demande explicite — POST /:id/versions ne bouge plus le numéro de version, et le nouveau
// POST /:id/versions/bump ne touche jamais au fichier).
describe('POST /api/documents/:id/versions et /versions/bump — fichier et numéro de version indépendants', () => {
  it('POST /:id/versions remplace le fichier sans changer le numéro de version', async () => {
    tenant = await createTenant();

    const created = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-SPLIT-001')
      .field('title', 'Document initial')
      .attach('file', Buffer.from('v1'), 'v1.txt');
    const originalVersion = created.body.version;

    const res = await request(app)
      .post(`/api/documents/${created.body.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', Buffer.from('v1-bis'), 'v1-bis.txt');

    expect(res.status).toBe(201);
    expect(res.body.version).toBe(originalVersion);
    expect(res.body.file_name).toBe('v1-bis.txt');
    expect(res.body.status).toBe('draft');

    const { data: archived } = await admin
      .from('document_versions')
      .select('version, file_name')
      .eq('document_id', created.body.id)
      .single();
    expect(archived.version).toBe(originalVersion);
    expect(archived.file_name).toBe('v1.txt');
  });

  it('POST /:id/versions/bump fait évoluer le numéro de version sans toucher au fichier', async () => {
    tenant = await createTenant();

    const created = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-SPLIT-002')
      .field('title', 'Document à faire évoluer')
      .attach('file', Buffer.from('contenu'), 'original.txt');
    const originalVersion = created.body.version;

    const res = await request(app)
      .post(`/api/documents/${created.body.id}/versions/bump`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ change_note: 'Révision administrative' });

    expect(res.status).toBe(201);
    expect(res.body.version).not.toBe(originalVersion);
    expect(res.body.file_name).toBe('original.txt');
    expect(res.body.file_path).toBe(created.body.file_path);
    expect(res.body.status).toBe('draft');

    const { data: archived } = await admin
      .from('document_versions')
      .select('version, file_name, change_note')
      .eq('document_id', created.body.id)
      .single();
    expect(archived.version).toBe(originalVersion);
    expect(archived.file_name).toBe('original.txt');
    expect(archived.change_note).toBe('Révision administrative');
  });

  it('POST /:id/versions/bump respecte requireCategoryPermission("edit") comme /:id/versions', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const { data: category } = await admin
      .from('document_categories')
      .insert({ tenant_id: tenant.tenantId, name: 'Restreinte bump', is_restricted: true })
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
      .field('number', 'DOC-SPLIT-003')
      .field('title', 'Document restreint')
      .field('category_id', category.id)
      .attach('file', Buffer.from('contenu'), 'original.txt');

    const res = await request(app)
      .post(`/api/documents/${doc.body.id}/versions/bump`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(404);
  });
});

// GET /api/documents expose latest_version_comment (le change_note de la version archivée la
// plus récente) pour l'export CSV/PDF — sans ce champ, la colonne "Commentaire dernière
// version" resterait toujours vide côté frontend.
describe('GET /api/documents — champ latest_version_comment', () => {
  it("renvoie null sans historique, puis le change_note de l'archivage le plus récent", async () => {
    tenant = await createTenant();

    const created = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-COMMENT-001')
      .field('title', 'Document avec historique')
      .attach('file', Buffer.from('v1'), 'v1.txt');

    const noHistory = await request(app).get('/api/documents').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(noHistory.body.find((d) => d.id === created.body.id).latest_version_comment).toBeNull();

    await request(app)
      .post(`/api/documents/${created.body.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('change_note', 'Première correction')
      .attach('file', Buffer.from('v2'), 'v2.txt');

    await request(app)
      .post(`/api/documents/${created.body.id}/versions/bump`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ change_note: 'Montée de version administrative' });

    const afterTwoChanges = await request(app).get('/api/documents').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(afterTwoChanges.body.find((d) => d.id === created.body.id).latest_version_comment).toBe(
      'Montée de version administrative'
    );
  });
});

// Corrige un trou de contrôle d'accès réel : hasCategoryPermission renvoie true pour QUICONQUE
// dès qu'une catégorie n'est pas restreinte (comportement voulu pour view/edit, pas pour
// approve) — un member pouvait donc désigner n'importe quel autre member comme approbateur sur
// un document sans catégorie ou à catégorie non restreinte. Voir isQualifiedApprover.
describe('POST /api/documents/:id/submit-for-approval — habilitation des approbateurs', () => {
  async function createCategory(tenantId, name, extra = {}) {
    const { data } = await admin.from('document_categories').insert({ tenant_id: tenantId, name, ...extra }).select().single();
    return data.id;
  }

  async function createDocument(token, number, extra = {}) {
    const req = request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .field('number', number)
      .field('title', `Titre ${number}`);
    for (const [key, value] of Object.entries(extra)) req.field(key, value);
    const res = await req;
    expect(res.status).toBe(201);
    return res.body;
  }

  it("un member ne peut pas désigner un autre member comme approbateur (document sans catégorie)", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;
    const doc = await createDocument(memberA.token, 'DOC-APPR-001');

    const res = await request(app)
      .post(`/api/documents/${doc.id}/submit-for-approval`)
      .set('Authorization', `Bearer ${memberA.token}`)
      .send({ approver_ids: [memberB.id] });
    expect(res.status).toBe(400);
  });

  it('un member peut désigner un manager comme approbateur', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const doc = await createDocument(member.token, 'DOC-APPR-002');

    const res = await request(app)
      .post(`/api/documents/${doc.id}/submit-for-approval`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ approver_ids: [manager.id] });
    expect(res.status).toBe(201);
  });

  it("un id d'approbateur inexistant est rejeté", async () => {
    tenant = await createTenant();
    const doc = await createDocument(tenant.admin.token, 'DOC-APPR-003');

    const res = await request(app)
      .post(`/api/documents/${doc.id}/submit-for-approval`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ approver_ids: ['00000000-0000-0000-0000-000000000000'] });
    expect(res.status).toBe(400);
  });

  it("la déduction par required_approver_role='member' reste acceptée (choix d'admin délibéré sur la catégorie)", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const categoryId = await createCategory(tenant.tenantId, 'Cat member-approver', { required_approver_role: 'member' });
    const doc = await createDocument(tenant.admin.token, 'DOC-APPR-004', { category_id: categoryId });

    const res = await request(app)
      .post(`/api/documents/${doc.id}/submit-for-approval`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.workflow.required_approvers).toEqual([member.id]);
  });

  it("sur catégorie restreinte, un member avec can_approve explicite est un approbateur valide", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const approver = tenant.users[0];
    const categoryId = await createCategory(tenant.tenantId, 'Restreinte approve', { is_restricted: true });

    await request(app)
      .post(`/api/categories/${categoryId}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: approver.id, can_view: true, can_approve: true })
      .expect(201);

    const doc = await createDocument(tenant.admin.token, 'DOC-APPR-005', { category_id: categoryId });

    // Soumis par l'admin (bypass de hasCategoryPermission, non concerné par ce test) : seul le
    // choix de l'approbateur ci-dessous est sous test.
    const res = await request(app)
      .post(`/api/documents/${doc.id}/submit-for-approval`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ approver_ids: [approver.id] });
    expect(res.status).toBe(201);
  });
});

describe('GET /api/documents/:id/certificate', () => {
  it('génère un certificat PDF valide pour un document approuvé', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const doc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-CERT-001')
      .field('title', 'Procédure certifiée');
    expect(doc.status).toBe(201);

    const submitted = await request(app)
      .post(`/api/documents/${doc.body.id}/submit-for-approval`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ approver_ids: [manager.id] });
    expect(submitted.status).toBe(201);

    const decided = await request(app)
      .post(`/api/workflows/${submitted.body.workflow.id}/decide`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ decision: 'approved' });
    expect(decided.status).toBe(200);

    const res = await request(app)
      .get(`/api/documents/${doc.body.id}/certificate`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob');
    expect(res.status).toBe(200);
    const buffer = Buffer.from(res.body);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it("404 sans workflow approuvé", async () => {
    tenant = await createTenant();
    const doc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-CERT-002')
      .field('title', 'Document non approuvé');

    const res = await request(app)
      .get(`/api/documents/${doc.body.id}/certificate`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(404);
  });
});
