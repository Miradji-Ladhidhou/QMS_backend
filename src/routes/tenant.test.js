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
