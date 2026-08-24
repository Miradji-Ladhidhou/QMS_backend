import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

const IMPORT_HEADERS = {
  number: 'Numéro *',
  title: 'Titre *',
  description: 'Description',
  category: 'Catégorie',
  version: 'Version',
  status: 'Statut',
  createdAt: 'Date de création (JJ/MM/AAAA)',
  reviewDate: 'Prochaine révision (JJ/MM/AAAA)',
  reviewFrequency: 'Fréquence de révision (mois)',
};

async function buildImportFile(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Documents');
  sheet.columns = Object.entries(IMPORT_HEADERS).map(([key, header]) => ({ header, key }));
  rows.forEach((row) => sheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

describe('GET /api/documents/import-template.xlsx', () => {
  it('contient la colonne Statut et le libellé renommé "Prochaine révision"', async () => {
    tenant = await createTenant();

    const res = await request(app)
      .get('/api/documents/import-template.xlsx')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    const sheet = workbook.getWorksheet('Documents');
    const headerRow = sheet.getRow(1).values.filter(Boolean);

    expect(headerRow).toContain('Statut');
    expect(headerRow).toContain('Prochaine révision (JJ/MM/AAAA)');
    expect(headerRow).not.toContain('Date de révision (JJ/MM/AAAA)');
  });
});

describe('POST /api/documents/import — statut', () => {
  it('sans colonne Statut renseignée, le document est créé en Brouillon (comportement historique)', async () => {
    tenant = await createTenant();
    const file = await buildImportFile([{ number: 'DOC-A', title: 'Doc A' }]);

    const res = await request(app)
      .post('/api/documents/import')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', file, 'import.xlsx');

    expect(res.status).toBe(201);
    expect(res.body.created_count).toBe(1);

    const { data } = await admin.from('documents').select('status').eq('number', 'DOC-A').single();
    expect(data.status).toBe('draft');
  });

  it('"Approuvé" dans la colonne Statut crée directement le document en statut approuvé', async () => {
    tenant = await createTenant();
    const file = await buildImportFile([{ number: 'DOC-B', title: 'Doc B', status: 'Approuvé' }]);

    const res = await request(app)
      .post('/api/documents/import')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', file, 'import.xlsx');

    expect(res.status).toBe(201);
    const row = res.body.results.find((r) => r.number === 'DOC-B');
    expect(row.status).toBe('created');

    const { data } = await admin.from('documents').select('status').eq('number', 'DOC-B').single();
    expect(data.status).toBe('approved');
  });

  it('un statut non reconnu retombe en Brouillon avec un avertissement, sans bloquer la ligne', async () => {
    tenant = await createTenant();
    const file = await buildImportFile([{ number: 'DOC-C', title: 'Doc C', status: 'Validé' }]);

    const res = await request(app)
      .post('/api/documents/import')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', file, 'import.xlsx');

    expect(res.status).toBe(201);
    const row = res.body.results.find((r) => r.number === 'DOC-C');
    expect(row.status).toBe('warning');
    expect(row.message).toMatch(/Statut/);

    const { data } = await admin.from('documents').select('status').eq('number', 'DOC-C').single();
    expect(data.status).toBe('draft');
  });
});

describe('POST /api/documents/import — historique de versions (même Numéro sur plusieurs lignes)', () => {
  it('crée un seul document (la ligne la plus récente) et archive les autres comme versions passées', async () => {
    tenant = await createTenant();
    const file = await buildImportFile([
      {
        number: 'QP-100',
        title: 'Procédure v1',
        version: '1.0',
        status: 'Obsolète',
        createdAt: '01/01/2023',
      },
      {
        number: 'QP-100',
        title: 'Procédure v2',
        version: '2.0',
        status: 'Approuvé',
        createdAt: '15/06/2024',
      },
    ]);

    const res = await request(app)
      .post('/api/documents/import')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', file, 'import.xlsx');

    expect(res.status).toBe(201);
    expect(res.body.created_count).toBe(1);
    expect(res.body.archived_count).toBe(1);

    const row1 = res.body.results.find((r) => r.row === 2);
    const row2 = res.body.results.find((r) => r.row === 3);
    expect(row1.status).toBe('archived');
    expect(row2.status).toBe('created');

    const { data: doc } = await admin
      .from('documents')
      .select('id, title, version, status, created_at')
      .eq('number', 'QP-100')
      .single();
    expect(doc.title).toBe('Procédure v2');
    expect(doc.version).toBe('2.0');
    expect(doc.status).toBe('approved');
    // La date de création du document reste celle de la toute première version (2023), pas de
    // la version courante (2024).
    expect(doc.created_at.slice(0, 4)).toBe('2023');

    const { data: versions } = await admin.from('document_versions').select('version, status').eq('document_id', doc.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe('1.0');
    expect(versions[0].status).toBe('obsolete');
  });

  it("l'ordre des lignes dans le fichier n'a pas d'importance, seule la date compte", async () => {
    tenant = await createTenant();
    // v2 (plus récente) écrite AVANT v1 dans le fichier.
    const file = await buildImportFile([
      { number: 'QP-200', title: 'Plus récente', version: '2.0', createdAt: '15/06/2024' },
      { number: 'QP-200', title: 'Plus ancienne', version: '1.0', createdAt: '01/01/2023' },
    ]);

    const res = await request(app)
      .post('/api/documents/import')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', file, 'import.xlsx');

    expect(res.status).toBe(201);
    const { data: doc } = await admin.from('documents').select('title, version').eq('number', 'QP-200').single();
    expect(doc.title).toBe('Plus récente');
    expect(doc.version).toBe('2.0');
  });

  it('trois versions du même document : deux archivées, une courante', async () => {
    tenant = await createTenant();
    const file = await buildImportFile([
      { number: 'QP-300', title: 'V1', version: '1.0', createdAt: '01/01/2022' },
      { number: 'QP-300', title: 'V2', version: '2.0', createdAt: '01/01/2023' },
      { number: 'QP-300', title: 'V3', version: '3.0', createdAt: '01/01/2024' },
    ]);

    const res = await request(app)
      .post('/api/documents/import')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', file, 'import.xlsx');

    expect(res.status).toBe(201);
    expect(res.body.created_count).toBe(1);
    expect(res.body.archived_count).toBe(2);

    const { data: doc } = await admin.from('documents').select('id, title').eq('number', 'QP-300').single();
    expect(doc.title).toBe('V3');
    const { data: versions } = await admin.from('document_versions').select('version').eq('document_id', doc.id);
    expect(versions.map((v) => v.version).sort()).toEqual(['1.0', '2.0']);
  });
});

describe('POST /api/documents/import — comportements existants préservés', () => {
  it('un Numéro déjà présent en base est toujours refusé', async () => {
    tenant = await createTenant();
    await admin.from('documents').insert({ tenant_id: tenant.tenantId, number: 'DOC-EXIST', title: 'Déjà là' });

    const file = await buildImportFile([{ number: 'DOC-EXIST', title: 'Nouvelle tentative' }]);
    const res = await request(app)
      .post('/api/documents/import')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', file, 'import.xlsx');

    expect(res.status).toBe(201);
    const row = res.body.results.find((r) => r.number === 'DOC-EXIST');
    expect(row.status).toBe('error');
    expect(row.message).toMatch(/déjà utilisé/);
  });
});
