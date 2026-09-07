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

async function createAnalysis(token, extra = {}) {
  const res = await request(app)
    .post('/api/qqoqccp')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Analyse test', ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

// 3 des 7 questions renseignées — juste au-dessus du seuil minimum partagé par /generate,
// /create-capa et /close (voir routes/qqoqccp.js#QQOQCCP_FIELDS).
const THREE_FIELDS = { qui: 'Opérateur ligne 3', quoi: 'Arrêt de ligne répété', ou_: 'Atelier 2' };

describe('POST /api/qqoqccp/:id/create-capa — exige un contenu minimal', () => {
  it('refuse une analyse avec moins de 3 des 7 questions renseignées', async () => {
    tenant = await createTenant();
    const analysis = await createAnalysis(tenant.admin.token, { quoi: 'Un seul champ rempli' });

    const res = await request(app)
      .post(`/api/qqoqccp/${analysis.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA depuis analyse incomplète' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Remplissez au moins 3 des 7 questions avant de créer une CAPA depuis cette analyse.');
  });

  it('autorise la création avec au moins 3 des 7 questions renseignées, et pose le lien bidirectionnel', async () => {
    tenant = await createTenant();
    const analysis = await createAnalysis(tenant.admin.token, THREE_FIELDS);

    const res = await request(app)
      .post(`/api/qqoqccp/${analysis.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA depuis analyse complète' });

    expect(res.status).toBe(201);
    expect(res.body.qqoqccp_analysis_id).toBe(analysis.id);

    const detail = await request(app)
      .get(`/api/qqoqccp/${analysis.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.status).toBe('validated');
    expect(detail.body.linked_capa_id).toBe(res.body.id);
  });
});

describe('POST /api/qqoqccp/:id/close — clôture sans action', () => {
  it('refuse sans commentaire de justification', async () => {
    tenant = await createTenant();
    const analysis = await createAnalysis(tenant.admin.token, THREE_FIELDS);

    const res = await request(app)
      .post(`/api/qqoqccp/${analysis.id}/close`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('refuse une analyse avec moins de 3 des 7 questions renseignées', async () => {
    tenant = await createTenant();
    const analysis = await createAnalysis(tenant.admin.token, { quoi: 'Un seul champ rempli' });

    const res = await request(app)
      .post(`/api/qqoqccp/${analysis.id}/close`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ closure_reason: 'Analyse incomplète, ne devrait pas passer.' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Remplissez au moins 3 des 7 questions avant de clôturer cette analyse.');
  });

  it('403 pour un member, 201 pour un manager avec une justification', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const analysis = await createAnalysis(tenant.admin.token, THREE_FIELDS);

    const memberAttempt = await request(app)
      .post(`/api/qqoqccp/${analysis.id}/close`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ closure_reason: 'Rien à signaler.' });
    expect(memberAttempt.status).toBe(403);

    const res = await request(app)
      .post(`/api/qqoqccp/${analysis.id}/close`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ closure_reason: 'Cas isolé, aucune récidive constatée sur les 6 derniers mois.' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
    expect(res.body.closure_reason).toBe('Cas isolé, aucune récidive constatée sur les 6 derniers mois.');
  });

  it('refuse de clôturer une analyse déjà validée (CAPA liée), et de clôturer deux fois', async () => {
    tenant = await createTenant();
    const validated = await createAnalysis(tenant.admin.token, THREE_FIELDS);
    await request(app)
      .post(`/api/qqoqccp/${validated.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA' });

    const onValidated = await request(app)
      .post(`/api/qqoqccp/${validated.id}/close`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ closure_reason: 'Devrait être refusé.' });
    expect(onValidated.status).toBe(409);

    const closed = await createAnalysis(tenant.admin.token, THREE_FIELDS);
    await request(app)
      .post(`/api/qqoqccp/${closed.id}/close`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ closure_reason: 'Première clôture.' });

    const onAlreadyClosed = await request(app)
      .post(`/api/qqoqccp/${closed.id}/close`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ closure_reason: 'Deuxième tentative, devrait être refusée.' });
    expect(onAlreadyClosed.status).toBe(409);
  });

  it('404 sur une analyse d’un autre tenant, pour create-capa comme pour close', async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      const foreignAnalysis = await createAnalysis(otherTenant.admin.token, THREE_FIELDS);

      const createCapaAttempt = await request(app)
        .post(`/api/qqoqccp/${foreignAnalysis.id}/create-capa`)
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ title: 'CAPA' });
      expect(createCapaAttempt.status).toBe(404);

      const closeAttempt = await request(app)
        .post(`/api/qqoqccp/${foreignAnalysis.id}/close`)
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ closure_reason: 'Ne devrait jamais atteindre cette analyse.' });
      expect(closeAttempt.status).toBe(404);
    } finally {
      await otherTenant.cleanup();
    }
  });
});
