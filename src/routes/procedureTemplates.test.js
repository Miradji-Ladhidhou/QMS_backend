import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

describe('GET /api/procedure-templates', () => {
  it("propose un point de départ minimal (jamais persisté) tant qu'aucun gabarit n'a été enregistré", async () => {
    tenant = await createTenant();

    const res = await request(app).get('/api/procedure-templates').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.section_structure.length).toBeGreaterThan(0);

    const { data: row } = await admin.from('procedure_templates').select('id').eq('tenant_id', tenant.tenantId).maybeSingle();
    expect(row).toBeNull();
  });
});

describe('PUT /api/procedure-templates', () => {
  it('réservé admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const res = await request(app)
      .put('/api/procedure-templates')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ section_structure: [{ key: 'objet', label: 'Objet' }] });
    expect(res.status).toBe(403);
  });

  it('crée puis met à jour le même gabarit (une seule ligne par tenant)', async () => {
    tenant = await createTenant();

    const created = await request(app)
      .put('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ section_structure: [{ key: 'objet', label: 'Objet' }] });
    expect(created.status).toBe(200);

    const updated = await request(app)
      .put('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ section_structure: [{ key: 'objet', label: 'Objet' }, { key: 'domaine', label: "Domaine d'application" }] });
    expect(updated.status).toBe(200);
    expect(updated.body.section_structure).toHaveLength(2);
    expect(updated.body.id).toBe(created.body.id);
  });
});
