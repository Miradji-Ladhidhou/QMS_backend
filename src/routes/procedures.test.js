import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import pdfParse from 'pdf-parse';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import app from '../app.js';
import { supabase } from '../services/supabase.js';
import { createTenant, admin } from '../test-utils/tenant.js';

let tenant;

afterEach(async () => {
  vi.restoreAllMocks();
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

async function createProcedure(token, number, extra = {}) {
  const res = await request(app)
    .post('/api/procedures')
    .set('Authorization', `Bearer ${token}`)
    .send({ number, title: `Procédure ${number}`, ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

// L'envoi de notification à la soumission (routes/procedures.js#submit) n'est volontairement
// pas attendu par la réponse HTTP (même principe que documents.js#submit-for-approval : ne
// pas faire attendre l'auteur pour l'envoi d'emails) — on interroge donc la table le temps
// qu'elle apparaisse plutôt que de supposer qu'elle existe juste après la requête.
async function waitForNotification(userId, type, { timeoutMs = 3000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await admin.from('notifications').select('*').eq('user_id', userId).eq('type', type).maybeSingle();
    if (data) return data;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

describe('POST /api/procedures', () => {
  it("tous les rôles peuvent créer une procédure, sans version associée", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const res = await request(app)
      .post('/api/procedures')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ number: 'PROC-001', title: 'Gestion des non-conformités' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.current_version_id).toBeNull();
  });

  it('rejette un numéro déjà utilisé dans le même tenant', async () => {
    tenant = await createTenant();
    await createProcedure(tenant.admin.token, 'PROC-002');

    const res = await request(app)
      .post('/api/procedures')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ number: 'PROC-002', title: 'Doublon' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/procedures/from-document', () => {
  it('reprend le contenu, la version et la date en brouillon, sans modifier le document source', async () => {
    tenant = await createTenant();
    const { data: source } = await admin
      .from('documents')
      .insert({
        tenant_id: tenant.tenantId,
        number: 'PR-LEGACY-1',
        title: 'Procédure interne existante',
        description: 'Objectif et périmètre.',
        extracted_text: 'Étape 1 : vérifier le lot.\nÉtape 2 : enregistrer le résultat.',
        version: '3.2',
        status: 'approved',
        review_date: '2027-01-15',
        file_path: `${tenant.tenantId}/documents/procedure-interne.pdf`,
        file_name: 'procedure-interne.pdf',
      })
      .select('id')
      .single();

    const res = await request(app)
      .post('/api/procedures/from-document')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ document_id: source.id, number: 'PR-LEGACY-1', title: 'Procédure interne existante' });

    expect(res.status).toBe(201);
    expect(res.body.procedure.status).toBe('draft');
    expect(res.body.procedure.current_version_id).toBeNull();

    const { data: procedure } = await admin.from('procedures').select('*').eq('id', res.body.procedure.id).single();
    expect(procedure.source_document_id).toBe(source.id);
    expect(procedure.next_review_date).toBe('2027-01-15');

    const { data: version } = await admin
      .from('procedure_versions')
      .select('id, version, status, content, attachment_file_path, attachment_file_name, attachment_storage_provider')
      .eq('procedure_id', procedure.id)
      .single();
    expect(version.version).toBe('3.2');
    expect(version.status).toBe('draft');
    expect(version.attachment_file_path).toBe(`${tenant.tenantId}/documents/procedure-interne.pdf`);
    expect(version.attachment_file_name).toBe('procedure-interne.pdf');
    expect(version.attachment_storage_provider).toBeNull();
    const acknowledgment = await request(app)
      .post(`/api/procedures/${procedure.id}/acknowledge`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(acknowledgment.status).toBe(400);
    expect(version.content.sections[0].blocks.map((block) => block.text)).toEqual([
      'Objectif et périmètre.',
      'Étape 1 : vérifier le lot.',
      'Étape 2 : enregistrer le résultat.',
    ]);

    const { data: unchangedSource } = await admin.from('documents').select('status').eq('id', source.id).single();
    expect(unchangedSource.status).toBe('approved');

    const detail = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.source_document).toMatchObject({
      id: source.id,
      number: 'PR-LEGACY-1',
      version: '3.2',
    });

    const attachment = await request(app)
      .get(`/api/procedures/${procedure.id}/versions/${version.id}/attachment`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(attachment.status).toBe(200);
    expect(attachment.body.url).toContain(version.attachment_file_path);

    const documents = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(documents.status).toBe(200);
    const listedSource = documents.body.find((document) => document.id === source.id);
    expect(listedSource.source_procedure[0].id).toBe(procedure.id);

    const repeated = await request(app)
      .post('/api/procedures/from-document')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ document_id: source.id, number: 'PR-LEGACY-1', title: 'Procédure interne existante' });
    expect(repeated.status).toBe(200);
    expect(repeated.body.already_exists).toBe(true);
    expect(repeated.body.procedure.id).toBe(procedure.id);
  });

  it('conserve les titres et tableaux du Word source dans la procédure convertie', async () => {
    tenant = await createTenant();
    const sourceBuffer = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph({ text: '1. Objectifs de la procédure', heading: HeadingLevel.HEADING_1 }),
              new Paragraph('Décrire le processus.'),
              new Paragraph({ text: '3. Responsabilités', heading: HeadingLevel.HEADING_1 }),
              new Table({
                rows: [
                  new TableRow({
                    children: [
                      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Poste', bold: true })] })] }),
                      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Responsabilités', bold: true })] })] }),
                    ],
                  }),
                  new TableRow({
                    children: [
                      new TableCell({ children: [new Paragraph('Responsable')] }),
                      new TableCell({ children: [new Paragraph('Pilote la procédure.')] }),
                    ],
                  }),
                ],
              }),
            ],
          },
        ],
      })
    );
    const filePath = `${tenant.tenantId}/documents/procedure-source.docx`;
    const { data: source } = await admin
      .from('documents')
      .insert({
        tenant_id: tenant.tenantId,
        number: 'PR-LEGACY-DOCX',
        title: 'Procédure Word source',
        description: 'Résumé conservé.',
        extracted_text: 'Texte indexé utilisé pour la recherche.',
        file_path: filePath,
        file_name: 'procedure-source.docx',
        storage_provider: 'supabase',
      })
      .select('id')
      .single();
    const download = vi.fn().mockResolvedValue({ data: new Blob([sourceBuffer]), error: null });
    vi.spyOn(supabase.storage, 'from').mockReturnValue({ download });

    const converted = await request(app)
      .post('/api/procedures/from-document')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ document_id: source.id, number: 'PR-LEGACY-DOCX', title: 'Procédure Word source' });

    expect(converted.status).toBe(201);
    expect(download).toHaveBeenCalledWith(filePath);

    const { data: version } = await admin
      .from('procedure_versions')
      .select('content')
      .eq('procedure_id', converted.body.procedure.id)
      .single();
    expect(version.content.sections.map((section) => section.label)).toEqual([
      'Objectifs de la procédure',
      'Responsabilités',
    ]);
    expect(version.content.sections[0].blocks[0]).toMatchObject({
      type: 'paragraphe',
      text: 'Résumé conservé.',
    });
    expect(version.content.sections[1].blocks[0]).toMatchObject({
      type: 'tableau',
      headers: ['Poste', 'Responsabilités'],
      rows: [['Responsable', 'Pilote la procédure.']],
    });
  });

  describe('POST /api/procedures/:id/reimport-source', () => {
    it('crée une nouvelle version brouillon structurée sans modifier la version existante', async () => {
      tenant = await createTenant();
      const sourceBuffer = await Packer.toBuffer(
        new Document({
          sections: [
            {
              children: [
                new Paragraph({ text: '1. Contrôle du produit', heading: HeadingLevel.HEADING_1 }),
                new Paragraph('Vérifier chaque lot avant libération.'),
                new Paragraph({ text: '2. Responsabilités', heading: HeadingLevel.HEADING_1 }),
                new Table({
                  rows: [
                    new TableRow({
                      children: [
                        new TableCell({
                          children: [new Paragraph({ children: [new TextRun({ text: 'Rôle', bold: true })] })],
                        }),
                        new TableCell({
                          children: [new Paragraph({ children: [new TextRun({ text: 'Responsabilité', bold: true })] })],
                        }),
                      ],
                    }),
                    new TableRow({
                      children: [
                        new TableCell({ children: [new Paragraph('Qualité')] }),
                        new TableCell({ children: [new Paragraph('Enregistrer la décision.')] }),
                      ],
                    }),
                  ],
                }),
              ],
            },
          ],
        })
      );
      const filePath = `${tenant.tenantId}/documents/procedure-source.docx`;
      const { data: source } = await admin
        .from('documents')
        .insert({
          tenant_id: tenant.tenantId,
          number: 'PR-REIMPORT',
          title: 'Procédure importée',
          description: 'Description de la source.',
          extracted_text: 'Texte aplati utilisé avant la reprise.',
          version: '4.1',
          file_path: filePath,
          file_name: 'procedure-source.docx',
          storage_provider: 'supabase',
        })
        .select('id')
        .single();
      const download = vi.fn().mockResolvedValue({ data: new Blob([sourceBuffer]), error: null });
      vi.spyOn(supabase.storage, 'from').mockReturnValue({ download });

      const procedure = await createProcedure(tenant.admin.token, 'PR-REIMPORT');
      await admin.from('procedures').update({ source_document_id: source.id }).eq('id', procedure.id);
      const legacyContent = {
        sections: [
          {
            key: 'contenu_importe',
            label: 'Contenu repris du document source',
            blocks: [{ type: 'paragraphe', text: 'Texte déjà aplati.' }],
          },
        ],
        documents_associes: [],
      };
      await admin.from('procedure_versions').insert({
        tenant_id: tenant.tenantId,
        procedure_id: procedure.id,
        version: '4.1',
        status: 'draft',
        content: legacyContent,
        author_id: tenant.admin.id,
      });

      const reimported = await request(app)
        .post(`/api/procedures/${procedure.id}/reimport-source`)
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send();

      expect(reimported.status).toBe(201);
      expect(reimported.body.version).toBe('4.2');
      expect(reimported.body.status).toBe('draft');
      expect(reimported.body.content.sections.map((section) => section.label)).toEqual([
        'Contrôle du produit',
        'Responsabilités',
      ]);
      expect(reimported.body.content.sections[1].blocks[0]).toMatchObject({
        type: 'tableau',
        headers: ['Rôle', 'Responsabilité'],
        rows: [['Qualité', 'Enregistrer la décision.']],
      });

      const { data: previousVersion } = await admin
        .from('procedure_versions')
        .select('version, content')
        .eq('procedure_id', procedure.id)
        .eq('version', '4.1')
        .single();
      expect(previousVersion.content).toEqual(legacyContent);
      expect(download).toHaveBeenCalledTimes(1);
      expect(download).toHaveBeenCalledWith(filePath);
    });

    it('réserve le réimport aux rôles de gestion', async () => {
      tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
      const member = tenant.users[0];
      const procedure = await createProcedure(tenant.admin.token, 'PR-REIMPORT-ACCESS');

      const res = await request(app)
        .post(`/api/procedures/${procedure.id}/reimport-source`)
        .set('Authorization', `Bearer ${member.token}`)
        .send();

      expect(res.status).toBe(403);
    });
  });

  it('réserve la conversion aux rôles de gestion', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const { data: source } = await admin
      .from('documents')
      .insert({ tenant_id: tenant.tenantId, number: 'PR-LEGACY-2', title: 'Procédure' })
      .select('id')
      .single();

    const res = await request(app)
      .post('/api/procedures/from-document')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ document_id: source.id, number: 'PR-LEGACY-2', title: 'Procédure' });
    expect(res.status).toBe(403);
  });

  it('garde le provider Google Drive du fichier source lors de la reprise', async () => {
    tenant = await createTenant();
    const { data: source } = await admin
      .from('documents')
      .insert({
        tenant_id: tenant.tenantId,
        number: 'PR-LEGACY-DRIVE',
        title: 'Procédure Drive',
        file_path: 'existing-drive-file-id',
        file_name: 'procedure-drive.pdf',
        storage_provider: 'google_drive',
      })
      .select('id')
      .single();

    const converted = await request(app)
      .post('/api/procedures/from-document')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ document_id: source.id, number: 'PR-LEGACY-DRIVE', title: 'Procédure Drive' });
    expect(converted.status).toBe(201);

    const version = await admin
      .from('procedure_versions')
      .select('id, attachment_file_path, attachment_file_name, attachment_storage_provider')
      .eq('procedure_id', converted.body.procedure.id)
      .single();
    expect(version.data).toMatchObject({
      attachment_file_path: 'existing-drive-file-id',
      attachment_file_name: 'procedure-drive.pdf',
      attachment_storage_provider: 'google_drive',
    });

    const attachment = await request(app)
      .get(`/api/procedures/${converted.body.procedure.id}/versions/${version.data.id}/attachment`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(attachment.status).toBe(200);
    expect(attachment.body.url).toContain('/api/documents/drive-file?ticket=');
  });

  it('conserve les restrictions du document source sur la liste, la fiche et le fichier de la procédure', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const { data: category } = await admin
      .from('document_categories')
      .insert({ tenant_id: tenant.tenantId, name: 'Procédures confidentielles', is_restricted: true })
      .select('id')
      .single();
    const { data: source } = await admin
      .from('documents')
      .insert({
        tenant_id: tenant.tenantId,
        category_id: category.id,
        number: 'PR-SECRET',
        title: 'Procédure confidentielle',
        file_path: `${tenant.tenantId}/private/procedure.pdf`,
        file_name: 'procedure.pdf',
      })
      .select('id')
      .single();

    const converted = await request(app)
      .post('/api/procedures/from-document')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ document_id: source.id, number: 'PR-SECRET', title: 'Procédure confidentielle' });
    expect(converted.status).toBe(201);
    const procedureId = converted.body.procedure.id;
    const versionId = converted.body.procedure.current_version_id;

    const list = await request(app).get('/api/procedures').set('Authorization', `Bearer ${member.token}`);
    expect(list.status).toBe(200);
    expect(list.body.some((procedure) => procedure.id === procedureId)).toBe(false);

    const detail = await request(app)
      .get(`/api/procedures/${procedureId}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(detail.status).toBe(404);

    const attachment = await request(app)
      .get(`/api/procedures/${procedureId}/versions/${versionId}/attachment`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(attachment.status).toBe(404);
  });
});

describe('Catégorie (dossier) sur les procédures', () => {
  it('un member peut créer avec category_id, admin/manager peuvent reclasser via PATCH /:id/category', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const category = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'procedure', name: 'Qualité' });
    expect(category.status).toBe(201);

    const created = await createProcedure(member.token, 'PROC-CAT-1', { category_id: category.body.id });
    expect(created.category_id).toBe(category.body.id);

    const other = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'procedure', name: 'Sécurité' });
    expect(other.status).toBe(201);

    const reclassified = await request(app)
      .patch(`/api/procedures/${created.id}/category`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ category_id: other.body.id });
    expect(reclassified.status).toBe(200);
    expect(reclassified.body.category.name).toBe('Sécurité');

    const blocked = await request(app)
      .patch(`/api/procedures/${created.id}/category`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ category_id: category.body.id });
    expect(blocked.status).toBe(403);
  });

  it('une procédure dans une catégorie restreinte est invisible à un member sans permission', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const category = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'procedure', name: 'Direction', is_restricted: true });
    expect(category.status).toBe(201);

    const created = await createProcedure(tenant.admin.token, 'PROC-CAT-2', { category_id: category.body.id });

    const list = await request(app).get('/api/procedures').set('Authorization', `Bearer ${member.token}`);
    expect(list.body.find((p) => p.id === created.id)).toBeUndefined();

    const detail = await request(app).get(`/api/procedures/${created.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(detail.status).toBe(404);

    const asAdmin = await request(app).get(`/api/procedures/${created.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(asAdmin.status).toBe(200);
  });
});

describe('Actions en masse sur les procédures', () => {
  it('PATCH /bulk-category déplace plusieurs procédures, réservé admin/manager', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const a = await createProcedure(tenant.admin.token, 'PROC-BULK-1');
    const b = await createProcedure(tenant.admin.token, 'PROC-BULK-2');

    const category = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'procedure', name: 'Qualité' });
    expect(category.status).toBe(201);

    const blocked = await request(app)
      .patch('/api/procedures/bulk-category')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [a.id, b.id], category_id: category.body.id });
    expect(blocked.status).toBe(403);

    const res = await request(app)
      .patch('/api/procedures/bulk-category')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [a.id, b.id], category_id: category.body.id });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    const list = await request(app).get('/api/procedures').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(list.body.filter((p) => [a.id, b.id].includes(p.id)).every((p) => p.category_id === category.body.id)).toBe(true);
  });

  it('DELETE /bulk supprime les brouillons éligibles et ignore silencieusement le reste', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const ownDraft = await createProcedure(member.token, 'PROC-BULK-3');
    const othersDraft = await createProcedure(tenant.admin.token, 'PROC-BULK-4');
    const submitted = await createProcedure(tenant.admin.token, 'PROC-BULK-5');
    const version = await request(app)
      .post(`/api/procedures/${submitted.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    expect(version.status).toBe(201);
    await request(app)
      .post(`/api/procedures/${submitted.id}/versions/${version.body.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);

    // Un member ne peut supprimer que sa propre procédure brouillon : othersDraft et submitted
    // (déjà soumise) sont silencieusement ignorées, seule ownDraft est réellement supprimée.
    const res = await request(app)
      .delete('/api/procedures/bulk')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [ownDraft.id, othersDraft.id, submitted.id] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);

    const list = await request(app).get('/api/procedures').set('Authorization', `Bearer ${tenant.admin.token}`);
    const remainingIds = list.body.map((p) => p.id);
    expect(remainingIds).not.toContain(ownDraft.id);
    expect(remainingIds).toContain(othersDraft.id);
    expect(remainingIds).toContain(submitted.id);
  });
});

describe('POST /api/procedures/:id/versions — ai_generated', () => {
  it('false par défaut, true si fourni explicitement', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-005');

    const defaultRes = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    expect(defaultRes.body.ai_generated).toBe(false);

    const aiRes = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ content: { objet: 'Généré par IA' }, ai_generated: true });
    expect(aiRes.body.ai_generated).toBe(true);
  });
});

// Ces 3 routes appellent Groq en direct : comme POST /api/risks/service-suggestion et
// consorts, aucun test automatisé ne couvre le chemin qui appelle réellement l'IA (vérifié
// manuellement, voir le smoke test du Prompt 3). On couvre ici uniquement la résolution de la
// version/procédure et les cas d'erreur qui ne nécessitent pas d'atteindre l'appel Groq.
describe('POST /api/procedures/generate-draft — validation', () => {
  it('400 sans titre', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .post('/api/procedures/generate-draft')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ process: 'Qualité' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/procedures/:id/versions/:versionId/check-compliance et /compare — résolution de la version', () => {
  it('404 sur une version qui ne correspond pas à la procédure', async () => {
    tenant = await createTenant();
    const procedureA = await createProcedure(tenant.admin.token, 'PROC-006');
    const procedureB = await createProcedure(tenant.admin.token, 'PROC-007');
    const versionOfB = await request(app)
      .post(`/api/procedures/${procedureB.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});

    const compliance = await request(app)
      .post(`/api/procedures/${procedureA.id}/versions/${versionOfB.body.id}/check-compliance`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(compliance.status).toBe(404);

    const compare = await request(app)
      .post(`/api/procedures/${procedureA.id}/versions/${versionOfB.body.id}/compare`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(compare.status).toBe(404);
  });
});

// Même principe que check-compliance ci-dessus : appelle Groq en direct, non couvert par un
// test automatisé au-delà de la résolution de version et de la validation d'entrée.
describe('POST /api/procedures/:id/versions/:versionId/compliance-fix', () => {
  it('404 sur une version qui ne correspond pas à la procédure', async () => {
    tenant = await createTenant();
    const procedureA = await createProcedure(tenant.admin.token, 'PROC-008');
    const procedureB = await createProcedure(tenant.admin.token, 'PROC-009');
    const versionOfB = await request(app)
      .post(`/api/procedures/${procedureB.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});

    const res = await request(app)
      .post(`/api/procedures/${procedureA.id}/versions/${versionOfB.body.id}/compliance-fix`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ section_key: 'etapes', issue: 'Section vide.' });
    expect(res.status).toBe(404);
  });

  it('400 si section_key ou issue est manquant', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-011');
    const version = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.body.id}/compliance-fix`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ issue: 'Section vide.' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/procedures/:id/versions', () => {
  it('première version à 1.0, puis incrémentée automatiquement', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-010');

    const v1 = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ content: { objet: 'Test' } });
    expect(v1.status).toBe(201);
    expect(v1.body.version).toBe('1.0');
    expect(v1.body.author_id).toBe(tenant.admin.id);
    expect(v1.body.status).toBe('draft');

    const v2 = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe('1.1');
  });
});

describe('Workflow submit / validate / reject', () => {
  async function createVersion(token, procedureId, extra = {}) {
    const res = await request(app)
      .post(`/api/procedures/${procedureId}/versions`)
      .set('Authorization', `Bearer ${token}`)
      .send(extra);
    expect(res.status).toBe(201);
    return res.body;
  }

  it("l'auteur peut soumettre sa version ; un autre member ne peut pas", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [author, other] = tenant.users;
    const procedure = await createProcedure(tenant.admin.token, 'PROC-020');
    const version = await createVersion(author.token, procedure.id);

    const forbidden = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(forbidden.status).toBe(403);

    const submitted = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${author.token}`);
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe('pending');

    const procedureAfter = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(procedureAfter.body.status).toBe('in_review');
  });

  it("notifie l'admin (et pas le soumetteur) à la soumission, et fait apparaître la version dans pending-validations", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const author = tenant.users[0];
    const procedure = await createProcedure(tenant.admin.token, 'PROC-022');
    const version = await createVersion(author.token, procedure.id);

    const submitted = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${author.token}`);
    expect(submitted.status).toBe(200);

    const notification = await waitForNotification(tenant.admin.id, 'procedure_validation_request');
    expect(notification).not.toBeNull();
    expect(notification.message).toContain('PROC-022');

    const authorNotification = await admin
      .from('notifications')
      .select('*')
      .eq('user_id', author.id)
      .eq('type', 'procedure_validation_request')
      .maybeSingle();
    expect(authorNotification.data).toBeNull();

    const pending = await request(app)
      .get('/api/procedures/pending-validations')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(pending.status).toBe(200);
    expect(pending.body.map((v) => v.id)).toContain(version.id);

    const memberBlocked = await request(app)
      .get('/api/procedures/pending-validations')
      .set('Authorization', `Bearer ${author.token}`);
    expect(memberBlocked.status).toBe(403);

    const validated = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/validate`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(validated.status).toBe(200);

    const pendingAfter = await request(app)
      .get('/api/procedures/pending-validations')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(pendingAfter.body.map((v) => v.id)).not.toContain(version.id);
  });

  it('un member ne peut pas valider (réservé admin/manager, même principe que la CAPA)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const procedure = await createProcedure(tenant.admin.token, 'PROC-021');
    const version = await createVersion(member.token, procedure.id);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${member.token}`)
      .expect(200);

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/validate`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(403);
  });

  it('admin valide : la procédure passe "approved" et current_version_id est mis à jour', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const validator = tenant.users[0];
    const procedure = await createProcedure(tenant.admin.token, 'PROC-022');
    const version = await createVersion(tenant.admin.token, procedure.id);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/validate`)
      .set('Authorization', `Bearer ${validator.token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.validator_id).toBe(validator.id);

    const procedureAfter = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(procedureAfter.body.status).toBe('approved');
    expect(procedureAfter.body.current_version_id).toBe(version.id);
  });

  it('un admin peut approuver sa propre version quand il travaille seul', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-022b');
    const version = await createVersion(tenant.admin.token, procedure.id);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/validate`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.author_id).toBe(tenant.admin.id);
    expect(res.body.validator_id).toBe(tenant.admin.id);

    const procedureAfter = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(procedureAfter.body.status).toBe('approved');
    expect(procedureAfter.body.current_version_id).toBe(version.id);
  });

  it('rejet : commentaire obligatoire, la procédure repasse "draft"', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-023');
    const version = await createVersion(tenant.admin.token, procedure.id);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);

    const noComment = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/reject`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    expect(noComment.status).toBe(400);

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/reject`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ comment: 'Section responsabilités incomplète.' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.comment).toBe('Section responsabilités incomplète.');

    const procedureAfter = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(procedureAfter.body.status).toBe('draft');
  });

  it('impossible de valider deux fois la même version', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const validator = tenant.users[0];
    const procedure = await createProcedure(tenant.admin.token, 'PROC-024');
    const version = await createVersion(tenant.admin.token, procedure.id);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/validate`)
      .set('Authorization', `Bearer ${validator.token}`)
      .expect(200);

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/validate`)
      .set('Authorization', `Bearer ${validator.token}`);
    expect(res.status).toBe(409);
  });
});

