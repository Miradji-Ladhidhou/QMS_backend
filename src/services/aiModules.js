export const AI_MODULES = ['capas', 'qqoqccp', 'pdca', 'risks', 'haccp', 'audits', 'management_reviews', 'procedures', 'kpis', 'problem_guide'];

const ACTIONS = [
  ['problem_guide', /^\/api\/ai\/problem-guide-search$/],
  ['capas', /^\/api\/ai\/capa-suggestion$/],
  ['risks', /^\/api\/(?:ai\/risk-treatment-suggestion|risks\/service-suggestion)$/],
  ['haccp', /^\/api\/(?:ai\/haccp-(?:surveillance|significance|ccp)-suggestion|haccp\/steps\/[^/]+\/hazard-suggestion)$/],
  ['qqoqccp', /^\/api\/qqoqccp\/[^/]+\/generate$/],
  ['pdca', /^\/api\/pdca\/[^/]+\/generate$/],
  ['audits', /^\/api\/audits\/[^/]+\/checklist\/generate$/],
  ['management_reviews', /^\/api\/management-reviews\/[^/]+\/ai-draft$/],
  ['kpis', /^\/api\/kpi-imports\/[^/]+\/ai-suggestion$/],
  ['procedures', /^\/api\/procedures\/(?:generate-draft|generate-full-draft|generate-draft-from-qqoqccp|[^/]+\/suggest-revision-from-capa|[^/]+\/versions\/[^/]+\/(?:check-compliance|compliance-fix|compare|distribution-sheet))$/],
];

export function aiModuleForRequest(req) {
  if (req.method !== 'POST') return null;
  const path = `${req.baseUrl}${req.path}`.replace(/\/$/, '');
  return ACTIONS.find(([, pattern]) => pattern.test(path))?.[0] || null;
}

export function effectiveAiModules(settings) {
  return Object.fromEntries(AI_MODULES.map((key) => [key, settings?.[key] !== false]));
}
