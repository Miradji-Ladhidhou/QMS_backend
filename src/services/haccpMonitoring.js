import { supabase } from './supabase.js';

// Une dérive répétée : au moins DEVIATION_ALERT_COUNT relevés hors limites sur DEVIATION_ALERT_DAYS jours
// glissants pour un même CCP — le signe d'un problème qui ne se corrige pas par une simple action immédiate.
export const DEVIATION_ALERT_COUNT = 3;
export const DEVIATION_ALERT_DAYS = 7;

// Fenêtre horaire (heure locale de l'entreprise) dans laquelle les rappels de relevé sont envoyés :
// jamais en pleine nuit pour un site qui ne travaille pas.
export const REMINDER_HOURS = { from: 6, to: 20 };

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;

// « Bornes chiffrées » d'un CCP : null tant qu'aucune borne n'est définie (pas de verdict automatique).
export function numericLimitsOf(ccp) {
  const min = ccp?.limit_min === null || ccp?.limit_min === undefined ? null : Number(ccp.limit_min);
  const max = ccp?.limit_max === null || ccp?.limit_max === undefined ? null : Number(ccp.limit_max);
  if (min === null && max === null) return null;
  return { min, max, unit: ccp.limit_unit || '' };
}

// Bornes incluses : 4 °C est dans la limite « max 4 ».
export function isWithinLimits(value, limits) {
  if (!Number.isFinite(value) || !limits) return null;
  if (limits.min !== null && value < limits.min) return false;
  if (limits.max !== null && value > limits.max) return false;
  return true;
}

// Nombre saisi à la française (« 3,5 ») ou à l'anglaise (« 3.5 ») ; null si ce n'est pas un nombre.
export function parseNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  return Number(normalized);
}

// « 4 °C » — texte d'affichage d'un relevé numérique.
export function formatReading(value, unit) {
  return `${value}${unit ? ` ${unit}` : ''}`;
}

// Verdict d'un relevé à enregistrer. CCP avec bornes chiffrées : la valeur numérique (numeric_value, sinon
// recorded_value s'il est numérique) décide seule, jamais le client. Sans bornes : le verdict envoyé fait foi.
// Renvoie { error } ou { numericValue, recordedValue, withinLimits }.
export function evaluateReading(ccp, { numeric_value: numericRaw, recorded_value: recordedRaw, within_limits: withinRaw }) {
  const limits = numericLimitsOf(ccp);
  if (!limits) {
    const text = typeof recordedRaw === 'string' ? recordedRaw.trim() : '';
    if (!text) return { error: 'La valeur relevée est requise.' };
    if (typeof withinRaw !== 'boolean') return { error: 'Indiquez si le relevé est dans les limites.' };
    return { numericValue: parseNumber(numericRaw ?? text), recordedValue: text, withinLimits: withinRaw };
  }
  const value = parseNumber(numericRaw ?? recordedRaw);
  if (value === null) return { error: `Ce point critique a des limites chiffrées : saisissez une valeur numérique${limits.unit ? ` (en ${limits.unit})` : ''}.` };
  return { numericValue: value, recordedValue: formatReading(value, limits.unit), withinLimits: isWithinLimits(value, limits) };
}

// « ≥ 0 °C et ≤ 4 °C », « ≤ 4 °C », « ≥ 63 °C ».
export function describeLimits(limits) {
  if (!limits) return '';
  const unit = limits.unit ? ` ${limits.unit}` : '';
  const parts = [];
  if (limits.min !== null) parts.push(`≥ ${limits.min}${unit}`);
  if (limits.max !== null) parts.push(`≤ ${limits.max}${unit}`);
  return parts.join(' et ');
}

// Nombre de relevés hors limites dans les `days` derniers jours (logs : { within_limits, recorded_at }).
export function countRecentDeviations(logs, now = new Date(), days = DEVIATION_ALERT_DAYS) {
  const since = now.getTime() - days * DAY_MS;
  return logs.filter((log) => !log.within_limits && new Date(log.recorded_at).getTime() >= since).length;
}

export function hasRepeatedDeviation(logs, now = new Date()) {
  return countRecentDeviations(logs, now) >= DEVIATION_ALERT_COUNT;
}

// État de la surveillance d'un CCP à l'instant `now`.
//  - 'no_schedule' : aucun intervalle défini (pas de rappel possible) ;
//  - 'overdue'     : le prochain relevé aurait dû être fait ;
//  - 'due_soon'    : à faire dans la prochaine heure (ou le dernier quart de l'intervalle) ;
//  - 'ok'          : à jour.
// Sans relevé, l'échéance part de la création du CCP. `due_at` = date du prochain relevé attendu.
export function monitoringState(ccp, lastRecordedAt, now = new Date()) {
  const interval = ccp.monitoring_interval_hours === null || ccp.monitoring_interval_hours === undefined ? null : Number(ccp.monitoring_interval_hours);
  if (!interval) return { state: 'no_schedule', due_at: null, overdue_hours: 0 };

  const reference = new Date(lastRecordedAt || ccp.created_at).getTime();
  const dueAt = reference + interval * HOUR_MS;
  const remaining = dueAt - now.getTime();
  if (remaining < 0) return { state: 'overdue', due_at: new Date(dueAt).toISOString(), overdue_hours: Math.round((-remaining / HOUR_MS) * 10) / 10 };
  const soonWindow = Math.min(HOUR_MS, (interval * HOUR_MS) / 4);
  return { state: remaining <= soonWindow ? 'due_soon' : 'ok', due_at: new Date(dueAt).toISOString(), overdue_hours: 0 };
}