describe('PUT /api/procedures/:id/versions/:versionId', () => {
  async function createVersion(token, procedureId, extra = {}) {
    const res = await request(app)
      .post(`/api/procedures/${procedureId}/versions`)
      .set('Authorization', `Bearer ${token}`)
      .send(extra);
    expect(res.status).toBe(201);
    return res.body;
  }

  it('modifie le contenu tant que la version est "draft" ; refusé pour tout autre statut, et pour un autre rédacteur', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const [other] = tenant.users;
    const procedure = await createProcedure(tenant.admin.token, 'PROC-030');
    const version = await createVersion(tenant.admin.token, procedure.id, { content: { objet: 'Brouillon initial' } });

    const forbidden = await request(app)
      .put(`/api/procedures/${procedure.id}/versions/${version.id}`)
      .set('Authorization', `Bearer ${other.token}`)
      .send({ content: { objet: 'Tentative non autorisée' } });
    expect(forbidden.status).toBe(403);

    const edited = await request(app)
      .put(`/api/procedures/${procedure.id}/versions/${version.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ content: { objet: 'Objet corrigé' } });
    expect(edited.status).toBe(200);
    expect(edited.body.content.objet).toBe('Objet corrigé');
    expect(edited.body.version).toBe(version.version);

    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);

    const afterSubmit = await request(app)
      .put(`/api/procedures/${procedure.id}/versions/${version.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ content: { objet: 'Trop tard' } });
    expect(afterSubmit.status).toBe(409);
  });
});

