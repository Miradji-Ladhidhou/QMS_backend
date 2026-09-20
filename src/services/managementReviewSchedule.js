import { supabase } from './supabase.js';

// Planification des revues de direction (ISO 9001 §9.3.1 : « à intervalles planifiés »). La date attendue de la
// prochaine revue = date de la dernière revue CLÔTURÉE + tenants.management_review_frequency_months. Une revue
// déjà programmée (brouillon daté d'aujourd'hui ou plus tard) suffit : le rappel « à programmer » disparaît.
// status :
//  - not_configured : aucune fréquence définie ;
//  - no_review      : fréquence définie mais aucune revue clôturée encore (rien pour calculer une échéance) ;
//  - scheduled      : une revue est déjà programmée ;
//  - ok             : prochaine échéance dans plus de 60 jours ;
//  - due_soon       : échéance dans les 60 jours ;
//  - overdue        : échéance dépassée et aucune revue programmée.
export const DUE_SOON_DAYS = 60;

// Ajoute des mois sans déborder : 31 janvier + 1 mois = 28 février (jamais le 3 mars, ce que fait Date.setMonth).
export function addMonths(dateStr, months) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Fonction pure (testable sans base).
export function resolveSchedule({ frequencyMonths, lastCompletedDate, scheduledReview, today }) {
  const base = { frequency_months: frequencyMonths || null, last_completed_date: lastCompletedDate || null, next_due_date: null, scheduled_review: scheduledReview || null };
  if (!frequencyMonths) return { ...base, status: 'not_configured' };
  if (!lastCompletedDate) return { ...base, status: scheduledReview ? 'scheduled' : 'no_review' };

  const nextDue = addMonths(lastCompletedDate, frequencyMonths);
  if (scheduledReview) return { ...base, next_due_date: nextDue, status: 'scheduled' };
  if (nextDue < today) return { ...base, next_due_date: nextDue, status: 'overdue' };
  return { ...base, next_due_date: nextDue, status: nextDue <= addDays(today, DUE_SOON_DAYS) ? 'due_soon' : 'ok' };
}

export async function computeReviewSchedule(tenantId, { userId, userRole, filterViewable } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const [{ data: tenant }, { data: lastCompleted }, { data: drafts }] = await Promise.all([
    supabase.from('tenants').select('management_review_frequency_months').eq('id', tenantId).single(),
    supabase.from('management_reviews').select('review_date').eq('tenant_id', tenantId).eq('status', 'completed').order('review_date', { ascending: false }).limit(1).maybeSingle(),
    supabase
      .from('management_reviews')
      .select('id, title, review_date, category_id, category:categories(id, is_restricted)')
      .eq('tenant_id', tenantId)
      .eq('status', 'draft')
      .gte('review_date', today)
      .order('review_date', { ascending: true }),
  ]);

  // Une revue programmée en catégorie restreinte inaccessible ne compte pas pour cet utilisateur (comme le planning).
  const visibleDrafts = filterViewable ? await filterViewable({ userId, userRole, items: drafts || [] }) : drafts || [];
  const scheduled = visibleDrafts[0] ? { id: visibleDrafts[0].id, title: visibleDrafts[0].title, review_date: visibleDrafts[0].review_date } : null;

  return resolveSchedule({
    frequencyMonths: tenant?.management_review_frequency_months,
    lastCompletedDate: lastCompleted?.review_date,
    scheduledReview: scheduled,
    today,
  });
}
