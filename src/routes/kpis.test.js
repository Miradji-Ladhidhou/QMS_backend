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

// calc_type = 'manual' (migration 26) : une série sans recette de calcul, servant à regrouper
// des valeurs saisies à la main sous plusieurs courbes distinctes d'un même KPI "manuel" —
// même mécanisme que les séries import (kpi_calculation_configs), mais alimentées par
// POST /:id/records au lieu du pipeline d'import.
describe('KPI manuel à plusieurs séries (calc_type = "manual")', () => {
  it('POST /:id/series accepte calc_type "manual" avec juste un label', async () => {
    tenant = await createTenant();
    const kpi = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Taux de conformité par ligne' });

    const series = await request(app)
      .post(`/api/kpis/${kpi.body.id}/series`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ label: 'Ligne A', calc_type: 'manual' });
    expect(series.status).toBe(201);
    expect(series.body.calc_type).toBe('manual');
    expect(series.body.source_column).toBeNull();
  });

  it('POST /:id/records avec config_id : plusieurs séries peuvent chacune avoir leur valeur sur la même période', async () => {
    tenant = await createTenant();
    const kpi = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Taux de conformité par ligne' });

    const seriesA = await request(app)
      .post(`/api/kpis/${kpi.body.id}/series`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ label: 'Ligne A', calc_type: 'manual' });
    const seriesB = await request(app)
      .post(`/api/kpis/${kpi.body.id}/series`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ label: 'Ligne B', calc_type: 'manual' });

    const recordA = await request(app)
      .post(`/api/kpis/${kpi.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ period_date: '2026-01-01', value: 95, config_id: seriesA.body.id });
    expect(recordA.status).toBe(201);
    expect(recordA.body.config_id).toBe(seriesA.body.id);

    // Même période, série différente : ne doit pas entrer en conflit avec recordA malgré
    // l'index unique (kpi_id, period_date) où config_id est null — ici config_id est non-null
    // pour les deux, régis par la contrainte unique (config_id, period_date) à la place.
    const recordB = await request(app)
      .post(`/api/kpis/${kpi.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ period_date: '2026-01-01', value: 88, config_id: seriesB.body.id });
    expect(recordB.status).toBe(201);

    // Mais la même série ne peut pas avoir deux valeurs pour la même période.
    const conflict = await request(app)
      .post(`/api/kpis/${kpi.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ period_date: '2026-01-01', value: 99, config_id: seriesA.body.id });
    expect(conflict.status).toBe(409);
  });

  it("400 si config_id ne correspond à aucune série de ce KPI (ex : série d'un autre KPI)", async () => {
    tenant = await createTenant();
    const kpiA = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'KPI A' });
    const kpiB = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'KPI B' });
    const seriesOfB = await request(app)
      .post(`/api/kpis/${kpiB.body.id}/series`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ label: 'Série de B', calc_type: 'manual' });

    const res = await request(app)
      .post(`/api/kpis/${kpiA.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ period_date: '2026-01-01', value: 10, config_id: seriesOfB.body.id });
    expect(res.status).toBe(400);
  });

  it('sans config_id, le comportement historique (un seul point par période) est inchangé', async () => {
    tenant = await createTenant();
    const kpi = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'KPI simple' });

    const first = await request(app)
      .post(`/api/kpis/${kpi.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ period_date: '2026-01-01', value: 10 });
    expect(first.status).toBe(201);
    expect(first.body.config_id).toBeNull();

    const conflict = await request(app)
      .post(`/api/kpis/${kpi.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ period_date: '2026-01-01', value: 20 });
    expect(conflict.status).toBe(409);
  });
});

describe('POST/PATCH /api/kpis — responsable (owner)', () => {
  it('accepte un responsable à la création et à la modification, renvoyé avec son nom', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const created = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'KPI avec responsable', owner: manager.id });
    expect(created.status).toBe(201);
    expect(created.body.owner).toBe(manager.id);
    expect(created.body.owner_user.full_name).toBe('Test manager');

    const updated = await request(app)
      .patch(`/api/kpis/${created.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ owner: null });
    expect(updated.status).toBe(200);
    expect(updated.body.owner).toBeNull();
  });
});

describe('POST /api/kpis/:id/create-capa — lien bidirectionnel', () => {
  it('crée une CAPA liée dans les deux sens, assignée par défaut au responsable du KPI', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const kpi = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Taux de service', unit: '%', target: 95, target_direction: 'min', owner: manager.id });

    const res = await request(app)
      .post(`/api/kpis/${kpi.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Taux de service hors objectif' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Taux de service hors objectif');
    expect(res.body.kpi_id).toBe(kpi.body.id);
    expect(res.body.assigned_to).toBe(manager.id);

    const { data: kpiRow } = await admin.from('kpis').select('linked_capa_id').eq('id', kpi.body.id).single();
    expect(kpiRow.linked_capa_id).toBe(res.body.id);

    const kpiDetail = await request(app).get(`/api/kpis/${kpi.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(kpiDetail.body.linked_capa.id).toBe(res.body.id);
  });

  it('assigned_to explicite prime sur le responsable du KPI ; reste null si aucun des deux', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'manager' }] });
    const [owner, assignee] = tenant.users;
    const kpiWithOwner = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'KPI avec responsable', owner: owner.id });

    const withExplicitAssignee = await request(app)
      .post(`/api/kpis/${kpiWithOwner.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA', assigned_to: assignee.id });
    expect(withExplicitAssignee.body.assigned_to).toBe(assignee.id);

    const kpiWithoutOwner = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'KPI sans responsable' });

    const withoutOwnerOrAssignee = await request(app)
      .post(`/api/kpis/${kpiWithoutOwner.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA' });
    expect(withoutOwnerOrAssignee.body.assigned_to).toBeNull();
  });

  it('refuse un member, 404 sur un KPI d’un autre tenant, et exige un titre', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const otherTenant = await createTenant();
    try {
      const kpi = await request(app)
        .post('/api/kpis')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ name: 'KPI protégé' });

      const memberAttempt = await request(app)
        .post(`/api/kpis/${kpi.body.id}/create-capa`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ title: 'CAPA' });
      expect(memberAttempt.status).toBe(403);

      const foreignAttempt = await request(app)
        .post(`/api/kpis/${kpi.body.id}/create-capa`)
        .set('Authorization', `Bearer ${otherTenant.admin.token}`)
        .send({ title: 'CAPA' });
      expect(foreignAttempt.status).toBe(404);

      const missingTitle = await request(app)
        .post(`/api/kpis/${kpi.body.id}/create-capa`)
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ title: '' });
      expect(missingTitle.status).toBe(400);
    } finally {
      await otherTenant.cleanup();
    }
  });
});
