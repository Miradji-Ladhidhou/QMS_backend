import { PROBLEM_CONCEPTS } from './problemConcepts.js';

export const PROBLEM_GUIDE_MODULES = [
  {
    id: 'complaints',
    label: 'Réclamations',
    path: '/complaints',
    description: 'Enregistrez et traitez une réclamation client.',
    keywords: [
      ['réclamation', 110], ['réclamations', 110], ['plainte client', 105],
      ['client mécontent', 105], ['client est mécontent', 105], ['client insatisfait', 100],
      ['insatisfaction client', 100],
      ['retour client', 90], ['mécontentement', 85],
    ],
  },
  {
    id: 'customer-satisfaction',
    label: 'Satisfaction client',
    path: '/customer-satisfaction',
    description: 'Suivez les retours et le niveau de satisfaction de vos clients.',
    keywords: [
      ['satisfaction client', 110], ['client mécontent', 90], ['client est mécontent', 90],
      ['client insatisfait', 90],
      ['avis client', 90], ['enquête client', 85], ['retour client', 70],
      ['réclamation client', 80], ['réclamation', 80], ['insatisfaction', 75],
    ],
  },
  {
    id: 'nonconforming-outputs',
    label: 'Non-conformités produit/service',
    path: '/nonconforming-outputs',
    description: 'Enregistrez un produit, un service ou une opération non conforme.',
    keywords: [
      ['non conformité', 110], ['non conforme', 110], ['défectueux', 100],
      ['défectueuse', 100], ['produit abîmé', 100], ['erreur de préparation', 105],
      ['erreur pendant la préparation', 105], ['erreur', 55], ['défaut produit', 95],
      ['problème qualité', 70],
    ],
  },
  {
    id: 'capas',
    label: 'CAPA',
    path: '/capas',
    description: 'Définissez, attribuez et suivez une action corrective ou préventive.',
    keywords: [
      ['capa', 115], ['action corrective', 110], ['action préventive', 105],
      ['problème récurrent', 100], ['récurrent', 75], ['répétitif', 85],
      ['se répète', 80], ['éviter que cela se reproduise', 100], ['cause racine', 90],
      ['corriger durablement', 95], ['réclamation', 60], ['non conformité', 50],
      ['erreur de préparation', 60], ['erreur pendant la préparation', 60],
    ],
  },
  {
    id: 'qqoqccp',
    label: 'QQOQCCP',
    path: '/qqoqccp',
    description: 'Structurez les faits et décrivez précisément la situation à analyser.',
    keywords: [
      ['qqoqccp', 115], ['analyser le problème', 90], ['analyse du problème', 90],
      ['comprendre le problème', 80], ['décrire les faits', 85], ['clarifier les faits', 85],
      ['problème récurrent', 55], ['erreur de préparation', 60],
      ['erreur pendant la préparation', 60], ['non conformité', 50], ['réclamation', 70],
    ],
  },
  {
    id: 'suppliers',
    label: 'Évaluation fournisseurs',
    path: '/suppliers',
    description: 'Consultez et évaluez les performances de vos fournisseurs.',
    keywords: [
      ['fournisseur', 110], ['fournisseurs', 110], ['prestataire', 90],
      ['produit reçu', 75], ['produits reçus', 75], ['livraison fournisseur', 100],
      ['retard de livraison', 65], ['retards de livraison', 65],
    ],
  },
  {
    id: 'accidents',
    label: 'Accidents du travail',
    path: '/accidents',
    description: 'Déclarez et suivez un accident ou un incident au travail.',
    keywords: [
      ['accident', 115], ['blessure', 105], ['incident de travail', 110],
      ['accident du travail', 120], ['presque accident', 100], ['salarié blessé', 110],
    ],
  },
  {
    id: 'risks',
    label: 'Registre des risques',
    path: '/risks',
    description: 'Évaluez un risque identifié et suivez son traitement.',
    keywords: [
      ['risque', 110], ['risques', 110], ['danger', 95], ['risque identifié', 120],
      ['situation dangereuse', 105], ['prévenir un risque', 100],
    ],
  },
  {
    id: 'trainings',
    label: 'Formations',
    path: '/trainings',
    description: 'Planifiez et suivez les formations et compétences requises.',
    keywords: [
      ['formation', 110], ['former', 95], ['besoin de formation', 115],
      ['besoin de former', 105], ['compétence', 90], ['compétences', 90],
      ['formé', 100], ['formée', 100], ['ne maîtrise pas', 95], ['ne maîtrisent pas', 95],
      ['manque de compétence', 100],
    ],
  },
  {
    id: 'employees',
    label: 'Personnel',
    path: '/employees',
    description: 'Consultez les informations et compétences du personnel.',
    keywords: [
      ['personnel', 85], ['salarié', 80], ['salariés', 80], ['employé', 80],
      ['employés', 80], ['collaborateur', 75], ['collaborateurs', 75],
    ],
  },
  {
    id: 'procedures',
    label: 'Procédures',
    path: '/procedures',
    description: 'Consultez et gérez les procédures applicables.',
    keywords: [
      ['procédure', 110], ['procédures', 110], ['mode opératoire', 100],
      ['instruction de travail', 100], ['procédure non respectée', 120],
      ['non respect de la procédure', 120], ['respecter la procédure', 100],
    ],
  },
  {
    id: 'documents',
    label: 'Documents',
    path: '/documents',
    description: 'Retrouvez les documents et enregistrements associés à votre activité.',
    keywords: [
      ['document qualité', 85], ['documents qualité', 85], ['enregistrement', 70],
      ['document associé', 70],
    ],
  },
  {
    id: 'planning',
    label: 'Planning',
    path: '/planning',
    description: 'Planifiez les tâches et échéances liées au traitement du problème.',
    keywords: [
      ['planifier', 100], ['planning', 100], ['échéance', 85], ['plan d’action', 95],
      ['plan d action', 95], ['suivre les actions', 90], ['action à réaliser', 90],
      ['retard de livraison', 60], ['retards de livraison', 60],
    ],
  },
  {
    id: 'kpis',
    label: 'KPIs',
    path: '/kpis',
    description: 'Suivez les indicateurs et l’évolution du problème dans le temps.',
    keywords: [
      ['indicateur', 100], ['kpi', 100], ['évolution', 90], ['tendance', 90],
      ['beaucoup de', 60], ['fréquence', 85], ['problème récurrent', 65],
      ['retards de livraison', 55], ['erreurs répétées', 85],
    ],
  },
  {
    id: 'pdca',
    label: 'PDCA',
    path: '/pdca',
    description: 'Organisez une démarche d’amélioration continue et suivez ses étapes.',
    keywords: [
      ['amélioration continue', 105], ['démarche d’amélioration', 100],
      ['cycle pdca', 110], ['pdca', 110],
    ],
  },
  {
    id: 'audits',
    label: 'Audits internes',
    path: '/audits',
    description: 'Vérifiez la conformité des pratiques au cours d’un audit interne.',
    keywords: [
      ['audit interne', 110], ['auditer', 90], ['vérifier la conformité', 85],
      ['écart d’audit', 100], ['écart audit', 100],
    ],
  },
  {
    id: 'haccp',
    label: 'HACCP',
    path: '/haccp',
    description: 'Consignez et suivez les éléments de maîtrise sanitaire HACCP.',
    keywords: [
      ['haccp', 115], ['hygiène alimentaire', 110], ['sécurité alimentaire', 110],
      ['contamination alimentaire', 110], ['chaîne du froid', 100],
    ],
  },
];

