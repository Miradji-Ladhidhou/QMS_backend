import { supabase } from '../services/supabase.js';
import { SHAREABLE_RESOURCES } from '../services/shareableResources.js';
import { getSharePermissions } from '../services/sharePermissions.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHARE_ROUTE_TYPES = {
  documents: 'document', capas: 'capa', complaints: 'complaint', qqoqccp: 'qqoqccp',
  procedures: 'procedure', accidents: 'accident', pdca: 'pdca', audits: 'audit',
  'management-reviews': 'management_review', risks: 'risk', haccp: 'haccp_plan',
  suppliers: 'supplier', 'nonconforming-outputs': 'nonconforming_output',
  'customer-satisfaction': 'customer_satisfaction', employees: 'employee',
  trainings: 'training', kpis: 'kpi', tasks: 'task', services: 'service',
  'quality-policy': 'quality_policy',
};
const EXPORT_PATH = /(?:^|\/)(?:export[^/]*|download|attachment(?:-url)?|preview-url|drive-link|pdf|word|report(?:\.[^/]+)?|certificate|distribution-sheet|record-sheet|content)(?:\/|$)|\.(?:pdf|docx|xlsx|csv)(?:\/|$)/i;

async function parentId(req, table, id, column) {
  const { data, error } = await supabase.from(table).select(column)
    .eq('tenant_id', req.tenantId).eq('id', id).maybeSingle();
  if (error) throw new Error(`Vérification de la fiche parente impossible : ${error.message}`);
  return data?.[column] || null;
}

export async function resolveSharedTarget(req) {
  const parts = req.originalUrl.split('?')[0].split('/').filter(Boolean).slice(1);
  const [module, first, second] = parts;
  let type = SHARE_ROUTE_TYPES[module];
  let id = UUID.test(first || '') ? first.toLowerCase() : null;
  if (module === 'evidence') {
    type = SHARE_ROUTE_TYPES[first];
    id = UUID.test(second || '') ? second.toLowerCase() : null;
    if (first === 'supplier-evaluations' && id) {
      type = 'supplier';
      id = await parentId(req, 'supplier_evaluations', id, 'supplier_id');
    }
  }
  if (module === 'haccp' && UUID.test(second || '')) {
    if (first === 'monitoring-logs') {
      const ccp = await parentId(req, 'haccp_monitoring_logs', second, 'ccp_id');
      const hazard = ccp ? await parentId(req, 'haccp_ccps', ccp, 'hazard_id') : null;
      const step = hazard ? await parentId(req, 'haccp_hazards', hazard, 'step_id') : null;
      id = step ? await parentId(req, 'haccp_process_steps', step, 'plan_id') : null;
    }
    if (first === 'steps') id = await parentId(req, 'haccp_process_steps', second, 'plan_id');
    if (first === 'hazards') {
      const step = await parentId(req, 'haccp_hazards', second, 'step_id');
      id = step ? await parentId(req, 'haccp_process_steps', step, 'plan_id') : null;
    }
    if (first === 'ccps') {
      const hazard = await parentId(req, 'haccp_ccps', second, 'hazard_id');
      const step = hazard ? await parentId(req, 'haccp_hazards', hazard, 'step_id') : null;
      id = step ? await parentId(req, 'haccp_process_steps', step, 'plan_id') : null;
    }
    if (first === 'plans') id = second;
  }
  if (module === 'workflows' && id) {
    type = 'document';
    id = await parentId(req, 'document_workflows', id, 'document_id');
  }
  if (module === 'kpi-imports') {
    type = 'kpi';
    if (req.query.kpi_id || req.body?.kpi_id) id = req.query.kpi_id || req.body.kpi_id;
    else if (id) id = await parentId(req, 'kpi_raw_imports', id, 'kpi_id');
  }
  if (module === 'shares' && first === 'received') {
    type = Object.hasOwn(SHAREABLE_RESOURCES, second) ? second : null;
    id = UUID.test(parts[3] || '') ? parts[3] : null;
  }
  return { type, id, parts, module };
}

export async function enforceSharePermissions(req, res) {
  if (req.userRole === 'admin') return true;
  const permissions = await getSharePermissions({ tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole });
  req.recordSharePermissions = permissions;
  if (!permissions.size) return true;
  const target = await resolveSharedTarget(req);
  const access = target.id && target.type ? permissions.get(`${target.type}:${target.id}`) : null;
  req.shareAccess = access;
  req.shareTarget = target;
  const exporting = (EXPORT_PATH.test(req.originalUrl.split('?')[0]) &&
    !(target.type === 'procedure' && ['POST', 'DELETE'].includes(req.method) && target.parts.at(-1) === 'attachment')) ||
    ['reports', 'drive'].includes(target.module) || req.query.format === 'xlsx' || req.query.format === 'pdf';
  const relevant = target.id && target.type ? (access ? [access] : []) : [...permissions].filter(([key]) =>
    !target.type || key.startsWith(`${target.type}:`)
  ).map(([, value]) => value);
  if (exporting && relevant.some((value) => value.can_export === false)) {
    res.status(403).json({ code: 'SHARE_EXPORT_DENIED', error: 'Export et téléchargement interdits par les règles de partage.' });
    return false;
  }
  const writing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  // Sans identifiant vérifiable, une action groupée ne peut contourner un partage en lecture seule.
  const bulkWrite = !exporting && writing && target.type && !target.id &&
    (target.parts.length > 1 || target.module === 'kpi-imports');
  if ((!exporting && writing && access?.restricted && !access.can_edit) ||
      (bulkWrite && relevant.some((value) => value.restricted && !value.can_edit))) {
    res.status(403).json({ code: 'SHARE_READ_ONLY', error: 'Cet élément est partagé en lecture seule. Modification interdite.' });
    return false;
  }
  // Un partage ne donne aucun droit d'administration, de suppression ou d'approbation.
  req.sharedEditAllowed = access?.can_edit === true &&
    ((req.method === 'PATCH' && target.parts.length === 2) ||
     (target.type === 'haccp_plan' && req.method === 'PATCH' && target.parts[1] === 'plans' && target.parts.length === 3) ||
     (target.type === 'document' && req.method === 'PATCH' && target.parts[2] === 'metadata') ||
     (target.type === 'document' && req.method === 'POST' && target.parts[2] === 'versions') ||
     (target.type === 'supplier' && target.parts[2] === 'documents' &&
       ((req.method === 'POST' && target.parts.length === 3) ||
        (req.method === 'PATCH' && target.parts.length === 4) ||
        (req.method === 'PUT' && target.parts[4] === 'file' && target.parts.length === 5))) ||
     (target.type === 'procedure' && target.parts[2] === 'versions' &&
       ((req.method === 'POST' && target.parts.length === 3) ||
        (req.method === 'PUT' && target.parts.length === 4) ||
        (req.method === 'POST' && target.parts.at(-1) === 'attachment'))));
  if (req.sharedEditAllowed && req.userRole === 'member' &&
      ['status', 'effectiveness_verified', 'validated_at', 'validated_by', 'approved_at', 'approved_by', 'closed_at', 'category_id', 'assigned_to', 'created_by'].some((field) => Object.hasOwn(req.body || {}, field))) {
    res.status(403).json({ error: 'Le droit de modification ne permet pas de valider, réassigner ou administrer cet élément.' });
    return false;
  }
  if (access?.shared && target.id && target.type) {
    const config = SHAREABLE_RESOURCES[target.type];
    if (config.categorySource) {
      req.sharedCategoryId = await parentId(req, config.table, target.id, 'category_id');
    }
  }
  return true;
}
