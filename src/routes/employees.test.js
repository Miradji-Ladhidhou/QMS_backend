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

describe('Employees CRUD — admin only, read open to all roles', () => {
  it('member/manager bloqués en écriture, lecture ouverte à tous', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }] });
    const [manager, member] = tenant.users;

    for (const user of [manager, member]) {
      const res = await request(app)
        .post('/api/employees')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ full_name: 'Salarié interdit' });
      expect(res.status).toBe(403);
    }

    const created = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Jean Opérateur', email: 'jean@example.com' });
    expect(created.status).toBe(201);

    const list = await request(app).get('/api/employees').set('Authorization', `Bearer ${member.token}`);
    expect(list.status).toBe(200);
    expect(list.body.some((e) => e.id === created.body.id)).toBe(true);
  });

  it('refuse la suppression si des réalisations de formation existent, message clair', async () => {
    tenant = await createTenant();
    const employee = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Marie Terrain' });

    const training = await request(app)
      .post('/api/trainings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Sécurité machine' });

    const record = await request(app)
      .post(`/api/trainings/${training.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ employee_id: employee.body.id, completed_at: '2026-01-10' });
    expect(record.status).toBe(201);

    const blocked = await request(app)
      .delete(`/api/employees/${employee.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/désactiv/i);

    await admin.from('training_records').delete().eq('id', record.body.id);

    const ok = await request(app)
      .delete(`/api/employees/${employee.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(ok.status).toBe(204);
  });
});

describe('Enregistrement de formation pour du personnel sans compte', () => {
  it('POST /:id/records accepte employee_id, exige exactement un des deux identifiants', async () => {
    tenant = await createTenant();
    const employee = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Paul Atelier' });
    const training = await request(app)
      .post('/api/trainings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Habilitation électrique', frequency_months: 12 });

    const neither = await request(app)
      .post(`/api/trainings/${training.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ completed_at: '2026-01-10' });
    expect(neither.status).toBe(400);

    const both = await request(app)
      .post(`/api/trainings/${training.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ user_id: tenant.admin.id, employee_id: employee.body.id, completed_at: '2026-01-10' });
    expect(both.status).toBe(400);

    const ok = await request(app)
      .post(`/api/trainings/${training.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ employee_id: employee.body.id, completed_at: '2026-01-10' });
    expect(ok.status).toBe(201);
    expect(ok.body.employee_id).toBe(employee.body.id);
    expect(ok.body.user_id).toBeNull();
    expect(ok.body.employee.full_name).toBe('Paul Atelier');
    expect(ok.body.next_due_date).toBe('2027-01-10');
  });

  it('la liste des formations embarque à la fois les réalisations comptes et sans compte', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const employee = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Sophie Ligne' });
    const training = await request(app)
      .post('/api/trainings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Formation mixte' });

    await request(app)
      .post(`/api/trainings/${training.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ user_id: member.id, completed_at: '2026-01-10' });
    await request(app)
      .post(`/api/trainings/${training.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ employee_id: employee.body.id, completed_at: '2026-01-10' });

    const list = await request(app).get('/api/trainings').set('Authorization', `Bearer ${tenant.admin.token}`);
    const found = list.body.find((t) => t.id === training.body.id);
    expect(found.records).toHaveLength(2);
    expect(found.records.some((r) => r.user?.id === member.id)).toBe(true);
    expect(found.records.some((r) => r.employee?.id === employee.body.id)).toBe(true);
  });
});

describe('GET /api/trainings/matrix inclut le personnel sans compte', () => {
  it('renvoie une entrée "people" avec kind user et employee', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const employee = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Karim Chaîne' });
    const training = await request(app)
      .post('/api/trainings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Formation matrice' });

    await request(app)
      .post(`/api/trainings/${training.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ employee_id: employee.body.id, completed_at: '2026-01-10' });

    const matrix = await request(app).get('/api/trainings/matrix').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(matrix.status).toBe(200);
    const row = matrix.body.find((entry) => entry.training.id === training.body.id);

    const employeeEntry = row.people.find((p) => p.person.id === employee.body.id);
    expect(employeeEntry.person.kind).toBe('employee');
    expect(employeeEntry.status).toBe('up_to_date');

    const memberEntry = row.people.find((p) => p.person.id === member.id);
    expect(memberEntry.person.kind).toBe('user');
    expect(memberEntry.status).toBe('never_done');
  });

  it('deux salariés sans compte sur la même formation ne se confondent pas (régression clé de groupement)', async () => {
    tenant = await createTenant();
    const empA = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Employé A' });
    const empB = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Employé B' });
    const training = await request(app)
      .post('/api/trainings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Formation partagée' });

    await request(app)
      .post(`/api/trainings/${training.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ employee_id: empA.body.id, completed_at: '2026-01-10' });
    // B n'a jamais suivi la formation : ne doit surtout pas hériter du statut de A.

    const matrix = await request(app).get('/api/trainings/matrix').set('Authorization', `Bearer ${tenant.admin.token}`);
    const row = matrix.body.find((entry) => entry.training.id === training.body.id);

    expect(row.people.find((p) => p.person.id === empA.body.id).status).toBe('up_to_date');
    expect(row.people.find((p) => p.person.id === empB.body.id).status).toBe('never_done');
  });

  it('GET /dashboard/stats compte correctement les formations à renouveler pour plusieurs salariés sans compte', async () => {
    tenant = await createTenant();
    const empA = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Renouvellement A' });
    const empB = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Renouvellement B' });
    const training = await request(app)
      .post('/api/trainings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Formation à renouveler', frequency_months: 1 });

    // completed_at il y a ~25 jours, fréquence 1 mois => next_due_date dans ~5 jours : due_soon.
    const nearlyDue = new Date();
    nearlyDue.setDate(nearlyDue.getDate() - 25);
    const completedAt = nearlyDue.toISOString().slice(0, 10);

    await request(app)
      .post(`/api/trainings/${training.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ employee_id: empA.body.id, completed_at: completedAt });
    await request(app)
      .post(`/api/trainings/${training.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ employee_id: empB.body.id, completed_at: completedAt });

    const stats = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    // Sans la clé de groupement corrigée, les deux se confondraient (comptées comme 1).
    expect(stats.body.trainings.to_renew).toBe(2);
  });
});
