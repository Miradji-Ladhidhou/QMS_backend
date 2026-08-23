import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { admin } from '../test-utils/tenant.js';

let createdUserId;
let createdTenantId;

afterEach(async () => {
  if (createdTenantId) {
    await admin.from('tenants').delete().eq('id', createdTenantId);
    createdTenantId = undefined;
  }
  if (createdUserId) {
    await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
    createdUserId = undefined;
  }
});

describe('POST /api/auth/register — confirmation email requise', () => {
  it("crée le compte non confirmé et refuse la connexion tant que l'email n'est pas confirmé", async () => {
    const email = `register-test-${Date.now()}@example.com`;

    const res = await request(app).post('/api/auth/register').send({
      email,
      password: 'password123',
      fullName: 'Test Register',
      companyName: 'Entreprise Test Register',
    });

    expect(res.status).toBe(201);
    expect(res.body.email_confirmation_required).toBe(true);
    createdUserId = res.body.user.id;
    createdTenantId = res.body.tenant.id;

    const { data: authUser } = await admin.auth.admin.getUserById(createdUserId);
    expect(authUser.user.email_confirmed_at).toBeFalsy();

    const { data: profile } = await admin.from('users').select('role, tenant_id').eq('id', createdUserId).single();
    expect(profile.role).toBe('admin');
    expect(profile.tenant_id).toBe(createdTenantId);
  });

  it('refuse un second enregistrement avec le même email (déjà existant)', async () => {
    const email = `register-dupe-${Date.now()}@example.com`;

    const first = await request(app).post('/api/auth/register').send({
      email,
      password: 'password123',
      fullName: 'Premier',
      companyName: 'Première entreprise',
    });
    expect(first.status).toBe(201);
    createdUserId = first.body.user.id;
    createdTenantId = first.body.tenant.id;

    const second = await request(app).post('/api/auth/register').send({
      email,
      password: 'password123',
      fullName: 'Deuxième',
      companyName: 'Deuxième entreprise',
    });
    expect(second.status).toBe(409);
  });
});
