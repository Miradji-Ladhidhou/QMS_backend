import { randomUUID } from 'crypto';

// Utilitaires partagés autour du modèle de contenu à blocs des procédures (voir le plan de
// refonte : une section = { key, label, blocks: [...] }, chaque bloc { type, id, ... } parmi
// paragraphe/liste_puces/tableau/encadre/sous_titre/photo_placeholder — voir
// services/procedureWord.js#blocksToDocxParagraphs et services/procedurePdf.js#drawBlocks pour
// les deux rendus). Utilisé à la fois par les routes (conversion des réponses IA "un coup" en
// blocs) et par le script de migration (backend/scripts/migrate-procedure-content-to-blocks.mjs).

export function makeBlockId() {
  return randomUUID();
}

// Convertit un texte à plat (réponse IA "un coup" — generateProcedureDraft/
// generateProcedureDraftFromQqoqccp — ou ancien contenu de section avant la refonte à blocs) en
// blocs paragraphe : un bloc par ligne non vide, pour rester éditable finement dans l'éditeur
// manuel (voir frontend/src/components/ProcedureSectionsEditor.jsx) plutôt qu'un unique bloc
// portant tout le texte avec des \n internes.
export function textToParagraphBlocks(text) {
  return (text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ type: 'paragraphe', id: makeBlockId(), text: line }));
}

// draft : { sections: [{key,label,content}], documents_associes } — la forme renvoyée par
// generateProcedureDraft/generateProcedureDraftFromQqoqccp (un seul appel Groq, contenu à plat
// par section). Convertit en { sections: [{key,label,blocks}], documents_associes }, la forme
// canonique persistée dans procedure_versions.content (voir le plan de refonte).
export function draftToBlockContent(draft) {
  return {
    sections: (draft?.sections || []).map((s) => ({ key: s.key, label: s.label, blocks: textToParagraphBlocks(s.content) })),
    documents_associes: draft?.documents_associes || [],
  };
}

// Représentation texte d'un bloc — utilisée pour construire les prompts IA (comparaison de
// versions, fiche de diffusion, vérification de conformité, correction ciblée) qui doivent
// "lire" une section sans connaître le modèle à blocs. Pas destinée à l'affichage écran ni à
// l'export (voir plutôt procedureWord.js/procedurePdf.js/ProcedureContentView.jsx pour ça).
function blockToPlainText(block) {
  switch (block.type) {
    case 'sous_titre':
      return block.text || '';
    case 'liste_puces':
      return (block.items || []).map((item) => `- ${item}`).join('\n');
    case 'tableau': {
      const header = (block.headers || []).join(' | ');
      const rows = (block.rows || []).map((row) => row.join(' | '));
      return [header, ...rows].filter(Boolean).join('\n');
    }
    case 'encadre':
      return `Point d'attention : ${block.text || ''}`;
    case 'photo_placeholder':
      return `[ Emplacement réservé à une photo : ${block.caption || ''} ]`;
    case 'paragraphe':
    default:
      return block.text || '';
  }
}

export function blocksToPlainText(blocks) {
  return (blocks || []).map(blockToPlainText).filter(Boolean).join('\n\n');
}
