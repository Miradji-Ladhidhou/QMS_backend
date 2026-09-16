import { supabase } from './supabase.js';
import { generateProcedureFullPlan, generateProcedureSubsectionContent } from './groq.js';
import { makeBlockId } from '../lib/procedureBlocks.js';

// Mots-clés déclenchant un encadré "Point d'attention" — recherchés sur le TITRE de la
// sous-section (connu avant l'appel IA, donc décision déterministe et testable), jamais sur le
// contenu généré (qui n'existe pas encore au moment de construire le prompt). Décide UNIQUEMENT
// s'il faut émettre un bloc "encadre" — plus de sévérité pilotant son style (voir le modèle à
// blocs, un seul traitement visuel pour tout encadré, services/procedureWord.js).
const CALLOUT_KEYWORDS = ['sécurité', 'securite', 'traçabilité', 'tracabilite', 'contrôle', 'controle', 'anomalie'];

function wantsCallout(subsectionTitle) {
  const normalized = subsectionTitle.toLowerCase();
  return CALLOUT_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

// Le modèle préfixe parfois lui-même action.text par une numérotation ("1. Enregistrer...")
// malgré la consigne du prompt — on la retire avant d'appliquer la nôtre, pour éviter un
// double numérotage ("1. 1. Enregistrer...") observé lors des tests manuels contre l'API Groq
// réelle.
function stripLeadingNumbering(text) {
  return (text || '').replace(/^\s*\d+[.)]\s*/, '');
}

// Même principe que stripLeadingNumbering ci-dessus : malgré la consigne du prompt (voir
// PROCEDURE_SUBSECTION_RESPONSE_CONTRACT dans groq.js), le modèle glisse parfois du Markdown
// (**gras**) dans intro/actions.text — jamais interprété par Word, ça apparaîtrait tel quel
// (astérisques compris).
function stripMarkdownArtifacts(text) {
  return (text || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s+/, '');
}

function formatActions(actions) {
  return (actions || [])
    .map((action, index) => {
      const subBullets = (action.sub_bullets || []).map((bullet) => `   - ${stripMarkdownArtifacts(bullet)}`).join('\n');
      return `${index + 1}. ${stripMarkdownArtifacts(stripLeadingNumbering(action.text))}${subBullets ? `\n${subBullets}` : ''}`;
    })
    .join('\n');
}

// Convertit une sous-section générée (intro/actions/callout/photo_placeholders, voir
// PROCEDURE_SUBSECTION_RESPONSE_CONTRACT dans groq.js) en blocs du modèle canonique — LA seule
// représentation persistée désormais (voir le plan de refonte : avant ce chantier, cette même
// sous-section produisait EN PLUS un texte à plat concurrent, ignoré par l'éditeur manuel mais
// préféré par tous les exports, la vraie cause du bug "correction manuelle ignorée"). Pas de
// 5e type "liste numérotée" : les actions numérotées + sub_bullets restent un texte "1. ...\n2.
// ..." dans un bloc paragraphe, hors périmètre du prompt.
function subsectionToBlocks(subsectionTitle, { intro, actions, callout, photo_placeholders: photoPlaceholders }) {
  const blocks = [{ type: 'sous_titre', id: makeBlockId(), text: subsectionTitle }];
  if (intro) blocks.push({ type: 'paragraphe', id: makeBlockId(), text: stripMarkdownArtifacts(intro) });
  const actionsText = formatActions(actions);
  if (actionsText) blocks.push({ type: 'paragraphe', id: makeBlockId(), text: actionsText });
  // callout.severity (info/warning/danger) n'est conservé nulle part : un seul traitement
  // visuel pour tout encadré, quelle que soit la gravité perçue par l'IA — voir
  // services/procedureWord.js#calloutParagraphs / services/procedurePdf.js#drawBlocks.
  if (callout?.text) blocks.push({ type: 'encadre', id: makeBlockId(), text: stripMarkdownArtifacts(callout.text) });
  (photoPlaceholders || []).forEach((caption) => {
    blocks.push({ type: 'photo_placeholder', id: makeBlockId(), caption });
  });
  return blocks;
}

