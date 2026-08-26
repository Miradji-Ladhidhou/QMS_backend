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

function historyHeaders() {
  const headers = {};
  for (let i = 1; i <= 10; i += 1) {
    headers[`historyVersion${i}`] = `Historique V${i} - Version`;
    headers[`historyDate${i}`] = `Historique V${i} - Date (JJ/MM/AAAA)`;
    headers[`historyComment${i}`] = `Historique V${i} - Commentaire`;
  }
  return headers;
}

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
  ...historyHeaders(),
};

async function buildImportFile(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Documents');
  sheet.columns = Object.entries(IMPORT_HEADERS).map(([key, header]) => ({ header, key }));
  rows.forEach((row) => sheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

async function downloadTemplateWorkbook(token) {
  const res = await request(app)
    .get('/api/documents/import-template.xlsx')
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((response, callback) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body);
  return workbook;
}

describe('GET /api/documents/import-template.xlsx', () => {
  it('contient la colonne Statut, le libellé renommé "Prochaine révision" et 10 emplacements d\'historique', async () => {
    tenant = await createTenant();
    const workbook = await downloadTemplateWorkbook(tenant.admin.token);
    const sheet = workbook.getWorksheet('Documents');
    const headerRow = sheet.getRow(1).values.filter(Boolean);

    expect(headerRow).toContain('Statut');
    expect(headerRow).toContain('Prochaine révision (JJ/MM/AAAA)');
    expect(headerRow).not.toContain('Date de révision (JJ/MM/AAAA)');
    expect(headerRow).toContain('Historique V1 - Version');
    expect(headerRow).toContain('Historique V1 - Date (JJ/MM/AAAA)');
    expect(headerRow).toContain('Historique V1 - Commentaire');
    expect(headerRow).toContain('Historique V10 - Version');
    expect(headerRow).toContain('Historique V10 - Date (JJ/MM/AAAA)');
    expect(headerRow).toContain('Historique V10 - Commentaire');
    expect(headerRow).not.toContain('Historique V11 - Version');
  });

  it("l'exemple d'historique de version tient sur une seule ligne (pas deux lignes avec le même Numéro)", async () => {
    tenant = await createTenant();
    const workbook = await downloadTemplateWorkbook(tenant.admin.token);
    const sheet = workbook.getWorksheet('Documents');

    // Une seule ligne d'exemple (ligne 1 = en-têtes, ligne 2 = exemple), pas de ligne 3.
    expect(sheet.getRow(3).values.filter((v) => v !== undefined && v !== null)).toHaveLength(0);
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

describe('POST /api/documents/import — historique de versions (colonnes Historique Vn)', () => {
  it('les créneaux Historique V1/V2 remplis créent le document courant + 2 versions archivées', async () => {
    tenant = await createTenant();
    const file = await buildImportFile([
      {
        number: 'QP-100',
        title: 'Procédure la plus récente',
        version: '2.0',
        status: 'Approuvé',
        createdAt: '01/01/2023',
        historyVersion1: '1.0',
        historyDate1: '01/01/2023',
        historyVersion2: '1.1',
        historyDate2: '15/06/2023',
      },
    ]);

    const res = await request(app)
      .post('/api/documents/import')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', file, 'import.xlsx');

    expect(res.status).toBe(201);
    expect(res.body.created_count).toBe(1);
    expect(res.body.archived_count).toBe(2);

    const row = res.body.results.find((r) => r.number === 'QP-100');
    expect(row.status).toBe('created');
    expect(row.message).toMatch(/2 version\(s\) archivée/);

    const { data: doc } = await admin
      .from('documents')
      .select('id, title, version, status')
      .eq('number', 'QP-100')
      .single();
    expect(doc.title).toBe('Procédure la plus récente');
    expect(doc.version).toBe('2.0');
    expect(doc.status).toBe('approved');

    const { data: versions } = await admin
      .from('document_versions')
      .select('version, created_at')
      .eq('document_id', doc.id)
      .order('version', { ascending: true });
    expect(versions.map((v) => v.version)).toEqual(['1.0', '1.1']);
    expect(versions[0].created_at.slice(0, 10)).toBe('2023-01-01');
    expect(versions[1].created_at.slice(0, 10)).toBe('2023-06-15');
  });

  it('le commentaire d\'un créneau est archivé comme change_note, séparément du numéro de version', async () => {
    tenant = await createTenant();
    const file = await buildImportFile([
      {
        number: 'QP-COMMENT',
        title: 'Historique commenté',
        historyVersion1: '1.0',
        historyDate1: '01/01/2023',
        historyComment1: 'Création initiale.',
        historyVersion2: '1.1',
        historyDate2: '15/06/2024',
        historyComment2: 'Modification structure plus ajout process.',
      },
    ]);

    const res = await request(app)
      .post('/api/documents/import')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', file, 'import.xlsx');

    expect(res.status).toBe(201);
    expect(res.body.archived_count).toBe(2);

    const { data: doc } = await admin.from('documents').select('id').eq('number', 'QP-COMMENT').single();
    const { data: versions } = await admin
      .from('document_versions')
      .select('version, change_note')
      .eq('document_id', doc.id)
      .order('version', { ascending: true });
    expect(versions).toEqual([
      { version: '1.0', change_note: 'Création initiale.' },
      { version: '1.1', change_note: 'Modification structure plus ajout process.' },
    ]);
  });

  it('un créneau sans commentaire archive change_note à null (pas de chaîne vide)', async () => {
    tenant = await createTenant();
    const file = await buildImportFile([
      { number: 'QP-NO-COMMENT', title: 'Sans commentaire', historyVersion1: '1.0', historyDate1: '01/01/2023' },
    ]);

    const res = await request(app)
      .post('/api/documents/import')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', file, 'import.xlsx');

    expect(res.status).toBe(201);
    const { data: doc } = await admin.from('documents').select('id').eq('number', 'QP-NO-COMMENT').single();
    const { data: versions } = await admin.from('document_versions').select('change_note').eq('document_id', doc.id);
    expect(versions[0].change_note).toBeNull();
  });

  it('un créneau vide (ni version ni date) est ignoré — aucune version archivée créée', async () => {
    tenant = await createTenant();
    const file = await buildImportFile([{ number: 'QP-EMPTY', title: 'Sans historique' }]);

    const res = await request(app)
      .post('/api/documents/import')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', file, 'import.xlsx');

    expect(res.status).toBe(201);
    expect(res.body.archived_count).toBe(0);

    const { data: doc } = await admin.from('documents').select('id').eq('number', 'QP-EMPTY').single();
    const { data: versions } = await admin.from('document_versions').select('id').eq('document_id', doc.id);
    expect(versions).toHaveLength(0);
  });

  it('un créneau avec seulement une date (version manquante) est complété avec un avertissement, pas rejeté', async () => {
    tenant = await createTenant();
    const file = await buildImportFile([
      { number: 'QP-PARTIAL', title: 'Historique partiel', historyDate1: '01/01/2023' },
    ]);

    const res = await request(app)
      .post('/api/documents/import')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', file, 'import.xlsx');

    expect(res.status).toBe(201);
    const row = res.body.results.find((r) => r.number === 'QP-PARTIAL');
    expect(row.status).toBe('warning');
    expect(row.message).toMatch(/version manquante/);

    const { data: doc } = await admin.from('documents').select('id').eq('number', 'QP-PARTIAL').single();
    const { data: versions } = await admin.from('document_versions').select('version').eq('document_id', doc.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe('v1');
  });

  it('les 10 emplacements peuvent tous être remplis sur une seule ligne', async () => {
    tenant = await createTenant();
    const row = { number: 'QP-FULL', title: 'Dix versions historiques' };
    for (let i = 1; i <= 10; i += 1) {
      row[`historyVersion${i}`] = `${i}.0`;
      row[`historyDate${i}`] = `0${(i % 9) + 1}/01/2020`;
    }
    const file = await buildImportFile([row]);

    const res = await request(app)
      .post('/api/documents/import')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', file, 'import.xlsx');

    expect(res.status).toBe(201);
    expect(res.body.archived_count).toBe(10);

    const { data: doc } = await admin.from('documents').select('id').eq('number', 'QP-FULL').single();
    const { data: versions } = await admin.from('document_versions').select('id').eq('document_id', doc.id);
    expect(versions).toHaveLength(10);
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

  it('un Numéro répété sur deux lignes du même fichier est rejeté (pas un mécanisme de version)', async () => {
    tenant = await createTenant();
    const file = await buildImportFile([
      { number: 'DOC-DUPE', title: 'Première ligne' },
      { number: 'DOC-DUPE', title: 'Deuxième ligne, même numéro' },
    ]);

    const res = await request(app)
      .post('/api/documents/import')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', file, 'import.xlsx');

    expect(res.status).toBe(201);
    expect(res.body.created_count).toBe(1);
    expect(res.body.error_count).toBe(1);
    const errorRow = res.body.results.find((r) => r.row === 3);
    expect(errorRow.status).toBe('error');
    expect(errorRow.message).toMatch(/déjà utilisé/);
  });
});
