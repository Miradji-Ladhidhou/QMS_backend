import { supabase } from './supabase.js';
import { KPI_EVALUATION_SELECT, offTargetSeries } from './kpiSeriesEvaluation.js';
import { filterViewableByCategory } from '../middleware/genericCategoryPermissions.js';

// Objets auxquels un risque peut être rattaché : la colonne de risk_links, la table, et comment
// l'afficher (libellé + page de l'application). Un KPI n'a pas de page de détail : le lien ouvre la liste.
export const RISK_LINK_KINDS = {
  audit: { column: 'audit_id', table: 'audits', select: 'id, title', title: (row) => row.title, href: (row) => `/audits/${row.id}`, label: 'Audit' },
  supplier: { column: 'supplier_id', table: 'suppliers', select: 'id, name', title: (row) => row.name, href: (row) => `/suppliers/${row.id}`, label: 'Fournisseur' },
  kpi: { column: 'kpi_id', table: 'kpis', select: 'id, name', title: (row) => row.name, href: () => '/kpis', label: 'KPI' },
  procedure: {
    column: 'procedure_id',
    table: 'procedures',
    select: 'id, number, title',
    title: (row) => `${row.number} — ${row.title}`,
    href: (row) => `/procedures/${row.id}`,
    label: 'Procédure',
  },
};

export const RISK_LINK_KIND_KEYS = Object.keys(RISK_LINK_KINDS);

// Colonnes lues avec chaque objet : sa catégorie, pour ne jamais montrer (ni laisser lier) un objet rangé dans
// une catégorie restreinte que l'utilisateur ne peut pas voir.
const withCategory = (config) => `${config.select}, category_id, category:categories(id, is_restricted)`;

// L'objet visé existe-t-il, appartient-il à l'entreprise et l'utilisateur peut-il le voir ? (jamais de lien
// vers l'objet d'un autre tenant, ni vers un objet d'une catégorie restreinte hors de sa vue)
export async function findLinkTarget(tenantId, kind, refId, viewer) {
  const config = RISK_LINK_KINDS[kind];
  if (!config) return null;
  const { data } = await supabase.from(config.table).select(withCategory(config)).eq('tenant_id', tenantId).eq('id', refId).maybeSingle();
  if (!data) return null;
  if (!viewer) return data;
  const [visible] = await filterViewableByCategory({ ...viewer, items: [data] });
  return visible || null;
}

// Objets que l'utilisateur peut rattacher à un risque (liste de choix) : id + titre, 200 au plus.
export async function listLinkCandidates(tenantId, kind, viewer) {
  const config = RISK_LINK_KINDS[kind];
  const { data, error } = await supabase.from(config.table).select(withCategory(config)).eq('tenant_id', tenantId).limit(200);
  if (error || !data) return [];
  const visible = await filterViewableByCategory({ ...viewer, items: data });
  return visible.map((row) => ({ id: row.id, title: config.title(row) })).sort((a, b) => a.title.localeCompare(b.title, 'fr'));
}

// Liens d'un risque, résolus (titre + page). Un objet supprimé disparaît de lui-même (on delete cascade).
export async function fetchRiskLinks(tenantId, riskId, viewer) {
  const { data, error } = await supabase
    .from('risk_links')
    .select('id, audit_id, supplier_id, kpi_id, procedure_id, created_at')
    .eq('tenant_id', tenantId)
    .eq('risk_id', riskId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);

  const resolved = [];
  for (const link of data) {
    const kind = RISK_LINK_KIND_KEYS.find((key) => link[RISK_LINK_KINDS[key].column]);
    if (!kind) continue;
    const config = RISK_LINK_KINDS[kind];
    const target = await findLinkTarget(tenantId, kind, link[config.column], viewer);
    if (!target) continue;
    resolved.push({ id: link.id, kind, kind_label: config.label, ref_id: target.id, title: config.title(target), href: config.href(target) });
  }
  return resolved;
}

// KPI actuellement hors objectif (une de leurs courbes rate SON objectif, voir kpiSeriesEvaluation.js)
// qu'aucun risque ne couvre encore : autant de risques probablement à identifier.
export async function fetchKpiRiskSuggestions(tenantId) {
  const [{ data: kpis, error }, { data: links }] = await Promise.all([
    supabase.from('kpis').select(KPI_EVALUATION_SELECT).eq('tenant_id', tenantId),
    supabase.from('risk_links').select('kpi_id').eq('tenant_id', tenantId).not('kpi_id', 'is', null),
  ]);
  if (error || !kpis) return [];

  const covered = new Set((links || []).map((link) => link.kpi_id));
  return kpis
    .filter((kpi) => !covered.has(kpi.id))
    .map((kpi) => ({
      kpi_id: kpi.id,
      name: kpi.name,
      off_target_series: offTargetSeries(kpi).map(({ series, average }) => ({
        label: series.label,
        average: Number(average.toFixed(2)),
        unit: series.unit,
        target: series.target,
        direction: series.direction,
      })),
    }))
    .filter((item) => item.off_target_series.length > 0);
}
