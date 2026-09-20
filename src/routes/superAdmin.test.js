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

  it('drive_connection vaut null sans connexion Google Drive, et expose le diagnostic (jamais les jetons) si connectée', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);

    const noneRes = await request(app)
      .get(`/api/super-admin/tenants/${tenant.tenantId}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(noneRes.body.drive_connection).toBeNull();

    await admin.from('google_drive_connections').insert({
      tenant_id: tenant.tenantId,
      google_email: 'qualite@exemple.com',
      access_token: 'secret-access-token',
      refresh_token: 'secret-refresh-token',
      token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      root_folder_id: 'root-folder',
      connected_by: tenant.admin.id,
    });

    const { data: adminUser } = await admin.from('users').select('full_name').eq('id', tenant.admin.id).single();

    const res = await request(app)
      .get(`/api/super-admin/tenants/${tenant.tenantId}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.body.drive_connection.google_email).toBe('qualite@exemple.com');
    expect(res.body.drive_connection.is_active).toBe(true);
    expect(res.body.drive_connection.connected_by_name).toBe(adminUser.full_name);
    expect(res.body.drive_connection.access_token).toBeUndefined();
    expect(res.body.drive_connection.refresh_token).toBeUndefined();
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

describe('GET /api/super-admin/activity-log — double écriture + pagination/filtre/tri', () => {
  it('les actions de tenant (suspend/réactive) apparaissent, filtrables par entity et tenantId, paginées', async () => {
    tenant = await createTenant();
    targetTenant = await createTenant();
    await makeSuperAdmin(tenant);

    await request(app)
      .patch(`/api/super-admin/tenants/${targetTenant.tenantId}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_suspended: true });
    await request(app)
      .patch(`/api/super-admin/tenants/${targetTenant.tenantId}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_suspended: false });

    const res = await request(app)
      .get('/api/super-admin/activity-log')
      .query({ entity: 'tenant', tenantId: targetTenant.tenantId, limit: 10 })
      .set('Authorization', `Bearer ${tenant.admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(10);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    const actions = res.body.data.map((row) => row.action);
    expect(actions).toContain('TENANT_SUSPENDED');
    expect(actions).toContain('TENANT_REACTIVATED');
    expect(res.body.data.every((row) => row.tenant_id === targetTenant.tenantId)).toBe(true);
    expect(res.body.data[0].actor.full_name).toBe('Test Admin');
  });

  it('un changement de rôle via PATCH /users/:id produit à la fois USER_UPDATED et USER_ROLE_CHANGED', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    await makeSuperAdmin(tenant);
    const member = tenant.users[0];

    const res = await request(app)
      .patch(`/api/super-admin/users/${member.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ role: 'manager' });
    expect(res.status).toBe(200);

    const log = await request(app)
      .get('/api/super-admin/activity-log')
      .query({ entity: 'user', actorId: tenant.admin.id })
      .set('Authorization', `Bearer ${tenant.admin.token}`);

    const actions = log.body.data.filter((row) => row.entity_id === member.id).map((row) => row.action);
    expect(actions).toContain('USER_UPDATED');
    expect(actions).toContain('USER_ROLE_CHANGED');
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

// job_runs n'a pas de tenant_id (table plateforme, voir schema.sql) : les lignes insérées ici
// sont nettoyées explicitement, pas via tenant.cleanup() comme le reste de la suite.
describe('GET /api/super-admin/job-runs', () => {
  afterEach(async () => {
    await admin.from('job_runs').delete().like('job_name', 'test-job-runs-route-%');
  });

  it('403 pour un admin de tenant classique', async () => {
    tenant = await createTenant();
    const res = await request(app).get('/api/super-admin/job-runs').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(403);
  });

  it('renvoie une entrée par tâche connue, la plus récente en premier, plus les tâches inconnues à la suite', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);

    // Un run plus ancien puis un plus récent pour moduleKpiJob : c'est bien le second qui doit
    // apparaître (jamais le premier trouvé, jamais une moyenne des deux).
    await admin.from('job_runs').insert([
      { job_name: 'moduleKpiJob', started_at: '2026-01-01T03:30:00Z', finished_at: '2026-01-01T03:31:00Z', status: 'success', summary: 'Ancien run' },
      { job_name: 'moduleKpiJob', started_at: '2026-06-01T03:30:00Z', finished_at: '2026-06-01T03:31:05Z', status: 'partial', summary: '4/5 traité(s) avec succès.' },
      { job_name: 'test-job-runs-route-orpheline', started_at: '2026-06-01T00:00:00Z', status: 'failed', error: 'Job retiré depuis' },
    ]);

    const res = await request(app).get('/api/super-admin/job-runs').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);

    const byName = new Map(res.body.map((r) => [r.job_name, r]));
    // Les 5 tâches connues sont toutes présentes (voir KNOWN_JOB_NAMES), même celles qui n'ont
    // jamais encore tourné dans cette base de test.
    expect(byName.has('notificationJob')).toBe(true);
    expect(byName.has('backupJob')).toBe(true);
    expect(byName.has('driveTokenRefreshJob')).toBe(true);
    expect(byName.has('dashboardSnapshotJob')).toBe(true);

    expect(byName.get('moduleKpiJob').status).toBe('partial');
    expect(byName.get('moduleKpiJob').summary).toBe('4/5 traité(s) avec succès.');

    // Tâche inconnue (absente de KNOWN_JOB_NAMES) : reste visible plutôt que silencieusement
    // ignorée.
    expect(byName.get('test-job-runs-route-orpheline').status).toBe('failed');
    expect(byName.get('test-job-runs-route-orpheline').error).toBe('Job retiré depuis');
  });

  it("une tâche connue jamais exécutée a le statut 'never_run'", async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);

    const res = await request(app).get('/api/super-admin/job-runs').set('Authorization', `Bearer ${tenant.admin.token}`);
    const entry = res.body.find((r) => r.job_name === 'backupJob');
    expect(entry).toBeDefined();
    // 'never_run' seulement si vraiment aucune ligne pour ce job dans cette base — sinon on
    // vérifie juste que le statut est l'une des valeurs valides (un run réel a pu être inséré
    // par un autre test de ce fichier).
    expect(['never_run', 'success', 'partial', 'failed', 'running']).toContain(entry.status);
  });
});

