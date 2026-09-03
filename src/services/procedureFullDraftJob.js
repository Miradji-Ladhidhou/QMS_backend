import { supabase } from './supabase.js';
import { generateProcedureFullPlan, generateProcedureSubsectionContent } from './groq.js';

// Mots-clés déclenchant un encadré Important/Attention/Danger — recherchés sur le TITRE de la
// sous-section (connu avant l'appel IA, donc décision déterministe et testable), jamais sur le
// contenu généré (qui n'existe pas encore au moment de construire le prompt).
const CALLOUT_KEYWORDS = ['sécurité', 'securite', 'traçabilité', 'tracabilite', 'contrôle', 'controle', 'anomalie'];

const CALLOUT_LABELS = { info: 'Important', warning: 'Attention', danger: 'Danger' };

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

function formatActions(actions) {
  return (actions || [])
    .map((action, index) => {
      const subBullets = (action.sub_bullets || []).map((bullet) => `   - ${bullet}`).join('\n');
      return `${index + 1}. ${stripLeadingNumbering(action.text)}${subBullets ? `\n${subBullets}` : ''}`;
    })
    .join('\n');
}

function formatSubsectionText(subsectionTitle, { intro, actions, callout, photo_placeholders: photoPlaceholders }) {
  const parts = [subsectionTitle, '', intro || '', '', formatActions(actions)];
  if (callout) {
    const label = CALLOUT_LABELS[callout.severity] || CALLOUT_LABELS.info;
    parts.push('', `${label} : ${callout.text}`);
  }
  (photoPlaceholders || []).forEach((caption) => {
    parts.push('', `[ Emplacement réservé à une photo : ${caption} ]`);
  });
  return parts.filter((part) => part !== undefined).join('\n').trim();
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

      const content = generatedSubsections
        .map((subsection) =>
          subsection.generation_status === 'failed'
            ? `${subsection.title}\n\nÀ compléter manuellement — la génération automatique de cette sous-section a échoué.`
            : formatSubsectionText(subsection.title, subsection)
        )
        .join('\n\n');

      resultSections.push({
        key: planSection.key,
        label: planSection.label,
        content,
        subsections: generatedSubsections,
      });
    }

    const result = {
      objet: plan.objet,
      domaine_application: plan.domaine_application,
      responsabilites: plan.responsabilites,
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
