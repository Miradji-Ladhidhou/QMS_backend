import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';

let tenants = [];
const newTenant = async (options) => {
  const created = await createTenant(options);
  tenants.push(created);
  return created;
};
afterEach(async () => {
  for (const tenant of tenants) await tenant.cleanup();
  tenants = [];
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const qualifications = (token) => request(app).get('/api/audits/auditor-qualifications').set(auth(token));

async function createTraining(tenant, extra = {}) {
  const res = await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'Audit interne', qualifies_internal_auditor: true, ...extra });
  expect(res.status).toBe(201);
  return res.body;
}
const record = async (tenant, training, userId, extra = {}) => {
  const res = await request(app).post(`/api/trainings/${training.id}/records`).set(auth(tenant.admin.token)).send({ user_id: userId, completed_at: '2026-03-01', ...extra });
  expect(res.status).toBe(201);
  return res.body;
};

describe('Formation qualifiante pour les auditeurs internes', () => {
  it('POST/PATCH acceptent le booléen ; false ne provoque pas d\'erreur (colonne NOT NULL) ; valeur invalide → 400', async () => {
    const tenant = await newTenant();
    const flagged = await createTraining(tenant);
    expect(flagged.qualifies_internal_auditor).toBe(true);

    const plain = (await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'Autre' })).body;
    expect(plain.qualifies_internal_auditor).toBe(false);

    const off = await request(app).patch(`/api/trainings/${flagged.id}`).set(auth(tenant.admin.token)).send({ qualifies_internal_auditor: false });
    expect(off.status).toBe(200);
    expect(off.body.qualifies_internal_auditor).toBe(false);
    const on = await request(app).patch(`/api/trainings/${flagged.id}`).set(auth(tenant.admin.token)).send({ qualifies_internal_auditor: true });
    expect(on.body.qualifies_internal_auditor).toBe(true);

    expect((await request(app).patch(`/api/trainings/${flagged.id}`).set(auth(tenant.admin.token)).send({ qualifies_internal_auditor: 'peut-être' })).status).toBe(400);
    expect((await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'X', qualifies_internal_auditor: 'oui' })).status).toBe(400);
  });

  it('la liste des formations expose l\'indicateur (le frontend en tire le badge et le lien vers les audits)', async () => {
    const tenant = await newTenant();
    const flagged = await createTraining(tenant);
    const list = await request(app).get('/api/trainings').set(auth(tenant.admin.token));
    expect(list.body.find((t) => t.id === flagged.id).qualifies_internal_auditor).toBe(true);
  });
});

