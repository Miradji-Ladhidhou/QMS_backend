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
