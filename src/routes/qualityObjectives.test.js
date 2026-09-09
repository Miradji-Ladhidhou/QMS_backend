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

async function makeObjective(token, overrides = {}) {
  const res = await request(app)
    .post('/api/quality-objectives')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Réduire le taux de non-conformité fournisseur', ...overrides });
  return res;
}

describe('POST /api/quality-objectives — création réservée à admin/manager', () => {
  it('403 pour un member, 201 pour un manager avec statut "in_progress" par défaut', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const memberAttempt = await makeObjective(member.token);
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await makeObjective(manager.token);
    expect(managerAttempt.status).toBe(201);
    expect(managerAttempt.body.status).toBe('in_progress');
    expect(managerAttempt.body.achieved_at).toBeNull();
  });
});

describe('GET /api/quality-objectives — visible à tous les rôles', () => {
  it('un member voit les objectifs créés par un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    await makeObjective(tenant.admin.token, { title: 'Objectif visible par tous' });

    const res = await request(app).get('/api/quality-objectives').set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(200);
    expect(res.body.some((o) => o.title === 'Objectif visible par tous')).toBe(true);
  });
});

describe('PATCH /api/quality-objectives/:id — statut négatif justifié, achieved_at posé une fois', () => {
  it('403 pour un member', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const objective = await makeObjective(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/quality-objectives/${objective.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ status: 'achieved' });
    expect(res.status).toBe(403);
  });

  it('refuse "not_achieved"/"abandoned" sans commentaire, accepte avec', async () => {
    tenant = await createTenant();

    // Un objectif frais par statut testé : status_comment ne doit pas fuiter d'une tentative
    // à l'autre (sinon le repli fetch-fallback verrait à tort un commentaire déjà posé).
    for (const status of ['not_achieved', 'abandoned']) {
      const objective = await makeObjective(tenant.admin.token, { title: `Objectif ${status}` });

      const withoutComment = await request(app)
        .patch(`/api/quality-objectives/${objective.body.id}`)
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ status });
      expect(withoutComment.status).toBe(400);

      const withComment = await request(app)
        .patch(`/api/quality-objectives/${objective.body.id}`)
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ status, status_comment: 'Ressources réaffectées à une priorité plus urgente.' });
      expect(withComment.status).toBe(200);
      expect(withComment.body.status).toBe(status);
    }
  });

  it('"achieved" n’exige aucun commentaire et pose achieved_at une seule fois', async () => {
    tenant = await createTenant();
    const objective = await makeObjective(tenant.admin.token);

    const achieved = await request(app)
      .patch(`/api/quality-objectives/${objective.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'achieved' });
    expect(achieved.status).toBe(200);
    expect(achieved.body.achieved_at).not.toBeNull();
    const firstAchievedAt = achieved.body.achieved_at;

    // Re-sauvegarder un autre champ sans repasser par "achieved" ne doit pas rejouer achieved_at.
    const reSaved = await request(app)
      .patch(`/api/quality-objectives/${objective.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'achieved', description: 'Précision ajoutée après coup.' });
    expect(reSaved.status).toBe(200);
    expect(reSaved.body.achieved_at).toBe(firstAchievedAt);
  });
});

describe('POST /api/quality-objectives/:id/create-capa — lien bidirectionnel optionnel', () => {
  it("crée une CAPA liée, assignée au responsable de l'objectif par défaut, visible dans les deux sens", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const owner = tenant.users[0];
    const objective = await makeObjective(tenant.admin.token, { owner: owner.id });

    const capa = await request(app)
      .post(`/api/quality-objectives/${objective.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Plan de rattrapage' });
    expect(capa.status).toBe(201);
    expect(capa.body.quality_objective_id).toBe(objective.body.id);
    expect(capa.body.origin).toContain('Objectif qualité');
    expect(capa.body.assigned_to).toBe(owner.id);

    const detail = await request(app)
      .get(`/api/quality-objectives/${objective.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.linked_capa.id).toBe(capa.body.id);
  });

  it('un objectif "not_achieved" reste valide sans jamais avoir de CAPA liée', async () => {
    tenant = await createTenant();
    const objective = await makeObjective(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/quality-objectives/${objective.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'not_achieved', status_comment: 'Cible trop ambitieuse, révisée pour le cycle suivant.' });
    expect(res.status).toBe(200);
    expect(res.body.linked_capa).toBeNull();
  });
});

describe('Catégories — un objectif qualité respecte les mêmes règles que les 14 autres modules', () => {
  it('la déduction du garde-fou de suppression de catégorie couvre quality_objective sans changement dans moduleCategories.js', async () => {
    tenant = await createTenant();

    const category = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'quality_objective', name: 'Catégorie objectifs restreinte', is_restricted: true });
    expect(category.status).toBe(201);

    const objective = await makeObjective(tenant.admin.token, { category_id: category.body.id });
    expect(objective.body.category_id).toBe(category.body.id);

    const blocked = await request(app)
      .delete(`/api/module-categories/${category.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('1 objectif qualité');

    await request(app)
      .delete(`/api/quality-objectives/${objective.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);

    const ok = await request(app)
      .delete(`/api/module-categories/${category.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(ok.status).toBe(204);
  });
});

describe('Isolation multi-tenant', () => {
  it('404 sur un objectif qualité d’un autre tenant', async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      const foreignObjective = await makeObjective(otherTenant.admin.token);

      const getAttempt = await request(app)
        .get(`/api/quality-objectives/${foreignObjective.body.id}`)
        .set('Authorization', `Bearer ${tenant.admin.token}`);
      expect(getAttempt.status).toBe(404);

      const patchAttempt = await request(app)
        .patch(`/api/quality-objectives/${foreignObjective.body.id}`)
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ status: 'achieved' });
      expect(patchAttempt.status).toBe(404);
    } finally {
      await otherTenant.cleanup();
    }
  });
});
