// Migration ponctuelle : convertit procedure_versions.content de l'ancien format (triade
// objet/domaine_application/responsabilites en champs séparés + sections en section.content à
// plat OU section.subsections riche) vers le modèle à blocs unique (voir le plan de refonte de
// la mise en page des procédures : content = { sections: [{key,label,blocks}], documents_associes }).
//
// Idempotent : une ligne dont la première section porte déjà un tableau "blocks" est laissée
// intacte (voir alreadyMigrated ci-dessous) — relancer ce script ne double jamais le travail.
// --dry-run : n'écrit rien, affiche seulement ce qui serait migré.
//
// À exécuter dans le MÊME déploiement que le nouveau renderer (services/procedureWord.js,
// procedurePdf.js) — jamais l'un sans l'autre, sous peine de laisser des lignes dans un format
// qu'aucun des deux renderers ne sait plus lire.
//
// Usage : node scripts/migrate-procedure-content-to-blocks.mjs [--dry-run]

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { supabase } = await import('../src/services/supabase.js');

const DRY_RUN = process.argv.includes('--dry-run');
const PAGE_SIZE = 200;

function makeBlockId() {
  return randomUUID();
}

// Même règle que lib/procedureBlocks.js#textToParagraphBlocks (partagé avec les routes IA) : un
// bloc paragraphe par ligne non vide.
export function textToParagraphBlocks(text) {
  return (text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ type: 'paragraphe', id: makeBlockId(), text: line }));
}

// Miroir de formatActions dans services/procedureFullDraftJob.js, appliqué ici à la forme déjà
// PERSISTÉE d'une action (action.text/action.sub_bullets), pas à la réponse brute de Groq.
function formatActionsLegacy(actions) {
  return (actions || [])
    .map((action, index) => {
      const subBullets = (action.sub_bullets || []).map((bullet) => `   - ${bullet}`).join('\n');
      const text = (action.text || '').replace(/^\s*\d+[.)]\s*/, '');
      return `${index + 1}. ${text}${subBullets ? `\n${subBullets}` : ''}`;
    })
    .join('\n');
}

// Miroir de subsectionToBlocks dans services/procedureFullDraftJob.js, appliqué ici à une
// sous-section déjà persistée (title/intro/actions/callout/photo_placeholders/generation_status)
// plutôt qu'à la réponse brute de generateProcedureSubsectionContent.
function subsectionToBlocksLegacy(subsection) {
  const blocks = [{ type: 'sous_titre', id: makeBlockId(), text: subsection.title || '' }];
  if (subsection.generation_status === 'failed') {
    blocks.push({
      type: 'paragraphe',
      id: makeBlockId(),
      text: 'À compléter manuellement — la génération automatique de cette sous-section a échoué.',
    });
    return blocks;
  }
  if (subsection.intro) blocks.push({ type: 'paragraphe', id: makeBlockId(), text: subsection.intro });
  const actionsText = formatActionsLegacy(subsection.actions);
  if (actionsText) blocks.push({ type: 'paragraphe', id: makeBlockId(), text: actionsText });
  if (subsection.callout?.text) blocks.push({ type: 'encadre', id: makeBlockId(), text: subsection.callout.text });
  (subsection.photo_placeholders || []).forEach((caption) => {
    blocks.push({ type: 'photo_placeholder', id: makeBlockId(), caption });
  });
  return blocks;
}

// section (ancien format) -> blocks : subsections riche aplatie, sinon content à plat découpé
// en paragraphes — même comportement que l'ancien flatSectionBodyParagraphs de procedureWord.js
// (avant sa réécriture) pour ce dernier cas.
function sectionToBlocks(section) {
  if (section.subsections?.length) {
    return section.subsections.flatMap(subsectionToBlocksLegacy);
  }
  return textToParagraphBlocks(section.content);
}

// content (ancien format) -> content (modèle à blocs) : la triade objet/domaine_application/
// responsabilites devient 3 sections ordinaires en tête (seulement si renseignée — jamais une
// section vide ajoutée pour un champ qui ne l'était pas), suivies des sections existantes.
export function convertContent(content) {
  const sections = [];
  if (content?.objet) {
    sections.push({ key: 'objet', label: 'Objectifs de la procédure', blocks: textToParagraphBlocks(content.objet) });
  }
  if (content?.domaine_application) {
    sections.push({ key: 'domaine_application', label: "Champ d'application", blocks: textToParagraphBlocks(content.domaine_application) });
  }
  if (content?.responsabilites) {
    sections.push({ key: 'responsabilites', label: 'Responsabilités', blocks: textToParagraphBlocks(content.responsabilites) });
  }
  (content?.sections || []).forEach((section) => {
    sections.push({ key: section.key, label: section.label, blocks: sectionToBlocks(section) });
  });
  return { sections, documents_associes: content?.documents_associes || [] };
}

export function alreadyMigrated(content) {
  return Array.isArray(content?.sections) && content.sections.length > 0 && Array.isArray(content.sections[0].blocks);
}

export async function migrateProcedureContentToBlocks({ dryRun = false } = {}) {
  let migrated = 0;
  let skipped = 0;
  let page = 0;

  for (;;) {
    const { data: rows, error } = await supabase
      .from('procedure_versions')
      .select('id, content')
      .order('id', { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (error) throw new Error(`Erreur de lecture de procedure_versions : ${error.message}`);
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      if (alreadyMigrated(row.content)) {
        skipped += 1;
        continue;
      }
      const nextContent = convertContent(row.content);
      migrated += 1;
      if (!dryRun) {
        const { error: updateError } = await supabase.from('procedure_versions').update({ content: nextContent }).eq('id', row.id);
        if (updateError) throw new Error(`Échec de mise à jour de la version ${row.id} : ${updateError.message}`);
      }
    }

    if (rows.length < PAGE_SIZE) break;
    page += 1;
  }

  return { migrated, skipped };
}

// Comparaison par chemin de fichier plutôt que par URL brute : le chemin de ce projet contient
// un espace ("QMS SaaS"), encodé en %20 dans import.meta.url mais pas dans process.argv[1] — une
// comparaison directe des deux chaînes échouait silencieusement (exécution en tant que module
// importé, jamais en CLI).
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  console.log(DRY_RUN ? '🔍 Dry-run : aucune écriture ne sera effectuée.' : '✏️  Migration réelle : les lignes seront mises à jour.');
  const { migrated, skipped } = await migrateProcedureContentToBlocks({ dryRun: DRY_RUN });
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}${migrated} version(s) migrée(s), ${skipped} déjà à jour (ignorée(s)).`);
  process.exit(0);
}
