import { supabase } from './supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Partagé entre dashboard.js et planning.js : les deux filtrent CAPA/formations par service
// avec la même logique par rôle (admin=tout, manager=ses services, member=personnel).

// Normalise ?service_id= (absent, valeur unique, ou répété plusieurs fois — voir
// dashboard.js) en tableau, et valide chaque UUID. Retourne null si un id est invalide.
export function parseServiceIdsParam(rawServiceId) {
  const ids = rawServiceId === undefined ? [] : [].concat(rawServiceId);
  if (ids.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
    return null;
  }
  return ids;
}

export async function fetchUserServiceIds(tenantId, userId) {
  const { data, error } = await supabase
    .from('user_services')
    .select('service_id')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);

  if (error) return [];
  return data.map((row) => row.service_id);
}

// Les formations n'ont pas de service_id propre, mais leurs réalisations sont rattachées à
// un utilisateur — filtrer "par service" revient à filtrer sur les membres de l'équipe.
export async function fetchServiceUserIds(tenantId, serviceIds) {
  if (serviceIds.length === 0) return [];

  const { data, error } = await supabase
    .from('user_services')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .in('service_id', serviceIds);

  if (error) return [];
  return [...new Set(data.map((row) => row.user_id))];
}

// admin/manager uniquement (le member n'a pas de notion de service) : détermine le(s)
// service(s) à filtrer selon la requête. null = pas de filtre (tout le tenant).
export async function resolveServiceScope({ tenantId, userId, userRole, requestedServiceIds }) {
  if (requestedServiceIds.length > 0) {
    return requestedServiceIds;
  }
  if (userRole === 'manager') {
    return fetchUserServiceIds(tenantId, userId);
  }
  return null;
}
