import { supabase } from './supabase.js';
import { filterViewableByCategory } from '../middleware/genericCategoryPermissions.js';
import { daysUntil, documentState, evaluationState } from './supplierPolicy.js';

// Un fournisseur « sous surveillance » ou « à remplacer » depuis plus de 6 mois sans que la situation ait évolué
// mérite qu'on tranche : le maintenir, ou le remplacer.
export const LONG_WATCH_DAYS = 180;

const SUMMARY_SELECT = 'id, name, category, criticality, status, next_evaluation_date, category_id, folder:categories(id, is_restricted), owner_user:users!suppliers_owner_fkey(id, full_name)';

export const scoreOf = (evaluation) => Number(evaluation.weighted_score ?? evaluation.overall_score);

// Depuis quand le fournisseur est-il en décision non « maintenue » ? Date de la première évaluation de la série
// ininterrompue (la plus récente en tête) de décisions « sous surveillance » / « à remplacer » ; null si la dernière
// décision est « maintenue » ou s'il n'y a aucune évaluation. evaluations : la plus récente d'abord.
export function watchSince(evaluations) {
  if (evaluations.length === 0 || evaluations[0].decision === 'maintained') return null;
  let since = evaluations[0].evaluation_date;
  for (const evaluation of evaluations) {
    if (evaluation.decision === 'maintained') break;
    since = evaluation.evaluation_date;
  }
  return since;
}

// Tableau de synthèse des fournisseurs visibles de l'utilisateur : note et décision les plus récentes, évolution,
// état de l'évaluation, certificats échus ou qui expirent, fournisseurs critiques jamais évalués, surveillance qui dure.
export async function buildSuppliersSummary({ tenantId, viewer, today = new Date().toISOString().slice(0, 10) }) {
  const { data: rows, error } = await supabase.from('suppliers').select(SUMMARY_SELECT).eq('tenant_id', tenantId).order('name', { ascending: true });
  if (error) throw new Error('Impossible de récupérer les fournisseurs.');
  const suppliers = await filterViewableByCategory({ ...viewer, items: rows, categoryKey: 'folder' });
  if (suppliers.length === 0) return { suppliers: [], counts: emptyCounts() };

  const ids = suppliers.map((supplier) => supplier.id);
  const [{ data: evaluations }, { data: documents }] = await Promise.all([
    supabase.from('supplier_evaluations').select('supplier_id, evaluation_date, weighted_score, overall_score, decision, created_at').eq('tenant_id', tenantId).in('supplier_id', ids).order('evaluation_date', { ascending: false }).order('created_at', { ascending: false }),
    supabase.from('supplier_documents').select('supplier_id, expires_on').eq('tenant_id', tenantId).in('supplier_id', ids),
  ]);

  const evaluationsBySupplier = new Map();
  for (const evaluation of evaluations || []) evaluationsBySupplier.set(evaluation.supplier_id, [...(evaluationsBySupplier.get(evaluation.supplier_id) || []), evaluation]);
  const documentsBySupplier = new Map();
  for (const document of documents || []) documentsBySupplier.set(document.supplier_id, [...(documentsBySupplier.get(document.supplier_id) || []), document]);

  const items = suppliers.map((supplier) => {
    const history = evaluationsBySupplier.get(supplier.id) || [];
    const latest = history[0] || null;
    const since = watchSince(history);
    const states = (documentsBySupplier.get(supplier.id) || []).map((document) => documentState(document.expires_on, today));
    return {
      id: supplier.id,
      name: supplier.name,
      category: supplier.category,
      criticality: supplier.criticality,
      status: supplier.status,
      owner: supplier.owner_user || null,
      next_evaluation_date: supplier.next_evaluation_date,
      evaluation_state: evaluationState({ next_evaluation_date: supplier.next_evaluation_date, evaluationCount: history.length }, today),
      evaluation_count: history.length,
      latest: latest ? { date: latest.evaluation_date, score: scoreOf(latest), decision: latest.decision } : null,
      trend: history.length >= 2 ? Math.round((scoreOf(history[0]) - scoreOf(history[1])) * 100) / 100 : null,
      watch_since: since,
      long_watch: since !== null && daysUntil(since, today) <= -LONG_WATCH_DAYS,
      expired_documents: states.filter((state) => state === 'expired').length,
      expiring_documents: states.filter((state) => state === 'expiring').length,
    };
  });

  const active = items.filter((item) => item.status === 'active');
  return {
    suppliers: items,
    counts: {
      active: active.length,
      evaluated: active.filter((item) => item.evaluation_count > 0).length,
      overdue: active.filter((item) => item.evaluation_state === 'overdue').length,
      due_soon: active.filter((item) => item.evaluation_state === 'due_soon').length,
      never_evaluated: active.filter((item) => item.evaluation_count === 0).length,
      critical_never_evaluated: active.filter((item) => item.evaluation_count === 0 && ['critical', 'high'].includes(item.criticality)).length,
      under_watch: active.filter((item) => item.latest && item.latest.decision !== 'maintained').length,
      long_watch: active.filter((item) => item.long_watch).length,
      expired_documents: active.reduce((sum, item) => sum + item.expired_documents, 0),
      expiring_documents: active.reduce((sum, item) => sum + item.expiring_documents, 0),
    },
  };
}

function emptyCounts() {
  return { active: 0, evaluated: 0, overdue: 0, due_soon: 0, never_evaluated: 0, critical_never_evaluated: 0, under_watch: 0, long_watch: 0, expired_documents: 0, expiring_documents: 0 };
}