describe('Reprise du contenu après un rejet', () => {
  async function createVersion(token, procedureId, extra = {}) {
    const res = await request(app)
      .post(`/api/procedures/${procedureId}/versions`)
      .set('Authorization', `Bearer ${token}`)
      .send(extra);
    expect(res.status).toBe(201);
    return res.body;
  }

  // La reprise elle-même (previousContent = version rejetée, pas la version approuvée) est
  // une décision de sélection côté ProcedureDetail.jsx — ce projet n'a pas de suite de tests
  // frontend. Ce test vérifie le contrat de données dont cette logique dépend : GET /:id
  // renvoie les versions plus récentes d'abord, donc "la dernière rejetée" est bien la
  // première trouvée par un .find(status === 'rejected'), avec son contenu intact.
  it('GET /:id renvoie la dernière version rejetée (et pas une plus ancienne) avec son contenu propre', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-031');

    const v1 = await createVersion(tenant.admin.token, procedure.id, { content: { objet: 'Premier essai' } });
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${v1.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${v1.id}/reject`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ comment: 'Section responsabilités incomplète.' })
      .expect(200);

    const v2 = await createVersion(tenant.admin.token, procedure.id, { content: { objet: 'Deuxième essai, corrigé' } });
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${v2.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${v2.id}/reject`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ comment: 'Toujours incomplet.' })
      .expect(200);

    const res = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);

    const lastRejected = res.body.versions.find((v) => v.status === 'rejected');
    expect(lastRejected.id).toBe(v2.id);
    expect(lastRejected.content.objet).toBe('Deuxième essai, corrigé');
  });
});

