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

describe('Registration and role model', () => {
  it('le fondateur du tenant est "admin", pas "owner" (rôle fusionné)', async () => {
    tenant = await createTenant();
    const me = await request(app).get('/api/users/me').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(me.body.role).toBe('admin');
  });

  it('la base rejette "owner" comme valeur de rôle (contrainte retirée)', async () => {
    tenant = await createTenant();
    const { error } = await admin.from('users').update({ role: 'owner' }).eq('id', tenant.admin.id);
    expect(error).not.toBeNull();
  });
});

describe('PATCH /api/users/:id — gestion symétrique entre admins', () => {
  it('un admin peut changer le rôle et désactiver un autre admin (plus de rôle protégé)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'admin' }] });
    const secondAdmin = tenant.users[0];

    // Déactivation d'abord : les deux sont encore admins à ce stade. Le rôle du fondateur
    // n'est changé qu'ensuite — le faire avant aurait fait perdre à son propre token le
    // droit d'appeler cette route admin-only pour l'étape suivante.
    const deactivate = await request(app)
      .patch(`/api/users/${secondAdmin.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_active: false });
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.is_active).toBe(false);

    const blocked = await request(app).get('/api/users/me').set('Authorization', `Bearer ${secondAdmin.token}`);
    expect(blocked.status).toBe(403);

    const reactivate = await request(app)
      .patch(`/api/users/${secondAdmin.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_active: true });
    expect(reactivate.status).toBe(200);

    const roleChange = await request(app)
      .patch(`/api/users/${tenant.admin.id}`)
      .set('Authorization', `Bearer ${secondAdmin.token}`)
      .send({ role: 'manager' });
    expect(roleChange.status).toBe(200);
    expect(roleChange.body.role).toBe('manager');
  });

  it('un utilisateur ne peut jamais se désactiver lui-même, quel que soit son rôle', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .patch(`/api/users/${tenant.admin.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_active: false });
    expect(res.status).toBe(403);
  });

  it('member bloqué (403) sur la modification d’un autre utilisateur', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const res = await request(app)
      .patch(`/api/users/${manager.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ role: 'member' });
    expect(res.status).toBe(403);
  });
});

describe('Invitation lifecycle', () => {
  it('GET /users expose email + invitation_pending, et /resend-invite fonctionne', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const list = await request(app).get('/api/users').set('Authorization', `Bearer ${tenant.admin.token}`);
    const row = list.body.find((u) => u.id === member.id);
    expect(row.email).toBe(member.email);
    expect(row.invitation_pending).toBe(true);

    const resend = await request(app)
      .post(`/api/users/${member.id}/resend-invite`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(resend.status).toBe(200);

    const forbidden = await request(app)
      .post(`/api/users/${member.id}/resend-invite`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(forbidden.status).toBe(403);
  });
});

describe('Removed features stay removed', () => {
  it('POST /users/:id/transfer-ownership n’existe plus (404)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const res = await request(app)
      .post(`/api/users/${tenant.users[0].id}/transfer-ownership`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(404);
  });

  it('GET/DELETE /api/tenant/export et /api/tenant n’existent plus (404)', async () => {
    tenant = await createTenant();
    const exportRes = await request(app).get('/api/tenant/export').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(exportRes.status).toBe(404);

    const deleteRes = await request(app)
      .delete('/api/tenant')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ confirm_name: tenant.companyName });
    expect(deleteRes.status).toBe(404);
  });
});
