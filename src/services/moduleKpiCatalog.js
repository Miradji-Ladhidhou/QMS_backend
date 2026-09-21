import { MODULE_KPI_PRESETS } from './moduleKpiSources.js';

// Le catalogue de métriques de module compte plus de 70 presets répartis sur 20 sources techniques. Pour un
// utilisateur, ce qui compte, c'est de suivre quelques indicateurs pertinents par DOMAINE de son système qualité :
// les sources sont regroupées en 9 domaines, et chaque domaine porte son NOYAU ESSENTIEL (2 à 4 indicateurs qui
// répondent à la question qu'un auditeur ou la direction se pose). Les autres presets restent disponibles, repliés,
// sous « Autres indicateurs ».
//
// menu_keys : entrées de menu (voir Layout.jsx) — le domaine n'est proposé que si l'une d'elles est visible pour
// l'utilisateur (une entreprise sans HACCP ne voit pas le domaine « Sécurité alimentaire »).
export const MODULE_KPI_DOMAINS = [
  {
    key: 'actions',
    label: 'Actions et non-conformités',
    question: 'Traitons-nous les problèmes à temps ?',
    modules: ['capa', 'nonconforming_output', 'pdca'],
    menu_keys: ['capas', 'nonconforming-outputs', 'pdca'],
    essential: ['capa_overdue_backlog', 'capa_on_time_rate', 'capa_resolution_days', 'nc_closed_rate'],
  },
  {
    key: 'customers',
    label: 'Clients',
    question: 'Nos clients sont-ils satisfaits, et leurs réclamations traitées ?',
    modules: ['complaint', 'customer_satisfaction'],
    menu_keys: ['complaints', 'customer-satisfaction'],
    essential: ['complaint_overdue_backlog', 'complaint_on_time_rate', 'complaint_received_count', 'satisfaction_avg_score'],
  },
  {
    key: 'audits',
    label: 'Audits et pilotage',
    question: 'Auditons-nous, et donnons-nous suite aux constats et aux décisions ?',
    modules: ['audit', 'audit_finding', 'management_review_action'],
    menu_keys: ['audits', 'management-reviews'],
    essential: ['audit_done_count', 'audit_nc_count', 'management_review_action_unresolved_backlog'],
  },
  {
    key: 'competences',
    label: 'Compétences et formation',
    question: 'Les personnes sont-elles formées et à jour ?',
    modules: ['competence', 'competence_person', 'training_record'],
    menu_keys: ['employees', 'trainings'],
    essential: ['competence_coverage_rate', 'competence_expired_backlog', 'competence_due_soon_backlog'],
  },
  {
    key: 'risks',
    label: 'Risques',
    question: 'Nos risques sont-ils maîtrisés et revus ?',
    modules: ['risk'],
    menu_keys: ['risks'],
    essential: ['risk_high_untreated_backlog', 'risk_treatment_coverage', 'risk_review_overdue_backlog'],
  },
  {
    key: 'suppliers',
    label: 'Fournisseurs',
    question: 'Nos fournisseurs sont-ils évalués et à la hauteur ?',
    modules: ['supplier', 'supplier_evaluation'],
    menu_keys: ['suppliers'],
    essential: ['supplier_avg_score', 'supplier_eval_overdue_backlog', 'supplier_critical_unevaluated_backlog'],
  },
  {
    key: 'documents',
    label: 'Documents et procédures',
    question: 'Notre documentation est-elle à jour ?',
    modules: ['document', 'document_workflow', 'procedure'],
    menu_keys: ['documents', 'procedures'],
    essential: ['document_review_overdue_backlog', 'procedure_review_overdue_backlog', 'document_approval_pending_backlog'],
  },
  {
    key: 'food_safety',
    label: 'Sécurité alimentaire (HACCP)',
    question: 'Nos points critiques sont-ils maîtrisés ?',
    modules: ['haccp_hazard', 'haccp_monitoring'],
    menu_keys: ['haccp'],
    essential: ['haccp_compliance_rate', 'haccp_deviation_count', 'haccp_significant_hazard_no_ccp_backlog'],
  },
  {
    key: 'safety',
    label: 'Santé et sécurité au travail',
    question: 'Travaille-t-on en sécurité ?',
    modules: ['accident'],
    menu_keys: ['accidents'],
    essential: ['accident_count', 'accident_lost_days'],
  },
];

const presetById = new Map(MODULE_KPI_PRESETS.map((preset) => [preset.id, preset]));
const domainByModule = new Map(MODULE_KPI_DOMAINS.flatMap((domain) => domain.modules.map((module) => [module, domain])));

export const ESSENTIAL_PRESET_IDS = MODULE_KPI_DOMAINS.flatMap((domain) => domain.essential);

export function domainOfPreset(preset) {
  return domainByModule.get(preset.module) || null;
}

export function isEssential(presetId) {
  return ESSENTIAL_PRESET_IDS.includes(presetId);
}

export function getEssentialPresets() {
  return ESSENTIAL_PRESET_IDS.map((id) => presetById.get(id)).filter(Boolean);
}

// Dossier des KPI créés depuis la vue « Indicateurs des modules » : ils y sont rangés plutôt que de se mélanger aux
// KPI saisis à la main dans la racine de la page KPI.
export const MODULE_KPI_FOLDER_NAME = 'Indicateurs des modules';
