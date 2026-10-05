import { supabase } from '../services/supabase.js';
import { APP_MODULES, effectiveAppModules } from '../services/appModules.js';

// Sections de menu configurables (visibilité par rôle/utilisateur) — dupliqué depuis
// Layout.jsx#NAV_ITEMS côté frontend (deux repos séparés, pas de package commun). Source
// unique côté backend : tenant.js (routes /menu, /menu-settings) et requireMenuVisible
// ci-dessous s'appuient tous les deux sur ce fichier, pour ne jamais diverger entre "ce qui
// est affiché" et "ce qui est réellement accessible".
export const MENU_ITEM_KEYS = APP_MODULES;
export const CONFIGURABLE_ROLES = ['manager', 'member'];
export const DEFAULT_HIDDEN_FOR_ROLE = { manager: ['services', 'employees'], member: ['services', 'employees'] };

// Calcule les clés de menu visibles pour CET utilisateur après filtrage par forfait.
export async function getVisibleMenuKeys({ tenantId, userId, userRole, appModules: configuredModules }) {
  if (configuredModules === undefined) {
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select('app_modules')
      .eq('id', tenantId)
      .maybeSingle();
    if (tenantError || !tenant) {
      console.error('[modules métier] lecture impossible :', tenantError?.message || 'Entreprise absente');
      throw new Error('Impossible de vérifier les modules de cette entreprise.');
    }
    configuredModules = tenant.app_modules;
  }
  const appModules = effectiveAppModules(configuredModules);
  if (userRole === 'admin') return new Set(MENU_ITEM_KEYS.filter((key) => appModules[key]));

  const { data: settings, error: settingsError } = await supabase
    .from('tenant_menu_settings')
    .select('role_hidden_items, user_overrides')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (settingsError) {
    console.error('[modules métier] lecture des permissions impossible :', settingsError.message);
    throw new Error('Impossible de vérifier les permissions de cet utilisateur.');
  }

  // undefined (rôle jamais configuré) => défaut ; [] explicite (l'admin a choisi de tout
  // montrer) => respecté tel quel — même distinction que GET /menu.
  const storedForRole = settings?.role_hidden_items?.[userRole];
  const hiddenForRole = new Set(storedForRole !== undefined ? storedForRole : DEFAULT_HIDDEN_FOR_ROLE[userRole] || []);
  const overridesForUser = settings?.user_overrides?.[userId] || {};

  const visible = MENU_ITEM_KEYS.filter((key) => {
    if (Object.prototype.hasOwnProperty.call(overridesForUser, key)) return overridesForUser[key];
    return !hiddenForRole.has(key);
  });

  return new Set(visible.filter((key) => appModules[key]));
}

// Middleware : bloque tout accès à un module dont le menu est masqué pour cet utilisateur —
// jusqu'ici la visibilité de menu ne masquait QUE la barre latérale (le raccourci dashboard et
// l'API elle-même restaient accessibles telle quelle, bug réel rapporté). À poser en
// `router.use()` juste après requireAuth sur les routes d'un module, pour couvrir toutes ses
// routes (lecture ET écriture) sans avoir à le répéter route par route.
export function requireMenuVisible(key) {
  return async (req, res, next) => {
    try {
      const visible = await getVisibleMenuKeys({
        tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole, appModules: req.appModules,
      });
      if (!visible.has(key)) {
        return res.status(403).json({
          code: 'APP_MODULE_DISABLED',
          module: key,
          error: "Ce module n'est pas inclus dans le forfait de votre entreprise. Contactez votre administrateur.",
        });
      }
      next();
    } catch (error) {
      console.error('[modules métier]', error.message);
      res.status(503).json({ error: 'Impossible de vérifier les accès aux modules.' });
    }
  };
}

// Les services et les salariés servent aussi de référentiels communs aux formulaires d'autres
// modules. Garder leurs lectures disponibles évite de casser ces sélecteurs, tout en bloquant
// les créations et modifications lorsque leur module est exclu du forfait.
export function requireModuleForWrites(key) {
  const guard = requireMenuVisible(key);
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    return guard(req, res, next);
  };
}
