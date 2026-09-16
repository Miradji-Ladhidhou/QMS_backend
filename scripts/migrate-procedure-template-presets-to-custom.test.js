import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { createTenant, admin } from '../src/test-utils/tenant.js';
import { migrateProcedureTemplatePresetsToCustom } from './migrate-procedure-template-presets-to-custom.mjs';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

// L'ancienne route POST /procedure-templates/apply-preset a été retirée avec ce chantier (voir
// le plan de refonte : un seul modèle mental "personnalisation directe" une fois la migration
// faite) — les fixtures "tenant sur un vieux preset" sont donc écrites directement en base, pas
// via l'API. Toutes les assertions portent sur LE tenant créé par ce test, jamais sur un compte
// global (result.migrated/result.total) : ce script parcourt TOUS les tenants de la base, donc
// un compte global n'est pas fiable en suite de tests parallèle.
async function seedLegacyPreset(tenantId, presetId, sectionStructure = []) {
  const { error } = await admin
    .from('procedure_templates')
    .upsert({ tenant_id: tenantId, section_structure: sectionStructure, active_preset_id: presetId }, { onConflict: 'tenant_id' });
  if (error) throw error;
}

describe('migrateProcedureTemplatePresetsToCustom', () => {
  it('bascule un tenant sur preset actif vers accent_color/visual_options, efface active_preset_id, préserve section_structure', async () => {
    tenant = await createTenant();
    const customSections = [{ key: 'processus', label: 'Processus personnalisé' }];
    await seedLegacyPreset(tenant.tenantId, 'industriel-securite', customSections);

    const before = await request(app)
      .get('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(before.body.active_preset_id).toBe('industriel-securite');
    expect(before.body.section_structure).toEqual(customSections);

    await migrateProcedureTemplatePresetsToCustom({ dryRun: false });

    const after = await request(app)
      .get('/api/procedure-templates')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(after.body.active_preset_id).toBeNull();
    expect(after.body.accent_color).toBe('#7A2E3B'); // industriel-securite -> #7A2E3B
    expect(after.body.visual_options).toEqual({ band: false, bulletStyle: 'dash', calloutStyle: 'left-border' });
    // Jamais touchée par cette migration (voir le plan) : préservée telle quelle.
    expect(after.body.section_structure).toEqual(customSections);
  });

  it('les 4 anciennes configurations sont mappées vers la bonne couleur', async () => {
    const mapping = {
      'mtl-logistique': '#44546A',
      'iso-generique': '#3A3A3A',
      'moderne-tertiaire': '#1F5C5C',
      'industriel-securite': '#7A2E3B',
    };
    const tenants = await Promise.all(Object.keys(mapping).map(() => createTenant()));
    try {
      await Promise.all(tenants.map((t, i) => seedLegacyPreset(t.tenantId, Object.keys(mapping)[i])));

      await migrateProcedureTemplatePresetsToCustom({ dryRun: false });

      const rows = await Promise.all(
        tenants.map((t) => admin.from('procedure_templates').select('accent_color, active_preset_id').eq('tenant_id', t.tenantId).single())
      );
      Object.keys(mapping).forEach((presetId, i) => {
        expect(rows[i].data.accent_color).toBe(mapping[presetId]);
        expect(rows[i].data.active_preset_id).toBeNull();
      });
    } finally {
      await Promise.all(tenants.map((t) => t.cleanup()));
    }
  });

  it('idempotent : un second passage ne modifie pas une ligne déjà migrée', async () => {
    tenant = await createTenant();
    await seedLegacyPreset(tenant.tenantId, 'moderne-tertiaire');

    await migrateProcedureTemplatePresetsToCustom({ dryRun: false });
    const { data: firstPass } = await admin
      .from('procedure_templates')
      .select('accent_color, active_preset_id')
      .eq('tenant_id', tenant.tenantId)
      .single();
    expect(firstPass.accent_color).toBe('#1F5C5C');
    expect(firstPass.active_preset_id).toBeNull();

    await migrateProcedureTemplatePresetsToCustom({ dryRun: false });
    const { data: secondPass } = await admin
      .from('procedure_templates')
      .select('accent_color, active_preset_id')
      .eq('tenant_id', tenant.tenantId)
      .single();
    // active_preset_id déjà null : ce tenant n'est plus sélectionné par la requête du script au
    // second passage, donc rien n'est réécrit.
    expect(secondPass.accent_color).toBe('#1F5C5C');
    expect(secondPass.active_preset_id).toBeNull();
  });

  it('dry-run ne modifie rien', async () => {
    tenant = await createTenant();
    await seedLegacyPreset(tenant.tenantId, 'iso-generique');

    await migrateProcedureTemplatePresetsToCustom({ dryRun: true });

    const { data: row } = await admin
      .from('procedure_templates')
      .select('active_preset_id, accent_color')
      .eq('tenant_id', tenant.tenantId)
      .single();
    expect(row.active_preset_id).toBe('iso-generique'); // inchangé
    expect(row.accent_color).toBe('#44546A'); // toujours le défaut, jamais écrit en dry-run
  });

  it('preset inconnu : signalé et ignoré, jamais un crash', async () => {
    tenant = await createTenant();
    // Simule une valeur historique orpheline (ancien preset renommé/supprimé entre-temps).
    await seedLegacyPreset(tenant.tenantId, 'preset-disparu');

    await expect(migrateProcedureTemplatePresetsToCustom({ dryRun: false })).resolves.toBeDefined();

    const { data: row } = await admin
      .from('procedure_templates')
      .select('active_preset_id, accent_color')
      .eq('tenant_id', tenant.tenantId)
      .single();
    // Ignoré : ni migré (accent_color reste le défaut), ni planté, ni faussement marqué migré
    // (active_preset_id reste tel quel — permet de le repérer et de le corriger manuellement).
    expect(row.active_preset_id).toBe('preset-disparu');
    expect(row.accent_color).toBe('#44546A');
  });
});
