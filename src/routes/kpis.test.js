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

// Régression : POST /api/kpis et POST /api/kpi-folders n'avaient aucune restriction de rôle
// côté backend (seul le frontend cachait les boutons via canManage, voir Kpis.jsx) — un
// member pouvait définir un indicateur ou un dossier d'entreprise en appelant l'API
// directement. Même classe de bug que categories.js avant sa correction plus tôt dans le
// projet.
describe('POST /api/kpis — création réservée à admin/manager', () => {
  it('403 pour un member, 201 pour un manager', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const memberAttempt = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: 'Indicateur créé par un member' });
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ name: 'Indicateur créé par un manager' });
    expect(managerAttempt.status).toBe(201);
  });
});

describe('POST /api/kpi-folders — création réservée à admin/manager', () => {
  it('403 pour un member, 201 pour un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const memberAttempt = await request(app)
      .post('/api/kpi-folders')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: 'Dossier créé par un member' });
    expect(memberAttempt.status).toBe(403);

    const adminAttempt = await request(app)
      .post('/api/kpi-folders')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Dossier créé par un admin' });
    expect(adminAttempt.status).toBe(201);
  });
});
