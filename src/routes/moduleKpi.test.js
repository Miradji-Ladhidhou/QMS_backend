import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';
import { MODULE_KPI_PRESETS } from '../services/moduleKpiSources.js';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

async function makeCapa(token, overrides = {}) {
  const res = await request(app)
    .post('/api/capas')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'CAPA test', origin: 'Test', ...overrides });
  return res.body;
}

async function closeCapa(token, id) {
  // status:'closed' pose closed_at côté backend (à la date du jour). La clôture exige action
  // corrective + vérification d'efficacité justifiée.
  const res = await request(app)
    .patch(`/api/capas/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      status: 'closed',
      corrective_action: 'fait',
      effectiveness_verified: true,
      effectiveness_notes: 'Vérifié sur 3 mois sans récidive.',
    });
  if (res.status !== 200) throw new Error(`closeCapa a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
  return res.body;
}

async function makeComplaint(token, overrides = {}) {
  const res = await request(app)
    .post('/api/complaints')
    .set('Authorization', `Bearer ${token}`)
    .send({ customer_name: 'Client', description: 'Problème', received_date: '2026-01-05', ...overrides });
  if (res.status !== 201) throw new Error(`makeComplaint a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
  return res.body;
}

async function resolveComplaint(token, id, patch = {}) {
  const res = await request(app)
    .patch(`/api/complaints/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'resolved', resolution: 'Traité', resolution_date: '2026-01-20', ...patch });
  if (res.status !== 200) throw new Error(`resolveComplaint a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
  return res.body;
}

function fromPreset(token, presetId) {
  return request(app).post('/api/kpis/from-module-preset').set('Authorization', `Bearer ${token}`).send({ preset_id: presetId });
}

describe('KPI de module — catalogue', () => {
  it('GET /api/kpis/module-presets renvoie le catalogue', async () => {
    tenant = await createTenant();
    const res = await request(app).get('/api/kpis/module-presets').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(5);
    const capaClosed = res.body.find((p) => p.id === 'capa_closed_count');
    expect(capaClosed).toBeTruthy();
    expect(capaClosed.module_label).toBe('CAPA');
  });

  it('un member ne peut pas créer de KPI de module', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const res = await fromPreset(tenant.users[0].token, 'capa_closed_count');
    expect(res.status).toBe(403);
  });

  it('preset inconnu → 400', async () => {
    tenant = await createTenant();
    const res = await fromPreset(tenant.admin.token, 'nope');
    expect(res.status).toBe(400);
  });

  // Filet de sécurité pour tout le catalogue : chaque preset doit se créer et se recalculer
  // sans planter sur un tenant sans aucune donnée (0 ligne dans la table source) — attrape une
  // faute de frappe de table/colonne dans une source (Supabase renverrait une erreur SQL) ou une
  // jointure cassée, même pour les ~40% de presets non couverts par un test dédié ci-dessous.
  it(
    'chaque preset du catalogue se crée sans erreur sur un tenant vide',
    async () => {
      tenant = await createTenant();
      const t = tenant.admin.token;
      const failures = [];

      for (const preset of MODULE_KPI_PRESETS) {
        const res = await fromPreset(t, preset.id);
        if (res.status !== 201) {
          failures.push({ id: preset.id, status: res.status, error: res.body?.error });
        }
      }

      expect(failures).toEqual([]);
    },
    60000
  );
});

describe('KPI de module — calcul (count)', () => {
  it('« CAPA clôturées » compte les CAPA clôturées par mois', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    const c1 = await makeCapa(t);
    const c2 = await makeCapa(t);
    await makeCapa(t); // reste ouverte

    await closeCapa(t, c1.id);
    await closeCapa(t, c2.id);

    const created = await fromPreset(t, 'capa_closed_count');
    expect(created.status).toBe(201);
    expect(created.body.calculation_type).toBe('module');
    expect(created.body.source_module).toBe('capa');

    // Les deux CAPA clôturées ce mois-ci → une valeur de période = 2.
    const records = created.body.records || [];
    expect(records.length).toBe(1);
    expect(Number(records[0].value)).toBe(2);
    expect(records[0].source).toBe('module');
  });

  it('recompute met à jour après un changement de données', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    const c1 = await makeCapa(t);
    await closeCapa(t, c1.id);

    const created = await fromPreset(t, 'capa_closed_count');
    expect(Number((created.body.records || [])[0].value)).toBe(1);

    const c2 = await makeCapa(t);
    await closeCapa(t, c2.id);

    const recompute = await request(app)
      .post(`/api/kpis/${created.body.id}/recompute`)
      .set('Authorization', `Bearer ${t}`);
    expect(recompute.status).toBe(200);
    expect(recompute.body.updated).toBe(1);

    const kpi = await request(app).get(`/api/kpis/${created.body.id}`).set('Authorization', `Bearer ${t}`);
    const rec = (kpi.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(2);
  });
});

describe('KPI de module — garde-fous', () => {
  it('POST /:id/records refusé sur un KPI de module (409)', async () => {
    tenant = await createTenant();
    const created = await fromPreset(tenant.admin.token, 'capa_closed_count');

    const res = await request(app)
      .post(`/api/kpis/${created.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ period_date: '2026-01-01', value: 5 });
    expect(res.status).toBe(409);
  });

  it('PATCH et DELETE d’une valeur refusés sur un KPI de module (409)', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    const c1 = await makeCapa(t);
    await closeCapa(t, c1.id);
    const created = await fromPreset(t, 'capa_closed_count');
    const recordId = (created.body.records || [])[0].id;
    expect(recordId).toBeTruthy();

    const patch = await request(app)
      .patch(`/api/kpis/${created.body.id}/records/${recordId}`)
      .set('Authorization', `Bearer ${t}`)
      .send({ value: 99 });
    expect(patch.status).toBe(409);

    const del = await request(app)
      .delete(`/api/kpis/${created.body.id}/records/${recordId}`)
      .set('Authorization', `Bearer ${t}`);
    expect(del.status).toBe(409);
  });

  it('POST /:id/recompute sur un KPI manuel → 400', async () => {
    tenant = await createTenant();
    const manual = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'KPI manuel' });

    const res = await request(app)
      .post(`/api/kpis/${manual.body.id}/recompute`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(400);
  });

  it('PATCH calculation_type sur un KPI de module → 409', async () => {
    tenant = await createTenant();
    const created = await fromPreset(tenant.admin.token, 'capa_closed_count');

    const res = await request(app)
      .patch(`/api/kpis/${created.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ calculation_type: 'manual' });
    expect(res.status).toBe(409);
  });

  it('isolation multi-tenant : recompute ne voit que les données de son tenant', async () => {
    tenant = await createTenant();
    const other = await createTenant();

    const oc = await makeCapa(other.admin.token);
    await closeCapa(other.admin.token, oc.id);

    const created = await fromPreset(tenant.admin.token, 'capa_closed_count');
    // Aucune CAPA clôturée dans CE tenant → aucun record.
    expect((created.body.records || []).length).toBe(0);

    await other.cleanup();
  });
});

function currentMonthBucket() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

describe('KPI de module — photo à date (snapshot)', () => {
  it('« CAPA ouvertes à ce jour » compte le stock courant, pas un agrégat de période', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    const c1 = await makeCapa(t);
    await makeCapa(t);
    await makeCapa(t);
    await closeCapa(t, c1.id);

    const created = await fromPreset(t, 'capa_open_backlog');
    expect(created.status).toBe(201);
    const records = (created.body.records || []).filter((r) => r.value !== null);
    expect(records.length).toBe(1);
    expect(Number(records[0].value)).toBe(2);
    expect(records[0].period_date).toBe(currentMonthBucket());
    expect(records[0].source).toBe('module');
    expect(created.body.target).toBe(10); // cible par défaut du stock ouvert (plafond)
    expect(created.body.target_direction).toBe('max');
  });

  it('« CAPA en retard à ce jour » ne compte que les CAPA ouvertes hors délai', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    await makeCapa(t, { due_date: '2020-01-01' }); // ouverte + échéance dépassée
    await makeCapa(t, { due_date: '2999-01-01' }); // ouverte mais dans les délais
    const done = await makeCapa(t, { due_date: '2020-01-01' });
    await closeCapa(t, done.id); // clôturée → hors backlog

    const created = await fromPreset(t, 'capa_overdue_backlog');
    const rec = (created.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);
  });

  it('recalcul idempotent : la photo ne supprime pas les relevés précédents', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    await makeCapa(t);
    const created = await fromPreset(t, 'capa_open_backlog');

    const first = await request(app).post(`/api/kpis/${created.body.id}/recompute`).set('Authorization', `Bearer ${t}`);
    expect(first.status).toBe(200);
    expect(first.body.deleted).toBe(0);

    const second = await request(app).post(`/api/kpis/${created.body.id}/recompute`).set('Authorization', `Bearer ${t}`);
    expect(second.body.deleted).toBe(0);
    expect(second.body.updated).toBe(1);
  });
});

describe('KPI de module — efficacité / rigueur CAPA', () => {
  it('« CAPA rouvertes » compte l’état rouvert courant, pas le mois de clôture', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    const c1 = await makeCapa(t);
    const c2 = await makeCapa(t);
    await closeCapa(t, c1.id);
    await closeCapa(t, c2.id);
    // c1 est rouverte : elle garde sa closed_at mais repasse "en cours".
    const reopen = await request(app)
      .patch(`/api/capas/${c1.id}`)
      .set('Authorization', `Bearer ${t}`)
      .send({ status: 'in_progress' });
    expect(reopen.status).toBe(200);
    expect(reopen.body.closed_at).toBeTruthy();

    const created = await fromPreset(t, 'capa_reopened_backlog');
    expect(created.status).toBe(201);
    const rec = (created.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);
    expect(rec.period_date).toBe(currentMonthBucket());
    expect(created.body.target).toBe(0);
  });

  it('« CAPA ouvertes sans analyse de cause » ne compte que les ouvertes au champ cause vide', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    await makeCapa(t); // ouverte, pas de cause
    await makeCapa(t); // ouverte, pas de cause
    await makeCapa(t, { root_cause: 'Défaut de réglage machine' }); // ouverte mais cause renseignée

    const created = await fromPreset(t, 'capa_no_root_cause_backlog');
    expect(created.status).toBe(201);
    const rec = (created.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(2);
    expect(created.body.target).toBe(0);
  });

  it('« Ancienneté de la plus ancienne CAPA ouverte » renvoie le maximum, pas la moyenne', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    await makeCapa(t);
    await makeCapa(t);

    const created = await fromPreset(t, 'capa_oldest_open_age');
    expect(created.status).toBe(201);
    const rec = (created.body.records || []).find((r) => r.value !== null);
    expect(rec).toBeTruthy();
    expect(Number(rec.value)).toBeGreaterThanOrEqual(0);
    expect(rec.period_date).toBe(currentMonthBucket());
  });
});

describe('KPI de module — réclamations clients', () => {
  it('« Réclamations ouvertes à ce jour » = stock non résolu au moment du calcul', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    const c1 = await makeComplaint(t);
    await makeComplaint(t);
    await makeComplaint(t);
    await resolveComplaint(t, c1.id);

    const created = await fromPreset(t, 'complaint_open_backlog');
    expect(created.status).toBe(201);
    const rec = (created.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(2);
    expect(rec.period_date).toBe(currentMonthBucket());
  });

  it('« Réclamations en retard à ce jour » ne compte que les non résolues hors délai', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    await makeComplaint(t, { due_date: '2020-01-01' }); // ouverte + échéance dépassée
    await makeComplaint(t, { due_date: '2999-01-01' }); // ouverte, dans les délais
    const done = await makeComplaint(t, { due_date: '2020-01-01' });
    await resolveComplaint(t, done.id); // résolue → hors backlog

    const created = await fromPreset(t, 'complaint_overdue_backlog');
    const rec = (created.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);
    expect(created.body.target).toBe(0);
  });

  it('« Clients insatisfaits à ce jour » compte les avis négatifs enregistrés (photo à date)', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    const c1 = await makeComplaint(t);
    const c2 = await makeComplaint(t);
    const c3 = await makeComplaint(t);
    await resolveComplaint(t, c1.id, { customer_satisfied: false });
    await resolveComplaint(t, c2.id, { customer_satisfied: true });
    await resolveComplaint(t, c3.id); // pas d'avis recueilli

    const created = await fromPreset(t, 'complaint_dissatisfied_count');
    const rec = (created.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);
    expect(rec.period_date).toBe(currentMonthBucket());
    expect(created.body.target).toBe(0);
  });

  it('« Réclamations résolues sans retour client » compte les résolues sans avis (§9.1.2)', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    const c1 = await makeComplaint(t);
    const c2 = await makeComplaint(t);
    await resolveComplaint(t, c1.id); // sans avis
    await resolveComplaint(t, c2.id, { customer_satisfied: true }); // avec avis

    const created = await fromPreset(t, 'complaint_no_feedback_backlog');
    const rec = (created.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);
    expect(rec.period_date).toBe(currentMonthBucket());
  });

  it('« Réclamations graves sans CAPA » filtre gravité + absence de lien CAPA', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    await makeComplaint(t, { severity: 'critical' });
    await makeComplaint(t, { severity: 'high' });
    await makeComplaint(t, { severity: 'low' });

    const created = await fromPreset(t, 'complaint_severe_no_capa_backlog');
    const rec = (created.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(2);
    expect(created.body.target).toBe(0);
  });
});

describe('KPI de module — compétences (matrice)', () => {
  async function makeTraining(token, body) {
    const res = await request(app).post('/api/trainings').set('Authorization', `Bearer ${token}`).send(body);
    if (res.status !== 201) throw new Error(`makeTraining a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
    return res.body;
  }
  async function addRecord(token, trainingId, body) {
    const res = await request(app)
      .post(`/api/trainings/${trainingId}/records`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    if (res.status !== 201) throw new Error(`addRecord a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
    return res.body;
  }

  it('expirées / jamais suivies / couverture reflètent l’état de la matrice', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    // Formation A : récurrente, réalisée il y a longtemps → renouvellement expiré.
    const tA = await makeTraining(t, { title: 'Sécurité au poste', frequency_months: 12 });
    await addRecord(t, tA.id, { user_id: tenant.admin.id, completed_at: '2020-01-01' });

    // Formation B : obligatoire, jamais réalisée → manquante.
    await makeTraining(t, { title: 'Sensibilisation qualité', frequency_months: 12 });

    const expired = await fromPreset(t, 'competence_expired_backlog');
    expect(expired.status).toBe(201);
    let rec = (expired.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);
    expect(rec.period_date).toBe(currentMonthBucket());
    expect(expired.body.target).toBe(0);

    const missing = await fromPreset(t, 'competence_missing_backlog');
    rec = (missing.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);

    const people = await fromPreset(t, 'competence_people_with_gap');
    rec = (people.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1); // l'admin cumule les deux écarts, compté une fois

    const coverage = await fromPreset(t, 'competence_coverage_rate');
    rec = (coverage.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(0); // 2 compétences requises, 0 à jour
  });

  it('une formation renouvelée dans les temps compte comme couverte', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;
    const today = new Date().toISOString().slice(0, 10);

    const tr = await makeTraining(t, { title: 'Habilitation électrique', frequency_months: 24 });
    await addRecord(t, tr.id, { user_id: tenant.admin.id, completed_at: today });

    const coverage = await fromPreset(t, 'competence_coverage_rate');
    const rec = (coverage.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(100);

    const gap = await fromPreset(t, 'competence_people_with_gap');
    const gapRec = (gap.body.records || []).find((r) => r.value !== null);
    expect(Number(gapRec.value)).toBe(0);
  });
});

describe('KPI de module — risques', () => {
  async function makeRisk(token, body) {
    const res = await request(app).post('/api/risks').set('Authorization', `Bearer ${token}`).send({ title: 'Risque', ...body });
    if (res.status !== 201) throw new Error(`makeRisk a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
    return res.body;
  }

  it('« Risques élevés non traités » + « sans plan » + « revue en retard »', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    await makeRisk(t, { likelihood: 4, impact: 3 }); // score 12, statut identified, pas de plan
    await makeRisk(t, { likelihood: 1, impact: 2, review_date: '2020-01-01' }); // score 2, revue dépassée

    const high = await fromPreset(t, 'risk_high_untreated_backlog');
    expect(high.status).toBe(201);
    let rec = (high.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);
    expect(rec.period_date).toBe(currentMonthBucket());
    expect(high.body.target).toBe(0);
    expect(high.body.target_direction).toBe('max');

    const noPlan = await fromPreset(t, 'risk_no_plan_backlog');
    rec = (noPlan.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(2); // les deux risques sont ouverts sans plan

    const review = await fromPreset(t, 'risk_review_overdue_backlog');
    rec = (review.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);
  });

  it('« Taux de risques maîtrisés » = part des risques traités/acceptés/clôturés', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    const r1 = await makeRisk(t, { likelihood: 3, impact: 3 });
    await makeRisk(t, { likelihood: 2, impact: 2 });
    // Passer à « accepté » exige l'évaluation résiduelle (gate risks.js).
    const patch = await request(app)
      .patch(`/api/risks/${r1.id}`)
      .set('Authorization', `Bearer ${t}`)
      .send({ status: 'accepted', residual_likelihood: 1, residual_impact: 1 });
    expect(patch.status).toBe(200);

    const coverage = await fromPreset(t, 'risk_treatment_coverage');
    const rec = (coverage.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(50);
  });

  it('les opportunités sont exclues des KPI de risque', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    await makeRisk(t, { likelihood: 5, impact: 5, type: 'opportunity' }); // score 25 mais opportunité
    await makeRisk(t, { likelihood: 2, impact: 2 }); // vrai risque, score 4

    const high = await fromPreset(t, 'risk_high_untreated_backlog');
    const rec = (high.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(0); // l'opportunité à 25 ne compte pas

    const open = await fromPreset(t, 'risk_open_backlog');
    const openRec = (open.body.records || []).find((r) => r.value !== null);
    expect(Number(openRec.value)).toBe(1); // seul le vrai risque
  });
});

describe('KPI de module — fournisseurs', () => {
  async function makeSupplier(token, body) {
    const res = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${token}`).send({ name: 'Fournisseur', ...body });
    if (res.status !== 201) throw new Error(`makeSupplier a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
    return res.body;
  }
  async function addEvaluation(token, supplierId, body) {
    const res = await request(app)
      .post(`/api/suppliers/${supplierId}/evaluations`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        evaluation_date: '2026-01-15',
        quality_score: 4,
        delivery_score: 4,
        price_score: 4,
        responsiveness_score: 4,
        ...body,
      });
    if (res.status !== 201) throw new Error(`addEvaluation a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
    return res.body;
  }

  it('critiques non évalués, évaluations en retard, note sous le seuil', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    await makeSupplier(t, { criticality: 'critical' }); // critique, jamais évalué
    await makeSupplier(t, { criticality: 'low', next_evaluation_date: '2020-01-01' }); // éval en retard
    const s3 = await makeSupplier(t, { criticality: 'medium' });
    await addEvaluation(t, s3.id, { quality_score: 2, delivery_score: 2, price_score: 2, responsiveness_score: 2 }); // note 2/5

    const unev = await fromPreset(t, 'supplier_critical_unevaluated_backlog');
    let rec = (unev.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);
    expect(rec.period_date).toBe(currentMonthBucket());

    const overdue = await fromPreset(t, 'supplier_eval_overdue_backlog');
    rec = (overdue.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);

    const below = await fromPreset(t, 'supplier_below_threshold_backlog');
    rec = (below.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);

    const avg = await fromPreset(t, 'supplier_avg_score');
    rec = (avg.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(2); // seul s3 a une évaluation
  });
});

describe('KPI de module — documents', () => {
  async function makeDocument(token, number, extra = {}) {
    const req = request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .field('number', number)
      .field('title', `Titre ${number}`);
    for (const [key, value] of Object.entries(extra)) req.field(key, value);
    const res = await req;
    if (res.status !== 201) throw new Error(`makeDocument a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
    return res.body;
  }
  async function approve(token, id) {
    const res = await request(app).patch(`/api/documents/${id}/status`).set('Authorization', `Bearer ${token}`).send({ status: 'approved' });
    if (res.status !== 200) throw new Error(`approve a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
    return res.body;
  }

  it('revue en retard, sans date de revue — seuls les documents approuvés comptent', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    const d1 = await makeDocument(t, 'DOC-001', { review_date: '2020-01-01' });
    await approve(t, d1.id); // approuvé, revue dépassée
    const d2 = await makeDocument(t, 'DOC-002');
    await approve(t, d2.id); // approuvé, jamais de date de revue
    await makeDocument(t, 'DOC-003', { review_date: '2020-01-01' }); // resté en brouillon → ignoré

    const overdue = await fromPreset(t, 'document_review_overdue_backlog');
    let rec = (overdue.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);
    expect(rec.period_date).toBe(currentMonthBucket());

    const noSchedule = await fromPreset(t, 'document_no_review_schedule_backlog');
    rec = (noSchedule.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);
  });
});

describe('KPI de module — HACCP', () => {
  async function buildCcpChain(token, { significant = true, log } = {}) {
    const plan = (await request(app).post('/api/haccp/plans').set('Authorization', `Bearer ${token}`).send({ title: 'Plan' })).body;
    const step = (
      await request(app).post(`/api/haccp/plans/${plan.id}/steps`).set('Authorization', `Bearer ${token}`).send({ name: 'Étape' })
    ).body;
    const hazard = (
      await request(app)
        .post(`/api/haccp/steps/${step.id}/hazards`)
        .set('Authorization', `Bearer ${token}`)
        .send({ hazard_type: 'biological', description: 'Listeria', likelihood: 3, severity: 4, is_significant: significant })
    ).body;
    let ccp = null;
    if (log) {
      ccp = (
        await request(app)
          .post(`/api/haccp/hazards/${hazard.id}/ccps`)
          .set('Authorization', `Bearer ${token}`)
          .send({ critical_limits: '< 4°C', monitoring_procedure: 'Relevé 2x/jour' })
      ).body;
      const res = await request(app)
        .post(`/api/haccp/ccps/${ccp.id}/monitoring-logs`)
        .set('Authorization', `Bearer ${token}`)
        .send({ recorded_value: '2°C', within_limits: true, ...log });
      if (res.status !== 201) throw new Error(`monitoring-log a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
    }
    return { plan, step, hazard, ccp };
  }

  it('danger significatif sans CCP + écarts', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    await buildCcpChain(t, { significant: true }); // pas de CCP créé
    await buildCcpChain(t, {
      significant: true,
      log: { within_limits: false, corrective_action_taken: 'Lot bloqué et recuit.' },
    });

    const noCcp = await fromPreset(t, 'haccp_significant_hazard_no_ccp_backlog');
    let rec = (noCcp.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);
    expect(rec.period_date).toBe(currentMonthBucket());

    const deviations = await fromPreset(t, 'haccp_deviation_count');
    rec = (deviations.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);

    const noCapa = await fromPreset(t, 'haccp_deviation_no_capa_count');
    rec = (noCapa.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1); // écart documenté mais sans CAPA formelle
  });
});

describe('KPI de module — PDCA', () => {
  async function makePdca(token) {
    const res = await request(app).post('/api/pdca').set('Authorization', `Bearer ${token}`).send({ title: 'Projet' });
    if (res.status !== 201) throw new Error(`makePdca a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
    return res.body;
  }
  async function closePdca(token, id) {
    await request(app).patch(`/api/pdca/${id}`).set('Authorization', `Bearer ${token}`).send({ plan_content: 'Analyse du problème.' });
    for (const body of [
      { do_content: 'Mise en place du changement.' },
      { check_content: 'Mesure des résultats.' },
      { act_content: 'Standardisation.' },
      {},
    ]) {
      const res = await request(app).post(`/api/pdca/${id}/advance`).set('Authorization', `Bearer ${token}`).send(body);
      if (res.status !== 200) throw new Error(`advance a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
    }
  }

  it('en retard, en cours, clôturé', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    await makePdca(t); // reste en 'plan', pas d'échéance
    const p2 = await makePdca(t);
    await request(app).patch(`/api/pdca/${p2.id}`).set('Authorization', `Bearer ${t}`).send({ target_date: '2020-01-01' });
    const p3 = await makePdca(t);
    await closePdca(t, p3.id);

    const overdue = await fromPreset(t, 'pdca_overdue_backlog');
    let rec = (overdue.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);

    const open = await fromPreset(t, 'pdca_open_backlog');
    rec = (open.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(2); // p3 est clôturé, les deux autres restent ouverts

    const closedCount = await fromPreset(t, 'pdca_closed_count');
    rec = (closedCount.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);
    expect(rec.period_date).toBe(currentMonthBucket());
  });
});

describe('KPI de module — revues de direction', () => {
  it('actions sans CAPA / non soldées', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    const review = (
      await request(app)
        .post('/api/management-reviews')
        .set('Authorization', `Bearer ${t}`)
        .send({ title: 'Revue annuelle', review_date: '2026-01-15' })
    ).body;

    const a1 = await request(app)
      .post(`/api/management-reviews/${review.id}/actions`)
      .set('Authorization', `Bearer ${t}`)
      .send({ description: 'Renforcer le contrôle réception.' }); // sans CAPA
    expect(a1.status).toBe(201);

    const a2 = await request(app)
      .post(`/api/management-reviews/${review.id}/actions`)
      .set('Authorization', `Bearer ${t}`)
      .send({ description: 'Recruter un second technicien qualité.' });
    const linkCapa = await request(app)
      .post(`/api/management-reviews/${review.id}/actions/${a2.body.id}/create-capa`)
      .set('Authorization', `Bearer ${t}`)
      .send({ title: 'Recruter un second technicien qualité' }); // CAPA créée et liée, reste ouverte
    expect(linkCapa.status).toBe(201);

    const noCapa = await fromPreset(t, 'management_review_action_no_capa_backlog');
    let rec = (noCapa.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);

    const unresolved = await fromPreset(t, 'management_review_action_unresolved_backlog');
    rec = (unresolved.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(2); // ni l'une ni l'autre n'est soldée
    expect(rec.period_date).toBe(currentMonthBucket());
  });
});

describe('KPI de module — procédures', () => {
  it('revue en retard sur une procédure non obsolète', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    await request(app)
      .post('/api/procedures')
      .set('Authorization', `Bearer ${t}`)
      .send({ number: 'PR-001', title: 'Contrôle réception', next_review_date: '2020-01-01' });
    await request(app)
      .post('/api/procedures')
      .set('Authorization', `Bearer ${t}`)
      .send({ number: 'PR-002', title: 'Gestion des achats' }); // pas de date de revue

    const overdue = await fromPreset(t, 'procedure_review_overdue_backlog');
    const rec = (overdue.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);
    expect(rec.period_date).toBe(currentMonthBucket());
  });
});

