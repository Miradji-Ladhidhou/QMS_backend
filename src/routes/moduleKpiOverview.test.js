import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';
import { MODULE_KPI_PRESETS } from '../services/moduleKpiSources.js';
import { ESSENTIAL_PRESET_IDS, MODULE_KPI_DOMAINS, MODULE_KPI_FOLDER_NAME, domainOfPreset } from '../services/moduleKpiCatalog.js';
import { buildComparisons, statusOf, suggestTarget, yearAgo } from '../services/moduleKpiOverview.js';

// « Suivre l'essentiel » crée une trentaine de KPI et leur premier calcul : sous la charge de toute la suite, 5 s ne suffisent pas.
vi.setConfig({ testTimeout: 60000 });

const tenants = [];
afterEach(async () => {
  while (tenants.length) await tenants.pop().cleanup();
});

async function newTenant(options) {
  const tenant = await createTenant(options);
  tenants.push(tenant);
  return tenant;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const overview = async (token) => (await request(app).get('/api/kpis/module-overview').set(auth(token))).body;
const indicator = (data, presetId) => data.domains.flatMap((domain) => domain.indicators).find((item) => item.preset_id === presetId);
const enable = (tenant, body = {}, token = tenant.admin.token) => request(app).post('/api/kpis/module-overview/enable-essentials').set(auth(token)).send(body);

describe('Catalogue : domaines et noyau essentiel', () => {
  it('chaque preset appartient à un domaine ; chaque essentiel existe, dans son domaine ; 2 à 4 essentiels par domaine', () => {
    for (const preset of MODULE_KPI_PRESETS) expect(domainOfPreset(preset), preset.id).not.toBeNull();
    const ids = new Set(MODULE_KPI_PRESETS.map((preset) => preset.id));
    for (const domain of MODULE_KPI_DOMAINS) {
      expect(domain.essential.length).toBeGreaterThanOrEqual(2);
      expect(domain.essential.length).toBeLessThanOrEqual(4);
      for (const id of domain.essential) {
        expect(ids.has(id), id).toBe(true);
        expect(domain.modules).toContain(MODULE_KPI_PRESETS.find((preset) => preset.id === id).module);
      }
    }
    expect(new Set(ESSENTIAL_PRESET_IDS).size).toBe(ESSENTIAL_PRESET_IDS.length);
    expect(ESSENTIAL_PRESET_IDS.length).toBeLessThanOrEqual(32);
    expect(MODULE_KPI_PRESETS.length).toBeGreaterThan(ESSENTIAL_PRESET_IDS.length * 2);
  });
});

describe('Calculs : état, comparaisons, objectif suggéré', () => {
  it('statusOf : plafond / plancher, marge de 10 % « à surveiller », neutre sans objectif ni valeur', () => {
    expect(statusOf(4, 5, 'max')).toBe('good');
    expect(statusOf(5, 5, 'max')).toBe('good');
    expect(statusOf(5.4, 5, 'max')).toBe('warning');
    expect(statusOf(6, 5, 'max')).toBe('bad');
    expect(statusOf(95, 90, 'min')).toBe('good');
    expect(statusOf(85, 90, 'min')).toBe('warning');
    expect(statusOf(50, 90, 'min')).toBe('bad');
    expect(statusOf(1, 0, 'max')).toBe('bad'); // objectif 0 : tout écart est hors objectif
    expect(statusOf(0, 0, 'max')).toBe('good');
    expect(statusOf(null, 5, 'max')).toBe('neutral');
    expect(statusOf(3, null, 'max')).toBe('neutral');
  });

  it('buildComparisons : précédente, même période l’an dernier, moyenne des 6 précédentes ; null sans historique', () => {
    expect(buildComparisons([])).toEqual({ latest: null, previous: null, year_ago: null, average_6: null });
    const one = buildComparisons([{ period_date: '2026-06-01', value: 4 }]);
    expect(one).toEqual({ latest: { period_date: '2026-06-01', value: 4 }, previous: null, year_ago: null, average_6: null });

    const points = [
      { period_date: '2025-06-01', value: 10 },
      { period_date: '2026-01-01', value: 8 },
      { period_date: '2026-02-01', value: 6 },
      { period_date: '2026-03-01', value: 4 },
      { period_date: '2026-04-01', value: 4 },
      { period_date: '2026-05-01', value: 2 },
      { period_date: '2026-06-01', value: 1 },
    ];
    const result = buildComparisons(points);
    expect(result.latest.value).toBe(1);
    expect(result.previous).toEqual({ period_date: '2026-05-01', value: 2 });
    expect(result.year_ago).toEqual({ period_date: '2025-06-01', value: 10 });
    expect(result.average_6).toEqual({ count: 6, value: 5.67 }); // les 6 périodes précédentes : 10, 8, 6, 4, 4, 2
    expect(yearAgo('2026-06-01')).toBe('2025-06-01');
  });

  it('suggestTarget : meilleure valeur des 6 dernières périodes (min pour un plafond, max pour un plancher)', () => {
    const points = [3, 5, 4, 2, 6, 3, 4].map((value, index) => ({ period_date: `2026-0${index + 1}-01`, value }));
    expect(suggestTarget(points, 'max')).toBe(2);
    expect(suggestTarget(points, 'min')).toBe(6);
    expect(suggestTarget([{ period_date: '2026-01-01', value: 3 }], 'max')).toBeNull();
    expect(suggestTarget([], 'min')).toBeNull();
  });
});

describe('Vue « Indicateurs des modules » (API)', () => {
  it('sans rien de suivi : tous les indicateurs sont proposés, essentiels d’abord, aucun compté', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const data = await overview(tenant.users[0].token); // lisible par tout rôle
    expect(data.domains.map((domain) => domain.key)).toEqual(MODULE_KPI_DOMAINS.map((domain) => domain.key));
    expect(data.summary).toEqual({ tracked: 0, good: 0, warning: 0, bad: 0, essential_total: ESSENTIAL_PRESET_IDS.length, essential_tracked: 0 });
    const actions = data.domains.find((domain) => domain.key === 'actions');
    expect(actions.indicators.slice(0, 4).map((item) => item.preset_id)).toEqual(MODULE_KPI_DOMAINS[0].essential);
    expect(actions.indicators.slice(0, 4).every((item) => item.essential)).toBe(true);
    expect(actions.indicators.slice(4).every((item) => !item.essential)).toBe(true);
    expect(indicator(data, 'capa_overdue_backlog')).toMatchObject({ tracked: false, kpi_id: null, default_target: 0, default_direction: 'max', unit: 'CAPA', snapshot: true });
    expect(data.domains.reduce((sum, domain) => sum + domain.indicators.length, 0)).toBe(MODULE_KPI_PRESETS.length);
  });

  it('« suivre l’essentiel » crée les KPI rangés dans un dossier dédié, une seule fois ; réservé à admin/manager', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    expect((await enable(tenant, {}, tenant.users[0].token)).status).toBe(403);

    // Une CAPA en retard : l'indicateur « CAPA en retard » doit le refléter dès le premier calcul.
    await request(app).post('/api/capas').set(auth(tenant.admin.token)).send({ title: 'CAPA en retard', origin: 'Test', due_date: '2020-01-01' }).expect(201);

    const first = await enable(tenant);
    expect(first.status).toBe(201);
    expect(first.body.failed).toEqual([]);
    expect(first.body.created).toHaveLength(ESSENTIAL_PRESET_IDS.length);

    const second = await enable(tenant);
    expect(second.body.created).toEqual([]);

    const { data: folders } = await admin.from('kpi_folders').select('id, name').eq('tenant_id', tenant.tenantId);
    expect(folders).toHaveLength(1);
    expect(folders[0].name).toBe(MODULE_KPI_FOLDER_NAME);
    const { data: kpis } = await admin.from('kpis').select('module_preset_id, folder_id, calculation_type').eq('tenant_id', tenant.tenantId);
    expect(kpis).toHaveLength(ESSENTIAL_PRESET_IDS.length);
    expect(kpis.every((kpi) => kpi.folder_id === folders[0].id && kpi.calculation_type === 'module')).toBe(true);
    expect(new Set(kpis.map((kpi) => kpi.module_preset_id)).size).toBe(ESSENTIAL_PRESET_IDS.length);

    const data = await overview(tenant.admin.token);
    expect(data.summary.tracked).toBe(ESSENTIAL_PRESET_IDS.length);
    expect(data.summary.essential_tracked).toBe(ESSENTIAL_PRESET_IDS.length);
    const overdue = indicator(data, 'capa_overdue_backlog');
    expect(overdue).toMatchObject({ tracked: true, target: 0, target_direction: 'max', status: 'bad', target_changed: false });
    expect(overdue.latest.value).toBe(1);
    expect(overdue.previous).toBeNull(); // un seul relevé : la photo d'aujourd'hui, pas encore d'historique
    expect(overdue.series).toHaveLength(1);
    expect(data.summary.good + data.summary.warning + data.summary.bad).toBeLessThanOrEqual(data.summary.tracked);
  });

  it('« suivre l’essentiel » peut se limiter à certains domaines', async () => {
    const tenant = await newTenant();
    const res = await enable(tenant, { domains: ['risks', 'safety'] });
    expect(res.body.created.sort()).toEqual([...MODULE_KPI_DOMAINS.find((d) => d.key === 'risks').essential, ...MODULE_KPI_DOMAINS.find((d) => d.key === 'safety').essential].sort());
    expect((await enable(tenant, { domains: 'risks' })).status).toBe(400);
    const data = await overview(tenant.admin.token);
    expect(data.domains.find((domain) => domain.key === 'risks').counts.tracked).toBe(3);
    expect(data.domains.find((domain) => domain.key === 'actions').counts.tracked).toBe(0);
  });

  it('suivre un indicateur seul (route existante) le range dans le dossier des indicateurs et retient son preset', async () => {
    const tenant = await newTenant();
    const res = await request(app).post('/api/kpis/from-module-preset').set(auth(tenant.admin.token)).send({ preset_id: 'capa_open_backlog' });
    expect(res.status).toBe(201);
    expect(res.body.module_preset_id).toBe('capa_open_backlog');
    const { data: folder } = await admin.from('kpi_folders').select('id, name').eq('id', res.body.folder_id).single();
    expect(folder.name).toBe(MODULE_KPI_FOLDER_NAME);
    expect(indicator(await overview(tenant.admin.token), 'capa_open_backlog')).toMatchObject({ tracked: true, kpi_id: res.body.id });

    // Un dossier choisi explicitement est respecté.
    const custom = await request(app).post('/api/kpi-folders').set(auth(tenant.admin.token)).send({ name: 'Mon dossier' });
    const other = await request(app).post('/api/kpis/from-module-preset').set(auth(tenant.admin.token)).send({ preset_id: 'capa_overdue_backlog', folder_id: custom.body.id });
    expect(other.body.folder_id).toBe(custom.body.id);
  });

  it('rattache aux presets les KPI de module créés avant module_preset_id (même nom, même module)', async () => {
    const tenant = await newTenant();
    const preset = MODULE_KPI_PRESETS.find((item) => item.id === 'complaint_received_count');
    const { data: legacy } = await admin
      .from('kpis')
      .insert({ tenant_id: tenant.tenantId, name: preset.label, unit: preset.unit, target: 9, target_direction: 'max', frequency: 'monthly', calculation_type: 'module', source_module: preset.module })
      .select('id')
      .single();
    const data = await overview(tenant.admin.token);
    expect(indicator(data, 'complaint_received_count')).toMatchObject({ tracked: true, kpi_id: legacy.id, target: 9, target_changed: true });
    const { data: stored } = await admin.from('kpis').select('module_preset_id').eq('id', legacy.id).single();
    expect(stored.module_preset_id).toBe('complaint_received_count');
    // Un KPI de module sans preset connu (nom personnalisé) n'est pas rattaché.
    await admin.from('kpis').insert({ tenant_id: tenant.tenantId, name: 'Mon KPI perso', frequency: 'monthly', calculation_type: 'module', source_module: 'capa' });
    expect((await overview(tenant.admin.token)).summary.tracked).toBe(1);
  });

  it('comparaisons et objectif suggéré d’après l’historique des relevés', async () => {
    const tenant = await newTenant();
    const res = await request(app).post('/api/kpis/from-module-preset').set(auth(tenant.admin.token)).send({ preset_id: 'capa_open_backlog' });
    const { data: config } = await admin.from('kpi_calculation_configs').select('id').eq('kpi_id', res.body.id).single();
    const now = new Date();
    const month = (offset) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1)).toISOString().slice(0, 10);
    await admin.from('kpi_records').delete().eq('kpi_id', res.body.id);
    const values = [12, 10, 9, 8, 6, 5, 4]; // du plus ancien (il y a 6 mois) au plus récent
    await admin.from('kpi_records').insert(values.map((value, index) => ({ tenant_id: tenant.tenantId, kpi_id: res.body.id, config_id: config.id, period_date: month(6 - index), value, source: 'module' })));
    await admin.from('kpi_records').insert({ tenant_id: tenant.tenantId, kpi_id: res.body.id, config_id: config.id, period_date: month(12), value: 20, source: 'module' });

    const item = indicator(await overview(tenant.admin.token), 'capa_open_backlog');
    expect(item.latest).toEqual({ period_date: month(0), value: 4 });
    expect(item.previous).toEqual({ period_date: month(1), value: 5 });
    expect(item.year_ago).toEqual({ period_date: month(12), value: 20 });
    expect(item.average_6).toEqual({ count: 6, value: 8.33 }); // les 6 périodes précédant la dernière : 12, 10, 9, 8, 6, 5 (le relevé d'il y a 12 mois est plus ancien)
    expect(item.series).toHaveLength(8);
    expect(item.target).toBe(10);
    expect(item.status).toBe('good');
    expect(item.suggested_target).toBe(4); // plafond : meilleure (plus basse) valeur des 6 dernières périodes
  });

  it('un KPI rangé dans une catégorie restreinte n’apparaît pas comme suivi pour un member sans accès', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const category = await request(app).post('/api/module-categories').set(auth(tenant.admin.token)).send({ resource_type: 'kpi', name: 'Confidentiel', is_restricted: true });
    expect(category.status).toBe(201);
    const res = await request(app).post('/api/kpis/from-module-preset').set(auth(tenant.admin.token)).send({ preset_id: 'capa_open_backlog', category_id: category.body.id });
    expect(res.status).toBe(201);
    expect(indicator(await overview(tenant.admin.token), 'capa_open_backlog').tracked).toBe(true);
    expect(indicator(await overview(tenant.users[0].token), 'capa_open_backlog').tracked).toBe(false);
  });
});

