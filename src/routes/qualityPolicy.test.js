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

describe('GET /api/quality-policy — avant toute publication', () => {
  it('renvoie current: null, sans erreur, pour tout rôle authentifié', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const res = await request(app).get('/api/quality-policy').set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(200);
    expect(res.body.current).toBeNull();
    expect(res.body.versions).toEqual([]);
    expect(res.body.my_acknowledgment).toBeNull();
  });
});

describe('POST /api/quality-policy — publication réservée admin', () => {
  it('403 pour un member et un manager, 201 pour un admin ; la version devient "current"', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    for (const user of [member, manager]) {
      const res = await request(app)
        .post('/api/quality-policy')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ content: 'Notre engagement qualité.' });
      expect(res.status).toBe(403);
    }

    const created = await request(app)
      .post('/api/quality-policy')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ content: 'Notre engagement qualité.' });
    expect(created.status).toBe(201);
    expect(created.body.content).toBe('Notre engagement qualité.');
    expect(created.body.author.id).toBe(tenant.admin.id);

    const detail = await request(app).get('/api/quality-policy').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.current.id).toBe(created.body.id);
    expect(detail.body.versions).toHaveLength(1);
  });

  it('refuse un contenu vide', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .post('/api/quality-policy')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ content: '   ' });
    expect(res.status).toBe(400);
  });

  it('republier crée une nouvelle version courante, l’ancienne reste dans l’historique', async () => {
    tenant = await createTenant();

    const first = await request(app)
      .post('/api/quality-policy')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ content: 'Version 1.' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/quality-policy')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ content: 'Version 2.' });
    expect(second.status).toBe(201);

    const detail = await request(app).get('/api/quality-policy').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.current.id).toBe(second.body.id);
    expect(detail.body.versions).toHaveLength(2);
    expect(detail.body.versions.map((v) => v.id)).toContain(first.body.id);
  });
});

describe('POST /api/quality-policy/acknowledge', () => {
  it('400 sans politique publiée, 201 une fois publiée, idempotent au second appel', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const tooEarly = await request(app)
      .post('/api/quality-policy/acknowledge')
      .set('Authorization', `Bearer ${member.token}`);
    expect(tooEarly.status).toBe(400);

    await request(app)
      .post('/api/quality-policy')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ content: 'Notre engagement qualité.' });

    const first = await request(app)
      .post('/api/quality-policy/acknowledge')
      .set('Authorization', `Bearer ${member.token}`);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/quality-policy/acknowledge')
      .set('Authorization', `Bearer ${member.token}`);
    expect(second.status).toBe(201);

    const detail = await request(app).get('/api/quality-policy').set('Authorization', `Bearer ${member.token}`);
    expect(detail.body.my_acknowledgment).not.toBeNull();
  });

  it('republier remet tout le monde à "pas encore lu", et acknowledgment_summary reflète le décompte réel (admin/manager seulement)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    await request(app)
      .post('/api/quality-policy')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ content: 'Version 1.' });

    await request(app).post('/api/quality-policy/acknowledge').set('Authorization', `Bearer ${member.token}`);

    const afterFirstAck = await request(app).get('/api/quality-policy').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(afterFirstAck.body.acknowledgment_summary).toEqual({ acknowledged_count: 1, total_users: 2 });

    // Un member n'a pas accès à l'agrégat de pilotage.
    const memberView = await request(app).get('/api/quality-policy').set('Authorization', `Bearer ${member.token}`);
    expect(memberView.body.acknowledgment_summary).toBeNull();

    await request(app)
      .post('/api/quality-policy')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ content: 'Version 2.' });

    const afterRepublish = await request(app).get('/api/quality-policy').set('Authorization', `Bearer ${member.token}`);
    expect(afterRepublish.body.my_acknowledgment).toBeNull();

    const summaryAfterRepublish = await request(app)
      .get('/api/quality-policy')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(summaryAfterRepublish.body.acknowledgment_summary).toEqual({ acknowledged_count: 0, total_users: 2 });
  });
});

describe('Isolation multi-tenant', () => {
  it('la politique qualité d’un tenant n’est jamais visible depuis un autre', async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      await request(app)
        .post('/api/quality-policy')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ content: 'Politique du tenant A, ne doit jamais fuiter.' });

      const res = await request(app)
        .get('/api/quality-policy')
        .set('Authorization', `Bearer ${otherTenant.admin.token}`);
      expect(res.status).toBe(200);
      expect(res.body.current).toBeNull();
      expect(res.body.versions).toEqual([]);
    } finally {
      await otherTenant.cleanup();
    }
  });
});
