import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { admin, createTenant } from '../test-utils/tenant.js';

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

// activity_log est immuable (trigger, voir schema.sql) : pas de nettoyage par DELETE, on
// retrouve la ligne par son action + son email unique (timestamp) plutôt que par un id gardé
// en mémoire entre les tests.
async function latestActivityRow(action, actorEmail) {
  let query = admin.from('activity_log').select('*').eq('action', action);
  query = actorEmail === null ? query.is('actor_email', null) : query.eq('actor_email', actorEmail);
  const { data } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data;
}

describe('POST /api/auth/activity', () => {
  let tenant;

  afterEach(async () => {
    if (tenant) {
      await tenant.cleanup();
      tenant = undefined;
    }
  });

  it('400 sur un type invalide', async () => {
    const res = await request(app).post('/api/auth/activity').send({ type: 'not_a_real_type' });
    expect(res.status).toBe(400);
  });

  it('login_failed : résout tenant_id/actor_id depuis un email connu, sans jeton', async () => {
    tenant = await createTenant();
    const res = await request(app).post('/api/auth/activity').send({ type: 'login_failed', email: tenant.admin.email, reason: 'invalid_credentials' });
    expect(res.status).toBe(204);

    const row = await latestActivityRow('LOGIN_FAILED', tenant.admin.email);
    expect(row.tenant_id).toBe(tenant.tenantId);
    expect(row.actor_id).toBe(tenant.admin.id);
    expect(row.metadata).toEqual({ reason: 'invalid_credentials' });
  });

  it('login_failed : email inconnu -> toujours 204, journalisé avec tenant_id/actor_id null (jamais de fuite sur l’existence du compte)', async () => {
    const email = `inconnu-${Date.now()}@example.com`;
    const res = await request(app).post('/api/auth/activity').send({ type: 'login_failed', email });
    expect(res.status).toBe(204);

    const row = await latestActivityRow('LOGIN_FAILED', email);
    expect(row.tenant_id).toBeNull();
    expect(row.actor_id).toBeNull();
    expect(row.actor_email).toBe(email);
  });

  it('login_success : résout l’identité depuis le jeton Bearer, ignore tout email fourni dans le corps', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .post('/api/auth/activity')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ type: 'login_success', email: 'usurpation@example.com' });
    expect(res.status).toBe(204);

    const row = await latestActivityRow('LOGIN_SUCCESS', tenant.admin.email);
    expect(row.tenant_id).toBe(tenant.tenantId);
    expect(row.actor_id).toBe(tenant.admin.id);

    // L'email usurpé du corps n'a jamais été utilisé pour résoudre l'identité.
    const spoofed = await latestActivityRow('LOGIN_SUCCESS', 'usurpation@example.com');
    expect(spoofed).toBeNull();
  });

  it('login_success sans jeton (ou jeton invalide) : jamais de confiance dans un email fourni par le client, actor_id reste null', async () => {
    const res = await request(app).post('/api/auth/activity').send({ type: 'login_success', email: 'nimporte-qui@example.com' });
    expect(res.status).toBe(204);

    const row = await latestActivityRow('LOGIN_SUCCESS', null);
    // La ligne existe bien (actor_email vaut null car "email" n'est utilisé QUE pour les
    // types non-authentifiés), et n'a jamais résolu d'identité depuis le corps de la requête.
    expect(row?.actor_id ?? null).toBeNull();
  });

  it('logout manuel : résout l’identité depuis le jeton', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .post('/api/auth/activity')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ type: 'logout', reason: 'manual' });
    expect(res.status).toBe(204);

    const row = await latestActivityRow('LOGOUT', tenant.admin.email);
    expect(row.tenant_id).toBe(tenant.tenantId);
    expect(row.metadata).toEqual({ reason: 'manual' });
  });

  it('password_reset_requested : résout depuis l’email, comme login_failed', async () => {
    tenant = await createTenant();
    const res = await request(app).post('/api/auth/activity').send({ type: 'password_reset_requested', email: tenant.admin.email });
    expect(res.status).toBe(204);

    const row = await latestActivityRow('PASSWORD_RESET_REQUESTED', tenant.admin.email);
    expect(row.tenant_id).toBe(tenant.tenantId);
    expect(row.actor_id).toBe(tenant.admin.id);
  });
});
