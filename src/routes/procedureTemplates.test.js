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

// Personnalisation directe par tenant (voir le plan de refonte de la mise en page des
// procédures) — remplace l'ancien système de 4 presets figés (apply-preset/GET presets,
// retirés avec ce chantier une fois backend/scripts/migrate-procedure-template-presets-to-
// custom.mjs disponible, voir son propre fichier de test).
describe('PUT /api/procedure-templates — accent_color/visual_options', () => {
  it('accepte et renvoie accent_color/visual_options, avec les défauts si omis', async () => {
    tenant = await createTenant();

    const res = await request(app)
      .put('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        section_structure: [{ key: 'objet', label: 'Objet' }],
        accent_color: '#123ABC',
        visual_options: { band: true, bulletStyle: 'round', calloutStyle: 'full-tint' },
      });
    expect(res.status).toBe(200);
    expect(res.body.accent_color).toBe('#123abc');
    expect(res.body.visual_options).toEqual({ band: true, bulletStyle: 'round', calloutStyle: 'full-tint' });

    const reloaded = await request(app)
      .get('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(reloaded.body.accent_color).toBe('#123abc');
    expect(reloaded.body.visual_options).toEqual({ band: true, bulletStyle: 'round', calloutStyle: 'full-tint' });
  });

  it('un enregistrement qui omet accent_color/visual_options ne réinitialise pas ce qui était déjà enregistré', async () => {
    tenant = await createTenant();

    await request(app)
      .put('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ section_structure: [], accent_color: '#7A2E3B' })
      .expect(200);

    const res = await request(app)
      .put('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ section_structure: [{ key: 'objet', label: 'Objet' }] }); // ni accent_color ni visual_options cette fois
    expect(res.status).toBe(200);
    expect(res.body.accent_color).toBe('#7a2e3b');
  });

  it('400 sur une couleur mal formée ou une clé visual_options inconnue', async () => {
    tenant = await createTenant();

    const badColor = await request(app)
      .put('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ section_structure: [], accent_color: 'rouge' });
    expect(badColor.status).toBe(400);

    const badOption = await request(app)
      .put('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ section_structure: [], visual_options: { bulletStyle: 'etoile' } });
    expect(badOption.status).toBe(400);

    const unknownKey = await request(app)
      .put('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ section_structure: [], visual_options: { fontSize: 12 } });
    expect(unknownKey.status).toBe(400);
  });

  it('isole par tenant : la couleur d’un tenant n’apparaît jamais dans le gabarit d’un autre', async () => {
    tenant = await createTenant();
    const otherTenant = await createTenant();
    try {
      await request(app)
        .put('/api/procedure-templates')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send({ section_structure: [], accent_color: '#111111' })
        .expect(200);
      await request(app)
        .put('/api/procedure-templates')
        .set('Authorization', `Bearer ${otherTenant.admin.token}`)
        .send({ section_structure: [], accent_color: '#222222' })
        .expect(200);

      const mine = await request(app).get('/api/procedure-templates').set('Authorization', `Bearer ${tenant.admin.token}`);
      const theirs = await request(app).get('/api/procedure-templates').set('Authorization', `Bearer ${otherTenant.admin.token}`);
      expect(mine.body.accent_color).toBe('#111111');
      expect(theirs.body.accent_color).toBe('#222222');
    } finally {
      await otherTenant.cleanup();
    }
  });
});

describe('POST /api/procedure-templates/preview-word', () => {
  it('réservé admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const res = await request(app)
      .post('/api/procedure-templates/preview-word')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('génère un .docx à partir des réglages du BODY, jamais ceux déjà enregistrés en base', async () => {
    tenant = await createTenant();
    await request(app)
      .put('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ section_structure: [], accent_color: '#000000' })
      .expect(200);

    const res = await request(app)
      .post('/api/procedure-templates/preview-word')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ accent_color: '#7A2E3B', visual_options: { band: true, bulletStyle: 'round', calloutStyle: 'full-tint' } })
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const buffer = Buffer.from(res.body);
    expect(buffer.subarray(0, 2).toString()).toBe('PK'); // signature ZIP (.docx est un conteneur ZIP)

    // Le gabarit enregistré en base n'a pas bougé — un aperçu ne modifie jamais rien.
    const reloaded = await request(app).get('/api/procedure-templates').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(reloaded.body.accent_color).toBe('#000000');
  });

  it('400 sur une couleur mal formée', async () => {
    tenant = await createTenant();
    const res = await request(app)
      .post('/api/procedure-templates/preview-word')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ accent_color: 'pas-une-couleur' });
    expect(res.status).toBe(400);
  });
});