// Heure locale (0-23) d'un instant dans un fuseau IANA ; UTC si le fuseau est inconnu.
export function localHour(now, timeZone) {
  try {
    const hour = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: timeZone || 'UTC' }).format(now);
    return Number(hour);
  } catch {
    return now.getUTCHours();
  }
}

export function isWithinReminderHours(now, timeZone) {
  const hour = localHour(now, timeZone);
  return hour >= REMINDER_HOURS.from && hour < REMINDER_HOURS.to;
}

const CCP_SELECT =
  'id, ccp_number, critical_limits, limit_min, limit_max, limit_unit, monitoring_procedure, monitoring_frequency, monitoring_interval_hours, monitoring_responsible, corrective_action_procedure, verification_procedure, verification_frequency, record_keeping_procedure, created_at, ' +
  'monitoring_responsible_user:users!haccp_ccps_monitoring_responsible_fkey(id, full_name), ' +
  'hazard:haccp_hazards(id, description, step:haccp_process_steps(id, name, step_number, plan:haccp_plans(id, title, status, created_by, service_id, category_id, category:categories(id, is_restricted))))';

// Tous les CCP du tenant (ou des plans demandés) avec leur plan, leur dernier relevé, leur état de surveillance
// et leurs dérives récentes. `activeOnly` : seulement les plans actifs (ceux réellement appliqués sur le terrain).
export async function fetchCcpStatuses(tenantId, { planIds, ccpIds: onlyCcpIds, activeOnly = false, now = new Date() } = {}) {
  const { data: rows, error } = await supabase.from('haccp_ccps').select(CCP_SELECT).eq('tenant_id', tenantId);
  if (error) throw new Error('Impossible de récupérer les points critiques.');

  const ccps = (rows || [])
    .map((row) => {
      const step = row.hazard?.step;
      const plan = step?.plan;
      if (!plan) return null;
      return { ...row, hazard_description: row.hazard.description, step_name: step.name, step_number: step.step_number, plan };
    })
    .filter((ccp) => ccp && (!planIds || planIds.includes(ccp.plan.id)) && (!onlyCcpIds || onlyCcpIds.includes(ccp.id)) && (!activeOnly || ccp.plan.status === 'active'));
  if (ccps.length === 0) return [];

  const since = new Date(now.getTime() - DEVIATION_ALERT_DAYS * DAY_MS).toISOString();
  const ccpIds = ccps.map((ccp) => ccp.id);
  const [{ data: lastLogs }, { data: recentLogs }] = await Promise.all([
    supabase.from('haccp_monitoring_logs').select('ccp_id, recorded_at, recorded_value, within_limits').eq('tenant_id', tenantId).in('ccp_id', ccpIds).order('recorded_at', { ascending: false }).limit(5000),
    supabase.from('haccp_monitoring_logs').select('ccp_id, recorded_at, within_limits').eq('tenant_id', tenantId).in('ccp_id', ccpIds).gte('recorded_at', since),
  ]);

  const lastByCcp = new Map();
  for (const log of lastLogs || []) if (!lastByCcp.has(log.ccp_id)) lastByCcp.set(log.ccp_id, log);
  const recentByCcp = new Map();
  for (const log of recentLogs || []) recentByCcp.set(log.ccp_id, [...(recentByCcp.get(log.ccp_id) || []), log]);

  return ccps.map((ccp) => {
    const last = lastByCcp.get(ccp.id) || null;
    const recent = recentByCcp.get(ccp.id) || [];
    const limits = numericLimitsOf(ccp);
    return {
      ...ccp,
      limits,
      limits_text: describeLimits(limits),
      last_reading: last ? { recorded_at: last.recorded_at, recorded_value: last.recorded_value, within_limits: last.within_limits } : null,
      ...monitoringStateFields(ccp, last?.recorded_at, now),
      recent_deviations: countRecentDeviations(recent, now),
      repeated_deviation: hasRepeatedDeviation(recent, now),
    };
  });
}

function monitoringStateFields(ccp, lastRecordedAt, now) {
  const { state, due_at: dueAt, overdue_hours: overdueHours } = monitoringState(ccp, lastRecordedAt, now);
  return { monitoring_state: state, due_at: dueAt, overdue_hours: overdueHours };
}
