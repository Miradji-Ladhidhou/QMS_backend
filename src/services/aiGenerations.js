import { createHash, randomUUID } from 'node:crypto';
import { supabase } from './supabase.js';
import { aiModuleForRequest } from './aiModules.js';
import { attachAiQuota } from './aiQuota.js';
import { getRequestContext } from './requestContext.js';
import { validAiResult } from './aiResultValidation.js';
import { hasGenericCategoryPermission } from '../middleware/genericCategoryPermissions.js';
import { getVisibleMenuKeys } from '../middleware/menuVisibility.js';
import { isSharedWithUser } from './recordSharing.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => value[key] !== undefined && value[key] !== null && value[key] !== '')
      .map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function aiScopeKey(endpoint, body, suffix = '') {
  const hasObject = /\/[0-9a-f]{8}-[0-9a-f-]{27,}\//i.test(endpoint);
  const input = body?.source ? { source: { type: body.source.type, id: body.source.id } }
    : body?.resourceId ? { resourceId: body.resourceId }
    : body?.planId ? { planId: body.planId }
    : hasObject && !endpoint.endsWith('/compliance-fix') && !endpoint.endsWith('/suggest-revision-from-capa') ? {} : body;
  return createHash('sha256').update(JSON.stringify([endpoint, canonical(input || {}), suffix])).digest('hex');
}

function scopeQuery(req, scope) {
  return supabase.from('ai_generations').select('*')
    .eq('tenant_id', req.tenantId).eq('user_id', req.user.id).eq('scope_key', scope);
}

async function updateGeneration(req, id, patch) {
  const { error } = await supabase.from('ai_generations').update({ ...patch, updated_at: new Date().toISOString() })
    .eq('tenant_id', req.tenantId).eq('user_id', req.user.id).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function aiApplicationSeed(req, res, endpoint) {
  const id = req.body.ai_generation_id;
  if (!id) return null;
  if (!UUID.test(id)) {
    res.status(400).json({ error: 'Référence de génération IA invalide.' });
    return undefined;
  }
  let current = id;
  const visited = new Set();
  while (!visited.has(current)) {
    visited.add(current);
    const { data, error } = await supabase.from('ai_generations').select('id, endpoint, origin, previous_id, status, input')
      .eq('tenant_id', req.tenantId).eq('user_id', req.user.id).eq('id', current).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data || data.endpoint !== endpoint || data.status !== 'completed') {
      res.status(404).json({ error: 'Génération IA disponible introuvable.' });
      return undefined;
    }
    if (endpoint.endsWith('/service-suggestion') && data.input?.source?.type === 'service'
      && data.input.source.id !== req.body.service_id) {
      res.status(404).json({ error: 'Génération IA incompatible avec ce service.' });
      return undefined;
    }
    if (data.origin === 'ai') return data.id;
    current = data.previous_id;
  }
  res.status(409).json({ error: 'Historique IA invalide. Rechargez le résultat enregistré.' });
  return undefined;
}

