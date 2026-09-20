import { supabase } from './supabase.js';
import { filterViewableByCategory } from '../middleware/genericCategoryPermissions.js';
import { computeReviewSchedule } from './managementReviewSchedule.js';

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
// tout le tenant selon le mode. userId/userRole servent uniquement à appliquer la restriction
// de catégorie (voir Paramètres > Catégories) — un item d'une catégorie restreinte sans
// permission ne doit pas apparaître dans le planning, même juste comme échéance.
export async function fetchCapaItems(tenantId, { assignedTo, serviceIds, userId, userRole }) {
  let query = supabase
    .from('capas')
    .select('id, number, title, due_date, category_id, category:categories(id, is_restricted)')
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

  const visible = await filterViewableByCategory({ userId, userRole, items: data });

  return visible.map((capa) =>
    withOverdue({
      type: 'capa',
      id: capa.id,
      title: `${capa.number} — ${capa.title}`,
      date: capa.due_date,
      link: `/capas/${capa.id}`,
    })
  );
}

// Fournisseurs actifs à réévaluer — par service ou tout le tenant pour admin/manager, jamais
// pour member (pas de porteur individuel, comme les documents : un fournisseur n'est
// "possédé" par personne en particulier — voir suppliers.js).
export async function fetchSupplierItems(tenantId, { serviceIds, userId, userRole }) {
  let query = supabase
    .from('suppliers')
    .select('id, name, next_evaluation_date, category_id, category:categories(id, is_restricted)')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .not('next_evaluation_date', 'is', null);

  if (serviceIds) {
    if (serviceIds.length === 0) return [];
    query = query.in('service_id', serviceIds);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  const visible = await filterViewableByCategory({ userId, userRole, items: data });

  return visible.map((supplier) =>
    withOverdue({
      type: 'supplier',
      id: supplier.id,
      title: `Évaluation fournisseur — ${supplier.name}`,
      date: supplier.next_evaluation_date,
      link: `/suppliers/${supplier.id}`,
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

// Procédures avec une prochaine révision — même forme que fetchDocumentItems (pas de
// service_id/category_id sur procedures, voir schema.sql : toujours tout le tenant, jamais
// scopé ni filtré par catégorie, contrairement à capas/audits/...). Une procédure déjà
// obsolete est exclue : sa révision n'a plus de sens, même logique que isReviewOverdue côté
// frontend (Procedures.jsx).
export async function fetchProcedureItems(tenantId) {
  const { data, error } = await supabase
    .from('procedures')
    .select('id, number, title, next_review_date')
    .eq('tenant_id', tenantId)
    .neq('status', 'obsolete')
    .not('next_review_date', 'is', null);

  if (error || !data) return [];

  return data.map((procedure) =>
    withOverdue({
      type: 'procedure',
      id: procedure.id,
      title: `${procedure.number} — ${procedure.title}`,
      date: procedure.next_review_date,
      link: `/procedures/${procedure.id}`,
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

// Réclamations non résolues/clôturées avec une échéance de réponse — même scope que CAPA
// (assigné à moi, par service, ou tout le tenant), même famille de règles côté rôle
// (complaints.js reflète capas.js : member = ses réclamations assignées uniquement).
export async function fetchComplaintItems(tenantId, { assignedTo, serviceIds, userId, userRole }) {
  let query = supabase
    .from('complaints')
    .select('id, customer_name, due_date, category_id, category:categories(id, is_restricted)')
    .eq('tenant_id', tenantId)
    .not('due_date', 'is', null)
    .not('status', 'in', '(resolved,closed)');

  if (assignedTo) {
    query = query.eq('assigned_to', assignedTo);
  } else if (serviceIds) {
    if (serviceIds.length === 0) return [];
    query = query.in('service_id', serviceIds);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  const visible = await filterViewableByCategory({ userId, userRole, items: data });

  return visible.map((complaint) =>
    withOverdue({
      type: 'complaint',
      id: complaint.id,
      title: `Réclamation — ${complaint.customer_name}`,
      date: complaint.due_date,
      link: `/complaints/${complaint.id}`,
    })
  );
}

// Risques/opportunités non clôturés/acceptés avec une date de revue — scope : ceux dont je
// suis responsable (member), par service, ou tout le tenant selon le mode. Même principe de
// transparence que les audits (voir risks.js) : la lecture reste ouverte à tous les rôles,
// seule la SÉLECTION des items du planning personnel d'un member change ici.
export async function fetchRiskItems(tenantId, { ownerId, serviceIds, userId, userRole }) {
  let query = supabase
    .from('risks')
    .select('id, title, review_date, category_id, category:categories(id, is_restricted)')
    .eq('tenant_id', tenantId)
    .not('review_date', 'is', null)
    .not('status', 'in', '(accepted,closed)');

  if (ownerId) {
    query = query.eq('owner', ownerId);
  } else if (serviceIds) {
    if (serviceIds.length === 0) return [];
    query = query.in('service_id', serviceIds);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  const visible = await filterViewableByCategory({ userId, userRole, items: data });

  return visible.map((risk) =>
    withOverdue({
      type: 'risk',
      id: risk.id,
      title: risk.title,
      date: risk.review_date,
      link: `/risks/${risk.id}`,
    })
  );
}

// Audits internes non clôturés — scope : ceux que je mène (member), par service audité, ou
// tout le tenant selon le mode. Contrairement à CAPA/formations, un audit reste visible en
// lecture à tous les rôles (voir audits.js) ; ici on ne filtre que la SÉLECTION des items du
// planning personnel d'un member sur "je suis l'auditeur", pas l'accès à la donnée elle-même.
export async function fetchAuditItems(tenantId, { leadAuditorId, serviceIds, userId, userRole }) {
  let query = supabase
    .from('audits')
    .select('id, title, planned_date, category_id, category:categories(id, is_restricted)')
    .eq('tenant_id', tenantId)
    .in('status', ['planned', 'in_progress']);

  if (leadAuditorId) {
    query = query.eq('lead_auditor', leadAuditorId);
  } else if (serviceIds) {
    if (serviceIds.length === 0) return [];
    query = query.in('service_id', serviceIds);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  const visible = await filterViewableByCategory({ userId, userRole, items: data });

  return visible.map((audit) =>
    withOverdue({
      type: 'audit',
      id: audit.id,
      title: audit.title,
      date: audit.planned_date,
      link: `/audits/${audit.id}`,
    })
  );
}

// Projets PDCA non clôturés avec une date cible — scope : ceux dont je suis responsable
// (member), par service, ou tout le tenant selon le mode. Même principe de transparence que les
// risques (voir pdca.js) : la lecture reste ouverte à tous les rôles, seule la SÉLECTION des
// items du planning personnel d'un member change ici.
// Libellés courts — mêmes que frontend/src/lib/pdcaStatus.js#PDCA_STATUS_LABELS (dupliqués,
// même convention que les libellés de statut dans les générateurs PDF de ce projet).
const PDCA_PHASE_LABELS = { plan: 'Plan', do: 'Do', check: 'Check', act: 'Act' };

export async function fetchPdcaItems(tenantId, { ownerId, serviceIds, userId, userRole }) {
  let query = supabase
    .from('pdca_projects')
    .select(
      'id, title, status, target_date, plan_due_date, do_due_date, check_due_date, act_due_date, category_id, category:categories(id, is_restricted)'
    )
    .eq('tenant_id', tenantId)
    .neq('status', 'closed')
    .or('target_date.not.is.null,plan_due_date.not.is.null,do_due_date.not.is.null,check_due_date.not.is.null,act_due_date.not.is.null');

  if (ownerId) {
    query = query.eq('owner', ownerId);
  } else if (serviceIds) {
    if (serviceIds.length === 0) return [];
    query = query.in('service_id', serviceIds);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  const visible = await filterViewableByCategory({ userId, userRole, items: data });

  // Deux entrées possibles par projet, jamais plus : l'échéance globale (target_date, comme
  // avant) ET l'échéance de la SEULE phase en cours (pdca.status) si elle est renseignée — pas
  // les 4 phases, dont 3 sont forcément passées ou pas encore d'actualité. Id distinct
  // (`${id}:phase`) pour ne jamais entrer en collision avec l'entrée target_date du même projet
  // dans la sélection/l'export du planning (Planning.jsx), qui indexe par item.id.
  const items = [];
  for (const pdca of visible) {
    if (pdca.target_date) {
      items.push(
        withOverdue({
          type: 'pdca',
          id: pdca.id,
          title: pdca.title,
          date: pdca.target_date,
          link: `/pdca/${pdca.id}`,
        })
      );
    }
    const phaseDueDate = pdca[`${pdca.status}_due_date`];
    if (phaseDueDate) {
      items.push(
        withOverdue({
          type: 'pdca',
          id: `${pdca.id}:phase`,
          title: `${pdca.title} — Échéance ${PDCA_PHASE_LABELS[pdca.status] || pdca.status}`,
          date: phaseDueDate,
          link: `/pdca/${pdca.id}`,
        })
      );
    }
  }
  return items;
}

// Tâches manuelles non terminées — personnelles (créées ou assignées à moi) pour member,
// tout le tenant pour admin/manager (pas de notion de service sur les tâches).
export async function fetchTaskItems(tenantId, { personalUserId, userId, userRole }) {
  const { data, error } = await supabase
    .from('tasks')
    .select(
      'id, title, due_date, assigned_to, created_by, category_id, priority, checklist, recurrence, category:categories(id, is_restricted), capa:capas(id, number)'
    )
    .eq('tenant_id', tenantId)
    .eq('status', 'todo');

  if (error || !data) return [];

  const filtered = personalUserId
    ? data.filter((task) => task.assigned_to === personalUserId || task.created_by === personalUserId)
    : data;

  const visible = await filterViewableByCategory({ userId, userRole, items: filtered });

  // created_by/assigned_to sont renvoyés (pas seulement utilisés pour le filtre) pour que le
  // frontend puisse calculer les actions autorisées (mêmes règles que canManageTask dans
  // tasks.js) sans un second appel réseau.
  return visible.map((task) =>
    withOverdue({
      type: 'task',
      id: task.id,
      title: task.title,
      date: task.due_date,
      link: '/planning',
      created_by: task.created_by,
      assigned_to: task.assigned_to,
      priority: task.priority,
      checklist: task.checklist,
      recurrence: task.recurrence,
      capa: task.capa || null,
    })
  );
}

// Actions décidées en revue de direction, non réalisées ni abandonnées, avec une échéance — scope :
// celles dont je suis responsable (member), celles des personnes des services choisis (manager), ou tout
// le tenant. ownerIds : null = tout le tenant ; tableau = seulement ces responsables (jamais d'action sans
// responsable dans une vue restreinte : elle n'a personne à qui l'attribuer). Une revue en catégorie
// restreinte inaccessible n'apparaît pas, comme les autres modules.
export async function fetchReviewActionItems(tenantId, { ownerIds, userId, userRole }) {
  if (Array.isArray(ownerIds) && ownerIds.length === 0) return [];

  let query = supabase
    .from('management_review_actions')
    .select('id, description, due_date, review:management_reviews!management_review_actions_review_id_fkey(id, title, category_id, category:categories(id, is_restricted))')
    .eq('tenant_id', tenantId)
    .in('status', ['open', 'in_progress'])
    .not('due_date', 'is', null);
  if (Array.isArray(ownerIds)) query = query.in('owner', ownerIds);

  const { data, error } = await query;
  if (error || !data) return [];

  const withReview = data.filter((action) => action.review);
  const visibleReviews = await filterViewableByCategory({
    userId,
    userRole,
    items: withReview.map((action) => ({ ...action.review, __action: action })),
  });

  return visibleReviews.map((review) =>
    withOverdue({
      type: 'review_action',
      id: review.__action.id,
      title: `${review.title} — ${review.__action.description.length > 90 ? `${review.__action.description.slice(0, 89)}…` : review.__action.description}`,
      date: review.__action.due_date,
      link: `/management-reviews/${review.id}`,
    })
  );
}

// Revues de direction : celles déjà programmées (brouillons datés d'aujourd'hui ou plus tard) et, sinon, le rappel
// « à programmer » à la date attendue de la prochaine revue (dernière revue clôturée + fréquence choisie).
// Réservé à la vue admin/manager (comme les documents et procédures : pas de porteur individuel).
export async function fetchManagementReviewItems(tenantId, { userId, userRole }) {
  const schedule = await computeReviewSchedule(tenantId, { userId, userRole, filterViewable: filterViewableByCategory });
  const items = [];

  if (schedule.scheduled_review) {
    items.push(
      withOverdue({
        type: 'management_review',
        id: schedule.scheduled_review.id,
        title: `Revue de direction — ${schedule.scheduled_review.title}`,
        date: schedule.scheduled_review.review_date,
        link: `/management-reviews/${schedule.scheduled_review.id}`,
      })
    );
  } else if (schedule.next_due_date) {
    items.push(
      withOverdue({
        type: 'management_review_due',
        id: 'management-review-due',
        title: 'Revue de direction à programmer',
        date: schedule.next_due_date,
        link: '/management-reviews',
      })
    );
  }
  return items;
}
