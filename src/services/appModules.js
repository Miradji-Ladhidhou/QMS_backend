export const APP_MODULES = [
  'dashboard',
  'planning',
  'documents',
  'registers',
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
  'accidents',
  'pdca',
  'nonconforming-outputs',
  'customer-satisfaction',
  'my-approvals',
  'services',
  'employees',
];

export const APP_MODULE_LABELS = {
  dashboard: 'Tableau de bord',
  planning: 'Planning et tâches',
  documents: 'Documents',
  registers: 'Registres',
  capas: 'CAPA',
  complaints: 'Réclamations',
  trainings: 'Formations',
  kpis: 'KPIs',
  qqoqccp: 'QQOQCCP',
  audits: 'Audits internes',
  risks: 'Risques',
  haccp: 'HACCP',
  suppliers: 'Fournisseurs',
  'management-reviews': 'Revues de direction',
  accidents: 'Accidents du travail',
  pdca: 'PDCA',
  'nonconforming-outputs': 'Non-conformités produit/service',
  'customer-satisfaction': 'Satisfaction client',
  'my-approvals': 'Mes approbations',
  services: 'Services',
  employees: 'Personnel',
};

export function effectiveAppModules(settings) {
  return Object.fromEntries(APP_MODULES.map((key) => [key, settings?.[key] !== false]));
}

export function validAppModules(value) {
  return value && !Array.isArray(value) &&
    Object.keys(value).length === APP_MODULES.length &&
    APP_MODULES.every((key) => typeof value[key] === 'boolean');
}