// tenantId/userId/subject : voir POST /api/procedures/generate-full-draft. template : la ligne
// procedure_templates du tenant (ou le repli par défaut) — snapshotée dans le job pour ne pas
// mélanger deux gabarits si l'admin le modifie pendant l'exécution (voir schema.sql).
export async function createProcedureFullDraftJob({ tenantId, userId, subject, template }) {
  const { data, error } = await supabase
    .from('procedure_generation_jobs')
    .insert({
      tenant_id: tenantId,
      created_by: userId,
      subject,
      template_snapshot: {
        section_structure: template?.section_structure || [],
        fixed_instructions: template?.fixed_instructions || null,
      },
      status: 'pending',
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error('Erreur lors de la création du job de génération complète.');
  }

  return data;
}

async function updateJob(jobId, patch) {
  await supabase.from('procedure_generation_jobs').update(patch).eq('id', jobId);
}

// Exécute le pipeline complet (1 appel plan + 1 appel par sous-section, séquentiel) et met à
// jour la ligne procedure_generation_jobs au fur et à mesure. Exportée séparément de
// createProcedureFullDraftJob pour être appelée en fire-and-forget par la route (voir
// routes/procedures.js) tout en restant directement `await`able depuis les tests.
export async function runProcedureFullDraftJob(jobId) {
  const { data: job, error: fetchError } = await supabase
    .from('procedure_generation_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (fetchError || !job) {
    console.error('Job de génération complète introuvable :', jobId, fetchError?.message);
    return;
  }

  try {
    await updateJob(jobId, { status: 'running' });

    const template = job.template_snapshot;
    let plan;
    try {
      plan = await generateProcedureFullPlan(job.subject, template);
    } catch (err) {
      await updateJob(jobId, { status: 'failed', error: err.message });
      return;
    }

    const planSections = plan.plan || [];
    const totalSteps = planSections.reduce((sum, section) => sum + (section.subsections || []).length, 0);
    await updateJob(jobId, { total_steps: totalSteps, completed_steps: 0 });

    const resultSections = [];
    const failedSubsections = [];
    let completedSteps = 0;
    let rollingSummary = '';

    for (const planSection of planSections) {
      const subsectionTitles = planSection.subsections || [];
      const generatedSubsections = [];

      for (let index = 0; index < subsectionTitles.length; index += 1) {
        const subsectionTitle = subsectionTitles[index];
        completedSteps += 1;

        try {
          const subsection = await generateProcedureSubsectionContent({
            subject: job.subject,
            sectionLabel: planSection.label,
            subsectionTitle,
            position: completedSteps,
            total: totalSteps,
            siblingTitles: subsectionTitles.filter((title) => title !== subsectionTitle),
            rollingSummary,
            fixedInstructions: template?.fixed_instructions,
            wantsCallout: wantsCallout(subsectionTitle),
          });

          generatedSubsections.push({
            title: subsectionTitle,
            intro: subsection.intro,
            actions: subsection.actions || [],
            callout: subsection.callout || null,
            photo_placeholders: subsection.photo_placeholders || [],
            generation_status: 'ok',
          });

          if (subsection.summary_sentence) {
            rollingSummary = `${rollingSummary} ${subsection.summary_sentence}`.trim();
          }
        } catch (err) {
          console.error(`Échec de génération de la sous-section "${subsectionTitle}" :`, err.message);
          failedSubsections.push({ section_key: planSection.key, subsection_title: subsectionTitle });
          generatedSubsections.push({
            title: subsectionTitle,
            intro: null,
            actions: [],
            callout: null,
            photo_placeholders: [],
            generation_status: 'failed',
          });
        }

        await updateJob(jobId, {
          completed_steps: completedSteps,
          current_step_label: `Génération de la section ${completedSteps}/${totalSteps} : ${subsectionTitle}`,
        });
      }

      // Un bloc paragraphe unique "À compléter manuellement" en cas d'échec — plus une
      // sous-structure séparée (generation_status) hors du modèle à blocs : le bloc EST le
      // contenu, l'éditeur manuel peut le corriger comme n'importe quel autre bloc.
      const blocks = generatedSubsections.flatMap((subsection) =>
        subsection.generation_status === 'failed'
          ? [
              { type: 'sous_titre', id: makeBlockId(), text: subsection.title },
              {
                type: 'paragraphe',
                id: makeBlockId(),
                text: 'À compléter manuellement — la génération automatique de cette sous-section a échoué.',
              },
            ]
          : subsectionToBlocks(subsection.title, subsection)
      );

      resultSections.push({
        key: planSection.key,
        label: planSection.label,
        blocks,
      });
    }

    const result = {
      // title : intitulé court reformulé par l'IA (voir generateProcedureFullPlan) — jamais
      // job.subject brut, qui peut être un texte long collé par l'utilisateur (bug réel
      // constaté : un sujet de plusieurs dizaines de lignes utilisé tel quel comme titre de
      // procédure a fait gonfler l'export PDF à 444 pages, voir pdfTheme.js). Repli sur le
      // sujet tronqué si jamais l'IA ne renvoyait rien, pour ne jamais laisser le titre vide —
      // mais ce repli ne doit normalement jamais s'activer.
      title: plan.title || job.subject.slice(0, 120),
      // Objet/domaine d'application/responsabilités ne sont plus des champs séparés : ce sont
      // des sections ordinaires du gabarit (voir data/defaultProcedureSections.js), déjà
      // couvertes par resultSections comme n'importe quelle autre section du plan.
      sections: resultSections,
      documents_associes: plan.documents_associes || [],
      ai_generation: {
        mode: 'full_multi_call',
        subject: job.subject,
        job_id: jobId,
        generated_at: new Date().toISOString(),
        failed_subsections: failedSubsections,
      },
    };

    await updateJob(jobId, { status: 'completed', result, failed_subsections: failedSubsections });
  } catch (err) {
    console.error('Échec inattendu du job de génération complète :', err);
    await updateJob(jobId, { status: 'failed', error: err.message });
  }
}
