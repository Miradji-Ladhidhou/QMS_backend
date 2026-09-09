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

async function makeOutput(token, overrides = {}) {
  const res = await request(app)
    .post('/api/nonconforming-outputs')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Pièce hors tolérance', description: 'Défaut détecté au contrôle final.', detected_at: '2026-01-15', ...overrides });
  return res;
}

describe('POST /api/nonconforming-outputs — déclaration ouverte à tous les rôles', () => {
  it('201 pour un member, un manager ou un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const memberAttempt = await makeOutput(member.token);
    expect(memberAttempt.status).toBe(201);
    expect(memberAttempt.body.status).toBe('open');
    expect(memberAttempt.body.disposition).toBe('correction');

    const managerAttempt = await makeOutput(manager.token);
    expect(managerAttempt.status).toBe(201);

    const adminAttempt = await makeOutput(tenant.admin.token);
    expect(adminAttempt.status).toBe(201);
  });

  it('rejette un titre, une description ou une date manquants', async () => {
    tenant = await createTenant();

    const noTitle = await request(app)
      .post('/api/nonconforming-outputs')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ description: 'Défaut détecté.', detected_at: '2026-01-15' });
    expect(noTitle.status).toBe(400);

    const noDescription = await request(app)
      .post('/api/nonconforming-outputs')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Pièce hors tolérance', detected_at: '2026-01-15' });
    expect(noDescription.status).toBe(400);

    const noDate = await request(app)
      .post('/api/nonconforming-outputs')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Pièce hors tolérance', description: 'Défaut détecté.' });
    expect(noDate.status).toBe(400);
  });
});

describe('PATCH /api/nonconforming-outputs/:id — réservé admin/manager', () => {
  it('403 pour un member, 200 pour un manager', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const output = await makeOutput(tenant.admin.token);

    const memberAttempt = await request(app)
      .patch(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ action_taken: 'Tri et retouche du lot.' });
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await request(app)
      .patch(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ action_taken: 'Tri et retouche du lot.' });
    expect(managerAttempt.status).toBe(200);
  });
});

