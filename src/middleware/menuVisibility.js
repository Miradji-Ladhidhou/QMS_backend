import { supabase } from '../services/supabase.js';

// Sections de menu configurables (visibilité par rôle/utilisateur) — dupliqué depuis
// Layout.jsx#NAV_ITEMS côté frontend (deux repos séparés, pas de package commun). Source
// unique côté backend : tenant.js (routes /menu, /menu-settings) et requireMenuVisible
// ci-dessous s'appuient tous les deux sur ce fichier, pour ne jamais diverger entre "ce qui
// est affiché" et "ce qui est réellement accessible".
export const MENU_ITEM_KEYS = [
  'dashboard',
  'planning',
  'documents',
  'capas',
  'complaints',
  'trainings',
  'kpis',
  'qqoqccp',
  'audits',
  'risks',
  'haccp',
  'suppliers',
  'management-reviews',
  'my-approvals',
  'services',
  'employees',
];
export const CONFIGURABLE_ROLES = ['manager', 'member'];
export const DEFAULT_HIDDEN_FOR_ROLE = { manager: ['services', 'employees'], member: ['services', 'employees'] };

// Calcule les clés de menu visibles pour CET utilisateur — un admin voit toujours tout (voir
// commentaire sur GET /menu dans tenant.js : ce réglage ne s'applique jamais au rôle admin).
export async function getVisibleMenuKeys({ tenantId, userId, userRole }) {
  if (userRole === 'admin') return new Set(MENU_ITEM_KEYS);

  const { data: settings } = await supabase
    .from('tenant_menu_settings')
    .select('role_hidden_items, user_overrides')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  // undefined (rôle jamais configuré) => défaut ; [] explicite (l'admin a choisi de tout
  // montrer) => respecté tel quel — même distinction que GET /menu.
  const storedForRole = settings?.role_hidden_items?.[userRole];
  const hiddenForRole = new Set(storedForRole !== undefined ? storedForRole : DEFAULT_HIDDEN_FOR_ROLE[userRole] || []);
  const overridesForUser = settings?.user_overrides?.[userId] || {};

  const visible = MENU_ITEM_KEYS.filter((key) => {
    if (Object.prototype.hasOwnProperty.call(overridesForUser, key)) return overridesForUser[key];
    return !hiddenForRole.has(key);
  });

  return new Set(visible);
}

// Middleware : bloque tout accès à un module dont le menu est masqué pour cet utilisateur —
// jusqu'ici la visibilité de menu ne masquait QUE la barre latérale (le raccourci dashboard et
// l'API elle-même restaient accessibles telle quelle, bug réel rapporté). À poser en
// `router.use()` juste après requireAuth sur les routes d'un module, pour couvrir toutes ses
// routes (lecture ET écriture) sans avoir à le répéter route par route.
export function requireMenuVisible(key) {
  return async (req, res, next) => {
    const visible = await getVisibleMenuKeys({ tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole });
    if (!visible.has(key)) {
      return res.status(403).json({ error: 'Accès non autorisé.' });
    }
    next();
  };
}
