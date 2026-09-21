import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';
import { normalizeJobTitle } from '../services/jobTitles.js';

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
const invite = (tenant, body) => request(app).post('/api/users/invite').set(auth(tenant.admin.token)).send(body);
const jobTitles = (token) => request(app).get('/api/users/job-titles').set(auth(token));

describe('Poste à la création d’un compte', () => {
  it('l’invitation enregistre le poste (espaces retirés), visible dans la liste des comptes ; sans poste = vide', async () => {
    const tenant = await newTenant();
    const withTitle = await invite(tenant, { email: `cariste-${Date.now()}@example.com`, full_name: 'Paul Cariste', role: 'member', job_title: '  Cariste  ' });
    expect(withTitle.status).toBe(201);
    expect(withTitle.body.job_title).toBe('Cariste');
    const without = await invite(tenant, { email: `sans-${Date.now()}@example.com`, full_name: 'Marie Sans Poste', role: 'member' });
    expect(without.status).toBe(201);
    expect(without.body.job_title).toBeNull();

    const list = (await request(app).get('/api/users').set(auth(tenant.admin.token))).body;
    expect(list.find((user) => user.id === withTitle.body.id).job_title).toBe('Cariste');
    expect(list.find((user) => user.id === without.body.id).job_title).toBeNull();
  });

  it('refuse un poste de plus de 150 caractères ; l’invitation reste réservée à l’admin', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    expect((await invite(tenant, { email: `long-${Date.now()}@example.com`, full_name: 'Long', job_title: 'x'.repeat(151) })).status).toBe(400);
    const asManager = await request(app).post('/api/users/invite').set(auth(tenant.users[0].token)).send({ email: `m-${Date.now()}@example.com`, full_name: 'M', job_title: 'Cariste' });
    expect(asManager.status).toBe(403);
  });
});

describe('Postes déjà utilisés (GET /users/job-titles)', () => {
  it('regroupe comptes et personnel sans compte, sans tenir compte de la casse ; retient la graphie la plus utilisée ; liste les formations obligatoires', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }] });
    const [manager, member] = tenant.users;
    const patch = (user, job_title) => request(app).patch(`/api/users/${user.id}`).set(auth(tenant.admin.token)).send({ job_title });
    await patch(manager, 'Cariste');
    await patch(member, ' cariste ');
    await request(app).post('/api/employees').set(auth(tenant.admin.token)).send({ full_name: 'Jean Opérateur', job_title: 'Cariste' }).expect(201);
    await request(app).post('/api/employees').set(auth(tenant.admin.token)).send({ full_name: 'Léa Soudeuse', job_title: 'Soudeur' }).expect(201);
    const inactive = await request(app).post('/api/employees').set(auth(tenant.admin.token)).send({ full_name: 'Ancien', job_title: 'Magasinier' });
    await request(app).patch(`/api/employees/${inactive.body.id}`).set(auth(tenant.admin.token)).send({ is_active: false });

    const forka = await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'CACES chariot', required_job_titles: ['CARISTE'] });
    await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'Habilitation soudage', required_job_titles: ['Soudeur', 'Chaudronnier'] });
    await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'Accueil sécurité' });

    const res = await jobTitles(tenant.admin.token);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.job_titles.map((entry) => [normalizeJobTitle(entry.title), entry]));
    expect(Object.keys(byKey).sort()).toEqual(['cariste', 'chaudronnier', 'soudeur']); // « Magasinier » (inactif) absent
    expect(byKey.cariste).toMatchObject({ title: 'Cariste', people: 3 }); // deux « Cariste » + un « cariste »
    expect(byKey.cariste.trainings).toEqual([{ id: forka.body.id, title: 'CACES chariot' }]);
    expect(byKey.soudeur.people).toBe(1);
    expect(byKey.chaudronnier).toMatchObject({ people: 0, trainings: [expect.objectContaining({ title: 'Habilitation soudage' })] });
    expect(res.body.general_trainings.map((training) => training.title)).toEqual(['Accueil sécurité']);
    expect(res.body.job_titles.map((entry) => entry.title)).toEqual([...res.body.job_titles.map((entry) => entry.title)].sort((a, b) => a.localeCompare(b, 'fr')));
  });

  it('réservé à admin/manager ; propre à l’entreprise', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }] });
    const other = await newTenant();
    await request(app).post('/api/employees').set(auth(tenant.admin.token)).send({ full_name: 'Jean', job_title: 'Cariste' }).expect(201);
    expect((await jobTitles(tenant.users[0].token)).status).toBe(200);
    expect((await jobTitles(tenant.users[1].token)).status).toBe(403);
    expect((await jobTitles(other.admin.token)).body).toEqual({ job_titles: [], general_trainings: [] });
  });
});
