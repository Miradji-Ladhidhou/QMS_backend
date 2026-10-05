const QUALITY_MANAGEMENT = {
  label: 'ISO 9001 — management de la qualité',
  url: 'https://www.iso.org/fr/iso-9001-quality-management.html',
  source: 'Organisation internationale de normalisation',
};

const RISK_ASSESSMENT = {
  label: 'Évaluation des risques professionnels',
  url: 'https://www.inrs.fr/demarche/evaluation-risques-professionnels/ce-qu-il-faut-retenir.html',
  source: 'INRS',
};

const ACCIDENT_ANALYSIS = {
  label: 'Analyser les accidents du travail et définir des actions de prévention',
  url: 'https://www.inrs.fr/demarche/analyse-accidents-travail/ce-qu-il-faut-retenir.html',
  source: 'INRS',
};

export const DEFAULT_RESOURCE_GROUPS = [
  {
    title: 'Audits et revues de direction',
    modules: ['audits', 'management-reviews'],
    description: 'Préparer les audits et faire le point sur le fonctionnement du système qualité.',
    resources: [
      {
        label: 'ISO 19011 — lignes directrices pour l’audit',
        url: 'https://www.iso.org/fr/standard/70017.html',
        source: 'Organisation internationale de normalisation',
      },
      QUALITY_MANAGEMENT,
    ],
  },
  {
    title: 'CAPA, PDCA et non-conformités',
    modules: ['capas', 'pdca', 'nonconforming-outputs'],
    description: 'Traiter les écarts, comprendre les causes et suivre les actions d’amélioration.',
    resources: [QUALITY_MANAGEMENT, ACCIDENT_ANALYSIS],
  },
  {
    title: 'QQOQCCP et résolution de problèmes',
    modules: ['qqoqccp'],
    description: 'Structurer les faits avant de choisir les actions à mener.',
    resources: [
      {
        label: 'QQOQCP et sa variante QQOQCCP — méthode et exemples',
        url: 'https://www.manager-go.com/gestion-de-projet/dossiers-methodes/qqoqcp',
        source: 'Manager GO! — guide pratique',
      },
      ACCIDENT_ANALYSIS,
    ],
  },
  {
    title: 'Gestion des risques',
    modules: ['risks'],
    description: 'Principes de management du risque et prévention des risques professionnels.',
    resources: [
      {
        label: 'ISO 31000 — management du risque',
        url: 'https://www.iso.org/fr/iso-31000-risk-management.html',
        source: 'Organisation internationale de normalisation',
      },
      RISK_ASSESSMENT,
    ],
  },
  {
    title: 'HACCP et hygiène alimentaire',
    modules: ['haccp'],
    description: 'Textes de référence pour la sécurité sanitaire des aliments.',
    resources: [
      {
        label: 'Codex — codes d’usage, dont les principes d’hygiène alimentaire (CXC 1-1969)',
        url: 'https://www.fao.org/fao-who-codexalimentarius/codex-texts/codes-of-practice/fr/',
        source: 'Codex Alimentarius — FAO/OMS',
      },
      {
        label: 'Règlement européen sur l’hygiène des denrées alimentaires',
        url: 'https://eur-lex.europa.eu/legal-content/FR/TXT/?uri=CELEX:32004R0852',
        source: 'EUR-Lex',
      },
    ],
  },
  {
    title: 'Documents, procédures et politique qualité',
    modules: ['documents', 'procedures', 'my-approvals'],
    description: 'Organiser les informations documentées, les versions et les validations du système qualité.',
    resources: [
      {
        label: 'ISO 10013 — recommandations pour les informations documentées',
        url: 'https://www.iso.org/fr/standard/75736.html',
        source: 'Organisation internationale de normalisation',
      },
      QUALITY_MANAGEMENT,
    ],
  },
  {
    title: 'Réclamations et satisfaction client',
    modules: ['complaints', 'customer-satisfaction'],
    description: 'Organiser le traitement des réclamations et mesurer la satisfaction des clients.',
    resources: [
      {
        label: 'ISO 10002 — traitement des réclamations',
        url: 'https://www.iso.org/fr/standard/71580.html',
        source: 'Organisation internationale de normalisation',
      },
      {
        label: 'ISO 10004 — surveillance et mesure de la satisfaction client',
        url: 'https://www.iso.org/fr/standard/71582.html',
        source: 'Organisation internationale de normalisation',
      },
    ],
  },
  {
    title: 'Tableau de bord et indicateurs',
    modules: ['dashboard', 'kpis'],
    description: 'Choisir des indicateurs pertinents et les relier à des objectifs mesurables.',
    resources: [
      {
        label: 'Comprendre et choisir ses KPI',
        url: 'https://www.manager-go.com/finance/glossaire/key-performance-indicator',
        source: 'Manager GO! — guide pratique',
      },
      {
        label: 'Définir des objectifs SMART',
        url: 'https://www.manager-go.com/management/dossiers-methodes/smart',
        source: 'Manager GO! — guide pratique',
      },
    ],
  },
  {
    title: 'Planning et tâches',
    modules: ['planning'],
    description: 'Planifier les activités, les échéances et les ressources nécessaires.',
    resources: [
      {
        label: 'Gestion de projet — étapes, planification et suivi',
        url: 'https://www.manager-go.com/gestion-de-projet',
        source: 'Manager GO! — guide pratique',
      },
      {
        label: 'ISO 10006 — management de la qualité dans les projets',
        url: 'https://www.iso.org/fr/standard/70376.html',
        source: 'Organisation internationale de normalisation',
      },
    ],
  },
  {
    title: 'Fournisseurs et achats',
    modules: ['suppliers'],
    description: 'Encadrer les achats et le suivi des fournisseurs dans une démarche qualité et responsable.',
    resources: [
      {
        label: 'ISO 20400 — achats responsables',
        url: 'https://www.iso.org/fr/standard/63026.html',
        source: 'Organisation internationale de normalisation',
      },
      QUALITY_MANAGEMENT,
    ],
  },
  {
    title: 'Formations et personnel',
    modules: ['trainings', 'employees'],
    description: 'Développer les compétences en prévention et protéger les données du personnel.',
    resources: [
      {
        label: 'Formations à la prévention des risques professionnels',
        url: 'https://www.inrs.fr/formation/themes.html',
        source: 'INRS',
      },
      {
        label: 'Gestion des ressources humaines et protection des données',
        url: 'https://www.cnil.fr/fr/la-gestion-des-ressources-humaines',
        source: 'CNIL',
      },
    ],
  },
  {
    title: 'Accidents du travail',
    modules: ['accidents'],
    description: 'Analyser les événements pour éviter leur répétition et améliorer la prévention.',
    resources: [ACCIDENT_ANALYSIS, RISK_ASSESSMENT],
  },
  {
    title: 'Services et organisation',
    modules: ['services'],
    description: 'Clarifier les responsabilités et coordonner les activités des équipes.',
    resources: [
      {
        label: 'Management — rôles, responsabilités et coordination',
        url: 'https://www.manager-go.com/management',
        source: 'Manager GO! — guide pratique',
      },
      QUALITY_MANAGEMENT,
    ],
  },
].map((group) => ({ ...group, id: group.modules[0] }));
