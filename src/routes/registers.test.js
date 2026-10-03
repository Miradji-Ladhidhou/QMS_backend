import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

describe('Document Registers — Registres documentaires personnalisables', () => {
  it('renomme un dossier pour tous ses registres sans toucher aux autres dossiers', async () => {
    tenant = await createTenant();
    const authorization = `Bearer ${tenant.admin.token}`;
    const first = await request(app).post('/api/registers')
      .set('Authorization', authorization)
      .send({ title: 'Registre A', folder: 'À classer' });
    const second = await request(app).post('/api/registers')
      .set('Authorization', authorization)
      .send({ title: 'Registre B', folder: 'À classer' });
    const other = await request(app).post('/api/registers')
      .set('Authorization', authorization)
      .send({ title: 'Registre C', folder: 'Autre dossier' });

    const renamed = await request(app).patch('/api/registers/folders/rename')
      .set('Authorization', authorization)
      .send({ folder: 'À classer', new_name: 'Archives qualité' });

    expect(renamed.status).toBe(200);
    expect(renamed.body.updated_count).toBe(2);
    const list = await request(app).get('/api/registers').set('Authorization', authorization);
    expect(list.body.find((register) => register.id === first.body.id).folder).toBe('Archives qualité');
    expect(list.body.find((register) => register.id === second.body.id).folder).toBe('Archives qualité');
    expect(list.body.find((register) => register.id === other.body.id).folder).toBe('Autre dossier');
  });

  it('importe un classeur courant dans un registre vide et adapte ses colonnes', async () => {
    tenant = await createTenant();
    const created = await request(app).post('/api/registers')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Suivi fournisseurs' });
    expect(created.status).toBe(201);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Données');
    sheet.addRow(['Fournisseur', 'Statut']);
    sheet.addRow(['Atelier A', 'Qualifié']);
    sheet.addRow(['Atelier B', 'En attente']);
    const file = Buffer.from(await workbook.xlsx.writeBuffer());
    const imported = await request(app).post(`/api/registers/${created.body.id}/import`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', file, 'fournisseurs.xlsx');

    expect(imported.status).toBe(200);
    expect(imported.body.imported).toBe(2);
    const detail = await request(app).get(`/api/registers/${created.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.columns.map((column) => column.name)).toEqual(['Fournisseur', 'Statut']);
    expect(detail.body.rows.map((row) => row.data.col_import_1)).toEqual(['Atelier A', 'Atelier B']);

    const otherWorkbook = new ExcelJS.Workbook();
    const otherSheet = otherWorkbook.addWorksheet('Compléments');
    otherSheet.addRow(['Fournisseur', 'Contact']);
    otherSheet.addRow(['Atelier C', 'contact@example.com']);
    const otherFile = Buffer.from(await otherWorkbook.xlsx.writeBuffer());
    const appended = await request(app).post(`/api/registers/${created.body.id}/import`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', otherFile, 'contacts.xlsx');
    expect(appended.status).toBe(200);
    const updated = await request(app).get(`/api/registers/${created.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(updated.body.columns.map((column) => column.name)).toEqual(['Fournisseur', 'Statut', 'Contact']);
    expect(updated.body.rows_count).toBe(3);
    expect(updated.body.rows[0].data.col_import_2).toBe('Qualifié');
    expect(updated.body.rows[2].data.col_import_1).toBe('Atelier C');
  });

  it('création de registre avec colonnes personnalisées, ajout de ligne, et export Excel', async () => {
    tenant = await createTenant();

    // 1. Créer un registre
    const createRes = await request(app)
      .post('/api/registers')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        title: 'Registre des exigences légales',
        folder: 'Veille réglementaire',
        description: 'Suivi de la veille réglementaire',
        columns: [
          { id: 'col_ref', name: 'Texte / Référence', type: 'text' },
          { id: 'col_due', name: 'Échéance', type: 'date', is_planning: true },
          { id: 'col_status', name: 'Statut', type: 'select', options: ['Conforme', 'À réviser'] },
        ],
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.title).toBe('Registre des exigences légales');
    expect(createRes.body.folder).toBe('Veille réglementaire');
    expect(createRes.body.columns.length).toBe(3);

    const registerId = createRes.body.id;

    // 2. Ajouter une ligne
    const addRowRes = await request(app)
      .post(`/api/registers/${registerId}/rows`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        data: {
          col_ref: 'Norme ISO 9001:2015',
          col_due: '2026-10-20',
          col_status: 'Conforme',
        },
      });

    expect(addRowRes.status).toBe(201);
    expect(addRowRes.body.planning_date).toBe('2026-10-20');
    expect(addRowRes.body.planning_title).toBe('Norme ISO 9001:2015');

    // 3. Vérifier la présence dans le planning
    const planningRes = await request(app)
      .get('/api/planning')
      .set('Authorization', `Bearer ${tenant.admin.token}`);

    expect(planningRes.status).toBe(200);
    const registerItem = planningRes.body.items.find((item) => item.type === 'register');
    expect(registerItem).toBeDefined();
    expect(registerItem.title).toContain('Norme ISO 9001:2015');
    expect(registerItem.date).toBe('2026-10-20');

    // 4. Télécharger l'export Excel
    const exportRes = await request(app)
      .get(`/api/registers/${registerId}/export-xlsx`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob');

    expect(exportRes.status).toBe(200);
    expect(exportRes.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(exportRes.headers['content-disposition']).toContain('tableur-registre.xlsx');
    expect(exportRes.body.length).toBeGreaterThan(1000);

    const importRes = await request(app)
      .post(`/api/registers/${registerId}/import`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', exportRes.body, 'registre.xlsx');

    expect(importRes.status).toBe(200);
    expect(importRes.body.imported).toBe(1);

    const detailRes = await request(app)
      .get(`/api/registers/${registerId}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detailRes.body.rows_count).toBe(2);
    expect(detailRes.body.rows[1].data.col_due).toBe('2026-10-20');

    const invalidImportRes = await request(app)
      .post(`/api/registers/${registerId}/import`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', Buffer.from('not an Excel workbook'), 'registre.xlsx');
    expect(invalidImportRes.status).toBe(400);

    const unchangedRes = await request(app)
      .get(`/api/registers/${registerId}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(unchangedRes.body.rows_count).toBe(2);

    const moveRes = await request(app)
      .patch(`/api/registers/${registerId}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ folder: 'Archives' });
    expect(moveRes.status).toBe(200);
    expect(moveRes.body.folder).toBe('Archives');
  });
});
