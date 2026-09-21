import { supabase } from './supabase.js';
import { filterViewableByCategory } from '../middleware/genericCategoryPermissions.js';

// Ce qu'un plan HACCP peut référencer : le fournisseur des matières premières, la formation que doivent
// avoir suivie les opérateurs, la procédure qui décrit la surveillance. Voir riskLinks.js (même mécanique).
export const HACCP_LINK_KINDS = {
  supplier: { column: 'supplier_id', table: 'suppliers', select: 'id, name', title: (row) => row.name, href: (row) => `/suppliers/${row.id}`, label: 'Fournisseur' },
  training: { column: 'training_id', table: 'trainings', select: 'id, title', title: (row) => row.title, href: () => '/trainings', label: 'Formation requise' },
  procedure: {
    column: 'procedure_id',
    table: 'procedures',
    select: 'id, number, title',
    title: (row) => `${row.number} — ${row.title}`,
    href: (row) => `/procedures/${row.id}`,
    label: 'Procédure',
  },
};
export const HACCP_LINK_KIND_KEYS = Object.keys(HACCP_LINK_KINDS);

const withCategory = (config) => `${config.select}, category_id, category:categories(id, is_restricted)`;

export async function findHaccpLinkTarget(tenantId, kind, refId, viewer) {
  const config = HACCP_LINK_KINDS[kind];
  if (!config) return null;
  const { data } = await supabase.from(config.table).select(withCategory(config)).eq('tenant_id', tenantId).eq('id', refId).maybeSingle();
  if (!data) return null;
  if (!viewer) return data;
  const [visible] = await filterViewableByCategory({ ...viewer, items: [data] });
  return visible || null;
}

export async function listHaccpLinkCandidates(tenantId, kind, viewer) {
  const config = HACCP_LINK_KINDS[kind];
  const { data, error } = await supabase.from(config.table).select(withCategory(config)).eq('tenant_id', tenantId).limit(200);
  if (error || !data) return [];
  const visible = await filterViewableByCategory({ ...viewer, items: data });
  return visible.map((row) => ({ id: row.id, title: config.title(row) })).sort((a, b) => a.title.localeCompare(b.title, 'fr'));
}

export async function fetchHaccpLinks(tenantId, planId, viewer) {
  const { data, error } = await supabase
    .from('haccp_plan_links')
    .select('id, supplier_id, training_id, procedure_id, created_at')
    .eq('tenant_id', tenantId)
    .eq('plan_id', planId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);

  const resolved = [];
  for (const link of data) {
    const kind = HACCP_LINK_KIND_KEYS.find((key) => link[HACCP_LINK_KINDS[key].column]);
    if (!kind) continue;
    const config = HACCP_LINK_KINDS[kind];
    const target = await findHaccpLinkTarget(tenantId, kind, link[config.column], viewer);
    if (!target) continue;
    resolved.push({ id: link.id, kind, kind_label: config.label, ref_id: target.id, title: config.title(target), href: config.href(target) });
  }
  return resolved;
}

// État de la formation d'une personne (dernière réalisation) :
//  - 'valid'   : réalisée, non échue (ou sans échéance) et évaluation non échouée ;
//  - 'expired' : échéance de renouvellement dépassée ;
//  - 'failed'  : dernière évaluation non réussie ;
//  - 'none'    : jamais suivie ;
//  - 'exempt'  : dispensée de formation (compte marqué « exempté »).
export function trainingStatus(record, today = new Date().toISOString().slice(0, 10)) {
  if (!record) return 'none';
  if (record.evaluation_result === false) return 'failed';
  if (record.next_due_date && record.next_due_date < today) return 'expired';
  return 'valid';
}

// Les opérateurs de surveillance (responsables des CCP du plan) ont-ils les formations liées au plan à jour ?
// Renvoie, par formation liée : { training: {id, title}, people: [{ user_id, name, status, next_due_date }] }.
export async function fetchTrainingCoverage(tenantId, planId, viewer) {
  const links = (await fetchHaccpLinks(tenantId, planId, viewer)).filter((link) => link.kind === 'training');
  if (links.length === 0) return { trainings: [], people_without_training: 0 };

  const { data: steps } = await supabase.from('haccp_process_steps').select('id').eq('tenant_id', tenantId).eq('plan_id', planId);
  const stepIds = (steps || []).map((step) => step.id);
  const { data: hazards } = stepIds.length ? await supabase.from('haccp_hazards').select('id').eq('tenant_id', tenantId).in('step_id', stepIds) : { data: [] };
  const hazardIds = (hazards || []).map((hazard) => hazard.id);
  const { data: ccps } = hazardIds.length
    ? await supabase.from('haccp_ccps').select('monitoring_responsible, responsible:users!haccp_ccps_monitoring_responsible_fkey(id, full_name, training_exempt)').eq('tenant_id', tenantId).in('hazard_id', hazardIds)
    : { data: [] };

  const people = new Map();
  for (const ccp of ccps || []) if (ccp.responsible) people.set(ccp.responsible.id, ccp.responsible);
  if (people.size === 0) return { trainings: links.map((link) => ({ training: { id: link.ref_id, title: link.title }, people: [] })), people_without_training: 0 };

  const { data: records } = await supabase
    .from('training_records')
    .select('training_id, user_id, completed_at, next_due_date, evaluation_result')
    .eq('tenant_id', tenantId)
    .in('training_id', links.map((link) => link.ref_id))
    .in('user_id', [...people.keys()]);

  const latest = new Map();
  for (const record of records || []) {
    const key = `${record.training_id}:${record.user_id}`;
    const existing = latest.get(key);
    if (!existing || record.completed_at > existing.completed_at) latest.set(key, record);
  }

  let missing = 0;
  const trainings = links.map((link) => ({
    training: { id: link.ref_id, title: link.title },
    people: [...people.values()].map((person) => {
      const record = latest.get(`${link.ref_id}:${person.id}`);
      const status = person.training_exempt ? 'exempt' : trainingStatus(record);
      if (status !== 'valid' && status !== 'exempt') missing += 1;
      return { user_id: person.id, name: person.full_name, status, next_due_date: record?.next_due_date || null };
    }),
  }));
  return { trainings, people_without_training: missing };
}
