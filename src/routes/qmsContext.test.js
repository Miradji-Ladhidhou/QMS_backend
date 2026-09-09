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

describe('GET /api/qms-context — avant toute publication', () => {
  it('renvoie current: null, sans erreur, pour tout rôle authentifié', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const res = await request(app).get('/api/qms-context').set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(200);
    expect(res.body.current).toBeNull();
    expect(res.body.versions).toEqual([]);
  });
});

describe('POST /api/qms-context — publication réservée admin', () => {
  it('403 pour un member et un manager, 201 pour un admin ; la version devient "current"', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const payload = {
      external_issues: 'Marché en forte croissance, nouveaux concurrents.',
      internal_issues: 'Turnover élevé sur les postes techniques.',
      products_services: 'Fabrication de pièces mécaniques usinées.',
      scope_description: 'Couvre le site de production principal, hors télétravail.',
      excluded_requirements: "§8.3 (conception) non applicable : l'organisme ne conçoit pas de nouveaux produits.",
      interested_parties: [
        { name: 'Clients', requirements: 'Conformité aux spécifications, délais de livraison.' },
        { name: 'Organisme certificateur', requirements: 'Conformité ISO 9001, audits annuels.' },
      ],
    };

    for (const user of [member, manager]) {
      const res = await request(app).post('/api/qms-context').set('Authorization', `Bearer ${user.token}`).send(payload);
      expect(res.status).toBe(403);
    }

    const created = await request(app).post('/api/qms-context').set('Authorization', `Bearer ${tenant.admin.token}`).send(payload);
    expect(created.status).toBe(201);
    expect(created.body.interested_parties).toHaveLength(2);
    expect(created.body.author.id).toBe(tenant.admin.id);

    const detail = await request(app).get('/api/qms-context').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.current.id).toBe(created.body.id);
    expect(detail.body.versions).toHaveLength(1);
  });

  it('accepte une publication sans aucune partie intéressée (tableau vide par défaut)', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .post('/api/qms-context')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ external_issues: 'Contexte minimal.' });
    expect(res.status).toBe(201);
    expect(res.body.interested_parties).toEqual([]);
  });

  it('refuse une partie intéressée sans nom', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .post('/api/qms-context')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ interested_parties: [{ name: '', requirements: 'Sans nom, doit être rejeté.' }] });
    expect(res.status).toBe(400);
  });

  it('republier crée une nouvelle version courante, l’ancienne reste dans l’historique', async () => {
    tenant = await createTenant();

    const first = await request(app)
      .post('/api/qms-context')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ scope_description: 'Périmètre version 1.' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/qms-context')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ scope_description: 'Périmètre version 2, mis à jour après revue.' });
    expect(second.status).toBe(201);

    const detail = await request(app).get('/api/qms-context').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.current.id).toBe(second.body.id);
    expect(detail.body.versions).toHaveLength(2);
    expect(detail.body.versions.map((v) => v.id)).toContain(first.body.id);
  });
});

describe('Isolation multi-tenant', () => {
  it('le contexte SMQ d’un tenant n’est jamais visible depuis un autre', async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      await request(app)
        .post('/api/qms-context')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ scope_description: 'Périmètre du tenant A, ne doit jamais fuiter.' });

      const res = await request(app).get('/api/qms-context').set('Authorization', `Bearer ${otherTenant.admin.token}`);
      expect(res.status).toBe(200);
      expect(res.body.current).toBeNull();
      expect(res.body.versions).toEqual([]);
    } finally {
      await otherTenant.cleanup();
    }
  });
});
