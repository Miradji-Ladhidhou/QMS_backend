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

  it('enregistre aussi les consignes de style (fixed_instructions), optionnelles', async () => {
    tenant = await createTenant();

    const res = await request(app)
      .put('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ section_structure: [{ key: 'objet', label: 'Objet' }], fixed_instructions: 'Toujours en gras.' });
    expect(res.status).toBe(200);
    expect(res.body.fixed_instructions).toBe('Toujours en gras.');

    const reloaded = await request(app)
      .get('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(reloaded.body.fixed_instructions).toBe('Toujours en gras.');
  });
});

describe('GET /api/procedure-templates/presets', () => {
  it('liste les 4 presets prêts à l’emploi', async () => {
    tenant = await createTenant();

    const res = await request(app)
      .get('/api/procedure-templates/presets')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    expect(res.body.map((p) => p.id)).toEqual(
      expect.arrayContaining(['mtl-logistique', 'iso-generique', 'moderne-tertiaire', 'industriel-securite'])
    );
    expect(res.body[0]).toHaveProperty('name');
    expect(res.body[0]).toHaveProperty('description');
    expect(res.body[0]).toHaveProperty('sections');
    expect(res.body[0]).toHaveProperty('renderStyle');
  });
});

describe('POST /api/procedure-templates/apply-preset', () => {
  it('réservé admin, 404 sur un preset inconnu', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const forbidden = await request(app)
      .post('/api/procedure-templates/apply-preset')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ preset_id: 'iso-generique' });
    expect(forbidden.status).toBe(403);

    const unknown = await request(app)
      .post('/api/procedure-templates/apply-preset')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ preset_id: 'inexistant' });
    expect(unknown.status).toBe(404);
  });

  it('copie le preset dans le gabarit du tenant (sections, consignes, style), librement modifiable ensuite', async () => {
    tenant = await createTenant();

    const res = await request(app)
      .post('/api/procedure-templates/apply-preset')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ preset_id: 'iso-generique' });
    expect(res.status).toBe(200);
    expect(res.body.section_structure.length).toBeGreaterThan(0);
    expect(res.body.fixed_instructions).toContain('PROCÉDURE QUALITÉ');
    expect(res.body.render_style.fontFamily).toBe('Times New Roman');

    const reloaded = await request(app)
      .get('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(reloaded.body.section_structure).toEqual(res.body.section_structure);

    // Reste une copie normale, librement modifiable ensuite via PUT — pas une référence figée.
    const edited = await request(app)
      .put('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ section_structure: [{ key: 'custom', label: 'Section personnalisée' }] });
    expect(edited.status).toBe(200);
    expect(edited.body.section_structure).toEqual([{ key: 'custom', label: 'Section personnalisée' }]);
  });
});
