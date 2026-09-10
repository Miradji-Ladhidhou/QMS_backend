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

  it('refuse aussi la suppression pour un accident ou une tâche rattachés (pas seulement les réalisations de formation)', async () => {
    tenant = await createTenant();
    const employee = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Paul Chantier' });
    const employeeId = employee.body.id;

    const accident = await request(app)
      .post('/api/accidents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Chute sur chantier', occurred_at: '2026-01-15', injured_employee_id: employeeId });
    expect(accident.body.injured_employee_id).toBe(employeeId);

    const task = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Refaire l’habilitation', due_date: '2026-02-01', assigned_employee_id: employeeId });
    expect(task.body.assigned_employee_id).toBe(employeeId);

    const blocked = await request(app)
      .delete(`/api/employees/${employeeId}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('1 accident du travail');
    expect(blocked.body.error).toContain('1 tâche assignée');
    expect(blocked.body.error).toMatch(/désactiv/i);

    await admin.from('accidents').delete().eq('id', accident.body.id);
    await admin.from('tasks').delete().eq('id', task.body.id);

    const ok = await request(app)
      .delete(`/api/employees/${employeeId}`)
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

describe('Personnel — dossiers (catégories génériques resource_type=employee)', () => {
  it('création/modification avec category_id, catégorie jointe dans la réponse', async () => {
    tenant = await createTenant();

    const cat = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'employee', name: 'Atelier' });
    expect(cat.status).toBe(201);

    const emp = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Ouvrier A', category_id: cat.body.id });
    expect(emp.status).toBe(201);
    expect(emp.body.category_id).toBe(cat.body.id);
    expect(emp.body.category?.name).toBe('Atelier');

    const moved = await request(app)
      .patch(`/api/employees/${emp.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ category_id: null });
    expect(moved.status).toBe(200);
    expect(moved.body.category_id).toBeNull();
  });

  it('refuse un category_id d’un autre resource_type / tenant', async () => {
    tenant = await createTenant();
    const other = await createTenant();

    const wrongType = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'risk', name: 'Pas pour le personnel' });
    const res1 = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'X', category_id: wrongType.body.id });
    expect(res1.status).toBe(400);

    const otherCat = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${other.admin.token}`)
      .send({ resource_type: 'employee', name: 'Autre tenant' });
    const res2 = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Y', category_id: otherCat.body.id });
    expect(res2.status).toBe(400);

    await other.cleanup();
  });

  it('un dossier restreint masque ses personnes pour un member sans permission', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const cat = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'employee', name: 'Confidentiel', is_restricted: true });
    const emp = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Personne cachée', category_id: cat.body.id });

    const adminList = await request(app).get('/api/employees').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminList.body.map((e) => e.id)).toContain(emp.body.id);

    const memberList = await request(app).get('/api/employees').set('Authorization', `Bearer ${member.token}`);
    expect(memberList.body.map((e) => e.id)).not.toContain(emp.body.id);
  });

  it('garde-fou : supprimer un dossier contenant une personne renvoie 409', async () => {
    tenant = await createTenant();

    const cat = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'employee', name: 'Site Nord' });
    const emp = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Salarié Nord', category_id: cat.body.id });

    const blocked = await request(app)
      .delete(`/api/module-categories/${cat.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('1 personne');

    await request(app).delete(`/api/employees/${emp.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    const ok = await request(app)
      .delete(`/api/module-categories/${cat.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(ok.status).toBe(204);
  });
});