describe('Objectif modifiable (PATCH /kpis/:id/objective)', () => {
  it('modifie objectif et sens (0 accepté), le retire, revient au défaut ; l’état se recalcule', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    await request(app).post('/api/capas').set(auth(tenant.admin.token)).send({ title: 'CAPA ouverte', origin: 'Test' }).expect(201);
    const created = await request(app).post('/api/kpis/from-module-preset').set(auth(tenant.admin.token)).send({ preset_id: 'capa_open_backlog' }); // objectif par défaut ≤ 10, 1 CAPA ouverte
    const patch = (body, id = created.body.id, token = tenant.admin.token) => request(app).patch(`/api/kpis/${id}/objective`).set(auth(token)).send(body);

    expect(indicator(await overview(tenant.admin.token), 'capa_open_backlog')).toMatchObject({ status: 'good', target: 10, target_changed: false });

    const zero = await patch({ target: 0 });
    expect(zero.status).toBe(200);
    expect(zero.body).toMatchObject({ target: 0, target_direction: 'max' });
    expect(indicator(await overview(tenant.admin.token), 'capa_open_backlog')).toMatchObject({ status: 'bad', target: 0, target_changed: true });

    expect((await patch({ target: 5, target_direction: 'min' })).body).toMatchObject({ target: 5, target_direction: 'min' });
    expect((await patch({ target: null })).body.target).toBeNull();
    expect(indicator(await overview(tenant.admin.token), 'capa_open_backlog').status).toBe('neutral');

    const reset = await patch({ reset: true });
    expect(reset.body).toMatchObject({ target: 10, target_direction: 'max' });
    expect(indicator(await overview(tenant.admin.token), 'capa_open_backlog')).toMatchObject({ status: 'good', target_changed: false });

    expect((await patch({ target: 'beaucoup' })).status).toBe(400);
    expect((await patch({ target: '5' })).status).toBe(400);
    expect((await patch({ target_direction: 'egal' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ target: 3 }, created.body.id, tenant.users[0].token)).status).toBe(403);
    expect((await patch({ target: 3 }, '00000000-0000-0000-0000-000000000000')).status).toBe(404);
    const other = await newTenant();
    expect((await patch({ target: 3 }, created.body.id, other.admin.token)).status).toBe(404);
  });

  it('« par défaut » impossible pour un KPI saisi à la main', async () => {
    const tenant = await newTenant();
    const manual = await request(app).post('/api/kpis').set(auth(tenant.admin.token)).send({ name: 'Mon KPI', target: 5, target_direction: 'max' });
    const res = await request(app).patch(`/api/kpis/${manual.body.id}/objective`).set(auth(tenant.admin.token)).send({ reset: true });
    expect(res.status).toBe(400);
    expect((await request(app).patch(`/api/kpis/${manual.body.id}/objective`).set(auth(tenant.admin.token)).send({ target: 7 })).body.target).toBe(7);
  });
});