describe('PATCH /api/nonconforming-outputs/:id — clôture : action menée exigée', () => {
  it('refuse la clôture sans action_taken', async () => {
    tenant = await createTenant();
    const output = await makeOutput(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed' });
    expect(res.status).toBe(400);
  });

  it('accepte une action_taken déjà posée précédemment, sans avoir à la renvoyer', async () => {
    tenant = await createTenant();
    const output = await makeOutput(tenant.admin.token);

    await request(app)
      .patch(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ action_taken: 'Tri et retouche du lot.' });

    const res = await request(app)
      .patch(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
    expect(res.body.closed_at).not.toBeNull();
  });

  it('ne pose closed_at qu’une seule fois', async () => {
    tenant = await createTenant();
    const output = await makeOutput(tenant.admin.token);

    const firstClose = await request(app)
      .patch(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed', action_taken: 'Tri et retouche du lot.' });
    expect(firstClose.status).toBe(200);
    const firstClosedAt = firstClose.body.closed_at;

    const secondPatch = await request(app)
      .patch(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed', customer_informed: true });
    expect(secondPatch.status).toBe(200);
    expect(secondPatch.body.closed_at).toBe(firstClosedAt);
  });
});

describe('PATCH /api/nonconforming-outputs/:id — clôture par dérogation : référence exigée', () => {
  it('refuse la clôture avec disposition concession sans concession_reference', async () => {
    tenant = await createTenant();
    const output = await makeOutput(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed', action_taken: 'Acceptation exceptionnelle.', disposition: 'concession' });
    expect(res.status).toBe(400);
  });

  it('accepte la clôture avec disposition concession et concession_reference fournie', async () => {
    tenant = await createTenant();
    const output = await makeOutput(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        status: 'closed',
        action_taken: 'Acceptation exceptionnelle.',
        disposition: 'concession',
        concession_reference: 'DER-2026-014',
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
  });

  it('refuse aussi si disposition concession était déjà posée précédemment sans concession_reference', async () => {
    tenant = await createTenant();
    const output = await makeOutput(tenant.admin.token, { disposition: 'concession' });

    const res = await request(app)
      .patch(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed', action_taken: 'Acceptation exceptionnelle.' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/nonconforming-outputs/:id — decided_by retombe sur l’auteur de la clôture', () => {
  it('pose decided_by = clôturant si non fourni, respecte la valeur fournie sinon', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const output = await makeOutput(tenant.admin.token);

    const closed = await request(app)
      .patch(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ status: 'closed', action_taken: 'Tri et retouche du lot.' });
    expect(closed.status).toBe(200);
    expect(closed.body.decided_by).toBe(manager.id);

    const output2 = await makeOutput(tenant.admin.token);
    const closedExplicit = await request(app)
      .patch(`/api/nonconforming-outputs/${output2.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ status: 'closed', action_taken: 'Tri et retouche du lot.', decided_by: tenant.admin.id });
    expect(closedExplicit.status).toBe(200);
    expect(closedExplicit.body.decided_by).toBe(tenant.admin.id);
  });

  it('retombe aussi sur le clôturant si decided_by est explicitement envoyé à null (comme le fait le formulaire d’édition du frontend)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const output = await makeOutput(tenant.admin.token);

    const closed = await request(app)
      .patch(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ status: 'closed', action_taken: 'Tri et retouche du lot.', decided_by: null });
    expect(closed.status).toBe(200);
    expect(closed.body.decided_by).toBe(manager.id);
  });
});

describe('PATCH /api/nonconforming-outputs/bulk-category — réservé admin/manager', () => {
  it('403 pour un member, 200 pour un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const output = await makeOutput(tenant.admin.token);

    const categoryRes = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'nonconforming_output', name: 'Ligne 2', is_restricted: true });
    expect(categoryRes.status).toBe(201);

    const memberAttempt = await request(app)
      .patch('/api/nonconforming-outputs/bulk-category')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [output.body.id], category_id: categoryRes.body.id });
    expect(memberAttempt.status).toBe(403);

    const adminAttempt = await request(app)
      .patch('/api/nonconforming-outputs/bulk-category')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [output.body.id], category_id: categoryRes.body.id });
    expect(adminAttempt.status).toBe(200);
    expect(adminAttempt.body.updated).toBe(1);
  });
});

describe('DELETE /api/nonconforming-outputs/:id et /bulk — réservé admin/manager', () => {
  it('403 pour un member, 204/200 pour un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const output = await makeOutput(member.token);
    const output2 = await makeOutput(member.token);

    const memberDelete = await request(app)
      .delete(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(memberDelete.status).toBe(403);

    const adminDelete = await request(app)
      .delete(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminDelete.status).toBe(204);

    const memberBulk = await request(app)
      .delete('/api/nonconforming-outputs/bulk')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [output2.body.id] });
    expect(memberBulk.status).toBe(403);

    const adminBulk = await request(app)
      .delete('/api/nonconforming-outputs/bulk')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [output2.body.id] });
    expect(adminBulk.status).toBe(200);
    expect(adminBulk.body.deleted).toBe(1);
  });
});

describe('Catégorie restreinte — visibilité', () => {
  it("une non-conformité d'une catégorie restreinte reste visible pour l'admin mais invisible pour un member sans permission", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const categoryRes = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'nonconforming_output', name: 'Confidentiel', is_restricted: true });
    expect(categoryRes.status).toBe(201);
    const output = await makeOutput(tenant.admin.token, { category_id: categoryRes.body.id });

    const adminList = await request(app).get('/api/nonconforming-outputs').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminList.body.map((o) => o.id)).toContain(output.body.id);

    const memberList = await request(app).get('/api/nonconforming-outputs').set('Authorization', `Bearer ${member.token}`);
    expect(memberList.body.map((o) => o.id)).not.toContain(output.body.id);
    const memberDetail = await request(app)
      .get(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(memberDetail.status).toBe(404);
  });
});

describe('POST /api/nonconforming-outputs/:id/create-capa — lien bidirectionnel, réservé admin/manager', () => {
  it('crée une CAPA liée avec nonconforming_output_id et met à jour linked_capa_id', async () => {
    tenant = await createTenant();
    const output = await makeOutput(tenant.admin.token);

    const capa = await request(app)
      .post(`/api/nonconforming-outputs/${output.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Revoir le contrôle en cours de production' });
    expect(capa.status).toBe(201);
    expect(capa.body.nonconforming_output_id).toBe(output.body.id);
    expect(capa.body.origin).toContain('Non-conformité produit/service');

    const detail = await request(app)
      .get(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.linked_capa.id).toBe(capa.body.id);
  });

  it('403 pour un member', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const output = await makeOutput(tenant.admin.token);

    const res = await request(app)
      .post(`/api/nonconforming-outputs/${output.body.id}/create-capa`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ title: 'Revoir le contrôle en cours de production' });
    expect(res.status).toBe(403);
  });
});

describe('Catégories — une non-conformité produit/service respecte les mêmes règles que les autres modules', () => {
  it('le garde-fou de suppression de catégorie couvre nonconforming_output sans changement dans moduleCategories.js', async () => {
    tenant = await createTenant();

    const category = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'nonconforming_output', name: 'Catégorie restreinte', is_restricted: true });
    expect(category.status).toBe(201);

    const output = await makeOutput(tenant.admin.token, { category_id: category.body.id });
    expect(output.body.category_id).toBe(category.body.id);

    const blocked = await request(app)
      .delete(`/api/module-categories/${category.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('1 non-conformité produit/service');

    await request(app).delete(`/api/nonconforming-outputs/${output.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);

    const ok = await request(app)
      .delete(`/api/module-categories/${category.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(ok.status).toBe(204);
  });
});

describe('Isolation multi-tenant', () => {
  it('un tenant ne voit pas les non-conformités d’un autre tenant', async () => {
    tenant = await createTenant();
    const other = await createTenant();
    const output = await makeOutput(other.admin.token);

    const detail = await request(app)
      .get(`/api/nonconforming-outputs/${output.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.status).toBe(404);

    await other.cleanup();
  });
});
