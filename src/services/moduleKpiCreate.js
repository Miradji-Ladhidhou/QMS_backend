import { supabase } from './supabase.js';
import { recomputeModuleKpi } from './moduleKpiRecompute.js';
import { MODULE_KPI_FOLDER_NAME } from './moduleKpiCatalog.js';

// Dossier racine « Indicateurs des modules » du tenant (créé au premier besoin).
export async function ensureModuleKpiFolder(tenantId) {
  const { data: existing } = await supabase
    .from('kpi_folders')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('name', MODULE_KPI_FOLDER_NAME)
    .is('parent_id', null)
    .limit(1)
    .maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await supabase.from('kpi_folders').insert({ tenant_id: tenantId, name: MODULE_KPI_FOLDER_NAME }).select('id').single();
  if (error) throw new Error('Impossible de créer le dossier des indicateurs.');
  return data.id;
}

// Crée un KPI calculé automatiquement depuis un preset de module : le KPI, sa recette de calcul, puis un premier
// calcul (un échec de ce premier calcul ne défait pas la création : le job nocturne le refera). Sans dossier
// explicite, le KPI est rangé dans « Indicateurs des modules ». `rowsCache` : lecture partagée des tables source quand
// on crée plusieurs KPI d'affilée. Lève une Error en cas d'échec de création.
export async function createModuleKpiFromPreset({ tenantId, userId, preset, folderId, categoryId, rowsCache = null }) {
  const targetFolderId = folderId || (await ensureModuleKpiFolder(tenantId));

  const { data: kpi, error: kpiError } = await supabase
    .from('kpis')
    .insert({
      tenant_id: tenantId,
      name: preset.label,
      unit: preset.unit || null,
      target: preset.target ?? null,
      target_direction: preset.target_direction || undefined,
      frequency: preset.frequency || null,
      calculation_type: 'module',
      source_module: preset.module,
      module_preset_id: preset.id,
      folder_id: targetFolderId,
      category_id: categoryId || null,
    })
    .select('id')
    .single();
  if (kpiError) throw new Error('Erreur lors de la création du KPI.');

  const { error: configError } = await supabase.from('kpi_calculation_configs').insert({
    tenant_id: tenantId,
    kpi_id: kpi.id,
    label: 'Automatique',
    calc_type: preset.recipe.calc_type,
    source_column: preset.recipe.source_column || null,
    filters: preset.recipe.filters || [],
    filter_logic: preset.recipe.filter_logic || 'all',
    group_by_column: preset.recipe.group_by_column || null,
    period_column: preset.recipe.period_column || null,
  });
  if (configError) {
    await supabase.from('kpis').delete().eq('id', kpi.id);
    throw new Error('Erreur lors de la création de la recette de calcul.');
  }

  try {
    await recomputeModuleKpi({ tenantId, kpiId: kpi.id, recordedBy: userId, rowsCache });
  } catch (err) {
    console.error('[moduleKpi] Premier calcul échoué :', err.message);
  }
  return kpi.id;
}