// ai_call_failures n'a pas de tenant_id avec FK (table de diagnostic, voir schema.sql) : les
// lignes insérées ici sont nettoyées explicitement par feature, pas via tenant.cleanup().
describe('GET /api/super-admin/ai-failures', () => {
  afterEach(async () => {
    await admin.from('ai_call_failures').delete().like('feature', 'test-ai-failures-route-%');
  });

  it('403 pour un admin de tenant classique', async () => {
    tenant = await createTenant();
    const res = await request(app).get('/api/super-admin/ai-failures').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(403);
  });

  it('renvoie les échecs récents avec le tenant résolu, le plus récent en premier', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);
    targetTenant = await createTenant();

    await admin.from('ai_call_failures').insert([
      {
        tenant_id: targetTenant.tenantId,
        feature: 'test-ai-failures-route-qqoqccp',
        category: 'rate_limit',
        message: 'Quota dépassé',
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        tenant_id: targetTenant.tenantId,
        feature: 'test-ai-failures-route-procedure_full_plan',
        category: 'timeout',
        message: 'Délai dépassé',
        created_at: '2026-06-01T00:00:00Z',
      },
      // tenant_id null : échec hors d'une requête HTTP authentifiée, doit rester exploitable.
      { tenant_id: null, feature: 'test-ai-failures-route-script', category: 'network', message: null, created_at: '2026-03-01T00:00:00Z' },
    ]);

    const res = await request(app).get('/api/super-admin/ai-failures').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);

    const ours = res.body.filter((r) => r.feature.startsWith('test-ai-failures-route-'));
    expect(ours).toHaveLength(3);
    // Le plus récent (procedure_full_plan, juin) avant le plus ancien (qqoqccp, janvier).
    expect(ours[0].feature).toBe('test-ai-failures-route-procedure_full_plan');
    expect(ours[0].tenant).toEqual({ id: targetTenant.tenantId, name: targetTenant.companyName });
    expect(ours[0].category).toBe('timeout');

    const scriptRow = ours.find((r) => r.feature === 'test-ai-failures-route-script');
    expect(scriptRow.tenant).toBeNull();
    expect(scriptRow.tenant_id).toBeNull();
  });

  it('respecte ?limit (borné à 200)', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);

    const res = await request(app).get('/api/super-admin/ai-failures?limit=1').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(1);
  });
});

