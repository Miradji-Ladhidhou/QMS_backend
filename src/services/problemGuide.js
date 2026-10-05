import {
  getAvailableProblemModules,
  getProblemRecommendations,
  mergeProblemRecommendations,
  needsProblemFallback,
} from '../lib/problemGuide/problemGuide.js';

export function prepareProblemGuideSearch(query, visibleMenuKeys) {
  const access = { visibleMenuKeys: [...visibleMenuKeys] };
  const modules = getAvailableProblemModules(access);
  const local = getProblemRecommendations(query, access);
  return { access, modules, local, needsFallback: modules.length > 0 && needsProblemFallback(local) };
}

export function validateProblemGuideResponse(response, allowedModules) {
  if (!response || !Array.isArray(response.recommendations) || response.recommendations.length > 6) {
    throw new Error('Format de recommandations invalide.');
  }
  const allowed = new Set(allowedModules.map(({ id }) => id));
  for (const recommendation of response.recommendations) {
    if (!recommendation || !allowed.has(recommendation.id) ||
        !Number.isInteger(recommendation.score) || recommendation.score < 50 || recommendation.score > 120) {
      throw new Error('Recommandation invalide ou module non autorisé.');
    }
  }
  return response.recommendations;
}

export function mergeGuideSearch(local, remote, access) {
  return mergeProblemRecommendations(local, remote, access).map(({ id, score }) => ({ id, score }));
}