export function aiApplicationId(seed, endpoint, content) {
  const hex = createHash('sha256').update(JSON.stringify([seed, endpoint, canonical(content)])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function insertAiApplication(req, res, { table, endpoint, row, select = '*' }) {
  const seed = await aiApplicationSeed(req, res, endpoint);
  if (seed === undefined) return null;
  const id = seed ? aiApplicationId(seed, endpoint, row) : undefined;
  const inserted = await supabase.from(table).insert({ ...row, ...(id ? { id } : {}) }).select(select).single();
  if (id && inserted.error?.code === '23505') {
    const existing = await supabase.from(table).select(select)
      .eq('tenant_id', req.tenantId).eq('created_by', req.user.id).eq('id', id).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) {
      if (table === 'risks' && !(await hasGenericCategoryPermission({
        tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole,
        categoryId: existing.data.category_id, permission: 'view',
      }))) {
        res.status(404).json({ error: 'Risque introuvable.' });
        return null;
      }
      return { ...existing, reused: true };
    }
  }
  return inserted;
}

export async function linkAiGenerationJob(req, job) {
  await updateGeneration(req, req.aiGenerationId, {
    job_id: job.id, result: { id: job.id, subject: job.subject, status: job.status },
  });
  req.aiLinkedJobId = job.id;
}

// Called only after the route's validation and business permission checks.
export async function prepareAiResult(req, res, { suffix = '', existingResult = null, onDelete } = {}) {
  const endpoint = `${req.baseUrl}${req.path}`.replace(/\/saved(?:\/read)?$/, '');
  const module = aiModuleForRequest({ method: 'POST', baseUrl: '', path: endpoint });
  const menus = await getVisibleMenuKeys({ tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole });
  if (!menus.has(module === 'management_reviews' ? 'management-reviews' : module)) {
    res.status(403).json({ error: 'Accès non autorisé.' });
    return false;
  }
  if (req.body?.source) {
    const sources = {
      audit_finding: ['audit_findings', 'audits', 'audit_id'],
      review_action: ['management_review_actions', 'management_reviews', 'review_id'],
      supplier_evaluation: ['supplier_evaluations', 'suppliers', 'supplier_id'],
      complaint: ['complaints'], risk: ['risks'], accident: ['accidents'],
      pdca: ['pdca_projects'], haccp_log: ['haccp_monitoring_logs'], service: ['services'],
    };
    const { type, id } = req.body.source;
    const definition = Object.hasOwn(sources, type) ? sources[type] : null;
    if (!definition || !UUID.test(id)
      || (type === 'service' ? !endpoint.endsWith('/service-suggestion') : !endpoint.endsWith('/capa-suggestion'))) {
      res.status(400).json({ error: 'Objet source IA invalide.' });
      return false;
    }
    const sourceMenus = {
      audit_finding: 'audits', review_action: 'management-reviews', supplier_evaluation: 'suppliers',
      complaint: 'complaints', risk: 'risks', accident: 'accidents', pdca: 'pdca', haccp_log: 'haccp',
    };
    if (sourceMenus[type] && !menus.has(sourceMenus[type])) {
      res.status(403).json({ error: 'Accès non autorisé.' });
      return false;
    }
    const { data: source, error: sourceError } = await supabase.from(definition[0]).select('*')
      .eq('tenant_id', req.tenantId).eq('id', id).maybeSingle();
    if (sourceError) throw new Error(sourceError.message);
    if (!source) {
      res.status(404).json({ error: 'Objet source IA introuvable.' });
      return false;
    }
    if (!['admin', 'manager'].includes(req.userRole)
      && (!['accident', 'pdca'].includes(type) || source.created_by !== req.user.id)) {
      res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
      return false;
    }
    let categoryId = source.category_id;
    if (definition[1]) {
      const { data: parent, error: parentError } = await supabase.from(definition[1]).select('category_id')
        .eq('tenant_id', req.tenantId).eq('id', source[definition[2]]).maybeSingle();
      if (parentError) throw new Error(parentError.message);
      if (!parent) {
        res.status(404).json({ error: 'Objet source IA introuvable.' });
        return false;
      }
      categoryId = parent.category_id;
    }
    const shared = type === 'complaint' && await isSharedWithUser({
      tenantId: req.tenantId, resourceType: type, resourceId: id, userId: req.user.id, userRole: req.userRole,
    });
    if (categoryId && !shared && !(await hasGenericCategoryPermission({
      tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole, categoryId, permission: 'view',
    }))) {
      res.status(404).json({ error: 'Objet source IA introuvable.' });
      return false;
    }
  }
  if (req.body?.resourceId) {
    const table = endpoint.endsWith('/risk-treatment-suggestion') ? 'risks'
      : /\/haccp-(significance|ccp)-suggestion$/.test(endpoint) ? 'haccp_hazards' : null;
    if (!table || !UUID.test(req.body.resourceId)) {
      res.status(400).json({ error: 'Objet source IA invalide.' });
      return false;
    }
    const { data: source, error: sourceError } = await supabase.from(table).select('*')
      .eq('tenant_id', req.tenantId).eq('id', req.body.resourceId).maybeSingle();
    if (sourceError) throw new Error(sourceError.message);
    if (!source || (table === 'risks' && !(await hasGenericCategoryPermission({
      tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole, categoryId: source.category_id, permission: 'view',
    })))) {
      res.status(404).json({ error: 'Objet source IA introuvable.' });
      return false;
    }
  }
  const scope = aiScopeKey(endpoint, req.body, suffix);
  const { data: latest, error } = await scopeQuery(req, scope)
    .in('status', endpoint.endsWith('/generate-full-draft') ? ['running', 'completed', 'deleted'] : ['completed', 'deleted'])
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) {
    console.error('[IA] lecture du résultat :', error.message);
    res.status(503).json({ error: 'Impossible de lire le résultat IA enregistré. Aucun appel IA effectué.' });
    return false;
  }
  let saved = latest && latest.status !== 'deleted' ? latest.result : (!latest ? existingResult : null);
  if (saved?.subject && saved?.id && endpoint.endsWith('/generate-full-draft')) {
    const { data: job, error: jobError } = await supabase.from('procedure_generation_jobs').select('*')
      .eq('tenant_id', req.tenantId).eq('created_by', req.user.id).eq('id', saved.id).maybeSingle();
    if (jobError) throw new Error(jobError.message);
    if (job) saved = job;
    if (job && latest.status === 'running' && ['completed', 'failed'].includes(job.status)) {
      await updateGeneration(req, latest.id, { status: job.status, error: job.error });
    }
    if (job && ['pending', 'running'].includes(job.status) && !req.aiResultMode) {
      res.status(202).json(job);
      return false;
    }
  }
  if (req.aiResultMode === 'delete') {
    if (endpoint.endsWith('/generate-full-draft') && ['pending', 'running'].includes(saved?.status)) {
      res.status(409).json({ error: 'Attendez la fin de la génération avant de supprimer le résultat.' });
      return false;
    }
    const { data: running, error: runningError } = await scopeQuery(req, scope).eq('status', 'running').limit(1).maybeSingle();
    if (runningError) throw new Error(runningError.message);
    if (running) {
      res.status(409).json({ error: 'Attendez la fin de la génération avant de supprimer le résultat.' });
      return false;
    }
    if (onDelete) await onDelete();
    if (endpoint.endsWith('/generate-full-draft') && saved?.id) {
      const { error: jobDeleteError } = await supabase.from('procedure_generation_jobs')
        .update({ status: 'failed', result: null, error: 'Résultat supprimé.' })
        .eq('tenant_id', req.tenantId).eq('created_by', req.user.id).eq('id', saved.id);
      if (jobDeleteError) throw new Error(jobDeleteError.message);
    }
    const { error: deleteError } = await supabase.from('ai_generations')
      .update({ status: 'deleted', result: null, updated_at: new Date().toISOString() })
      .eq('tenant_id', req.tenantId).eq('user_id', req.user.id).eq('scope_key', scope).neq('status', 'running');
    if (deleteError) res.status(500).json({ error: 'Impossible de supprimer le résultat IA.' });
    else res.json({ deleted: true });
    return false;
  }
  if (req.aiResultMode === 'read') {
    res.json({ result: saved, generation: latest ? { id: latest.id, origin: latest.origin, created_at: latest.created_at } : null });
    return false;
  }
  if (req.aiResultMode === 'edit') {
    if (!latest || latest.status !== 'completed' || endpoint.endsWith('/generate-full-draft')) {
      res.status(409).json({ error: 'Aucun résultat modifiable disponible.' });
      return false;
    }
    if (!validAiResult(endpoint, req.aiEditedResult, req.body)) {
      res.status(400).json({ error: 'Le résultat modifié est incomplet ou invalide.' });
      return false;
    }
    if (JSON.stringify(canonical(latest.result)) === JSON.stringify(canonical(req.aiEditedResult))) {
      res.json({ id: latest.id, result: latest.result });
      return false;
    }
    const { data, error: editError } = await supabase.from('ai_generations').insert({
      tenant_id: req.tenantId, user_id: req.user.id, endpoint, scope_key: scope, module: latest.module,
      request_id: randomUUID(), status: 'completed', input: req.body, result: req.aiEditedResult,
      origin: 'manual', previous_id: latest.id,
    }).select('id, result').single();
    if (editError) {
      if (editError.code === '23505') {
        const { data: duplicate, error: duplicateError } = await scopeQuery(req, scope)
          .eq('previous_id', latest.id).eq('origin', 'manual').eq('status', 'completed').maybeSingle();
        if (duplicateError) throw new Error(duplicateError.message);
        if (duplicate && JSON.stringify(canonical(duplicate.result)) === JSON.stringify(canonical(req.aiEditedResult))) {
          res.json({ id: duplicate.id, result: duplicate.result });
          return false;
        }
      }
      console.error('[IA] sauvegarde manuelle :', editError.message);
      res.status(editError.code === '23505' ? 409 : 500).json({ error: editError.code === '23505'
        ? 'Ce résultat a déjà été modifié. Rechargez la version enregistrée avant de sauvegarder.'
        : 'Impossible de sauvegarder le résultat modifié. Aucun appel IA effectué.' });
    } else res.json(data);
    return false;
  }

  const requestId = req.get('X-AI-Request-ID') || randomUUID();
  if (!UUID.test(requestId)) {
    res.status(400).json({ error: "Identifiant d'action IA invalide." });
    return false;
  }
  const { data: replay, error: replayError } = await supabase.from('ai_generations').select('*')
    .eq('tenant_id', req.tenantId).eq('user_id', req.user.id).eq('request_id', requestId).maybeSingle();
  if (replayError) throw new Error(replayError.message);
  if (replay) {
    res.set('X-AI-Generation-ID', replay.id);
    if (replay.scope_key !== scope) res.status(409).json({ error: "Cet identifiant appartient à une autre action IA." });
    else if (replay.status === 'completed') res.json(replay.result);
    else res.status(409).json({ code: 'AI_ACTION_ALREADY_SUBMITTED', error: "Cette action a déjà été envoyée. Rechargez le résultat ; aucune nouvelle génération n'a été lancée." });
    return false;
  }
  if (saved && req.get('X-AI-Regenerate') !== 'true') {
    if (latest) res.set('X-AI-Generation-ID', latest.id);
    res.json(saved);
    return false;
  }
  const { data: generation, error: claimError } = await supabase.from('ai_generations').insert({
    tenant_id: req.tenantId, user_id: req.user.id, endpoint, scope_key: scope,
    request_id: requestId, input: req.body, module: aiModuleForRequest(req), previous_id: latest?.id || null,
  }).select().single();
  if (claimError) {
    console.error('[IA] réservation du résultat :', claimError.message);
    res.status(claimError.code === '23505' ? 409 : 503).json({
      code: claimError.code === '23505' ? 'AI_GENERATION_RUNNING' : 'AI_STORAGE_UNAVAILABLE',
      error: claimError.code === '23505' ? 'Une génération est déjà en cours. Aucun nouvel appel IA effectué.' : 'Stockage IA indisponible. Aucun appel IA effectué.',
    });
    return false;
  }
  req.aiGenerationId = generation.id;
  res.set('X-AI-Generation-ID', generation.id);
  if (!(await attachAiQuota(req, res))) {
    await updateGeneration(req, generation.id, { status: 'failed', error: 'Quota IA refusé.' });
    return false;
  }
  getRequestContext().aiQuotaActionId = req.aiQuotaActionId;
  try {
    await updateGeneration(req, generation.id, { quota_action_id: req.aiQuotaActionId });
  } catch (err) {
    console.error('[IA] liaison au quota :', err.message);
    res.status(503).json({ error: "Impossible de préparer la sauvegarde IA. Aucun appel IA effectué." });
    return false;
  }

  const json = res.json.bind(res);
  let responding = false;
  res.json = (body) => {
    if (responding) return res;
    responding = true;
    if (req.aiQuotaDeferred && res.statusCode === 202 && req.aiLinkedJobId === body?.id) {
      json(body);
      return res;
    }
    if (res.statusCode < 400 && !validAiResult(endpoint, body, req.body)) {
      res.status(503);
      body = { code: 'AI_INVALID_RESULT', error: "L'IA n'a pas produit un résultat complet et valide. Aucun résultat incomplet n'a été enregistré." };
    }
    const success = res.statusCode < 400;
    updateGeneration(req, generation.id, success
      ? { status: 'completed', result: body }
      : { status: 'failed', error: body?.error || 'Génération échouée.' })
      .then(() => json(body))
      .catch(async (err) => {
        console.error('[IA] sauvegarde du résultat :', err.message);
        try {
          await updateGeneration(req, generation.id, { status: 'failed', error: "Le résultat n'a pas pu être sauvegardé." });
        } catch (stateError) {
          console.error('[IA] état de sauvegarde indisponible :', stateError.message);
        }
        res.status(500);
        json({ code: 'AI_RESULT_SAVE_FAILED', error: success
          ? "La génération IA a répondu, mais son résultat n'a pas pu être enregistré. L'opération n'est pas terminée. Ne relancez pas la génération pour tenter une sauvegarde."
          : "La génération a échoué et son état n'a pas pu être enregistré." });
      });
    return res;
  };
  return true;
}

// Same validators/guards/handler for reads and deletion; prepareAiResult stops before AI.
export function aiResultRoute(router, path, ...handlers) {
  router.post(path, ...handlers);
  router.post(`${path}/saved/read`, (req, res, next) => {
    req.aiResultMode = 'read';
    next();
  }, ...handlers);
  for (const mode of ['read', 'delete', 'edit']) {
    router[mode === 'read' ? 'get' : mode === 'edit' ? 'patch' : 'delete'](`${path}/saved`, (req, res, next) => {
      req.aiEditedResult = req.body?.result;
      try {
        req.body = req.body?.input ?? JSON.parse(req.query.input || '{}');
      } catch {
        return res.status(400).json({ error: 'Paramètres de lecture IA invalides.' });
      }
      if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object') {
        return res.status(400).json({ error: 'Paramètres de lecture IA invalides.' });
      }
      req.aiResultMode = mode;
      next();
    }, ...handlers);
  }
}