describe('POST /api/procedures/:id/acknowledge', () => {
  it('400 sans version approuvée, 201 une fois une version validée, idempotent', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const procedure = await createProcedure(tenant.admin.token, 'PROC-030');

    const tooEarly = await request(app)
      .post(`/api/procedures/${procedure.id}/acknowledge`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(tooEarly.status).toBe(400);

    // Rédigée et soumise par le member lui-même (autorisé, voir canActOnVersion) plutôt que
    // par l'admin : la validation qui suit doit venir de quelqu'un d'autre que l'auteur.
    const version = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({});
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.body.id}/submit`)
      .set('Authorization', `Bearer ${member.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.body.id}/validate`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);

    const first = await request(app)
      .post(`/api/procedures/${procedure.id}/acknowledge`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/procedures/${procedure.id}/acknowledge`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(second.status).toBe(201);
  });

  it("apparaît dans le suivi personnel (my_acknowledgment sur GET /:id) pour celui qui a lu, jamais pour un autre", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [reader, other] = tenant.users;
    const procedure = await createProcedure(tenant.admin.token, 'PROC-031');
    const version = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${reader.token}`)
      .send({});
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.body.id}/submit`)
      .set('Authorization', `Bearer ${reader.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.body.id}/validate`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);

    const beforeAck = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${reader.token}`);
    expect(beforeAck.body.my_acknowledgment).toBeNull();

    await request(app)
      .post(`/api/procedures/${procedure.id}/acknowledge`)
      .set('Authorization', `Bearer ${reader.token}`)
      .expect(201);

    const afterAck = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${reader.token}`);
    expect(afterAck.body.my_acknowledgment).not.toBeNull();
    expect(afterAck.body.my_acknowledgment.acknowledged_at).toBeTruthy();

    const otherView = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(otherView.body.my_acknowledgment).toBeNull();
  });
});

