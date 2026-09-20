import { supabase } from './supabase.js';
import { filterViewableByCategory } from '../middleware/genericCategoryPermissions.js';

// Qualification des auditeurs internes (ISO 9001 §9.2 : auditeurs choisis pour leur compétence).
// Les formations cochées « qualifie les auditeurs internes » (trainings.qualifies_internal_auditor)
// servent de référence : la personne est
//  - qualified : dernière réalisation d'une de ces formations valide (recyclage à jour) ET évaluation/QCM
//                non échoué ;
//  - expired   : réalisation trouvée mais échéance de recyclage dépassée (« à recycler ») ;
//  - failed    : dernière réalisation évaluée « non satisfaisante » (ex. QCM non réussi) ;
//  - none      : aucune réalisation de ces formations.
// Un simple indicateur (jamais un blocage) : voir la page Audits.
export const QUALIFICATION_STATUS = { QUALIFIED: 'qualified', EXPIRED: 'expired', FAILED: 'failed', NONE: 'none' };

// Meilleur statut d'abord, quand une personne a suivi plusieurs formations qualifiantes.
const RANK = { qualified: 3, expired: 2, failed: 1, none: 0 };

// Statut d'UNE réalisation. Un échec d'évaluation prime : une formation non validée ne qualifie pas,
// même si son échéance est lointaine. today : 'YYYY-MM-DD'.
export function classifyRecord(record, today) {
  if (record.evaluation_result === false) return QUALIFICATION_STATUS.FAILED;
  if (record.next_due_date && record.next_due_date < today) return QUALIFICATION_STATUS.EXPIRED;
  return QUALIFICATION_STATUS.QUALIFIED;
}

// Fonction pure (testable sans base) : trainings = formations qualifiantes [{ id, title }],
// records = leurs réalisations par compte, attempts = passages de QCM terminés.
// Retourne { [userId]: { status, training_id, training_title, completed_at, next_due_date,
// evaluation_result, quiz_score_percent } }. Les personnes sans réalisation n'y figurent pas (= none).
export function resolveQualifications({ trainings, records, attempts, today }) {
  const titleById = new Map(trainings.map((training) => [training.id, training.title]));

  // Dernier passage de QCM terminé par réalisation.
  const latestAttemptByRecord = new Map();
  for (const attempt of attempts) {
    const known = latestAttemptByRecord.get(attempt.record_id);
    if (!known || new Date(attempt.completed_at) > new Date(known.completed_at)) latestAttemptByRecord.set(attempt.record_id, attempt);
  }

  // Dernière réalisation de chaque (personne, formation).
  const latestByPair = new Map();
  for (const record of records) {
    const key = `${record.user_id}|${record.training_id}`;
    const known = latestByPair.get(key);
    if (!known || record.completed_at > known.completed_at) latestByPair.set(key, record);
  }

  const byUser = {};
  for (const record of latestByPair.values()) {
    const status = classifyRecord(record, today);
    const candidate = {
      status,
      training_id: record.training_id,
      training_title: titleById.get(record.training_id) || '',
      completed_at: record.completed_at,
      next_due_date: record.next_due_date,
      evaluation_result: record.evaluation_result,
      quiz_score_percent: latestAttemptByRecord.get(record.id)?.score_percent ?? null,
    };
    const current = byUser[record.user_id];
    if (!current || RANK[status] > RANK[current.status] || (RANK[status] === RANK[current.status] && record.completed_at > current.completed_at)) {
      byUser[record.user_id] = candidate;
    }
  }
  return byUser;
}

// Charge les formations qualifiantes VISIBLES par l'appelant (une catégorie restreinte reste
// confidentielle, comme dans la liste des formations) puis calcule le statut de chaque personne.
export async function fetchAuditorQualifications({ tenantId, userId, userRole }) {
  const { data: rawTrainings } = await supabase
    .from('trainings')
    .select('id, title, category_id, category:categories(id, is_restricted)')
    .eq('tenant_id', tenantId)
    .eq('qualifies_internal_auditor', true)
    .order('title', { ascending: true });

  const visible = await filterViewableByCategory({ userId, userRole, items: rawTrainings || [] });
  const trainings = visible.map(({ id, title }) => ({ id, title }));
  if (trainings.length === 0) return { trainings: [], byUser: {} };

  const { data: records } = await supabase
    .from('training_records')
    .select('id, training_id, user_id, completed_at, next_due_date, evaluation_result')
    .eq('tenant_id', tenantId)
    .in('training_id', trainings.map((training) => training.id))
    .not('user_id', 'is', null);

  const recordIds = (records || []).map((record) => record.id);
  let attempts = [];
  if (recordIds.length > 0) {
    const { data } = await supabase
      .from('training_quiz_attempts')
      .select('record_id, score_percent, completed_at')
      .eq('tenant_id', tenantId)
      .in('record_id', recordIds)
      .not('completed_at', 'is', null);
    attempts = data || [];
  }

  const today = new Date().toISOString().slice(0, 10);
  return { trainings, byUser: resolveQualifications({ trainings, records: records || [], attempts, today }) };
}
