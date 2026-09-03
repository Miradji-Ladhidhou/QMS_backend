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

async function createProcedure(token, number, extra = {}) {
  const res = await request(app)
    .post('/api/procedures')
    .set('Authorization', `Bearer ${token}`)
    .send({ number, title: `Procédure ${number}`, ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

describe('POST /api/procedures', () => {
  it("tous les rôles peuvent créer une procédure, sans version associée", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const res = await request(app)
      .post('/api/procedures')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ number: 'PROC-001', title: 'Gestion des non-conformités' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.current_version_id).toBeNull();
  });

  it('rejette un numéro déjà utilisé dans le même tenant', async () => {
    tenant = await createTenant();
    await createProcedure(tenant.admin.token, 'PROC-002');

    const res = await request(app)
      .post('/api/procedures')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ number: 'PROC-002', title: 'Doublon' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/procedures/:id/versions — ai_generated', () => {
  it('false par défaut, true si fourni explicitement', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-005');

    const defaultRes = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    expect(defaultRes.body.ai_generated).toBe(false);

    const aiRes = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ content: { objet: 'Généré par IA' }, ai_generated: true });
    expect(aiRes.body.ai_generated).toBe(true);
  });
});

// Ces 3 routes appellent Groq en direct : comme POST /api/risks/service-suggestion et
// consorts, aucun test automatisé ne couvre le chemin qui appelle réellement l'IA (vérifié
// manuellement, voir le smoke test du Prompt 3). On couvre ici uniquement la résolution de la
// version/procédure et les cas d'erreur qui ne nécessitent pas d'atteindre l'appel Groq.
describe('POST /api/procedures/generate-draft — validation', () => {
  it('400 sans titre', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .post('/api/procedures/generate-draft')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ process: 'Qualité' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/procedures/:id/versions/:versionId/check-compliance et /compare — résolution de la version', () => {
  it('404 sur une version qui ne correspond pas à la procédure', async () => {
    tenant = await createTenant();
    const procedureA = await createProcedure(tenant.admin.token, 'PROC-006');
    const procedureB = await createProcedure(tenant.admin.token, 'PROC-007');
    const versionOfB = await request(app)
      .post(`/api/procedures/${procedureB.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});

    const compliance = await request(app)
      .post(`/api/procedures/${procedureA.id}/versions/${versionOfB.body.id}/check-compliance`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(compliance.status).toBe(404);

    const compare = await request(app)
      .post(`/api/procedures/${procedureA.id}/versions/${versionOfB.body.id}/compare`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(compare.status).toBe(404);
  });
});

describe('POST /api/procedures/:id/versions', () => {
  it('première version à 1.0, puis incrémentée automatiquement', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-010');

    const v1 = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ content: { objet: 'Test' } });
    expect(v1.status).toBe(201);
    expect(v1.body.version).toBe('1.0');
    expect(v1.body.author_id).toBe(tenant.admin.id);
    expect(v1.body.status).toBe('draft');

    const v2 = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe('1.1');
  });
});

describe('Workflow submit / validate / reject', () => {
  async function createVersion(token, procedureId, extra = {}) {
    const res = await request(app)
      .post(`/api/procedures/${procedureId}/versions`)
      .set('Authorization', `Bearer ${token}`)
      .send(extra);
    expect(res.status).toBe(201);
    return res.body;
  }

  it("l'auteur peut soumettre sa version ; un autre member ne peut pas", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [author, other] = tenant.users;
    const procedure = await createProcedure(tenant.admin.token, 'PROC-020');
    const version = await createVersion(author.token, procedure.id);

    const forbidden = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(forbidden.status).toBe(403);

    const submitted = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${author.token}`);
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe('pending');

    const procedureAfter = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(procedureAfter.body.status).toBe('in_review');
  });

  it('un member ne peut pas valider (réservé admin/manager, même principe que la CAPA)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const procedure = await createProcedure(tenant.admin.token, 'PROC-021');
    const version = await createVersion(member.token, procedure.id);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${member.token}`)
      .expect(200);

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/validate`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(403);
  });

  it('admin valide : la procédure passe "approved" et current_version_id est mis à jour', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-022');
    const version = await createVersion(tenant.admin.token, procedure.id);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/validate`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.validator_id).toBe(tenant.admin.id);

    const procedureAfter = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(procedureAfter.body.status).toBe('approved');
    expect(procedureAfter.body.current_version_id).toBe(version.id);
  });

  it('rejet : commentaire obligatoire, la procédure repasse "draft"', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-023');
    const version = await createVersion(tenant.admin.token, procedure.id);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);

    const noComment = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/reject`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    expect(noComment.status).toBe(400);

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/reject`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ comment: 'Section responsabilités incomplète.' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.comment).toBe('Section responsabilités incomplète.');

    const procedureAfter = await request(app)
      .get(`/api/procedures/${procedure.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(procedureAfter.body.status).toBe('draft');
  });

  it('impossible de valider deux fois la même version', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-024');
    const version = await createVersion(tenant.admin.token, procedure.id);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/validate`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);

    const res = await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.id}/validate`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(409);
  });
});

