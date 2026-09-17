import { AsyncLocalStorage } from 'node:async_hooks';

// Contexte de la requête HTTP courante (tenantId/userId), accessible depuis n'importe quelle
// fonction appelée en aval SANS avoir à le faire transiter par chaque signature intermédiaire —
// utile pour une préoccupation transversale comme journaliser un échec IA par tenant (voir
// services/groq.js#callGroq) sans changer la signature des ~20 fonctions generateXxx exportées
// ni des dizaines de routes qui les appellent. Établi une seule fois, dans requireAuth (voir
// middleware/auth.js), dès que tenantId est connu.
//
// À utiliser avec parcimonie : ce n'est PAS un substitut à req.tenantId pour la logique métier
// normale (toujours explicite dans les routes) — seulement pour des préoccupations transversales
// comme celle-ci, où threader un paramètre à travers des dizaines d'appels serait plus fragile
// que ça n'en vaut la peine.
const requestContextStorage = new AsyncLocalStorage();

export function runWithRequestContext(context, callback) {
  return requestContextStorage.run(context, callback);
}

// {} plutôt que undefined si appelée hors de toute requête HTTP (job planifié, script, test qui
// appelle un service directement) — les appelants (voir groq.js) lisent context.tenantId sans
// jamais avoir à vérifier l'existence de l'objet lui-même.
export function getRequestContext() {
  return requestContextStorage.getStore() || {};
}
