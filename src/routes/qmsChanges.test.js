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

async function makeChange(token, overrides = {}) {
  const res = await request(app)
    .post('/api/qms-changes')
    .set('Authorization', `Bearer ${token}`)
    .send({
      title: 'Changement de logiciel de gestion des stocks',
      description: 'Remplacement du logiciel actuel par un nouvel ERP pour la gestion des stocks.',
      ...overrides,
    });
  return res;
}

const FULL_REVIEW_FIELDS = {
  purpose: 'Réduire les erreurs de saisie manuelle et fiabiliser le suivi des stocks.',
  potential_consequences: 'Interruption possible du suivi des stocks pendant la migration.',
  integrity_impact: "Aucun impact sur les autres processus du SMQ, le nouvel outil s'intègre au système documentaire existant.",
  resources_needed: 'Un budget de formation et 2 jours d’accompagnement du prestataire.',
  responsibilities_reallocation: 'Le responsable qualité devient administrateur du nouvel outil.',
};

describe('POST /api/qms-changes — création ouverte à tous les rôles', () => {
  it('201 pour un member, un manager ou un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const memberAttempt = await makeChange(member.token);
    expect(memberAttempt.status).toBe(201);
    expect(memberAttempt.body.status).toBe('planned');

    const managerAttempt = await makeChange(manager.token);
    expect(managerAttempt.status).toBe(201);

    const adminAttempt = await makeChange(tenant.admin.token);
    expect(adminAttempt.status).toBe(201);
  });

  it('rejette un titre ou une description manquants', async () => {
    tenant = await createTenant();

    const noTitle = await request(app)
      .post('/api/qms-changes')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ description: 'Une description.' });
    expect(noTitle.status).toBe(400);

    const noDescription = await request(app)
      .post('/api/qms-changes')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Un changement' });
    expect(noDescription.status).toBe(400);
  });
});

describe('PATCH /api/qms-changes/:id — réservé admin/manager', () => {
  it('403 pour un member, 200 pour un manager', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const change = await makeChange(tenant.admin.token);

    const memberAttempt = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send(FULL_REVIEW_FIELDS);
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send(FULL_REVIEW_FIELDS);
    expect(managerAttempt.status).toBe(200);
  });
});

describe('PATCH /api/qms-changes/:id — graphe de transition', () => {
  it('refuse un saut direct planned -> implemented', async () => {
    tenant = await createTenant();
    const change = await makeChange(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'implemented' });
    expect(res.status).toBe(400);
  });

  it('refuse toute transition depuis un état terminal (implemented)', async () => {
    tenant = await createTenant();
    const change = await makeChange(tenant.admin.token);

    await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ...FULL_REVIEW_FIELDS, status: 'approved' });
    const implemented = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'implemented' });
    expect(implemented.status).toBe(200);

    const backToPlanned = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'planned' });
    expect(backToPlanned.status).toBe(400);
  });

  it('permet planned -> approved -> implemented, et planned -> cancelled ainsi que approved -> cancelled', async () => {
    tenant = await createTenant();

    const change1 = await makeChange(tenant.admin.token);
    const toApproved = await request(app)
      .patch(`/api/qms-changes/${change1.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ...FULL_REVIEW_FIELDS, status: 'approved' });
    expect(toApproved.status).toBe(200);
    const toImplemented = await request(app)
      .patch(`/api/qms-changes/${change1.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'implemented' });
    expect(toImplemented.status).toBe(200);

    const change2 = await makeChange(tenant.admin.token);
    const cancelFromPlanned = await request(app)
      .patch(`/api/qms-changes/${change2.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'cancelled', cancellation_reason: 'Besoin réévalué, non prioritaire.' });
    expect(cancelFromPlanned.status).toBe(200);

    const change3 = await makeChange(tenant.admin.token);
    await request(app)
      .patch(`/api/qms-changes/${change3.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ...FULL_REVIEW_FIELDS, status: 'approved' });
    const cancelFromApproved = await request(app)
      .patch(`/api/qms-changes/${change3.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'cancelled', cancellation_reason: 'Le prestataire retenu s’est désisté.' });
    expect(cancelFromApproved.status).toBe(200);
  });
});

describe('PATCH /api/qms-changes/:id — approbation : les 4 points de §6.3 exigés', () => {
  it('refuse l’approbation si un des 4 champs manque', async () => {
    tenant = await createTenant();
    const change = await makeChange(tenant.admin.token);

    for (const missingField of Object.keys(FULL_REVIEW_FIELDS)) {
      const partial = { ...FULL_REVIEW_FIELDS };
      delete partial[missingField];
      const res = await request(app)
        .patch(`/api/qms-changes/${change.body.id}`)
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ ...partial, status: 'approved' });
      expect(res.status).toBe(400);
    }
  });

  it('accepte des champs déjà posés précédemment, sans avoir à les renvoyer', async () => {
    tenant = await createTenant();
    const change = await makeChange(tenant.admin.token);

    await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send(FULL_REVIEW_FIELDS);

    const res = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.approved_at).not.toBeNull();
  });
});

describe('PATCH /api/qms-changes/:id — annulation : motif exigé', () => {
  it('refuse l’annulation sans cancellation_reason', async () => {
    tenant = await createTenant();
    const change = await makeChange(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'cancelled' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/qms-changes/:id — approved_by/implemented_by retombent sur l’acteur', () => {
  it('pose approved_by = acteur si non fourni, respecte la valeur fournie sinon', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const change = await makeChange(tenant.admin.token);

    const approved = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ ...FULL_REVIEW_FIELDS, status: 'approved' });
    expect(approved.status).toBe(200);
    expect(approved.body.approved_by).toBe(manager.id);

    const change2 = await makeChange(tenant.admin.token);
    const approvedExplicit = await request(app)
      .patch(`/api/qms-changes/${change2.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ ...FULL_REVIEW_FIELDS, status: 'approved', approved_by: tenant.admin.id });
    expect(approvedExplicit.status).toBe(200);
    expect(approvedExplicit.body.approved_by).toBe(tenant.admin.id);
  });

  it('retombe aussi sur l’acteur si approved_by/implemented_by sont explicitement envoyés à null', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const change = await makeChange(tenant.admin.token);

    const approved = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ ...FULL_REVIEW_FIELDS, status: 'approved', approved_by: null });
    expect(approved.status).toBe(200);
    expect(approved.body.approved_by).toBe(manager.id);

    const implemented = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ status: 'implemented', implemented_by: null });
    expect(implemented.status).toBe(200);
    expect(implemented.body.implemented_by).toBe(manager.id);
  });

  it('pose approved_at et implemented_at une seule fois chacun', async () => {
    tenant = await createTenant();
    const change = await makeChange(tenant.admin.token);

    const approved = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ...FULL_REVIEW_FIELDS, status: 'approved' });
    const approvedAt = approved.body.approved_at;

    const editAfterApproval = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ planned_date: '2026-03-01' });
    expect(editAfterApproval.body.approved_at).toBe(approvedAt);

    const implemented = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'implemented' });
    expect(implemented.body.implemented_at).not.toBeNull();
  });

  it('ne réécrit pas approved_at/implemented_at sur un PATCH qui renvoie le statut déjà en base (no-op)', async () => {
    tenant = await createTenant();
    const change = await makeChange(tenant.admin.token);

    const approved = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ...FULL_REVIEW_FIELDS, status: 'approved' });
    expect(approved.status).toBe(200);
    const approvedAt = approved.body.approved_at;

    // Petit délai pour garantir un horodatage distinct si le bug réapparaissait.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const resent = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'approved' });
    expect(resent.status).toBe(200);
    expect(resent.body.approved_at).toBe(approvedAt);

    const implemented = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'implemented' });
    const implementedAt = implemented.body.implemented_at;

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const resentImplemented = await request(app)
      .patch(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'implemented' });
    expect(resentImplemented.status).toBe(200);
    expect(resentImplemented.body.implemented_at).toBe(implementedAt);
  });
});