describe('POST /api/procedures/:id/acknowledge', () => {
  it('400 sans version approuvée, 201 une fois une version validée, idempotent', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const procedure = await createProcedure(tenant.admin.token, 'PROC-030');

    const tooEarly = await request(app)
      .post(`/api/procedures/${procedure.id}/acknowledge`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(tooEarly.status).toBe(400);

    const version = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.body.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.body.id}/validate`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);

    const first = await request(app)
      .post(`/api/procedures/${procedure.id}/acknowledge`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/procedures/${procedure.id}/acknowledge`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(second.status).toBe(201);
  });
});

describe('GET /api/procedures/:id — historique des versions', () => {
  it('renvoie les versions avec auteur/validateur résolus', async () => {
    tenant = await createTenant();
    const procedure = await createProcedure(tenant.admin.token, 'PROC-050');
    const version = await request(app)
      .post(`/api/procedures/${procedure.id}/versions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.body.id}/submit`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);
    await request(app)
      .post(`/api/procedures/${procedure.id}/versions/${version.body.id}/validate`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .expect(200);

    const res = await request(app).get(`/api/procedures/${procedure.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.versions).toHaveLength(1);
    expect(res.body.versions[0].author.id).toBe(tenant.admin.id);
    expect(res.body.versions[0].validator.id).toBe(tenant.admin.id);
    expect(res.body.current_version.id).toBe(version.body.id);
  });
});

describe('GET /api/procedures — filtres', () => {
  it('filtre par statut et recherche texte', async () => {
    tenant = await createTenant();
    await createProcedure(tenant.admin.token, 'PROC-040', { title: 'Gestion des achats' });
    await createProcedure(tenant.admin.token, 'PROC-041', { title: 'Maîtrise documentaire' });

    const byStatus = await request(app)
      .get('/api/procedures')
      .query({ status: 'draft' })
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(byStatus.status).toBe(200);
    expect(byStatus.body).toHaveLength(2);

    const bySearch = await request(app)
      .get('/api/procedures')
      .query({ search: 'achats' })
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(bySearch.status).toBe(200);
    expect(bySearch.body.map((p) => p.number)).toEqual(['PROC-040']);
  });

  it("n'expose jamais les procédures d'un autre tenant, même à un admin", async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      await createProcedure(tenant.admin.token, 'PROC-050');
      await createProcedure(otherTenant.admin.token, 'PROC-051');

      const res = await request(app)
        .get('/api/procedures')
        .set('Authorization', `Bearer ${tenant.admin.token}`);

      expect(res.status).toBe(200);
      expect(res.body.map((p) => p.number)).toEqual(['PROC-050']);
    } finally {
      await otherTenant.cleanup();
    }
  });
});
