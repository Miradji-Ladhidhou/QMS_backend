// Les groupes d'une variante sont tous requis ; leurs synonymes sont interchangeables.
export const PROBLEM_CONCEPTS = [
  {
    id: 'expiry',
    variants: [
      [['produit', 'article', 'lot', 'aliment', 'marchandise'], ['périmé', 'périmée', 'périmés', 'périmées', 'expiré', 'expirée', 'expirés', 'expirées']],
      [['dlc', 'dluo', 'ddm', 'péremption'], ['dépassée', 'dépassé', 'dépassées', 'dépassés', 'expirée', 'expiré']],
      [['date limite de consommation'], ['dépassée', 'dépassé']],
      [['date de péremption'], ['dépassée', 'dépassé']],
    ],
    modules: [
      { id: 'nonconforming-outputs', score: 120, stage: 'Signaler', description: 'Enregistrez le produit ou le lot dont la date est dépassée comme non-conformité.' },
      { id: 'risks', score: 70, stage: 'Évaluer', description: 'Évaluez les risques associés à ce produit et suivez leur traitement.' },
      { id: 'qqoqccp', score: 60, stage: 'Analyser', description: 'Précisez les faits : produit, lot, dates et circonstances de découverte.' },
      { id: 'haccp', score: 90, requires: ['dlc', 'dluo', 'ddm', 'aliment', 'alimentaire', 'consommation'], stage: 'Maîtriser', description: 'Vérifiez les éléments de maîtrise sanitaire associés au produit alimentaire.' },
    ],
  },
  {
    id: 'customer-complaint',
    variants: [
      [['réclamation', 'réclamations', 'reclamation', 'reclamtion', 'plainte', 'plaintes']],
      [['client', 'clients', 'cliente', 'clientèle'], ['mécontent', 'mécontents', 'mécontente', 'insatisfait', 'insatisfaits', 'insatisfaite', 'pas satisfait', 'pas contents', 'se plaint', 'se plaignent']],
    ],
    modules: [
      { id: 'complaints', score: 120, stage: 'Signaler', description: 'Enregistrez et traitez la réclamation ou le mécontentement du client.' },
      { id: 'customer-satisfaction', score: 85, stage: 'Suivre' },
      { id: 'qqoqccp', score: 70, stage: 'Analyser' },
      { id: 'capas', score: 60, stage: 'Corriger', description: 'Si une action corrective est nécessaire, définissez-la et suivez son efficacité.' },
    ],
  },
  {
    id: 'preparation-error',
    variants: [
      [['erreur', 'erreurs', 'errreur', 'oubli', 'oublis', 'mauvais', 'mauvaise', 'incorrect', 'incorrecte'], ['préparation', 'préparations', 'preparaton', 'commande', 'commandes', 'picking', 'colis']],
      [['inversion', 'inversions'], ['produit', 'produits', 'colis', 'commande']],
    ],
    modules: [
      { id: 'nonconforming-outputs', score: 120, stage: 'Signaler' },
      { id: 'qqoqccp', score: 85, stage: 'Analyser', description: 'Structurez les faits pour comprendre où et comment l’erreur de préparation s’est produite.' },
      { id: 'capas', score: 75, stage: 'Corriger', description: 'Si une correction durable est nécessaire, préparez et suivez une CAPA.' },
    ],
  },
  {
    id: 'nonconformity',
    variants: [
      [['non conforme', 'non conformes', 'non conformité', 'non conformités', 'nonconformité', 'nonconformités']],
      [['défectueux', 'défectueuse', 'défectueuses', 'defectueu', 'abîmé', 'abîmés', 'abîmée', 'endommagé', 'endommagés', 'cassé', 'cassés']],
    ],
    modules: [
      { id: 'nonconforming-outputs', score: 120, stage: 'Signaler' },
      { id: 'qqoqccp', score: 70, stage: 'Analyser' },
      { id: 'capas', score: 60, stage: 'Corriger', description: 'Si une action corrective est nécessaire, créez une CAPA et vérifiez son efficacité.' },
    ],
  },
  {
    id: 'delivery-delay',
    variants: [
      [['retard', 'retards', 'tardive', 'en retard'], ['livraison', 'livraisons', 'livré', 'livrés', 'expédition', 'expéditions', 'commande', 'commandes']],
      [['délai', 'délais'], ['non respecté', 'non respectés', 'dépassé', 'dépassés']],
    ],
    modules: [
      { id: 'nonconforming-outputs', score: 100, stage: 'Signaler', description: 'Consignez la non-conformité de livraison ou de service.' },
      { id: 'planning', score: 80, stage: 'Planifier' },
      { id: 'suppliers', score: 65, stage: 'Évaluer' },
      { id: 'qqoqccp', score: 65, stage: 'Analyser' },
    ],
  },
  {
    id: 'recurrence',
    variants: [
      [['récurrent', 'récurrents', 'récurrente', 'répétitif', 'répétitifs', 'répétée', 'répétées', 'se répète', 'se reproduit', 'toujours la même', 'à chaque fois']],
    ],
    modules: [
      { id: 'capas', score: 110, stage: 'Corriger' },
      { id: 'nonconforming-outputs', score: 85, stage: 'Signaler' },
      { id: 'qqoqccp', score: 85, stage: 'Analyser' },
      { id: 'kpis', score: 80, stage: 'Suivre' },
    ],
  },
  {
    id: 'training',
    variants: [
      [['formation', 'formations', 'former', 'formé', 'formée', 'formés', 'formées']],
      [['ne maîtrise pas', 'ne maîtrisent pas', 'ne sait pas', 'ne savent pas', 'manque de compétence', 'manque de compétences', 'pas formé', 'pas formés']],
    ],
    modules: [
      { id: 'trainings', score: 120, stage: 'Former' },
      { id: 'employees', score: 75, stage: 'Suivre' },
      { id: 'procedures', score: 85, requires: ['procédure', 'procédures', 'instruction', 'mode opératoire'], stage: 'Consulter' },
    ],
  },
  {
    id: 'procedure-breach',
    variants: [
      [['procédure', 'procédures', 'instruction', 'instructions', 'consigne', 'consignes'], ['non respectée', 'non respectées', 'pas respectée', 'pas respectées', 'pas suivie', 'non suivie', 'pas appliquée', 'non appliquée']],
    ],
    modules: [
      { id: 'nonconforming-outputs', score: 110, stage: 'Signaler' },
      { id: 'procedures', score: 100, stage: 'Consulter' },
      { id: 'capas', score: 70, stage: 'Corriger' },
    ],
  },
  {
    id: 'supplier',
    variants: [[['fournisseur', 'fournisseurs', 'fourniseur', 'prestataire', 'prestataires', 'sous traitant']]],
    modules: [{ id: 'suppliers', score: 110, stage: 'Évaluer' }],
  },
  {
    id: 'work-accident',
    variants: [[['accident', 'accidents', 'blessure', 'blessures', 'blessé', 'blessée', 'presque accident']]],
    modules: [
      { id: 'accidents', score: 120, stage: 'Signaler' },
      { id: 'risks', score: 85, stage: 'Évaluer' },
    ],
  },
  {
    id: 'risk',
    variants: [[['risque', 'risques', 'danger', 'dangers', 'situation dangereuse']]],
    modules: [{ id: 'risks', score: 110, stage: 'Évaluer' }],
  },
  {
    id: 'food-safety',
    variants: [[['contamination', 'chaîne du froid', 'rupture du froid', 'hygiène alimentaire', 'sécurité alimentaire', 'allergène', 'allergènes', 'haccp']]],
    modules: [
      { id: 'haccp', score: 110, stage: 'Maîtriser' },
      { id: 'nonconforming-outputs', score: 80, stage: 'Signaler' },
      { id: 'risks', score: 70, stage: 'Évaluer' },
    ],
  },
  {
    id: 'corrective-action',
    variants: [[['action corrective', 'actions correctives', 'action préventive', 'actions préventives', 'capa', 'corriger durablement']]],
    modules: [{ id: 'capas', score: 120, stage: 'Corriger' }, { id: 'planning', score: 70, stage: 'Planifier' }],
  },
];
