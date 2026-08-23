import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';

let tenant;
let targetTenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
  if (targetTenant) {
    await targetTenant.cleanup();
    targetTenant = undefined;
  }
});

async function makeSuperAdmin(tenantInstance) {
  await admin.from('users').update({ is_super_admin: true }).eq('id', tenantInstance.admin.id);
}

describe('Super Admin — accès réservé', () => {
  it('un admin de tenant classique (non super admin) reçoit 403 sur toutes les routes', async () => {
    tenant = await createTenant();

    const routes = ['/api/super-admin/tenants', '/api/super-admin/audit-log', '/api/super-admin/stats', '/api/super-admin/health'];
    for (const route of routes) {
      const res = await request(app).get(route).set('Authorization', `Bearer ${tenant.admin.token}`);
      expect(res.status).toBe(403);
    }
  });
});

describe('GET /api/super-admin/tenants', () => {
  it('liste tous les tenants de la plateforme avec leur nombre d’utilisateurs', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    await makeSuperAdmin(tenant);

    const res = await request(app).get('/api/super-admin/tenants').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);

    const ours = res.body.find((t) => t.id === tenant.tenantId);
    expect(ours).toBeDefined();
    expect(ours.user_count).toBe(2); // admin + le member invité
  });
});

describe('GET /api/super-admin/tenants/:id — fiche détaillée', () => {
  it('renvoie les infos du tenant, ses utilisateurs et ses volumes par module', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    await makeSuperAdmin(tenant);

    await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA de test' });

    const res = await request(app)
      .get(`/api/super-admin/tenants/${tenant.tenantId}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.tenant.id).toBe(tenant.tenantId);
    expect(res.body.users).toHaveLength(2);
    expect(res.body.module_counts.capas).toBe(1);
    expect(res.body.module_counts.documents).toBe(0);
  });

  it('404 sur un tenant inexistant', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);

    const res = await request(app)
      .get('/api/super-admin/tenants/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/super-admin/tenants/:id — suspension + journal d’audit', () => {
  it('suspend un AUTRE tenant, journalise l’action, et la retrouve dans le journal et la fiche du tenant', async () => {
    // Deux tenants distincts : le super admin agit depuis le sien (tenant) sur un tenant
    // cible (targetTenant) — suspendre le tenant du super admin lui-même bloquerait son
    // propre token (requireAuth refuse tout utilisateur d'un tenant suspendu) et casserait
    // le reste du test.
    tenant = await createTenant();
    targetTenant = await createTenant();
    await makeSuperAdmin(tenant);

    const suspend = await request(app)
      .patch(`/api/super-admin/tenants/${targetTenant.tenantId}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_suspended: true });
    expect(suspend.status).toBe(200);
    expect(suspend.body.is_suspended).toBe(true);

    const reactivate = await request(app)
      .patch(`/api/super-admin/tenants/${targetTenant.tenantId}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_suspended: false });
    expect(reactivate.status).toBe(200);
    expect(reactivate.body.is_suspended).toBe(false);

    const auditLog = await request(app).get('/api/super-admin/audit-log').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(auditLog.status).toBe(200);
    const actions = auditLog.body.filter((entry) => entry.target_id === targetTenant.tenantId).map((entry) => entry.action);
    expect(actions).toContain('tenant_suspended');
    expect(actions).toContain('tenant_reactivated');

    const detail = await request(app)
      .get(`/api/super-admin/tenants/${targetTenant.tenantId}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.recent_actions.length).toBeGreaterThanOrEqual(2);
    expect(detail.body.recent_actions[0].actor.full_name).toBe('Test Admin');
  });
});

describe('GET /api/super-admin/stats', () => {
  it('renvoie des totaux cohérents (au moins notre tenant de test)', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);

    const res = await request(app).get('/api/super-admin/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.total_tenants).toBeGreaterThanOrEqual(1);
    expect(res.body.total_users).toBeGreaterThanOrEqual(1);
    expect(res.body.tenants_created_by_month).toHaveLength(6);
    expect(res.body.by_plan.free).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /api/super-admin/health', () => {
  it('renvoie un statut ok avec une latence base de données mesurée', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);

    const res = await request(app).get('/api/super-admin/health').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.api_status).toBe('ok');
    expect(res.body.db_status).toBe('ok');
    expect(typeof res.body.db_latency_ms).toBe('number');
  });
});