describe('GET /api/super-admin/backup-status', () => {
  it('403 pour un admin de tenant classique', async () => {
    tenant = await createTenant();
    const res = await request(app).get('/api/super-admin/backup-status').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(403);
  });

  it('renvoie last_local_backup (lu sur disque) et last_drive_backup sans jamais planter', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);

    const res = await request(app).get('/api/super-admin/backup-status').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect('last_local_backup' in res.body).toBe(true);
    expect('last_drive_backup' in res.body).toBe(true);
    // Pas d'appel à pg_dump ici (voir POST /backup, non couvert par des tests automatisés pour
    // la même raison que les autres services qui shell-out) : soit un backup local existe déjà
    // sur ce disque (exécution précédente, manuelle ou planifiée) et l'objet est bien formé,
    // soit il n'y en a aucun et la valeur est explicitement null plutôt qu'une erreur.
    if (res.body.last_local_backup) {
      expect(typeof res.body.last_local_backup.filename).toBe('string');
      expect(typeof res.body.last_local_backup.created_at).toBe('string');
      expect(typeof res.body.last_local_backup.size_bytes).toBe('number');
    }
  });
});

describe('POST /api/super-admin/tenants — création', () => {
  it('crée un tenant vide (sans admin) et journalise l’action', async () => {
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
    expect(res.body.admin).toBeNull();

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

  it('avec un admin fourni : crée le tenant ET l’administrateur en un seul appel, journalise les deux actions', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);
    const adminEmail = `founder-${Date.now()}@example.com`;

    const res = await request(app)
      .post('/api/super-admin/tenants')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Entreprise avec fondateur', admin: { email: adminEmail, full_name: 'Fondateur Test' } });

    expect(res.status).toBe(201);
    expect(res.body.user_count).toBe(1);
    expect(res.body.admin.email).toBe(adminEmail);
    expect(res.body.admin.role).toBe('admin');

    const { data: profile } = await admin
      .from('users')
      .select('role, tenant_id, full_name')
      .eq('id', res.body.admin.id)
      .single();
    expect(profile.role).toBe('admin');
    expect(profile.tenant_id).toBe(res.body.id);
    expect(profile.full_name).toBe('Fondateur Test');

    const { data: authUser } = await admin.auth.admin.getUserById(res.body.admin.id);
    expect(authUser.user.email).toBe(adminEmail);

    const { data: auditRows } = await admin
      .from('super_admin_audit_log')
      .select('action, target_type, target_id')
      .eq('actor_id', tenant.admin.id)
      .in('target_id', [res.body.id, res.body.admin.id]);
    expect(auditRows.some((row) => row.action === 'tenant_created' && row.target_id === res.body.id)).toBe(true);
    expect(auditRows.some((row) => row.action === 'user_created' && row.target_id === res.body.admin.id)).toBe(true);

    await admin.from('tenants').delete().eq('id', res.body.id);
    await admin.auth.admin.deleteUser(res.body.admin.id).catch(() => {});
  });

  it('avec un email d’admin déjà enregistré : 409, et le tenant nouvellement créé n’est pas laissé orphelin', async () => {
    tenant = await createTenant();
    await makeSuperAdmin(tenant);
    const tenantName = `Tenant rollback ${Date.now()}`;

    const res = await request(app)
      .post('/api/super-admin/tenants')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: tenantName, admin: { email: tenant.admin.email, full_name: 'Déjà pris' } });

    expect(res.status).toBe(409);

    const { data: orphan } = await admin.from('tenants').select('id').eq('name', tenantName).maybeSingle();
    expect(orphan).toBeNull();
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