describe('PATCH /api/qms-changes/bulk-category — réservé admin/manager', () => {
  it('403 pour un member, 200 pour un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const change = await makeChange(tenant.admin.token);

    const categoryRes = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'qms_change', name: 'IT', is_restricted: true });
    expect(categoryRes.status).toBe(201);

    const memberAttempt = await request(app)
      .patch('/api/qms-changes/bulk-category')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [change.body.id], category_id: categoryRes.body.id });
    expect(memberAttempt.status).toBe(403);

    const adminAttempt = await request(app)
      .patch('/api/qms-changes/bulk-category')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [change.body.id], category_id: categoryRes.body.id });
    expect(adminAttempt.status).toBe(200);
    expect(adminAttempt.body.updated).toBe(1);
  });
});

describe('DELETE /api/qms-changes/:id et /bulk — réservé admin/manager', () => {
  it('403 pour un member, 204/200 pour un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const change = await makeChange(member.token);
    const change2 = await makeChange(member.token);

    const memberDelete = await request(app)
      .delete(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(memberDelete.status).toBe(403);

    const adminDelete = await request(app)
      .delete(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminDelete.status).toBe(204);

    const memberBulk = await request(app)
      .delete('/api/qms-changes/bulk')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [change2.body.id] });
    expect(memberBulk.status).toBe(403);

    const adminBulk = await request(app)
      .delete('/api/qms-changes/bulk')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [change2.body.id] });
    expect(adminBulk.status).toBe(200);
    expect(adminBulk.body.deleted).toBe(1);
  });
});

describe('Catégorie restreinte — visibilité', () => {
  it("une modification d'une catégorie restreinte reste visible pour l'admin mais invisible pour un member sans permission", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const categoryRes = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'qms_change', name: 'Confidentiel', is_restricted: true });
    expect(categoryRes.status).toBe(201);
    const change = await makeChange(tenant.admin.token, { category_id: categoryRes.body.id });

    const adminList = await request(app).get('/api/qms-changes').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminList.body.map((c) => c.id)).toContain(change.body.id);

    const memberList = await request(app).get('/api/qms-changes').set('Authorization', `Bearer ${member.token}`);
    expect(memberList.body.map((c) => c.id)).not.toContain(change.body.id);
    const memberDetail = await request(app)
      .get(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(memberDetail.status).toBe(404);
  });
});

describe('Catégories — une modification planifiée respecte les mêmes règles que les autres modules', () => {
  it('le garde-fou de suppression de catégorie couvre qms_change sans changement dans moduleCategories.js', async () => {
    tenant = await createTenant();

    const category = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'qms_change', name: 'Catégorie restreinte', is_restricted: true });
    expect(category.status).toBe(201);

    const change = await makeChange(tenant.admin.token, { category_id: category.body.id });
    expect(change.body.category_id).toBe(category.body.id);

    const blocked = await request(app)
      .delete(`/api/module-categories/${category.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('1 modification planifiée');

    await request(app).delete(`/api/qms-changes/${change.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);

    const ok = await request(app)
      .delete(`/api/module-categories/${category.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(ok.status).toBe(204);
  });
});

describe('Isolation multi-tenant', () => {
  it('un tenant ne voit pas les modifications planifiées d’un autre tenant', async () => {
    tenant = await createTenant();
    const other = await createTenant();
    const change = await makeChange(other.admin.token);

    const detail = await request(app)
      .get(`/api/qms-changes/${change.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.status).toBe(404);

    await other.cleanup();
  });
});