export function normalizeProblemQuery(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr')
    .replace(/[’']/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const STOP_WORDS = new Set('le la les un une des de du d au aux a et est sont en pendant lors notre nos mon mes ce cet cette ces nous on qui que avec pour dans'.split(' '));
export const LOCAL_RELEVANCE_THRESHOLD = 90;
export const MIN_RECOMMENDATION_SCORE = 50;

function wordsOf(value) {
  return normalizeProblemQuery(value).split(' ').filter((word) => word && !STOP_WORDS.has(word));
}

function isOneEditAway(left, right) {
  if (Math.abs(left.length - right.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (left.length >= right.length) i++;
    if (right.length >= left.length) j++;
  }
  return edits + (i < left.length || j < right.length ? 1 : 0) <= 1;
}

function wordMatch(word, expected) {
  if (word === expected) return 1;
  if (['risque', 'risques', 'danger', 'dangers'].includes(expected)) return 0;
  if (expected.length >= 5 && word.length >= 5 && isOneEditAway(word, expected)) return 0.9;
  return 0;
}

function phraseMatch(words, phrase) {
  const expected = wordsOf(phrase);
  if (!expected.length) return 0;
  let best = 0;
  for (let start = 0; start <= words.length - expected.length; start++) {
    let quality = 1;
    for (let index = 0; index < expected.length; index++) {
      quality = Math.min(quality, wordMatch(words[start + index], expected[index]));
    }
    best = Math.max(best, quality);
  }
  return best;
}

export function getAvailableProblemModules({ appModules, visibleMenuKeys } = {}) {
  if (!Array.isArray(visibleMenuKeys)) return [];
  return PROBLEM_GUIDE_MODULES.filter((module) =>
    appModules?.[module.id] !== false && visibleMenuKeys.includes(module.id));
}

export function getProblemRecommendations(query, access = {}) {
  const words = wordsOf(query || '');
  if (!words.length) return [];
  const available = getAvailableProblemModules(access);
  const scores = new Map(available.map((module) => [module.id, {
    ...module,
    score: Math.max(0, ...module.keywords.map(([keyword, weight]) => Math.round(phraseMatch(words, keyword) * weight))),
  }]));
  for (const concept of PROBLEM_CONCEPTS) {
    const quality = Math.max(...concept.variants.map((groups) =>
      Math.min(...groups.map((synonyms) => Math.max(...synonyms.map((phrase) => phraseMatch(words, phrase)))))));
    if (!quality) continue;
    for (const association of concept.modules) {
      const module = scores.get(association.id);
      if (!module || (association.requires && !association.requires.some((phrase) => phraseMatch(words, phrase)))) continue;
      const score = Math.round(association.score * quality);
      if (score >= module.score) scores.set(module.id, {
        ...module, score, stage: association.stage,
        description: association.description || module.description,
      });
    }
  }
  return [...scores.values()].filter((module) => module.score >= MIN_RECOMMENDATION_SCORE).sort(compareRecommendations);
}

function compareRecommendations(left, right) {
  return right.score - left.score || left.label.localeCompare(right.label, 'fr');
}

export function needsProblemFallback(recommendations) {
  return !recommendations.some((module) => module.score >= LOCAL_RELEVANCE_THRESHOLD);
}

export function mergeProblemRecommendations(local, remote, access) {
  const available = new Map(getAvailableProblemModules(access).map((module) => [module.id, module]));
  const merged = new Map();
  for (const result of [...local, ...remote]) {
    const module = available.get(result?.id);
    if (!module || !Number.isFinite(result.score) || result.score < MIN_RECOMMENDATION_SCORE) continue;
    const score = Math.min(120, result.score);
    const previous = merged.get(module.id);
    if (!previous || score > previous.score) merged.set(module.id, {
      ...module, score,
      description: local.find((item) => item.id === module.id)?.description || module.description,
    });
  }
  return [...merged.values()].sort(compareRecommendations);
}

export function getRelevanceLabel(score) {
  if (score >= 100) return 'Très élevée';
  if (score >= 75) return 'Élevée';
  return 'Pertinente';
}
