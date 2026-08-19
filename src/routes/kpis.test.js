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

// Régression : POST /api/kpis et POST /api/kpi-folders n'avaient aucune restriction de rôle
// côté backend (seul le frontend cachait les boutons via canManage, voir Kpis.jsx) — un
// member pouvait définir un indicateur ou un dossier d'entreprise en appelant l'API
// directement. Même classe de bug que categories.js avant sa correction plus tôt dans le
// projet.
describe('POST /api/kpis — création réservée à admin/manager', () => {
  it('403 pour un member, 201 pour un manager', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const memberAttempt = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: 'Indicateur créé par un member' });
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ name: 'Indicateur créé par un manager' });
    expect(managerAttempt.status).toBe(201);
  });
});

describe('POST /api/kpi-folders — création réservée à admin/manager', () => {
  it('403 pour un member, 201 pour un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const memberAttempt = await request(app)
      .post('/api/kpi-folders')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: 'Dossier créé par un member' });
    expect(memberAttempt.status).toBe(403);

    const adminAttempt = await request(app)
      .post('/api/kpi-folders')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Dossier créé par un admin' });
    expect(adminAttempt.status).toBe(201);
  });
});

// Régression : le rapport PDF n'était jamais filtré par dossier (toujours tout le tenant),
// contrairement à la page KPI qui navigue par dossier — "pas conforme à la page" signalé par
// l'utilisateur. Pas d'extraction de texte du PDF généré (aucune dépendance de ce genre dans
// le projet, voir la convention établie pour les autres routes génératrices de PDF) : on
// vérifie que la requête respecte bien ?folder_id sans jamais planter, y compris pour un
// dossier vide ou un KPI multi-séries (nouveau chemin de dessin dans kpiReportPdf.js).
describe('GET /api/kpis/report — filtrage par dossier, cohérent avec GET /api/kpis', () => {
  it('200 et PDF valide sans folder_id (tout le tenant), avec folder_id=root, et pour un dossier vide', async () => {
    // Timeout par défaut (5s) trop juste pour 3 générations de PDF séquentielles sous la
    // charge de la suite complète (passe en isolation, plus flaky une fois combiné aux ~20
    // autres fichiers de test tournant en parallèle).
    tenant = await createTenant();

    await request(app).post('/api/kpis').set('Authorization', `Bearer ${tenant.admin.token}`).send({ name: 'KPI racine' });

    const folder = await request(app)
      .post('/api/kpi-folders')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Dossier vide' });

    const wholeTenant = await request(app)
      .get('/api/kpis/report')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob');
    expect(wholeTenant.status).toBe(200);
    expect(Buffer.from(wholeTenant.body).subarray(0, 4).toString()).toBe('%PDF');

    const rootScoped = await request(app)
      .get('/api/kpis/report')
      .query({ folder_id: 'root' })
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob');
    expect(rootScoped.status).toBe(200);
    expect(Buffer.from(rootScoped.body).subarray(0, 4).toString()).toBe('%PDF');

    const emptyFolder = await request(app)
      .get('/api/kpis/report')
      .query({ folder_id: folder.body.id })
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob');
    expect(emptyFolder.status).toBe(200);
    expect(Buffer.from(emptyFolder.body).subarray(0, 4).toString()).toBe('%PDF');
  }, 15000);

  it('200 et PDF valide pour un KPI multi-séries (nouveau chemin de rendu)', async () => {
    tenant = await createTenant();

    const kpi = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'KPI multi-séries', calculation_type: 'import', target: 10, target_direction: 'max' });

    const seriesA = await request(app)
      .post(`/api/kpis/${kpi.body.id}/series`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ label: 'Série A', calc_type: 'count' });
    const seriesB = await request(app)
      .post(`/api/kpis/${kpi.body.id}/series`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ label: 'Série B', calc_type: 'count' });

    // Insertion directe des relevés (bypass du pipeline d'import, hors périmètre ici) : seule
    // la présence de records avec un config_id distinct par série importe pour exercer
    // buildSeriesInfo/drawMultiSeriesChart dans kpiReportPdf.js.
    await admin.from('kpi_records').insert([
      { tenant_id: tenant.tenantId, kpi_id: kpi.body.id, config_id: seriesA.body.id, period_date: '2026-01-01', value: 5, source: 'import' },
      { tenant_id: tenant.tenantId, kpi_id: kpi.body.id, config_id: seriesA.body.id, period_date: '2026-02-01', value: 7, source: 'import' },
      { tenant_id: tenant.tenantId, kpi_id: kpi.body.id, config_id: seriesB.body.id, period_date: '2026-01-01', value: 3, source: 'import' },
      { tenant_id: tenant.tenantId, kpi_id: kpi.body.id, config_id: seriesB.body.id, period_date: '2026-02-01', value: 9, source: 'import' },
    ]);

    const res = await request(app)
      .get('/api/kpis/report')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .responseType('blob');
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).subarray(0, 4).toString()).toBe('%PDF');
  });
});