describe('GET /api/procedures/:id — historique des versions', () => {
  it('renvoie les versions avec auteur/validateur résolus', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const validator = tenant.users[0];
    const procedure = await createProcedure(tenant.admin.token, 'PROC-050');
    const version = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.body.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.body.id}/validate`)
      .set('Authorization', `Bearer ${validator.token}`)
      .expect(200);

    const res = await request(app).get(`/api/procedures/${procedure.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.versions).toHaveLength(1);
    expect(res.body.versions[0].author.id).toBe(tenant.admin.id);
    expect(res.body.versions[0].validator.id).toBe(validator.id);
    expect(res.body.current_version.id).toBe(version.body.id);
  });
});

describe('GET /api/procedures — filtres', () => {
  it('filtre par statut et recherche texte', async () => {
    tenant = await createTenant();
    await createProcedure(tenant.admin.token, 'PROC-040', { title: 'Gestion des achats' });
    await createProcedure(tenant.admin.token, 'PROC-041', { title: 'Maîtrise documentaire' });

    const byStatus = await request(app)
      .get('/api/procedures')
      .query({ status: 'draft' })
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(byStatus.status).toBe(200);
    expect(byStatus.body).toHaveLength(2);

    const bySearch = await request(app)
      .get('/api/procedures')
      .query({ search: 'achats' })
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(bySearch.status).toBe(200);
    expect(bySearch.body.map((p) => p.number)).toEqual(['PROC-040']);
  });

  it("n'expose jamais les procédures d'un autre tenant, même à un admin", async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      await createProcedure(tenant.admin.token, 'PROC-050');
      await createProcedure(otherTenant.admin.token, 'PROC-051');

      const res = await request(app)
        .get('/api/procedures')
        .set('Authorization', `Bearer ${tenant.admin.token}`);

      expect(res.status).toBe(200);
      expect(res.body.map((p) => p.number)).toEqual(['PROC-050']);
    } finally {
      await otherTenant.cleanup();
    }
  });

  it('filtre par processus', async () => {
    tenant = await createTenant();
    await createProcedure(tenant.admin.token, 'PROC-042', { process: 'Achats' });
    await createProcedure(tenant.admin.token, 'PROC-043', { process: 'Production' });

    const res = await request(app)
      .get('/api/procedures')
      .query({ process: 'Achats' })
      .set('Authorization', `Bearer ${tenant.admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.number)).toEqual(['PROC-042']);
  });

  it('search trouve aussi une procédure par le contenu de sa version courante, pas seulement numéro/titre', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const validator = tenant.users[0];
    const withMatch = await createProcedure(tenant.admin.token, 'PROC-044', { title: 'Maîtrise des enregistrements' });
    const withoutMatch = await createProcedure(tenant.admin.token, 'PROC-045', { title: 'Nettoyage des locaux' });

    const version = await request(app)
      .post(`/api/procedures/${withMatch.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        content: {
          sections: [{ key: 'etapes', label: 'Étapes', content: 'Chaque autoclave doit être vérifié avant utilisation.' }],
        },
      });
    expect(version.status).toBe(201);
    await request(app)
      .post(`/api/procedures/${withMatch.id}/versions/${version.body.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${withMatch.id}/versions/${version.body.id}/validate`)
      .set('Authorization', `Bearer ${validator.token}`)
      .expect(200);

    const res = await request(app)
      .get('/api/procedures')
      .query({ search: 'autoclave' })
      .set('Authorization', `Bearer ${tenant.admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.number)).toEqual([withMatch.number]);
    expect(res.body.map((p) => p.number)).not.toContain(withoutMatch.number);
  });

  // Colonnes exactement consommées par l'export CSV/Excel de la liste côté frontend
  // (Procedures.jsx#buildExportColumns) : ce test protège le contrat de données dont cet
  // export dépend, pas le rendu du fichier lui-même (CSV généré côté client, Excel générique
  // et déjà couvert par reports.test.js).
  it('GET / renvoie tous les champs consommés par les colonnes d’export (version courante, date de validation, auteur, validateur)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const validator = tenant.users[0];
    const procedure = await createProcedure(tenant.admin.token, 'PROC-046', { process: 'Qualité' });
    const version = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    expect(version.status).toBe(201);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.body.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.body.id}/validate`)
      .set('Authorization', `Bearer ${validator.token}`)
      .expect(200);

    const res = await request(app).get('/api/procedures').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);

    const row = res.body.find((p) => p.number === 'PROC-046');
    expect(row.title).toBe(procedure.title);
    expect(row.status).toBe('approved');
    expect(row.next_review_date).toBeNull();
    expect(row.current_version.version).toBe('1.0');
    expect(row.current_version.validated_at).toBeTruthy();
    expect(row.current_version.author.id).toBe(tenant.admin.id);
    expect(row.current_version.validator.id).toBe(validator.id);
  });
});

