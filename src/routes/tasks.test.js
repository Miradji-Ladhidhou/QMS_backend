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

describe('Tasks — creation and self-service management', () => {
  it('tous les rôles peuvent créer une tâche', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }] });

    for (const user of [tenant.admin, ...tenant.users]) {
      const res = await request(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ title: `Tâche de ${user.email}`, due_date: '2026-06-01' });
      expect(res.status).toBe(201);
    }
  });

  it('un member peut modifier/cocher sa propre tâche (créateur), mais pas celle d’un autre', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${memberA.token}`)
      .send({ title: 'Tâche de A', due_date: '2026-06-01' });

    const ownEdit = await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .set('Authorization', `Bearer ${memberA.token}`)
      .send({ status: 'done' });
    expect(ownEdit.status).toBe(200);
    expect(ownEdit.body.status).toBe('done');

    const othersEdit = await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .set('Authorization', `Bearer ${memberB.token}`)
      .send({ status: 'todo' });
    expect(othersEdit.status).toBe(403);
  });

  it('un member assigné (mais pas créateur) peut aussi cocher sa tâche', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Tâche assignée', due_date: '2026-06-01', assigned_to: member.id });

    const res = await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ status: 'done' });
    expect(res.status).toBe(200);
  });

  it('admin/manager peuvent gérer n’importe quelle tâche', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ title: 'Tâche du member', due_date: '2026-06-01' });

    const managerEdit = await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ title: 'Renommée par le manager' });
    expect(managerEdit.status).toBe(200);

    const adminDelete = await request(app)
      .delete(`/api/tasks/${created.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminDelete.status).toBe(204);
  });

  it('accepte un assigné utilisateur OU personnel sans compte, jamais les deux', async () => {
    tenant = await createTenant();
    const employee = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Léa Terrain' });

    const both = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Tâche invalide', due_date: '2026-06-01', assigned_to: tenant.admin.id, assigned_employee_id: employee.body.id });
    expect(both.status).toBe(400);

    const ok = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Tâche personnel', due_date: '2026-06-01', assigned_employee_id: employee.body.id });
    expect(ok.status).toBe(201);
    expect(ok.body.assigned_employee.full_name).toBe('Léa Terrain');
  });
});

describe('Tasks — priorité et checklist', () => {
  it('accepte priority et checklist valides, rejette les valeurs invalides', async () => {
    tenant = await createTenant();

    const invalidPriority = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Tâche', due_date: '2026-06-01', priority: 'extreme' });
    expect(invalidPriority.status).toBe(400);

    const invalidChecklist = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Tâche', due_date: '2026-06-01', checklist: [{ text: 'Étape 1' }] });
    expect(invalidChecklist.status).toBe(400);

    const ok = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        title: 'Tâche',
        due_date: '2026-06-01',
        priority: 'urgent',
        checklist: [{ text: 'Étape 1', done: false }, { text: 'Étape 2', done: true }],
      });
    expect(ok.status).toBe(201);
    expect(ok.body.priority).toBe('urgent');
    expect(ok.body.checklist).toHaveLength(2);
  });

  it('sans priority/checklist explicites, retombe sur les valeurs par défaut', async () => {
    tenant = await createTenant();

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Tâche', due_date: '2026-06-01' });
    expect(res.body.priority).toBe('normal');
    expect(res.body.checklist).toEqual([]);
  });
});

describe('Tasks — récurrence', () => {
  it('clôturer une tâche hebdomadaire recrée automatiquement la prochaine occurrence', async () => {
    tenant = await createTenant();

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        title: 'Contrôle hygiène',
        due_date: '2026-06-01',
        recurrence: 'weekly',
        recurrence_interval: 1,
        checklist: [{ text: 'Vérifier les frigos', done: false }],
      });
    expect(created.status).toBe(201);

    const closed = await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'done' });
    expect(closed.status).toBe(200);

    const list = await request(app).get('/api/tasks').set('Authorization', `Bearer ${tenant.admin.token}`);
    const next = list.body.find((t) => t.id !== created.body.id && t.title === 'Contrôle hygiène');
    expect(next).toBeDefined();
    expect(next.due_date).toBe('2026-06-08');
    expect(next.status).toBe('todo');
    expect(next.recurrence).toBe('weekly');
    expect(next.checklist).toEqual([]);
  });

  it('clôturer une tâche annuelle recrée la prochaine occurrence un an plus tard', async () => {
    tenant = await createTenant();

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Revue de direction', due_date: '2026-06-01', recurrence: 'yearly', recurrence_interval: 1 });
    expect(created.status).toBe(201);

    await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'done' })
      .expect(200);

    const list = await request(app).get('/api/tasks').set('Authorization', `Bearer ${tenant.admin.token}`);
    const next = list.body.find((t) => t.id !== created.body.id && t.title === 'Revue de direction');
    expect(next).toBeDefined();
    expect(next.due_date).toBe('2027-06-01');
    expect(next.recurrence).toBe('yearly');
  });

  it('clôturer une tâche non récurrente ne crée aucune occurrence', async () => {
    tenant = await createTenant();

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Tâche ponctuelle', due_date: '2026-06-01' });

    await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'done' });

    const list = await request(app).get('/api/tasks').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(list.body).toHaveLength(1);
  });

  it('re-cocher "done" une tâche récurrente déjà terminée ne recrée pas une occurrence supplémentaire', async () => {
    tenant = await createTenant();

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Tâche mensuelle', due_date: '2026-06-01', recurrence: 'monthly' });

    await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'done' });

    await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'done' });

    const list = await request(app).get('/api/tasks').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(list.body).toHaveLength(2);
  });
});