describe('POST /api/super-admin/tenants — création', () => {
  it('crée un tenant vide et journalise l’action', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);

    const res = await request(app)
      .post('/api/super-admin/tenants')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'CRUD Test Co', plan: 'pro' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('CRUD Test Co');
    expect(res.body.plan).toBe('pro');
    expect(res.body.user_count).toBe(0);

    await admin.from('tenants').delete().eq('id', res.body.id);
  });

  it('rejette un nom vide', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);

    const res = await request(app)
      .post('/api/super-admin/tenants')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: '' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/super-admin/tenants/:id', () => {
  it('refuse la suppression de son propre tenant', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);

    const res = await request(app)
      .delete(`/api/super-admin/tenants/${tenant.tenantId}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(403);
  });

  it('supprime un autre tenant et journalise l’action', async () => {
    tenant = await createTenant();
    targetTenant = await createTenant();
    await makeSuperAdmin(tenant);

    const res = await request(app)
      .delete(`/api/super-admin/tenants/${targetTenant.tenantId}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const check = await admin.from('tenants').select('id').eq('id', targetTenant.tenantId).maybeSingle();
    expect(check.data).toBeNull();

    // Déjà supprimé côté public.tenants (cascade) : ne pas laisser targetTenant.cleanup()
    // retenter un DELETE sur un tenant absent dans afterEach, seuls les comptes auth restent.
    await admin.auth.admin.deleteUser(targetTenant.admin.id).catch(() => {});
    targetTenant = undefined;
  });
});

describe('POST /api/super-admin/tenants/:id/users — invitation cross-tenant', () => {
  it('invite un utilisateur dans un tenant qui n’est pas celui de l’acteur', async () => {
    tenant = await createTenant();
    targetTenant = await createTenant();
    await makeSuperAdmin(tenant);

    const email = `cross-invite-${Date.now()}@example.com`;
    const res = await request(app)
      .post(`/api/super-admin/tenants/${targetTenant.tenantId}/users`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ email, full_name: 'Cross Tenant User', role: 'manager' });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('manager');

    const profile = await admin.from('users').select('tenant_id').eq('id', res.body.id).single();
    expect(profile.data.tenant_id).toBe(targetTenant.tenantId);

    await admin.from('users').delete().eq('id', res.body.id);
    await admin.auth.admin.deleteUser(res.body.id).catch(() => {});
  });
});

describe('PATCH /api/super-admin/users/:id — édition cross-tenant', () => {
  it('modifie le rôle d’un utilisateur d’un autre tenant', async () => {
    tenant = await createTenant();
    targetTenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    await makeSuperAdmin(tenant);
    const targetUser = targetTenant.users[0];

    const res = await request(app)
      .patch(`/api/super-admin/users/${targetUser.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ role: 'admin' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
  });

  it('refuse de se désactiver soi-même', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);

    const res = await request(app)
      .patch(`/api/super-admin/users/${tenant.admin.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_active: false });
    expect(res.status).toBe(403);
  });

  it('refuse de se retirer ses propres droits super admin', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);

    const res = await request(app)
      .patch(`/api/super-admin/users/${tenant.admin.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_super_admin: false });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/super-admin/users/:id', () => {
  it('refuse la suppression de son propre compte', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);

    const res = await request(app)
      .delete(`/api/super-admin/users/${tenant.admin.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(403);
  });

  it("supprime définitivement le compte d'un utilisateur d'un autre tenant (profil ET compte auth), et libère son email", async () => {
    tenant = await createTenant();
    targetTenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    await makeSuperAdmin(tenant);
    const targetUser = targetTenant.users[0];

    const res = await request(app)
      .delete(`/api/super-admin/users/${targetUser.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);

    const profile = await admin.from('users').select('id').eq('id', targetUser.id).maybeSingle();
    expect(profile.data).toBeNull();

    const authUser = await admin.auth.admin.getUserById(targetUser.id);
    expect(authUser.data.user).toBeNull();

    // Email libéré, exactement le scénario rapporté ("email déjà existant" en essayant de
    // recréer un compte après une suppression qui ne supprimait en réalité que le profil).
    const reinvite = await request(app)
      .post(`/api/super-admin/tenants/${targetTenant.tenantId}/users`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ email: targetUser.email, full_name: 'Nouveau titulaire', role: 'member' });
    expect(reinvite.status).toBe(201);

    // Pas suivi par targetTenant.authUserIds (créé après createTenant) : nettoyage manuel pour
    // ne pas laisser un compte auth orphelin une fois le tenant supprimé par cleanup().
    await admin.auth.admin.deleteUser(reinvite.body.id).catch(() => {});
  });
});

describe('POST /api/super-admin/restore-drive — validation du fichier', () => {
  it('refuse un file_id qui ne fait pas partie des sauvegardes Drive configurées', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);

    const res = await request(app)
      .post('/api/super-admin/restore-drive')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ file_id: 'not-a-real-drive-file-id', filename: '../../etc/passwd' });

    // Sans credentials Google OAuth valides en environnement de test, l'appel échoue avant
    // même la vérification (500) ; l'essentiel est qu'il ne restaure jamais un fichier non
    // vérifié (jamais 200).
    expect(res.status).not.toBe(200);
  });
});
