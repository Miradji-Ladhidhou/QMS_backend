// 4 points de départ prêts à l'emploi pour le gabarit de procédures d'un tenant — données de
// référence statiques (pas de tenant_id, pas de table dédiée : même logique que les autres
// catalogues fixes de l'app — statuts, niveaux... — plutôt qu'introduire un premier précédent
// de table "globale" dans un schéma autrement 100% multi-tenant, et sans mécanisme de seed
// existant nulle part ailleurs à réutiliser).
//
// Chaque preset ne liste QUE les sections qui n'existent PAS déjà comme champ fixe de toute
// procédure (Objet, Domaine d'application, Responsabilités, Documents associés, Historique des
// versions sont TOUJOURS présents quel que soit le gabarit — voir ProcedureSectionsEditor.jsx
// et ProcedureDetail.jsx) : les sections correspondantes du preset d'origine sont donc
// volontairement omises ici plutôt que dupliquées avec le même intitulé.
//
// numero : conservé tel que fourni dans le preset d'origine, à titre indicatif seulement pour
// l'instant — la numérotation réellement appliquée (à l'écran comme dans l'export PDF, voir
// procedurePdf.js) reste purement séquentielle (4.1, 4.2...), aucune UI ne lit encore ce champ.
//
// fixedInstructions : ajoutée au prompt IA (voir services/groq.js) comme consigne de style
// supplémentaire pour la génération de brouillon et la vérification de conformité.
//
// renderStyle : stocké tel quel pour un usage futur — l'export PDF garde aujourd'hui son rendu
// fixe (DejaVu Sans, navy/rouge/ambre) quel que soit le preset choisi ; voir procedurePdf.js.
export const PROCEDURE_TEMPLATE_PRESETS = [
  {
    id: 'mtl-logistique',
    name: 'Logistique / Industrie',
    description:
      "Style formel avec sommaire à puces, numérotation 4.1/4.2, sous-points 'o', encadrés 'Important :'. Adapté aux entreprises industrielles et logistiques avec exigences de traçabilité fortes.",
    sections: [
      { key: 'definitions_abreviations', label: 'Définitions et abréviations', numero: '3' },
      { key: 'processus', label: 'Processus (sous-sections numérotées)', numero: '5.x' },
      { key: 'indicateurs_performance_suivi', label: 'Indicateurs de performance et suivi', numero: '6' },
    ],
    fixedInstructions:
      "En-tête : 'PROCEDURE DU SYSTEME DE GESTION DE LA QUALITE' (QUALITE sans accent). Sommaire en puces (•), jamais de numérotation. Titres de sections processus en gras, jamais de bandeau gris. Listes numérotées 1./2./3. avec sous-points 'o' (jamais de tirets). Toute consigne impérative encadrée dans un paragraphe 'Important :' en gras sur fond gris clair. Historique des versions en tableau en fin de document.",
    renderStyle: { fontFamily: 'Times New Roman', accentColor: '#000000', boxBackground: '#EDEDED', boxBorder: '#000000' },
  },
  {
    id: 'iso-generique',
    name: 'ISO 9001 générique',
    description:
      "Style formel, sobre, noir et blanc, structure calquée sur les clauses ISO 9001. Adapté aux entreprises manufacturières ou souhaitant un rendu 'audit-ready' universel.",
    sections: [
      { key: 'references_documents_applicables', label: 'Références et documents applicables', numero: '2' },
      { key: 'termes_definitions', label: 'Termes et définitions', numero: '3' },
      { key: 'description_processus', label: 'Description du processus (sous-clauses)', numero: '5.x' },
    ],
    fixedInstructions:
      "En-tête sobre : 'PROCÉDURE QUALITÉ'. Police serif. Numérotation décimale classique (1., 1.1, 1.2), sans sous-points en 'o'. Puces avec tiret '-' pour les listes non séquentielles. Encadrés 'Note :' ou 'Attention :' en simple bordure noire, jamais de fond coloré. Aucune couleur d'accent — rendu strictement noir et blanc.",
    renderStyle: { fontFamily: 'Times New Roman', accentColor: '#000000', boxBackground: '#FFFFFF', boxBorder: '#000000' },
  },
  {
    id: 'moderne-tertiaire',
    name: 'Moderne / Tertiaire',
    description:
      "Style contemporain avec bannière de titre colorée, titres de section à bordure gauche colorée, encadrés 'À retenir'. Adapté aux entreprises de services, RH, tech, admin.",
    sections: [{ key: 'deroule_processus', label: 'Déroulé du processus (sous-sections)', numero: '4.x' }],
    fixedInstructions:
      "Bannière de titre en bloc coloré (fond bleu #2C5F8A, texte blanc). Police sans-serif. Titres de section avec bordure gauche colorée, pas de fond gris. Encadrés de conseil intitulés 'À retenir' sur fond bleu clair (#EAF2FA) avec bordure gauche épaisse colorée. Tableaux avec en-tête coloré (fond bleu, texte blanc) et lignes alternées légèrement teintées. Listes numérotées simples, sans sous-points.",
    renderStyle: { fontFamily: 'Calibri', accentColor: '#2C5F8A', boxBackground: '#EAF2FA', boxBorder: '#2C5F8A' },
  },
  {
    id: 'industriel-securite',
    name: 'Industriel / Sécurité terrain',
    description:
      "Style à fort contraste visuel, texte plus grand, encadrés DANGER/ATTENTION en couleur, emplacements pour pictogrammes de sécurité. Adapté aux procédures de sécurité en production, maintenance, ateliers.",
    sections: [
      { key: 'equipements_necessaires', label: 'Équipements nécessaires', numero: '3' },
      { key: 'deroule', label: 'Déroulé (sous-sections)', numero: '4.x' },
      { key: 'conduite_anomalie', label: "Conduite à tenir en cas d'anomalie", numero: '5' },
    ],
    fixedInstructions:
      "Bannière de titre sur fond noir avec accent orange sécurité (#F2A900). Police sans-serif, taille de corps légèrement augmentée pour lisibilité terrain. Encadré 'DANGER' obligatoire en tête de document si un risque grave existe, fond rouge clair (#FDEBEA), bordure rouge épaisse (#B00000). Encadré 'ATTENTION' pour les risques secondaires, fond orange clair (#FFF3E3), bordure orange (#C1610B). Titres de section sur bandeau gris clair. Emplacements réservés aux pictogrammes de sécurité en encadré pointillé.",
    renderStyle: { fontFamily: 'Arial', accentColor: '#F2A900', boxBackground: '#FDEBEA', boxBorder: '#B00000' },
  },
];

export function findProcedureTemplatePreset(id) {
  return PROCEDURE_TEMPLATE_PRESETS.find((preset) => preset.id === id) || null;
}