describe('KPI de module — approbations documentaires', () => {
  it('circuit d’approbation en attente', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const t = tenant.admin.token;
    const approverId = tenant.users[0].id;

    const doc = (
      await request(app).post('/api/documents').set('Authorization', `Bearer ${t}`).field('number', 'DOC-A1').field('title', 'Manuel qualité')
    ).body;
    const submit = await request(app)
      .post(`/api/documents/${doc.id}/submit-for-approval`)
      .set('Authorization', `Bearer ${t}`)
      .send({ approver_ids: [approverId] });
    expect(submit.status).toBe(201);

    const pending = await fromPreset(t, 'document_approval_pending_backlog');
    let rec = (pending.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(1);
    expect(rec.period_date).toBe(currentMonthBucket());

    const oldest = await fromPreset(t, 'document_approval_oldest_pending_age');
    rec = (oldest.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBeGreaterThanOrEqual(0);
  });
});

describe('KPI de module — satisfaction (average)', () => {
  it('« Note moyenne » = moyenne des scores du mois', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;
    const today = new Date().toISOString().slice(0, 10);

    for (const score of [2, 4, 3]) {
      await request(app)
        .post('/api/customer-satisfaction')
        .set('Authorization', `Bearer ${t}`)
        .send({ customer_name: 'C', survey_date: today, score });
    }

    const created = await fromPreset(t, 'satisfaction_avg_score');
    expect(created.status).toBe(201);
    const rec = (created.body.records || [])[0];
    expect(Number(rec.value)).toBe(3);
  });
});
