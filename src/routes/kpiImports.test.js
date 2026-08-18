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

const FAKE_IMPORT_ID = '00000000-0000-0000-0000-000000000000';

// Régression : les 3 routes d'écriture de ce fichier (dépôt de fichier, apply, evaluate)
// n'avaient aucune restriction de rôle — un member pouvait importer des données dans un KPI
// en appelant l'API directement, seul le wizard frontend le lui interdisait visuellement.
// Le rôle est vérifié avant tout accès aux données (requireRole tourne avant le handler),
// donc un importId ou une config bidon suffit à prouver le rejet — la route ne va jamais
// jusqu'à les résoudre pour un rôle non autorisé.
describe('POST /api/kpi-imports — écritures réservées à admin/manager', () => {
  it('403 pour un member sur le dépôt de fichier, 201 pour un manager', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const csv = Buffer.from('periode,valeur\n2026-01-01,42\n');

    const memberAttempt = await request(app)
      .post('/api/kpi-imports')
      .set('Authorization', `Bearer ${member.token}`)
      .attach('file', csv, 'test.csv');
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await request(app)
      .post('/api/kpi-imports')
      .set('Authorization', `Bearer ${manager.token}`)
      .attach('file', csv, 'test.csv');
    expect(managerAttempt.status).toBe(201);
  });

  it('403 pour un member sur /:importId/apply', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const res = await request(app)
      .post(`/api/kpi-imports/${FAKE_IMPORT_ID}/apply`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ config_id: FAKE_IMPORT_ID });
    expect(res.status).toBe(403);
  });

  it('403 pour un member sur /:importId/evaluate', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const res = await request(app)
      .post(`/api/kpi-imports/${FAKE_IMPORT_ID}/evaluate`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ calc_type: 'sum' });
    expect(res.status).toBe(403);
  });
});