describe('POST /api/procedures/:id/obsolete', () => {
  it('un member ne peut pas, un admin peut (même niveau que la validation), et la procédure disparaît de la liste par défaut', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const procedure = await createProcedure(tenant.admin.token, 'PROC-060');

    const forbidden = await request(app)
      .post(`/api/procedures/${procedure.id}/obsolete`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ reason: 'Remplacée par PROC-999' });
    expect(forbidden.status).toBe(403);

    const obsoleted = await request(app)
      .post(`/api/procedures/${procedure.id}/obsolete`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ reason: 'Remplacée par PROC-999' });
    expect(obsoleted.status).toBe(200);
    expect(obsoleted.body.status).toBe('obsolete');
    expect(obsoleted.body.obsolete_reason).toBe('Remplacée par PROC-999');
    expect(obsoleted.body.obsoleted_by).toBe(tenant.admin.id);
    expect(obsoleted.body.obsoleted_at).not.toBeNull();

    const alreadyObsolete = await request(app)
      .post(`/api/procedures/${procedure.id}/obsolete`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(alreadyObsolete.status).toBe(409);

    const defaultList = await request(app)
      .get('/api/procedures')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(defaultList.body.map((p) => p.number)).not.toContain('PROC-060');

    const obsoleteFilter = await request(app)
      .get('/api/procedures')
      .query({ status: 'obsolete' })
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(obsoleteFilter.body.map((p) => p.number)).toContain('PROC-060');
  });
});

describe('Traçabilité inverse Procédures <-> CAPA', () => {
  it('un lien créé apparaît des deux côtés (GET procédure ET GET CAPA), et disparaît des deux côtés une fois retiré', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-070');
    const capaRes = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Non-conformité ayant entraîné une révision' });
    expect(capaRes.status).toBe(201);
    const capa = capaRes.body;

    const linked = await request(app)
      .post(`/api/procedures/${procedure.id}/link-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ capa_id: capa.id });
    expect(linked.status).toBe(201);

    const duplicate = await request(app)
      .post(`/api/procedures/${procedure.id}/link-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ capa_id: capa.id });
    expect(duplicate.status).toBe(409);

    const procedureAfterLink = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(procedureAfterLink.body.linked_capas.map((c) => c.id)).toEqual([capa.id]);

    const capaAfterLink = await request(app)
      .get(`/api/capas/${capa.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(capaAfterLink.body.linked_procedures.map((p) => p.id)).toEqual([procedure.id]);

    const unlinked = await request(app)
      .delete(`/api/procedures/${procedure.id}/link-capa/${capa.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(unlinked.status).toBe(204);

    const procedureAfterUnlink = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(procedureAfterUnlink.body.linked_capas).toEqual([]);

    const capaAfterUnlink = await request(app)
      .get(`/api/capas/${capa.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(capaAfterUnlink.body.linked_procedures).toEqual([]);

    const unlinkAgain = await request(app)
      .delete(`/api/procedures/${procedure.id}/link-capa/${capa.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(unlinkAgain.status).toBe(404);
  });

  it("un CAPA ou une procédure d'un autre tenant ne peut pas être lié", async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      const procedure = await createProcedure(tenant.admin.token, 'PROC-071');
      const otherCapaRes = await request(app)
        .post('/api/capas')
        .set('Authorization', `Bearer ${otherTenant.admin.token}`)
        .send({ title: 'CAPA d’un autre tenant' });
      expect(otherCapaRes.status).toBe(201);

      const res = await request(app)
        .post(`/api/procedures/${procedure.id}/link-capa`)
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ capa_id: otherCapaRes.body.id });
      expect(res.status).toBe(404);
    } finally {
      await otherTenant.cleanup();
    }
  });
});

