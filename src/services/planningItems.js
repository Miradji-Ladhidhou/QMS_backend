import { supabase } from './supabase.js';

// Extrait de planning.js (partagé avec dashboard.js, voir stats.overdue) : les deux routes
// ont besoin exactement du même calcul "en retard" (date < aujourd'hui) et des mêmes règles
// de scope par rôle/service pour ne jamais afficher un total qui contredit le détail donné
// par /api/planning.
function today() {
  return new Date().toISOString().slice(0, 10);
}

function withOverdue(item) {
  return { ...item, is_overdue: item.date < today() };
}

// CAPA non clôturées avec une échéance — scope : personnel (assigné à moi), par service, ou
// tout le tenant selon le mode.
export async function fetchCapaItems(tenantId, { assignedTo, serviceIds }) {
  let query = supabase
    .from('capas')
    .select('id, number, title, due_date')
    .eq('tenant_id', tenantId)
    .not('due_date', 'is', null)
    .neq('status', 'closed');

  if (assignedTo) {
    query = query.eq('assigned_to', assignedTo);
  } else if (serviceIds) {
    if (serviceIds.length === 0) return [];
    query = query.in('service_id', serviceIds);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  return data.map((capa) =>
    withOverdue({
      type: 'capa',
      id: capa.id,
      title: `${capa.number} — ${capa.title}`,
      date: capa.due_date,
      link: `/capas/${capa.id}`,
    })
  );
}

// Documents à réviser — toujours tout le tenant pour admin/manager (pas de service_id sur
// les documents, voir dashboard.js), jamais pour member (pas de porteur individuel).
export async function fetchDocumentItems(tenantId) {
  const { data, error } = await supabase
    .from('documents')
    .select('id, number, title, review_date')
    .eq('tenant_id', tenantId)
    .not('review_date', 'is', null);

  if (error || !data) return [];

  return data.map((doc) =>
    withOverdue({
      type: 'document',
      id: doc.id,
      title: `${doc.number} — ${doc.title}`,
      date: doc.review_date,
      link: `/documents/${doc.id}`,
    })
  );
}

// Formations à échéance, comptes ET personnel sans compte — dédupliquées au dernier
// enregistrement par (formation, personne), comme trainings.js/dashboard.js.
export async function fetchTrainingItems(tenantId, { userId, userIds }) {
  let query = supabase
    .from('training_records')
    .select('training_id, user_id, employee_id, completed_at, next_due_date')
    .eq('tenant_id', tenantId);

  if (userId) {
    query = query.eq('user_id', userId);
  } else if (userIds) {
    if (userIds.length === 0) return [];
    query = query.in('user_id', userIds);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  const latestByPair = new Map();
  for (const record of data) {
    const personKey = record.user_id ? `u:${record.user_id}` : `e:${record.employee_id}`;
    const key = `${record.training_id}:${personKey}`;
    const existing = latestByPair.get(key);
    if (!existing || record.completed_at > existing.completed_at) {
      latestByPair.set(key, record);
    }
  }

  const due = [...latestByPair.values()].filter((record) => record.next_due_date);
  if (due.length === 0) return [];

  const trainingIds = [...new Set(due.map((record) => record.training_id))];
  const personUserIds = [...new Set(due.map((record) => record.user_id).filter(Boolean))];
  const personEmployeeIds = [...new Set(due.map((record) => record.employee_id).filter(Boolean))];

  const [{ data: trainings }, { data: users }, { data: employees }] = await Promise.all([
    supabase.from('trainings').select('id, title').in('id', trainingIds),
    personUserIds.length ? supabase.from('users').select('id, full_name').in('id', personUserIds) : Promise.resolve({ data: [] }),
    personEmployeeIds.length
      ? supabase.from('employees').select('id, full_name').in('id', personEmployeeIds)
      : Promise.resolve({ data: [] }),
  ]);

  const trainingsById = new Map((trainings || []).map((t) => [t.id, t]));
  const usersById = new Map((users || []).map((u) => [u.id, u]));
  const employeesById = new Map((employees || []).map((e) => [e.id, e]));

  return due.map((record) => {
    const training = trainingsById.get(record.training_id);
    const person = record.user_id ? usersById.get(record.user_id) : employeesById.get(record.employee_id);
    return withOverdue({
      type: 'training',
      id: `${record.training_id}:${record.user_id || record.employee_id}`,
      title: `${training?.title || 'Formation'} — ${person?.full_name || 'Personne'}`,
      date: record.next_due_date,
      link: '/trainings',
    });
  });
}

// Tâches manuelles non terminées — personnelles (créées ou assignées à moi) pour member,
// tout le tenant pour admin/manager (pas de notion de service sur les tâches).
export async function fetchTaskItems(tenantId, { personalUserId }) {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, due_date, assigned_to, created_by')
    .eq('tenant_id', tenantId)
    .eq('status', 'todo');

  if (error || !data) return [];

  const filtered = personalUserId
    ? data.filter((task) => task.assigned_to === personalUserId || task.created_by === personalUserId)
    : data;

  // created_by/assigned_to sont renvoyés (pas seulement utilisés pour le filtre) pour que le
  // frontend puisse calculer les actions autorisées (mêmes règles que canManageTask dans
  // tasks.js) sans un second appel réseau.
  return filtered.map((task) =>
    withOverdue({
      type: 'task',
      id: task.id,
      title: task.title,
      date: task.due_date,
      link: '/planning',
      created_by: task.created_by,
      assigned_to: task.assigned_to,
    })
  );
}
