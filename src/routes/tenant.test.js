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

// Durcissement : le logo était accepté quel que soit son type MIME et stocké tel quel comme
// content-type public — un SVG (peut embarquer du <script>) ou un HTML uploadé comme "logo"
// s'exécuterait dans le navigateur au lieu de s'afficher comme une image. Voir ALLOWED_LOGO_TYPES
// dans routes/tenant.js.
describe('POST /api/tenant/logo — types de fichiers acceptés', () => {
  it('accepte une image PNG, rejette un SVG', async () => {
    tenant = await createTenant();
    const fakeImage = Buffer.from('not a real image, content is irrelevant for this check');

    const svgAttempt = await request(app)
      .post('/api/tenant/logo')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', fakeImage, { filename: 'logo.svg', contentType: 'image/svg+xml' });
    expect(svgAttempt.status).toBe(400);

    const pngAttempt = await request(app)
      .post('/api/tenant/logo')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', fakeImage, { filename: 'logo.png', contentType: 'image/png' });
    expect(pngAttempt.status).toBe(200);
    expect(pngAttempt.body.logo_url).toBeTruthy();
  });
});

describe('Visibilité du menu par rôle et par utilisateur', () => {
  it("un admin voit toujours tout, même si son propre rôle est masqué dans role_hidden_items", async () => {
    tenant = await createTenant();

    await request(app)
      .patch('/api/tenant/menu-settings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ role_hidden_items: { manager: ['suppliers'] }, user_overrides: {} });

    const res = await request(app).get('/api/tenant/menu').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.visible).toContain('suppliers');
    expect(res.body.visible).toContain('documents');
  });

  it("masque une section pour un rôle, et une exception par utilisateur la rétablit pour lui seul", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;

    const patchRes = await request(app)
      .patch('/api/tenant/menu-settings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        role_hidden_items: { member: ['suppliers', 'kpis'] },
        user_overrides: { [memberA.id]: { suppliers: true } },
      });
    expect(patchRes.status).toBe(200);

    const menuA = await request(app).get('/api/tenant/menu').set('Authorization', `Bearer ${memberA.token}`);
    expect(menuA.body.visible).toContain('suppliers');
    expect(menuA.body.visible).not.toContain('kpis');

    const menuB = await request(app).get('/api/tenant/menu').set('Authorization', `Bearer ${memberB.token}`);
    expect(menuB.body.visible).not.toContain('suppliers');
    expect(menuB.body.visible).not.toContain('kpis');
    expect(menuB.body.visible).toContain('documents');
  });

  it('rejette une configuration invalide (rôle ou clé de section inconnus)', async () => {
    tenant = await createTenant();

    const badRole = await request(app)
      .patch('/api/tenant/menu-settings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ role_hidden_items: { admin: ['documents'] }, user_overrides: {} });
    expect(badRole.status).toBe(400);

    const badKey = await request(app)
      .patch('/api/tenant/menu-settings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ role_hidden_items: { member: ['not-a-real-section'] }, user_overrides: {} });
    expect(badKey.status).toBe(400);
  });

  it("services et personnel sont masqués par défaut pour manager/member (jamais configuré), visibles pour l'admin", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }] });
    const [manager, member] = tenant.users;

    const adminMenu = await request(app).get('/api/tenant/menu').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminMenu.body.visible).toContain('services');
    expect(adminMenu.body.visible).toContain('employees');

    const managerMenu = await request(app).get('/api/tenant/menu').set('Authorization', `Bearer ${manager.token}`);
    expect(managerMenu.body.visible).not.toContain('services');
    expect(managerMenu.body.visible).not.toContain('employees');
    expect(managerMenu.body.visible).toContain('documents');

    const memberMenu = await request(app).get('/api/tenant/menu').set('Authorization', `Bearer ${member.token}`);
    expect(memberMenu.body.visible).not.toContain('services');

    // L'admin peut explicitement les rendre visibles à un rôle malgré le défaut masqué.
    await request(app)
      .patch('/api/tenant/menu-settings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ role_hidden_items: { manager: [], member: ['services', 'employees'] }, user_overrides: {} })
      .expect(200);

    const managerAfter = await request(app).get('/api/tenant/menu').set('Authorization', `Bearer ${manager.token}`);
    expect(managerAfter.body.visible).toContain('services');
    const memberAfter = await request(app).get('/api/tenant/menu').set('Authorization', `Bearer ${member.token}`);
    expect(memberAfter.body.visible).not.toContain('services');
  });

  it('un manager/member ne peut pas lire ou modifier les réglages de visibilité', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const getRes = await request(app).get('/api/tenant/menu-settings').set('Authorization', `Bearer ${member.token}`);
    expect(getRes.status).toBe(403);

    const patchRes = await request(app)
      .patch('/api/tenant/menu-settings')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ role_hidden_items: {}, user_overrides: {} });
    expect(patchRes.status).toBe(403);
  });
});

// Un menu masqué ne masquait jusque-là QUE la barre latérale (raccourcis dashboard et API
// restaient accessibles tels quels, bug réel rapporté) — requireMenuVisible (voir
// middleware/menuVisibility.js) bloque désormais aussi l'API elle-même, sur les 9 modules
// "métier" (les autres clés — dashboard/planning/documents/my-approvals/services/employees —
// restent volontairement un réglage d'affichage pur, voir le commentaire sur DEFAULT_HIDDEN_FOR_ROLE).
describe('Visibilité de menu = accès API réellement bloqué (requireMenuVisible)', () => {
  it('un member avec "risks" masqué reçoit 403 sur GET /api/risks, un autre member non concerné passe', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;

    await request(app)
      .patch('/api/tenant/menu-settings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ role_hidden_items: { member: ['risks'] }, user_overrides: {} })
      .expect(200);

    const blocked = await request(app).get('/api/risks').set('Authorization', `Bearer ${memberA.token}`);
    expect(blocked.status).toBe(403);

    // Exception par utilisateur : rétablit l'accès pour memberB seul.
    await request(app)
      .patch('/api/tenant/menu-settings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ role_hidden_items: { member: ['risks'] }, user_overrides: { [memberB.id]: { risks: true } } })
      .expect(200);

    const allowed = await request(app).get('/api/risks').set('Authorization', `Bearer ${memberB.token}`);
    expect(allowed.status).toBe(200);
  });

  it("l'admin garde l'accès à un module même masqué pour son propre rôle dans role_hidden_items", async () => {
    tenant = await createTenant();

    await request(app)
      .patch('/api/tenant/menu-settings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ role_hidden_items: { manager: ['capas'], member: ['capas'] }, user_overrides: {} })
      .expect(200);

    const res = await request(app).get('/api/capas').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
  });

  it('le blocage couvre toutes les routes du module, pas seulement la liste (POST /api/suppliers)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    await request(app)
      .patch('/api/tenant/menu-settings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ role_hidden_items: { manager: ['suppliers'] }, user_overrides: {} })
      .expect(200);

    const res = await request(app)
      .post('/api/suppliers')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ name: 'Fournisseur test' });
    expect(res.status).toBe(403);
  });

  it('un module non masqué (par défaut) reste normalement accessible (capas, kpis)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const capas = await request(app).get('/api/capas').set('Authorization', `Bearer ${member.token}`);
    expect(capas.status).toBe(200);
    const kpis = await request(app).get('/api/kpis').set('Authorization', `Bearer ${member.token}`);
    expect(kpis.status).toBe(200);
  });
});