describe("Isolation multi-tenant sur l'ensemble des routes du module (pas seulement la liste)", () => {
  it("un id d'un autre tenant est traité comme introuvable sur détail, création de version, édition, workflow, obsolescence, suppression et export PDF", async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      const foreignProcedure = await createProcedure(otherTenant.admin.token, 'PROC-I01');
      const foreignVersionRes = await request(app)
        .post(`/api/procedures/${foreignProcedure.id}/versions`)
        .set('Authorization', `Bearer ${otherTenant.admin.token}`)
        .send({});
      expect(foreignVersionRes.status).toBe(201);
      const foreignVersion = foreignVersionRes.body;

      const detail = await request(app)
        .get(`/api/procedures/${foreignProcedure.id}`)
        .set('Authorization', `Bearer ${tenant.admin.token}`);
      expect(detail.status).toBe(404);

      const newVersion = await request(app)
        .post(`/api/procedures/${foreignProcedure.id}/versions`)
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({});
      expect(newVersion.status).toBe(404);

      const edit = await request(app)
        .put(`/api/procedures/${foreignProcedure.id}/versions/${foreignVersion.id}`)
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ content: { objet: 'Tentative' } });
      expect(edit.status).toBe(404);

      const submit = await request(app)
        .post(`/api/procedures/${foreignProcedure.id}/versions/${foreignVersion.id}/submit`)
        .set('Authorization', `Bearer ${tenant.admin.token}`);
      expect(submit.status).toBe(404);

      const obsolete = await request(app)
        .post(`/api/procedures/${foreignProcedure.id}/obsolete`)
        .set('Authorization', `Bearer ${tenant.admin.token}`);
      expect(obsolete.status).toBe(404);

      const pdf = await request(app)
        .get(`/api/procedures/${foreignProcedure.id}/pdf`)
        .set('Authorization', `Bearer ${tenant.admin.token}`);
      expect(pdf.status).toBe(404);

      const del = await request(app)
        .delete(`/api/procedures/${foreignProcedure.id}`)
        .set('Authorization', `Bearer ${tenant.admin.token}`);
      expect(del.status).toBe(404);

      // Rien de tout ça n'a pu modifier la procédure de l'autre tenant, malgré des tentatives
      // avec un token admin valide (juste pas du bon tenant).
      const stillThere = await admin.from('procedures').select('id, status').eq('id', foreignProcedure.id).maybeSingle();
      expect(stillThere.data).not.toBeNull();
      expect(stillThere.data.status).toBe('draft');
    } finally {
      await otherTenant.cleanup();
    }
  });
});

describe('DELETE /api/procedures/:id', () => {
  async function createVersion(token, procedureId, extra = {}) {
    const res = await request(app)
      .post(`/api/procedures/${procedureId}/versions`)
      .set('Authorization', `Bearer ${token}`)
      .send(extra);
    expect(res.status).toBe(201);
    return res.body;
  }

  it('refusée dès qu\'une version a été soumise au moins une fois, même rejetée depuis', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-080');
    const version = await createVersion(tenant.admin.token, procedure.id);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/reject`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ comment: 'À revoir.' })
      .expect(200);

    const res = await request(app)
      .delete(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(400);

    const { data: stillThere } = await admin.from('procedures').select('id').eq('id', procedure.id).maybeSingle();
    expect(stillThere).not.toBeNull();
  });

  it("acceptée quand toutes les versions sont encore en brouillon ; réservée à l'auteur ou à un admin (pas un manager)", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }] });
    const [manager, other] = tenant.users;
    const procedure = await createProcedure(other.token, 'PROC-081');
    await createVersion(other.token, procedure.id);

    const forbiddenManager = await request(app)
      .delete(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${manager.token}`);
    expect(forbiddenManager.status).toBe(403);

    const res = await request(app)
      .delete(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(res.status).toBe(204);

    const { data: gone } = await admin.from('procedures').select('id').eq('id', procedure.id).maybeSingle();
    expect(gone).toBeNull();
  });

  it('un admin peut supprimer la procédure brouillon de quelqu’un d’autre', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const procedure = await createProcedure(member.token, 'PROC-082');

    const res = await request(app)
      .delete(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(204);
  });
});

