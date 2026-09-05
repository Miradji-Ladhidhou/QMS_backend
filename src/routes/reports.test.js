import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

describe('POST /api/reports/table-pdf', () => {
  it('401 sans authentification', async () => {
    const res = await request(app)
      .post('/api/reports/table-pdf')
      .send({ title: 'Rapport', columns: [{ key: 'a', label: 'A' }], rows: [] });
    expect(res.status).toBe(401);
  });

  it('400 si titre ou colonnes manquants', async () => {
    tenant = await createTenant();

    const noTitle = await request(app)
      .post('/api/reports/table-pdf')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ columns: [{ key: 'a', label: 'A' }], rows: [] });
    expect(noTitle.status).toBe(400);

    const noColumns = await request(app)
      .post('/api/reports/table-pdf')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Rapport', columns: [], rows: [] });
    expect(noColumns.status).toBe(400);
  });

  it('200 avec un PDF valide, pour tout rôle authentifié (aucune restriction de rôle — voir ai.js pour le même principe)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const res = await request(app)
      .post('/api/reports/table-pdf')
      .set('Authorization', `Bearer ${member.token}`)
      .responseType('blob')
      .send({
        title: 'Registre des risques',
        subtitle: '3 risques',
        columns: [
          { key: 'title', label: 'Titre', width: 0.6 },
          { key: 'status', label: 'Statut', width: 0.4 },
        ],
        rows: [
          { title: 'Panne serveur', status: 'Identifié' },
          { title: 'Fournisseur unique', status: 'Traité' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const buffer = Buffer.from(res.body);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('200 avec generatedBy fourni (traçabilité — voir listReportPdf.js)', async () => {
    tenant = await createTenant();

    const res = await request(app)
      .post('/api/reports/table-pdf')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob')
      .send({
        title: 'Registre des risques',
        subtitle: '1 risque',
        generatedBy: 'Marie Dupont',
        columns: [{ key: 'title', label: 'Titre' }],
        rows: [{ title: 'Panne serveur' }],
      });

    expect(res.status).toBe(200);
    const buffer = Buffer.from(res.body);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('génère un PDF valide sur un tableau à 10 colonnes (bascule automatique en paysage)', async () => {
    tenant = await createTenant();
    const columns = Array.from({ length: 10 }, (_, i) => ({ key: `c${i}`, label: `Colonne ${i}` }));
    const rows = [Object.fromEntries(columns.map((col) => [col.key, `Valeur ${col.key}`]))];

    const res = await request(app)
      .post('/api/reports/table-pdf')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob')
      .send({ title: 'Rapport large', columns, rows });

    expect(res.status).toBe(200);
    const buffer = Buffer.from(res.body);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('POST /api/reports/table-xlsx', () => {
  it('401 sans authentification', async () => {
    const res = await request(app)
      .post('/api/reports/table-xlsx')
      .send({ title: 'Rapport', columns: [{ key: 'a', label: 'A' }], rows: [] });
    expect(res.status).toBe(401);
  });

  it('400 si titre ou colonnes manquants', async () => {
    tenant = await createTenant();

    const noTitle = await request(app)
      .post('/api/reports/table-xlsx')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ columns: [{ key: 'a', label: 'A' }], rows: [] });
    expect(noTitle.status).toBe(400);
  });

  it('200 avec un classeur Excel valide (signature ZIP, .xlsx est un conteneur ZIP)', async () => {
    tenant = await createTenant();

    const res = await request(app)
      .post('/api/reports/table-xlsx')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob')
      .send({
        title: 'Registre des risques',
        subtitle: '2 risques',
        generatedBy: 'Marie Dupont',
        columns: [
          { key: 'title', label: 'Titre' },
          { key: 'status', label: 'Statut' },
        ],
        rows: [
          { title: 'Panne serveur', status: 'Identifié' },
          { title: 'Fournisseur unique', status: '' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const buffer = Buffer.from(res.body);
    // Signature de fichier ZIP (PK\x03\x04) : un .xlsx est un conteneur ZIP.
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
  });
});

describe('POST /api/reports/table-word', () => {
  it('401 sans authentification', async () => {
    const res = await request(app)
      .post('/api/reports/table-word')
      .send({ title: 'Rapport', columns: [{ key: 'a', label: 'A' }], rows: [] });
    expect(res.status).toBe(401);
  });

  it('400 si titre ou colonnes manquants', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .post('/api/reports/table-word')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ columns: [{ key: 'a', label: 'A' }], rows: [] });
    expect(res.status).toBe(400);
  });

  it('200 avec un document Word valide (signature ZIP, .docx est un conteneur ZIP)', async () => {
    tenant = await createTenant();

    const res = await request(app)
      .post('/api/reports/table-word')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob')
      .send({
        title: 'Registre des risques',
        subtitle: '2 risques',
        generatedBy: 'Marie Dupont',
        columns: [
          { key: 'title', label: 'Titre' },
          { key: 'status', label: 'Statut' },
        ],
        rows: [
          { title: 'Panne serveur', status: 'Identifié' },
          { title: 'Fournisseur unique', status: '' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const buffer = Buffer.from(res.body);
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
  });

  it('200 quand rows est vide (message de repli plutôt qu’un tableau sans lignes)', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .post('/api/reports/table-word')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob')
      .send({ title: 'Registre vide', columns: [{ key: 'title', label: 'Titre' }], rows: [] });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/reports/table-csv', () => {
  it('401 sans authentification', async () => {
    const res = await request(app)
      .post('/api/reports/table-csv')
      .send({ title: 'Rapport', columns: [{ key: 'a', label: 'A' }], rows: [] });
    expect(res.status).toBe(401);
  });

  it('400 si titre ou colonnes manquants', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .post('/api/reports/table-csv')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ columns: [{ key: 'a', label: 'A' }], rows: [] });
    expect(res.status).toBe(400);
  });

  it('200 avec un CSV valide (BOM UTF-8, séparateur point-virgule, bloc méta)', async () => {
    tenant = await createTenant();

    const res = await request(app)
      .post('/api/reports/table-csv')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        title: 'Registre des risques',
        subtitle: '2 risques',
        generatedBy: 'Marie Dupont',
        columns: [
          { key: 'title', label: 'Titre' },
          { key: 'status', label: 'Statut' },
        ],
        rows: [
          { title: 'Panne serveur', status: 'Identifié' },
          { title: 'Virgule; et "guillemets"', status: '' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const lines = res.text.slice(1).split('\r\n');
    expect(lines[0]).toBe('Registre des risques');
    expect(lines[1]).toContain('Marie Dupont');
    expect(lines[2]).toBe('2 risques');
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe('Titre;Statut');
    expect(lines[5]).toBe('Panne serveur;Identifié');
    expect(lines[6]).toBe('"Virgule; et ""guillemets""";');
  });
});
