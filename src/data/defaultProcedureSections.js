// Structure de sections par défaut pour un tenant qui n'a encore jamais enregistré de gabarit
// (voir GET /api/procedure-templates et GET/POST /api/procedures#fetchTenantTemplate) —
// dédupliquée : avant ce fichier, la même liste (jusqu'ici réduite à une seule section
// "Étapes du processus") existait en deux copies littérales indépendantes
// (routes/procedureTemplates.js et routes/procedures.js), à maintenir en synchronisation
// manuelle. N'est JAMAIS écrite en base tant que le tenant n'a pas explicitement enregistré
// (PUT /api/procedure-templates) — un simple repli en mémoire.
//
// 7 sections listées dans la refonte de mise en page (objet/domaine d'application/
// responsabilités désormais des sections ordinaires, plus des sections dynamiques — voir
// services/procedureWord.js), mais seulement 6 entrées ici : "Historique des modifications"
// n'est volontairement PAS une section éditable de plus — le renderer Word ajoute déjà, de
// façon automatique et inconditionnelle, un vrai tableau d'historique des versions en fin de
// document (les données viennent de procedure_versions, pas d'un texte rédigé) ; en faire
// aussi une section vide dans cette liste créerait un doublon confus (une section "Historique"
// à rédiger à la main À CÔTÉ du vrai tableau généré). Le tenant peut librement ajouter sa
// propre 7e section si besoin (voir Paramètres > Procédures) — ce repli reste un point de
// départ, jamais une structure imposée.
export const DEFAULT_PROCEDURE_SECTIONS = [
  { key: 'objet', label: 'Objectifs de la procédure' },
  { key: 'domaine_application', label: "Champ d'application" },
  { key: 'responsabilites', label: 'Responsabilités' },
  { key: 'processus', label: 'Processus' },
  { key: 'controles_indicateurs', label: 'Contrôles et indicateurs' },
  { key: 'annexes', label: 'Annexes' },
];