describe('GET /api/procedures/:id/pdf', () => {
  async function createVersion(token, procedureId, extra = {}) {
    const res = await request(app)
      .post(`/api/procedures/${procedureId}/versions`)
      .set('Authorization', `Bearer ${token}`)
      .send(extra);
    expect(res.status).toBe(201);
    return res.body;
  }

  it('400 tant qu’aucune version n’existe', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-090');

    const res = await request(app)
      .get(`/api/procedures/${procedure.id}/pdf`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(400);
  });

  it('conserve le sommaire personnalisé dans le PDF en plus du sommaire automatique', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-090A');
    await createVersion(tenant.admin.token, procedure.id, {
      content: {
        sections: [
          { key: 'sommaire', label: 'Sommaire', blocks: [{ type: 'liste_puces', id: 'toc-note', items: ['Note personnalisée du sommaire'] }] },
          { key: 'objectif', label: 'Objectifs', blocks: [{ type: 'paragraphe', id: 'p1', text: 'Objectif de test.' }] },
          { key: 'processus', label: 'Processus', blocks: [{ type: 'paragraphe', id: 'p2', text: 'Processus de test.' }] },
        ],
      },
    });

    const res = await request(app)
      .get(`/api/procedures/${procedure.id}/pdf`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob');

    expect(res.status).toBe(200);
    const { text } = await pdfParse(Buffer.from(res.body));
    expect(text).toContain('Notes du sommaire');
    expect(text).toContain('Note personnalisée du sommaire');
    expect(text).toContain('Objectifs');
    expect(text).toContain('Processus');
  });

  it('conserve les tableaux de formulaire sans en-tête dans le PDF', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-090AA');
    await createVersion(tenant.admin.token, procedure.id, {
      content: {
        sections: [
          {
            key: 'formulaire',
            label: 'Formulaire',
            blocks: [
              {
                type: 'tableau',
                hasHeader: false,
                headers: ['Colonne 1', 'Colonne 2'],
                rows: [['Date', ''], ['Référence produit', '']],
              },
            ],
          },
        ],
      },
    });

    const res = await request(app)
      .get(`/api/procedures/${procedure.id}/pdf`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob');

    expect(res.status).toBe(200);
    const { text } = await pdfParse(Buffer.from(res.body));
    expect(text).toContain('Date');
    expect(text).toContain('Référence produit');
    expect(text).not.toContain('Colonne 1');
  });

  it('signale un brouillon et une révision échue, avec une couverture, un sommaire et le corps sur une page distincte', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-090B', { next_review_date: '2020-01-01' });
    await createVersion(tenant.admin.token, procedure.id, {
      content: {
        sections: [
          { key: 'objectif', label: 'Objectif', blocks: [{ type: 'paragraphe', id: 'p1', text: 'Objectif de test.' }] },
          { key: 'champ', label: 'Champ', blocks: [{ type: 'paragraphe', id: 'p2', text: 'Champ de test.' }] },
          { key: 'processus', label: 'Processus', blocks: [{ type: 'paragraphe', id: 'p3', text: 'Processus de test.' }] },
        ],
      },
    });

    const res = await request(app)
      .get(`/api/procedures/${procedure.id}/pdf`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob');

    expect(res.status).toBe(200);
    const { text, numpages } = await pdfParse(Buffer.from(res.body));
    expect(text).toContain('Version non approuvée');
    expect(text).toContain('Révision en retard');
    expect(text).toContain('Sommaire');
    expect(text).toContain('Page 1 sur 3');
    expect(text.indexOf('DATE DE CRÉATION')).toBeLessThan(text.indexOf('Sommaire'));
    expect(text.indexOf('Sommaire')).toBeLessThan(text.indexOf('Objectif de test.'));
    expect(numpages).toBe(3);
  });

  it('génère un PDF pour la version courante, avec sections du gabarit, documents associés, et encadré obsolescence', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const validator = tenant.users[0];
    const procedure = await createProcedure(tenant.admin.token, 'PROC-091');
    const version = await createVersion(tenant.admin.token, procedure.id, {
      content: {
        objet: 'Objet de test',
        domaine_application: 'Domaine de test',
        responsabilites: 'Responsabilités de test',
        sections: [
          { key: 'etapes', label: 'Étapes du processus', content: 'Détail des étapes.' },
          { key: 'enregistrements', label: 'Enregistrements', content: 'Détail des enregistrements.' },
        ],
        documents_associes: ['Formulaire F-01', 'Formulaire F-02'],
      },
    });
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/validate`)
      .set('Authorization', `Bearer ${validator.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${procedure.id}/obsolete`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ reason: 'Test PDF.' })
      .expect(200);

    const res = await request(app)
      .get(`/api/procedures/${procedure.id}/pdf`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const buffer = Buffer.from(res.body);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('POST /api/procedures/:id/versions/:versionId/export-word', () => {
  async function createVersion(token, procedureId, extra = {}) {
    const res = await request(app)
      .post(`/api/procedures/${procedureId}/versions`)
      .set('Authorization', `Bearer ${token}`)
      .send(extra);
    expect(res.status).toBe(201);
    return res.body;
  }

  it('404 sur une version inconnue', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-110');

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/00000000-0000-0000-0000-000000000000/export-word`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(404);
  });

  it('génère un .docx pour un brouillon (aucune restriction de statut, contrairement à distribution-sheet), avec le style personnalisé du tenant', async () => {
    tenant = await createTenant();
    await request(app)
      .put('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ section_structure: [{ key: 'deroule_processus', label: 'Déroulé du processus' }], accent_color: '#1f5c5c' })
      .expect(200);

    const procedure = await createProcedure(tenant.admin.token, 'PROC-111');
    const version = await createVersion(tenant.admin.token, procedure.id, {
      content: {
        sections: [{ key: 'deroule_processus', label: 'Déroulé du processus', blocks: [{ type: 'paragraphe', id: 'b1', text: 'Détail du déroulé.' }] }],
        documents_associes: ['Formulaire F-01'],
      },
    });
    expect(version.status).toBe('draft');

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/export-word`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(res.headers['content-disposition']).toContain(`${procedure.number}.docx`);
    const buffer = Buffer.from(res.body);
    expect(buffer.subarray(0, 2).toString()).toBe('PK'); // signature ZIP (.docx est un conteneur ZIP)
  });

  it('isole par tenant (404 depuis un autre tenant)', async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      const procedure = await createProcedure(tenant.admin.token, 'PROC-112');
      const version = await createVersion(tenant.admin.token, procedure.id);

      const res = await request(app)
        .post(`/api/procedures/${procedure.id}/versions/${version.id}/export-word`)
        .set('Authorization', `Bearer ${otherTenant.admin.token}`);
      expect(res.status).toBe(404);
    } finally {
      await otherTenant.cleanup();
    }
  });
});

describe('Pièce jointe de version (attachment)', () => {
  async function createVersion(token, procedureId, extra = {}) {
    const res = await request(app)
      .post(`/api/procedures/${procedureId}/versions`)
      .set('Authorization', `Bearer ${token}`)
      .send(extra);
    expect(res.status).toBe(201);
    return res.body;
  }

  it('refusée pour un autre rédacteur, et une fois la version soumise', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [author, other] = tenant.users;
    const procedure = await createProcedure(tenant.admin.token, 'PROC-101');
    const version = await createVersion(author.token, procedure.id);

    const forbidden = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/attachment`)
      .set('Authorization', `Bearer ${other.token}`)
      .attach('file', Buffer.from('contenu'), 'fichier.pdf');
    expect(forbidden.status).toBe(403);

    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${author.token}`)
      .expect(200);

    const afterSubmit = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/attachment`)
      .set('Authorization', `Bearer ${author.token}`)
      .attach('file', Buffer.from('contenu'), 'fichier.pdf');
    expect(afterSubmit.status).toBe(409);
  });

  it('une pièce jointe est récupérable via GET /api/procedures/:id (détail), et retirable', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-102');
    const version = await createVersion(tenant.admin.token, procedure.id);

    // L'upload réel passe par Google Drive (voir le test précédent : refusé sans connexion
    // configurée), indisponible dans cet environnement de test — on simule directement ce que
    // la route persiste après un upload réussi, pour vérifier ce qui est demandé : que la
    // pièce jointe déjà attachée ressort bien de l'API de détail, dans les deux sens.
    const { error: seedError } = await admin
      .from('procedure_versions')
      .update({
        attachment_file_path: 'fake-drive-file-id',
        attachment_file_name: 'procedure-officielle.pdf',
        attachment_storage_provider: 'google_drive',
      })
      .eq('id', version.id);
    expect(seedError).toBeNull();

    const detail = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.status).toBe(200);
    const versionInDetail = detail.body.versions.find((v) => v.id === version.id);
    expect(versionInDetail.attachment_file_name).toBe('procedure-officielle.pdf');
    expect(versionInDetail.attachment_file_path).toBe('fake-drive-file-id');

    const removed = await request(app)
      .delete(`/api/procedures/${procedure.id}/versions/${version.id}/attachment`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(removed.status).toBe(200);
    expect(removed.body.attachment_file_name).toBeNull();

    const detailAfter = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detailAfter.body.versions.find((v) => v.id === version.id).attachment_file_name).toBeNull();
  });

  it('GET .../attachment : 404 sans pièce jointe, url signée quand elle existe', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-103');
    const version = await createVersion(tenant.admin.token, procedure.id);

    const missing = await request(app)
      .get(`/api/procedures/${procedure.id}/versions/${version.id}/attachment`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(missing.status).toBe(404);

    await admin
      .from('procedure_versions')
      .update({
        attachment_file_path: 'fake-drive-file-id',
        attachment_file_name: 'procedure-officielle.pdf',
        attachment_storage_provider: 'google_drive',
      })
      .eq('id', version.id);

    const res = await request(app)
      .get(`/api/procedures/${procedure.id}/versions/${version.id}/attachment`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('/api/documents/drive-file?ticket=');
  });
});
