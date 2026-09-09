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

async function makeEquipment(token, overrides = {}) {
  const res = await request(app)
    .post('/api/measuring-equipment')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Pied à coulisse #1', ...overrides });
  return res;
}

describe('POST /api/measuring-equipment — création réservée à admin/manager', () => {
  it('403 pour un member, 201 pour un manager, actif par défaut', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const memberAttempt = await makeEquipment(member.token);
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await makeEquipment(manager.token);
    expect(managerAttempt.status).toBe(201);
    expect(managerAttempt.body.is_active).toBe(true);
  });
});

describe('GET /api/measuring-equipment — visible à tous les rôles', () => {
  it('un member voit les équipements créés par un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    await makeEquipment(tenant.admin.token, { name: 'Équipement visible par tous' });

    const res = await request(app).get('/api/measuring-equipment').set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(200);
    expect(res.body.some((e) => e.name === 'Équipement visible par tous')).toBe(true);
  });
});

describe('POST /api/measuring-equipment/:equipmentId/calibrations — commentaire exigé sur un résultat non conforme', () => {
  it('403 pour un member', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const equipment = await makeEquipment(tenant.admin.token);

    const res = await request(app)
      .post(`/api/measuring-equipment/${equipment.body.id}/calibrations`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ calibration_date: '2026-08-01' });
    expect(res.status).toBe(403);
  });

  it('refuse "non_conform" sans commentaire, accepte avec', async () => {
    tenant = await createTenant();
    const equipment = await makeEquipment(tenant.admin.token);

    const withoutComment = await request(app)
      .post(`/api/measuring-equipment/${equipment.body.id}/calibrations`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ calibration_date: '2026-08-01', result: 'non_conform' });
    expect(withoutComment.status).toBe(400);

    const withComment = await request(app)
      .post(`/api/measuring-equipment/${equipment.body.id}/calibrations`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        calibration_date: '2026-08-01',
        result: 'non_conform',
        comment: 'Écart de 0.05mm au-delà de la tolérance, mesures depuis mars à revérifier.',
      });
    expect(withComment.status).toBe(201);
    expect(withComment.body.recorder.id).toBe(tenant.admin.id);
  });

  it('"conform" (par défaut ou explicite) n’exige jamais de commentaire', async () => {
    tenant = await createTenant();
    const equipment = await makeEquipment(tenant.admin.token);

    const implicit = await request(app)
      .post(`/api/measuring-equipment/${equipment.body.id}/calibrations`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ calibration_date: '2026-08-01' });
    expect(implicit.status).toBe(201);
    expect(implicit.body.result).toBe('conform');

    const explicit = await request(app)
      .post(`/api/measuring-equipment/${equipment.body.id}/calibrations`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ calibration_date: '2026-08-02', result: 'conform' });
    expect(explicit.status).toBe(201);
  });
});

describe('DELETE /api/measuring-equipment/:id — bloqué si des étalonnages existent', () => {
  it('refuse la suppression tant qu’un étalonnage est rattaché, l’autorise une fois vidé', async () => {
    tenant = await createTenant();
    const equipment = await makeEquipment(tenant.admin.token);

    const calibration = await request(app)
      .post(`/api/measuring-equipment/${equipment.body.id}/calibrations`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ calibration_date: '2026-08-01' });
    expect(calibration.status).toBe(201);

    const blocked = await request(app)
      .delete(`/api/measuring-equipment/${equipment.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/désactiv/i);

    await request(app)
      .delete(`/api/measuring-equipment/${equipment.body.id}/calibrations/${calibration.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);

    const ok = await request(app)
      .delete(`/api/measuring-equipment/${equipment.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(ok.status).toBe(204);
  });
});

describe('POST /.../calibrations/:id/create-capa — lien bidirectionnel optionnel', () => {
  it('crée une CAPA liée, visible dans les deux sens, et survit à la suppression du relevé', async () => {
    tenant = await createTenant();
    const equipment = await makeEquipment(tenant.admin.token, { name: 'Balance de précision' });
    const calibration = await request(app)
      .post(`/api/measuring-equipment/${equipment.body.id}/calibrations`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ calibration_date: '2026-08-01', result: 'non_conform', comment: 'Dérive constatée.' });

    const capa = await request(app)
      .post(`/api/measuring-equipment/${equipment.body.id}/calibrations/${calibration.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Réétalonner et réviser les mesures affectées' });
    expect(capa.status).toBe(201);
    expect(capa.body.equipment_calibration_id).toBe(calibration.body.id);
    expect(capa.body.origin).toContain('Étalonnage');
    expect(capa.body.origin).toContain('Balance de précision');

    const detail = await request(app)
      .get(`/api/measuring-equipment/${equipment.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.calibrations[0].linked_capa.id).toBe(capa.body.id);
  });
});

describe('Catégories — un équipement de mesure respecte les mêmes règles que les autres modules', () => {
  it('le garde-fou de suppression de catégorie couvre measuring_equipment sans changement dans moduleCategories.js', async () => {
    tenant = await createTenant();

    const category = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'measuring_equipment', name: 'Catégorie équipements restreinte', is_restricted: true });
    expect(category.status).toBe(201);

    const equipment = await makeEquipment(tenant.admin.token, { category_id: category.body.id });
    expect(equipment.body.category_id).toBe(category.body.id);

    const blocked = await request(app)
      .delete(`/api/module-categories/${category.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('1 équipement de mesure');

    await request(app).delete(`/api/measuring-equipment/${equipment.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);

    const ok = await request(app)
      .delete(`/api/module-categories/${category.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(ok.status).toBe(204);
  });
});

describe('Isolation multi-tenant', () => {
  it('404 sur un équipement d’un autre tenant', async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      const foreignEquipment = await makeEquipment(otherTenant.admin.token);

      const getAttempt = await request(app)
        .get(`/api/measuring-equipment/${foreignEquipment.body.id}`)
        .set('Authorization', `Bearer ${tenant.admin.token}`);
      expect(getAttempt.status).toBe(404);

      const calibrationAttempt = await request(app)
        .post(`/api/measuring-equipment/${foreignEquipment.body.id}/calibrations`)
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ calibration_date: '2026-08-01' });
      expect(calibrationAttempt.status).toBe(404);
    } finally {
      await otherTenant.cleanup();
    }
  });
});