describe('GET /api/audits/auditor-qualifications', () => {
  it('aucune formation qualifiante désignée : liste vide (la page Audits invite à en désigner une)', async () => {
    const tenant = await newTenant();
    await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'Formation quelconque' });
    const res = await qualifications(tenant.admin.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ trainings: [], by_user: {} });
  });

  it('qualifié / à recycler / non qualifié selon la dernière réalisation, et absent si jamais suivie', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }, { role: 'member' }] });
    const [okUser, expiredUser, failedUser] = tenant.users.length === 3 ? tenant.users : [];
    const training = await createTraining(tenant, { frequency_months: 36 });

    await record(tenant, training, okUser.id);
    const expiredRecord = await record(tenant, training, expiredUser.id);
    await admin.from('training_records').update({ next_due_date: '2020-01-01' }).eq('id', expiredRecord.id);
    const failedRecord = await record(tenant, training, failedUser.id);
    await request(app).patch(`/api/trainings/${training.id}/records/${failedRecord.id}`).set(auth(tenant.admin.token)).send({ evaluation_result: false, evaluation_notes: 'QCM non réussi' }).expect(200);

    const res = await qualifications(tenant.admin.token);
    expect(res.body.trainings).toEqual([{ id: training.id, title: 'Audit interne' }]);
    expect(res.body.by_user[okUser.id]).toMatchObject({ status: 'qualified', training_id: training.id, training_title: 'Audit interne' });
    expect(res.body.by_user[expiredUser.id].status).toBe('expired');
    expect(res.body.by_user[failedUser.id].status).toBe('failed');
    // L'admin n'a jamais suivi la formation : aucune entrée (= aucune qualification).
    expect(res.body.by_user[tenant.admin.id]).toBeUndefined();
  });

  it('une formation NON cochée ne qualifie personne ; décocher retire la qualification', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const [member] = tenant.users;
    const notFlagged = (await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'Audit interne (non cochée)' })).body;
    await record(tenant, notFlagged, member.id);
    expect((await qualifications(tenant.admin.token)).body.by_user[member.id]).toBeUndefined();

    const flagged = await createTraining(tenant);
    await record(tenant, flagged, member.id);
    expect((await qualifications(tenant.admin.token)).body.by_user[member.id].status).toBe('qualified');

    await request(app).patch(`/api/trainings/${flagged.id}`).set(auth(tenant.admin.token)).send({ qualifies_internal_auditor: false });
    const after = await qualifications(tenant.admin.token);
    expect(after.body).toEqual({ trainings: [], by_user: {} });
  });

  it('un QCM passé apporte son score ; un échec au QCM rend l\'auditeur non qualifié', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const [member] = tenant.users;
    const training = await createTraining(tenant);
    const rec = await record(tenant, training, member.id);
    await admin.from('training_quiz_attempts').insert({
      tenant_id: tenant.tenantId, training_id: training.id, record_id: rec.id, token_hash: `h-${Date.now()}`, email: 'x@example.com',
      quiz_snapshot: [], pass_threshold: 80, expires_at: new Date(Date.now() + 1000).toISOString(),
      completed_at: new Date().toISOString(), score_percent: 45, correct_count: 1, total_count: 2, passed: false,
    });
    await admin.from('training_records').update({ evaluation_result: false, evaluation_notes: 'QCM non réussi' }).eq('id', rec.id);

    const res = await qualifications(tenant.admin.token);
    expect(res.body.by_user[member.id]).toMatchObject({ status: 'failed', quiz_score_percent: 45 });
  });

  it('un simple membre peut la consulter (comme la liste des audits) ; sans authentification → 401', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    await createTraining(tenant);
    expect((await qualifications(tenant.users[0].token)).status).toBe(200);
    expect((await request(app).get('/api/audits/auditor-qualifications')).status).toBe(401);
  });

  it('isolation : jamais les formations ni les qualifications d\'une autre entreprise', async () => {
    const owner = await newTenant();
    const other = await newTenant();
    const training = await createTraining(owner);
    await record(owner, training, owner.admin.id);
    const res = await qualifications(other.admin.token);
    expect(res.body).toEqual({ trainings: [], by_user: {} });
  });

  it('formation qualifiante en catégorie restreinte : invisible pour un manager sans accès (donc aucune qualification révélée)', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const category = (await request(app).post('/api/module-categories').set(auth(tenant.admin.token)).send({ resource_type: 'training', name: 'Confidentiel', is_restricted: true })).body;
    const training = await createTraining(tenant, { category_id: category.id });
    await record(tenant, training, tenant.admin.id);

    const asManager = await qualifications(tenant.users[0].token);
    expect(asManager.body).toEqual({ trainings: [], by_user: {} });
    const asAdmin = await qualifications(tenant.admin.token);
    expect(asAdmin.body.trainings).toHaveLength(1);
    expect(asAdmin.body.by_user[tenant.admin.id].status).toBe('qualified');
  });

  it('le point d\'entrée ne masque pas GET /audits/:id (un id reste un id)', async () => {
    const tenant = await newTenant();
    const created = await request(app).post('/api/audits').set(auth(tenant.admin.token)).send({ title: 'Audit test', audit_type: 'process', planned_date: '2026-10-01' });
    expect(created.status).toBe(201);
    expect((await request(app).get(`/api/audits/${created.body.id}`).set(auth(tenant.admin.token))).status).toBe(200);
    expect((await request(app).get('/api/audits/00000000-0000-4000-8000-000000000000').set(auth(tenant.admin.token))).status).toBe(404);
  });
});
