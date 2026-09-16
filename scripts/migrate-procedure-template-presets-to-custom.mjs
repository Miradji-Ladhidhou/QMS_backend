// Migration ponctuelle : pour chaque tenant qui a encore un preset figé actif
// (procedure_templates.active_preset_id is not null — voir l'ancien système à 4 presets,
// data/procedureTemplatePresets.js), bascule sur la personnalisation directe (accent_color/
// visual_options, voir le plan de refonte de la mise en page des procédures) et efface
// active_preset_id. Ne touche JAMAIS section_structure (préservée telle quelle si le tenant
// l'avait déjà personnalisée) ni procedure_versions (les procédures déjà exportées ne sont
// jamais régénérées rétroactivement — propriété garantie par construction : ce script n'écrit
// que dans procedure_templates).
//
// Idempotent : une ligne déjà migrée a active_preset_id = null, donc ignorée au passage suivant.
// --dry-run : n'écrit rien, affiche seulement ce qui serait migré.
//
// Usage : node scripts/migrate-procedure-template-presets-to-custom.mjs [--dry-run]

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { supabase } = await import('../src/services/supabase.js');

const DRY_RUN = process.argv.includes('--dry-run');

// Mapping fixé avec l'utilisateur (voir le plan de refonte) — délibérément DIFFÉRENT des
// couleurs renderStyle.accentColor de l'ancien système (data/procedureTemplatePresets.js) :
// l'objectif est de sortir du système de presets, pas de le reproduire à l'identique.
const PRESET_TO_ACCENT_COLOR = {
  'mtl-logistique': '#44546A',
  'iso-generique': '#3A3A3A',
  'moderne-tertiaire': '#1F5C5C',
  'industriel-securite': '#7A2E3B',
};
const DEFAULT_VISUAL_OPTIONS = { band: false, bulletStyle: 'dash', calloutStyle: 'left-border' };

export async function migrateProcedureTemplatePresetsToCustom({ dryRun = false } = {}) {
  const { data: rows, error } = await supabase
    .from('procedure_templates')
    .select('id, tenant_id, active_preset_id')
    .not('active_preset_id', 'is', null);

  if (error) throw new Error(`Erreur de lecture de procedure_templates : ${error.message}`);

  let migrated = 0;
  let skippedUnknownPreset = 0;

  for (const row of rows || []) {
    const accentColor = PRESET_TO_ACCENT_COLOR[row.active_preset_id];
    if (!accentColor) {
      console.warn(`⚠ Tenant ${row.tenant_id} : preset "${row.active_preset_id}" inconnu, ignoré.`);
      skippedUnknownPreset += 1;
      continue;
    }

    migrated += 1;
    if (!dryRun) {
      const { error: updateError } = await supabase
        .from('procedure_templates')
        .update({ accent_color: accentColor, visual_options: DEFAULT_VISUAL_OPTIONS, active_preset_id: null })
        .eq('id', row.id);
      if (updateError) throw new Error(`Échec de mise à jour du tenant ${row.tenant_id} : ${updateError.message}`);
    }
  }

  return { migrated, skippedUnknownPreset, total: (rows || []).length };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  console.log(DRY_RUN ? '🔍 Dry-run : aucune écriture ne sera effectuée.' : '✏️  Migration réelle : les lignes seront mises à jour.');
  const { migrated, skippedUnknownPreset, total } = await migrateProcedureTemplatePresetsToCustom({ dryRun: DRY_RUN });
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}${migrated}/${total} tenant(s) migré(s)${skippedUnknownPreset ? `, ${skippedUnknownPreset} preset(s) inconnu(s) ignoré(s)` : ''}.`);
  process.exit(0);
}
