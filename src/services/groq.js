import Groq from 'groq-sdk';

const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const MODEL = 'openai/gpt-oss-120b';

// Même structure de sortie pour tous les appels IA de l'app (QQOQCCP et, depuis, tous les
// flux "créer une CAPA depuis X" — audits, revues, réclamations, risques, fournisseurs) :
// un seul contrat JSON, un seul composant frontend de rendu (AiCapaSuggestion.jsx) capable
// d'afficher n'importe laquelle de ces suggestions sans distinction.
const RESPONSE_CONTRACT = `Rédige TOUTES les valeurs textuelles en français, quelle que soit la langue du contexte fourni en entrée.

- title : un titre court (objet, maximum une dizaine de mots) formulé comme un intitulé de non-conformité, pas une phrase complète
- synthesis : une synthèse concise du problème (2 à 3 phrases), utilisable telle quelle comme description de la non-conformité
- root_causes : un tableau de chaînes de caractères, les causes racines probables
- suggested_actions : un tableau d'objets {title, description, suggested_priority}, où suggested_priority vaut exactement 'low', 'medium', 'high' ou 'critical' — des actions CORRECTIVES, pour traiter le problème déjà survenu
- preventive_actions : un tableau de chaînes de caractères — des actions PRÉVENTIVES, distinctes des actions correctives, pour empêcher que ce problème (ou un problème similaire) ne se reproduise
- overall_priority : une seule valeur parmi 'low', 'medium', 'high', 'critical'

Réponds STRICTEMENT en JSON, sans texte avant ni après, avec exactement cette structure :
{
  "title": "string",
  "synthesis": "string",
  "root_causes": ["string", "string"],
  "suggested_actions": [{"title": "string", "description": "string", "suggested_priority": "medium"}],
  "preventive_actions": ["string", "string"],
  "overall_priority": "medium"
}`;

const QQOQCCP_SYSTEM_PROMPT = `Tu es un expert qualité (ISO 9001) qui aide à analyser un problème avec la méthode QQOQCCP (Qui, Quoi, Où, Quand, Comment, Combien, Pourquoi).

À partir des 7 réponses fournies par l'utilisateur, produis :
${RESPONSE_CONTRACT}`;

// Prompt générique pour les flux "créer une CAPA depuis X" (audit, revue de direction,
// réclamation, risque, évaluation fournisseur) : contrairement à QQOQCCP, ces outils n'ont
// pas de questionnaire structuré, juste un texte libre décrivant la situation (voir
// buildCapaSuggestionContext dans chaque route). Même contrat de sortie malgré tout.
const CAPA_SUGGESTION_SYSTEM_PROMPT = `Tu es un expert qualité (ISO 9001) qui aide à préparer une action corrective/préventive (CAPA) à partir d'un problème déjà décrit dans un autre outil du système qualité (audit interne, revue de direction, réclamation client, registre des risques, ou évaluation fournisseur).

À partir du contexte fourni par l'utilisateur, produis :
${RESPONSE_CONTRACT}`;

async function callGroq(systemPrompt, userPrompt) {
  if (!groq) {
    throw new Error('GROQ_API_KEY manquant : impossible de générer une suggestion IA.');
  }

  let completion;
  try {
    completion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    });
  } catch (err) {
    // Distinct de l'erreur de parsing JSON ci-dessous : celle-ci couvre l'appel réseau/API
    // lui-même (quota, authentification, timeout, indisponibilité de Groq).
    if (err instanceof Groq.RateLimitError) {
      throw new Error('Quota Groq dépassé : réessayez plus tard.');
    }
    if (err instanceof Groq.AuthenticationError) {
      throw new Error('Clé Groq invalide ou manquante (vérifiez GROQ_API_KEY).');
    }
    if (err instanceof Groq.APIConnectionTimeoutError) {
      throw new Error("Délai d'attente dépassé lors de l'appel à Groq.");
    }
    if (err instanceof Groq.APIConnectionError) {
      throw new Error("Erreur réseau lors de l'appel à Groq.");
    }
    // Catégorie imprévue (ni quota, ni auth, ni réseau/timeout) : err.message vient du SDK
    // Groq, pas d'un texte qu'on a écrit — jamais renvoyé tel quel au client (voir routes/ai.js
    // et routes/qqoqccp.js, qui affichent directement le message de cette erreur), on ne garde
    // ici que le détail utile côté serveur pour le diagnostic.
    console.error('Échec inattendu de l’appel à Groq :', err);
    throw new Error("Échec de l'appel à Groq. Réessayez dans quelques instants.");
  }

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error('Réponse Groq vide : impossible de générer une suggestion.');
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('Réponse Groq mal formée (JSON invalide) :', err, raw);
    throw new Error('Réponse Groq mal formée : impossible de générer une suggestion.');
  }
}

function buildUserPrompt({ qui, quoi, ou_, quand_, comment_, combien, pourquoi }) {
  return `Voici les réponses recueillies pour cette analyse QQOQCCP :
Qui : ${qui || 'non renseigné'}
Quoi : ${quoi || 'non renseigné'}
Où : ${ou_ || 'non renseigné'}
Quand : ${quand_ || 'non renseigné'}
Comment : ${comment_ || 'non renseigné'}
Combien : ${combien || 'non renseigné'}
Pourquoi : ${pourquoi || 'non renseigné'}`;
}

// analysisData : { qui, quoi, ou_, quand_, comment_, combien, pourquoi } — mêmes noms de
// champs que qqoqccp_analyses (voir schema.sql), pour pouvoir passer directement une ligne
// de la table sans transformation.
export async function generateQqoqccpSuggestion(analysisData) {
  return callGroq(QQOQCCP_SYSTEM_PROMPT, buildUserPrompt(analysisData));
}

// context : texte libre décrivant la situation (assemblé côté route à partir du constat
// d'audit / de l'action de revue / de la réclamation / du risque / de l'évaluation
// fournisseur — voir routes/ai.js). Même contrat de sortie que generateQqoqccpSuggestion,
// pour que le frontend affiche les deux avec le même composant.
export async function generateCapaSuggestion(context) {
  return callGroq(CAPA_SUGGESTION_SYSTEM_PROMPT, context);
}

const HACCP_HAZARD_RESPONSE_CONTRACT = `Rédige TOUTES les valeurs textuelles (description, suggested_controls) en français, quelle que soit la langue du contexte fourni en entrée. Seule la valeur de hazard_type reste l'un des identifiants anglais fixes ci-dessous.

Réponds STRICTEMENT en JSON, sans texte avant ni après, avec exactement cette structure :
{
  "hazards": [
    {
      "hazard_type": "biological",
      "description": "string",
      "likelihood": 3,
      "severity": 3,
      "suggested_controls": "string"
    }
  ]
}
Où hazard_type vaut exactement 'biological', 'chemical', 'physical' ou 'allergen', et likelihood/severity sont des entiers entre 1 et 5 (échelle standard 1 = très improbable/mineur, 5 = très probable/critique).`;

const HACCP_HAZARD_SYSTEM_PROMPT = `Tu es un expert en sécurité alimentaire (méthode HACCP, Codex Alimentarius) qui aide à réaliser l'analyse des dangers d'un plan HACCP.

À partir du nom et de la description d'une étape du procédé de fabrication fournis par l'utilisateur, identifie les dangers biologiques, chimiques, physiques et allergènes raisonnablement susceptibles de survenir à CETTE étape précise, avec pour chacun une évaluation de probabilité (likelihood) et de gravité (severity) sur une échelle de 1 à 5, ainsi que des mesures de maîtrise usuelles.

Ne propose que des dangers pertinents pour l'étape décrite — pas une liste générique. Limite-toi à 5 dangers maximum, les plus significatifs.

${HACCP_HAZARD_RESPONSE_CONTRACT}`;

function buildHazardUserPrompt({ stepName, stepDescription }) {
  return `Étape du procédé : ${stepName}
Description : ${stepDescription || 'non renseignée'}`;
}

// stepData : { stepName, stepDescription } — voir POST /haccp/plans/:planId/steps/:stepId/hazard-suggestion.
// Rien n'est persisté par cet appel : le frontend affiche les suggestions dans une liste à
// cocher (AiHazardSuggestion.jsx), chaque danger accepté devient une ligne haccp_hazards
// distincte via POST /haccp/plans/:planId/steps/:stepId/hazards.
export async function generateHaccpHazardSuggestion(stepData) {
  return callGroq(HACCP_HAZARD_SYSTEM_PROMPT, buildHazardUserPrompt(stepData));
}

const RISK_SUGGESTION_RESPONSE_CONTRACT = `Rédige TOUTES les valeurs textuelles (title, category, suggested_controls) en français, quelle que soit la langue du contexte fourni en entrée. Seule la valeur de type reste l'un des identifiants anglais fixes ci-dessous.

Réponds STRICTEMENT en JSON, sans texte avant ni après, avec exactement cette structure :
{
  "risks": [
    {
      "type": "risk",
      "title": "string",
      "category": "string",
      "likelihood": 3,
      "impact": 3,
      "suggested_controls": "string"
    }
  ]
}
Où type vaut exactement 'risk' ou 'opportunity', et likelihood/impact sont des entiers entre 1 et 5 (échelle standard 1 = très improbable/négligeable, 5 = quasi certain/critique).`;

const RISK_SUGGESTION_SYSTEM_PROMPT = `Tu es un expert qualité (ISO 9001:2015 §6.1 — approche par les risques) qui aide à identifier les risques et opportunités d'un service ou d'une activité pour le registre des risques.

À partir du nom et de la description d'un service/d'une activité fournis par l'utilisateur, identifie les risques ET opportunités raisonnablement susceptibles de le concerner, avec pour chacun une évaluation de probabilité (likelihood) et de gravité/impact (impact) sur une échelle de 1 à 5, ainsi que des mesures de maîtrise usuelles.

Ne propose que des risques/opportunités pertinents pour l'activité décrite — pas une liste générique. Limite-toi à 5 éléments maximum, les plus significatifs.

${RISK_SUGGESTION_RESPONSE_CONTRACT}`;

function buildRiskSuggestionUserPrompt({ serviceName, context }) {
  return `Service : ${serviceName}
Description de l'activité : ${context}`;
}

// { serviceName, context } — voir POST /risks/service-suggestion. Rien n'est persisté par cet
// appel : le frontend affiche les suggestions dans une liste à cocher (AiRiskSuggestion.jsx),
// chaque risque/opportunité accepté devient une ligne risks distincte via POST /risks.
export async function generateRiskSuggestion(data) {
  return callGroq(RISK_SUGGESTION_SYSTEM_PROMPT, buildRiskSuggestionUserPrompt(data));
}

// =============================================================================
// Module Procédures — prompts-implementation-module-procedures.md (Prompt 3) référençait un
// fichier de templates system/user "fournis séparément" qui n'a jamais existé (placeholder
// resté vide) : ces 5 prompts sont donc rédigés ici, dans le même style que les blocs
// ci-dessus, plutôt que repris d'un fichier externe. Comme le reste du module Procédures
// (routes, colonnes), noms de fonctions en anglais — cohérent avec generateQqoqccpSuggestion/
// generateRiskSuggestion/generateHaccpHazardSuggestion ci-dessus.
//
// Aucune de ces fonctions ne persiste ni ne journalise quoi que ce soit elle-même (même
// principe que generateRiskSuggestion/generateHaccpHazardSuggestion) : c'est à la route
// appelante de poser ai_generated: true sur la ligne procedure_versions au moment où une
// suggestion est effectivement enregistrée — pas encore câblé dans routes/procedures.js à ce
// stade (Prompt 3 ne portait que sur ce fichier de service).
// =============================================================================

const PROCEDURE_DRAFT_RESPONSE_CONTRACT = `Rédige TOUTES les valeurs textuelles en français, quelle que soit la langue du contexte fourni en entrée.

Réponds STRICTEMENT en JSON, sans texte avant ni après, avec exactement cette structure :
{
  "objet": "string",
  "domaine_application": "string",
  "responsabilites": "string",
  "sections": [{"key": "string", "label": "string", "content": "string"}],
  "documents_associes": ["string", "string"]
}
Le tableau "sections" doit contenir EXACTEMENT une entrée par section du gabarit fourni, dans le même ordre, avec le même "key"/"label" que dans le gabarit — seul "content" est à rédiger.`;

const PROCEDURE_DRAFT_SYSTEM_PROMPT = `Tu es un expert qualité (ISO 9001) qui aide à rédiger le brouillon d'une procédure documentée à partir d'un titre, d'un processus concerné, et du gabarit de sections imposé par l'entreprise.

Rédige un contenu plausible et structuré pour CHAQUE section du gabarit, cohérent avec le titre et le processus fournis — jamais de texte générique du type "à compléter", toujours une proposition concrète que le rédacteur pourra ensuite corriger.

${PROCEDURE_DRAFT_RESPONSE_CONTRACT}`;

function buildProcedureDraftUserPrompt(formData, template) {
  const sections = (template?.section_structure || [])
    .map((section, index) => `${index + 1}. ${section.label} (key: ${section.key})`)
    .join('\n');
  return `Titre de la procédure : ${formData?.title || 'non renseigné'}
Processus concerné : ${formData?.process || 'non renseigné'}

Gabarit de sections à respecter :
${sections || "Aucun gabarit configuré — utilise les sections standard objet/domaine d'application/responsabilités."}
${template?.fixed_instructions ? `\nConsignes de style propres à cette entreprise, à respecter : ${template.fixed_instructions}` : ''}`;
}

// formData : { title, process } — mêmes noms que procedures.title/process. template : la ligne
// procedure_templates du tenant ({ section_structure }), ou null si aucun gabarit configuré.
export async function generateProcedureDraft(formData, template) {
  return callGroq(PROCEDURE_DRAFT_SYSTEM_PROMPT, buildProcedureDraftUserPrompt(formData, template));
}

// Même contrat de sortie que generateProcedureDraft (objet/domaine_application/
// responsabilites/sections/documents_associes) — seule la source d'inspiration change : un
// diagnostic QQOQCCP qui a révélé un manque à formaliser, plutôt qu'un simple titre/processus
// tapés à la main. Réutilise donc le même formulaire de création et le même éditeur de
// sections côté frontend (Procedures.jsx), pas une UI dédiée.
const PROCEDURE_DRAFT_FROM_QQOQCCP_SYSTEM_PROMPT = `Tu es un expert qualité (ISO 9001) qui aide à rédiger le brouillon d'une NOUVELLE procédure documentée, à partir d'une analyse QQOQCCP qui a révélé un manque ou un problème récurrent nécessitant de formaliser un processus.

Utilise le diagnostic (qui/quoi/où/quand/comment/combien/pourquoi) et, s'ils sont disponibles, la synthèse et les causes racines déjà identifiées par l'IA sur cette analyse, pour rédiger une procédure qui répond concrètement au problème constaté — jamais un texte générique, toujours ancré dans les faits de cette analyse.

${PROCEDURE_DRAFT_RESPONSE_CONTRACT}`;

function buildProcedureDraftFromQqoqccpUserPrompt(analysis, template) {
  const sections = (template?.section_structure || [])
    .map((section, index) => `${index + 1}. ${section.label} (key: ${section.key})`)
    .join('\n');
  const rootCauses = analysis?.ai_suggested_actions?.root_causes;
  const preventiveActions = analysis?.ai_suggested_actions?.preventive_actions;

  return `Analyse QQOQCCP à l'origine de cette procédure : ${analysis?.title || 'non renseignée'}
Qui : ${analysis?.qui || 'non renseigné'}
Quoi : ${analysis?.quoi || 'non renseigné'}
Où : ${analysis?.ou_ || 'non renseigné'}
Quand : ${analysis?.quand_ || 'non renseigné'}
Comment : ${analysis?.comment_ || 'non renseigné'}
Combien : ${analysis?.combien || 'non renseigné'}
Pourquoi : ${analysis?.pourquoi || 'non renseigné'}
${analysis?.ai_synthesis ? `\nSynthèse IA de cette analyse : ${analysis.ai_synthesis}` : ''}
${rootCauses?.length ? `\nCauses racines déjà identifiées : ${rootCauses.join(', ')}` : ''}
${preventiveActions?.length ? `\nActions préventives déjà envisagées : ${preventiveActions.join(', ')}` : ''}

Gabarit de sections à respecter :
${sections || "Aucun gabarit configuré — utilise les sections standard objet/domaine d'application/responsabilités."}
${template?.fixed_instructions ? `\nConsignes de style propres à cette entreprise, à respecter : ${template.fixed_instructions}` : ''}`;
}

// analysis : ligne qqoqccp_analyses (qui/quoi/ou_/quand_/comment_/combien/pourquoi +
// ai_synthesis/ai_suggested_actions si l'IA a déjà été utilisée sur cette analyse). template :
// la ligne procedure_templates du tenant.
export async function generateProcedureDraftFromQqoqccp(analysis, template) {
  return callGroq(PROCEDURE_DRAFT_FROM_QQOQCCP_SYSTEM_PROMPT, buildProcedureDraftFromQqoqccpUserPrompt(analysis, template));
}

const PROCEDURE_COMPLIANCE_RESPONSE_CONTRACT = `Rédige TOUTES les valeurs textuelles en français.

Réponds STRICTEMENT en JSON, sans texte avant ni après, avec exactement cette structure :
{
  "compliant": true,
  "anomalies": [{"section_key": "string", "issue": "string", "severity": "minor"}]
}
Où severity vaut exactement 'minor', 'major' ou 'blocking', et section_key est TOUJOURS la valeur "key" de la section concernée telle que fournie dans le gabarit (ex. "objectif"), jamais son libellé affiché (ex. "Objectif"). "compliant" vaut false dès qu'au moins une anomalie "major" ou "blocking" est détectée. Un tableau "anomalies" vide signifie une conformité totale.`;

const PROCEDURE_COMPLIANCE_SYSTEM_PROMPT = `Tu es un auditeur qualité (ISO 9001) qui vérifie qu'une procédure respecte le gabarit de sections imposé par l'entreprise avant sa soumission pour validation.

Compare le contenu de la procédure au gabarit attendu : une section manquante, vide, ou dont le contenu ne correspond manifestement pas à son intitulé est une anomalie. Ne signale JAMAIS une anomalie de style ou de préférence rédactionnelle — uniquement des manques structurels réels.

${PROCEDURE_COMPLIANCE_RESPONSE_CONTRACT}`;

function buildProcedureComplianceUserPrompt(procedureContent, template) {
  const expectedSections = (template?.section_structure || []).map((s) => `- ${s.label} (key: ${s.key})`).join('\n');
  const actualSections = (procedureContent?.sections || [])
    .map((s) => `- ${s.label} (key: ${s.key}) : ${s.content ? s.content.slice(0, 300) : '(vide)'}`)
    .join('\n');
  return `Sections attendues par le gabarit :
${expectedSections || 'Aucun gabarit configuré.'}

Contenu actuel de la procédure :
${actualSections || 'Aucune section rédigée.'}`;
}

// procedureContent : le jsonb procedure_versions.content de la version à vérifier. template :
// la ligne procedure_templates du tenant.
export async function checkProcedureTemplateCompliance(procedureContent, template) {
  return callGroq(PROCEDURE_COMPLIANCE_SYSTEM_PROMPT, buildProcedureComplianceUserPrompt(procedureContent, template));
}

const PROCEDURE_DISTRIBUTION_SHEET_RESPONSE_CONTRACT = `Rédige TOUTES les valeurs textuelles en français.

Réponds STRICTEMENT en JSON, sans texte avant ni après, avec exactement cette structure :
{
  "summary": "string",
  "key_points": ["string", "string"],
  "audience_notes": "string"
}
"summary" : un résumé de 3 à 5 phrases de la procédure, compréhensible sans lire le document complet. "key_points" : les points essentiels à retenir, sous forme de puces courtes et actionnables (5 à 8 maximum). "audience_notes" : ce qui concerne SPÉCIFIQUEMENT le public cible fourni, pas un résumé générique.`;

const PROCEDURE_DISTRIBUTION_SHEET_SYSTEM_PROMPT = `Tu es un expert qualité (ISO 9001) qui prépare une fiche de diffusion — un résumé condensé d'une procédure destiné à un public précis qui doit la connaître sans nécessairement la lire en entier.

À partir du contenu complet de la procédure et du public cible fourni, produis une fiche claire, concrète, et centrée sur ce que CE public doit savoir/faire — pas une simple table des matières.

${PROCEDURE_DISTRIBUTION_SHEET_RESPONSE_CONTRACT}`;

function formatProcedureContentForPrompt(content) {
  if (!content) return '(aucun contenu)';
  // "key" toujours affiché à côté du libellé : c'est cette valeur, jamais le libellé, que les
  // réponses JSON doivent renvoyer dans section_key (voir les RESPONSE_CONTRACT ci-dessus).
  const sections = (content.sections || []).map((s) => `## ${s.label} (key: ${s.key})\n${s.content || ''}`).join('\n\n');
  return `Objet : ${content.objet || 'non renseigné'}
Domaine d'application : ${content.domaine_application || 'non renseigné'}
Responsabilités : ${content.responsabilites || 'non renseigné'}

${sections}`;
}

function buildProcedureDistributionSheetUserPrompt(procedureContent, targetAudience) {
  return `Public cible : ${targetAudience || 'non renseigné'}

Contenu complet de la procédure :
${formatProcedureContentForPrompt(procedureContent)}`;
}

// procedureContent : le jsonb content de la version approuvée. targetAudience : texte libre
// (ex. "nouveaux opérateurs de la ligne 2").
export async function generateProcedureDistributionSheet(procedureContent, targetAudience) {
  return callGroq(
    PROCEDURE_DISTRIBUTION_SHEET_SYSTEM_PROMPT,
    buildProcedureDistributionSheetUserPrompt(procedureContent, targetAudience)
  );
}

const PROCEDURE_VERSION_COMPARISON_RESPONSE_CONTRACT = `Rédige TOUTES les valeurs textuelles en français.

Réponds STRICTEMENT en JSON, sans texte avant ni après, avec exactement cette structure :
{
  "summary": "string",
  "changes": [{"section_key": "string", "change_type": "modified", "description": "string"}]
}
Où change_type vaut exactement 'added', 'removed' ou 'modified', et section_key est TOUJOURS la valeur "key" de la section (ex. "objectif"), jamais son libellé affiché (ex. "Objectif"). "summary" : une synthèse de 2 à 4 phrases de l'ampleur et de la nature des changements. "changes" : une entrée par section réellement modifiée entre les deux versions — jamais une section dont le contenu est resté identique.`;

const PROCEDURE_VERSION_COMPARISON_SYSTEM_PROMPT = `Tu es un expert qualité (ISO 9001) qui compare deux versions d'une procédure pour préparer sa revue par le validateur.

Identifie précisément ce qui a changé entre la version précédente et la nouvelle version, section par section — ajouts, suppressions, modifications de fond. Ignore les changements purement typographiques (orthographe, ponctuation) qui ne modifient pas le sens.

${PROCEDURE_VERSION_COMPARISON_RESPONSE_CONTRACT}`;

function buildProcedureVersionComparisonUserPrompt(previousContent, newContent) {
  return `Version précédente :
${previousContent ? formatProcedureContentForPrompt(previousContent) : "(aucune version précédente — c'est la toute première)"}

Nouvelle version :
${formatProcedureContentForPrompt(newContent)}`;
}

// previousContent : content de la version précédente (peut être null pour une toute première
// version). newContent : content de la nouvelle version.
export async function compareProcedureVersions(previousContent, newContent) {
  return callGroq(
    PROCEDURE_VERSION_COMPARISON_SYSTEM_PROMPT,
    buildProcedureVersionComparisonUserPrompt(previousContent, newContent)
  );
}

const PROCEDURE_REVISION_FROM_CAPA_RESPONSE_CONTRACT = `Rédige TOUTES les valeurs textuelles en français.

Réponds STRICTEMENT en JSON, sans texte avant ni après, avec exactement cette structure :
{
  "rationale": "string",
  "suggested_changes": [{"section_key": "string", "current_excerpt": "string", "suggested_content": "string"}]
}
section_key est TOUJOURS la valeur "key" de la section (ex. "objectif"), jamais son libellé affiché (ex. "Objectif"). "rationale" : pourquoi cette CAPA justifie (ou non) une révision de la procédure (2 à 3 phrases). "suggested_changes" : une entrée par section à modifier — "current_excerpt" cite brièvement ce qui pose problème dans le texte actuel (chaîne vide si la section est absente), "suggested_content" est le nouveau texte proposé pour cette section. Ne propose de changement QUE si la CAPA le justifie réellement — un tableau vide est une réponse valide si la procédure n'a pas besoin d'évoluer.`;

const PROCEDURE_REVISION_FROM_CAPA_SYSTEM_PROMPT = `Tu es un expert qualité (ISO 9001) qui détermine si une action corrective/préventive (CAPA) déjà traitée révèle un manque dans une procédure existante, et propose la révision correspondante.

À partir du contenu de la CAPA (cause racine, action corrective, action préventive) et du contenu actuel de la procédure, identifie les sections qui devraient être mises à jour pour empêcher que ce problème ne se reproduise — jamais une réécriture complète, seulement les sections réellement concernées.

${PROCEDURE_REVISION_FROM_CAPA_RESPONSE_CONTRACT}`;

function buildProcedureRevisionFromCapaUserPrompt(capaData, currentProcedure) {
  return `CAPA :
Titre : ${capaData?.title || 'non renseigné'}
Cause racine : ${capaData?.root_cause || 'non renseignée'}
Action corrective : ${capaData?.corrective_action || 'non renseignée'}
Action préventive : ${capaData?.preventive_action || 'non renseignée'}

Contenu actuel de la procédure :
${formatProcedureContentForPrompt(currentProcedure)}`;
}

// capaData : { title, root_cause, corrective_action, preventive_action } — mêmes noms que
// capas (voir schema.sql), pour passer directement une ligne de la table. currentProcedure :
// le jsonb content de la version courante de la procédure.
export async function suggestProcedureRevisionFromCapa(capaData, currentProcedure) {
  return callGroq(
    PROCEDURE_REVISION_FROM_CAPA_SYSTEM_PROMPT,
    buildProcedureRevisionFromCapaUserPrompt(capaData, currentProcedure)
  );
}

// =============================================================================
// Génération complète section par section (services/procedureFullDraftJob.js orchestre
// l'enchaînement) : contrairement à generateProcedureDraft (1 seul appel, contenu court et
// générique), un premier appel produit un PLAN de sous-sections adaptées au sujet, puis un
// appel dédié par sous-section rédige un contenu détaillé (150-300 mots). Toujours aucune
// persistance ici, même principe que le reste de ce fichier.
// =============================================================================

const PROCEDURE_FULL_PLAN_RESPONSE_CONTRACT = `Rédige TOUTES les valeurs textuelles en français, quelle que soit la langue du contexte fourni en entrée.

Réponds STRICTEMENT en JSON, sans texte avant ni après, avec exactement cette structure :
{
  "objet": "string",
  "domaine_application": "string",
  "responsabilites": "string",
  "documents_associes": ["string", "string"],
  "plan": [{"key": "string", "label": "string", "subsections": ["string", "string"]}]
}
Le tableau "plan" doit contenir EXACTEMENT une entrée par section du gabarit fourni, dans le même ordre, avec le même "key"/"label" que dans le gabarit. Pour chaque section, "subsections" liste des sous-sections concrètes et opérationnelles, adaptées au sujet précis — jamais des généralités. Ne subdivise que si le sujet le justifie réellement : une section qui n'a besoin que d'un seul point peut n'avoir qu'une seule sous-section, inutile de forcer une découpe artificielle.`;

const PROCEDURE_FULL_PLAN_SYSTEM_PROMPT = `Tu es un expert qualité (ISO 9001) qui prépare le plan détaillé d'une procédure documentée complète, à partir d'un sujet court et du gabarit de sections imposé par l'entreprise.

Pour chaque section du gabarit, décompose le sujet en sous-sections concrètes qui, une fois rédigées une par une, formeront un document complet et opérationnel — pas un résumé. Par exemple, pour un sujet "préparation de commande" et une section générique "Processus", des sous-sections plausibles seraient : réception de la commande, édition du bon de préparation, vérification des équipements, sélection du lot, traçabilité, prélèvement, contrôle, filmage, contrôle final, gestion des anomalies, formation — adapte cette logique au sujet réellement fourni, ne recopie pas cet exemple tel quel.

${PROCEDURE_FULL_PLAN_RESPONSE_CONTRACT}`;

function buildProcedureFullPlanUserPrompt(subject, template) {
  const sections = (template?.section_structure || [])
    .map((section, index) => `${index + 1}. ${section.label} (key: ${section.key})`)
    .join('\n');
  return `Sujet de la procédure à planifier : ${subject}

Gabarit de sections à respecter :
${sections || "Aucun gabarit configuré — utilise les sections standard objet/domaine d'application/responsabilités."}
${template?.fixed_instructions ? `\nConsignes de style propres à cette entreprise, à respecter : ${template.fixed_instructions}` : ''}`;
}

// subject : texte court tapé par l'utilisateur (ex. "procédure de préparation de commande").
// template : la ligne procedure_templates du tenant (ou le repli par défaut, voir
// fetchTenantTemplate dans routes/procedures.js).
export async function generateProcedureFullPlan(subject, template) {
  return callGroq(PROCEDURE_FULL_PLAN_SYSTEM_PROMPT, buildProcedureFullPlanUserPrompt(subject, template));
}

const PROCEDURE_SUBSECTION_RESPONSE_CONTRACT = `Rédige TOUTES les valeurs textuelles en français.

Réponds STRICTEMENT en JSON, sans texte avant ni après, avec exactement cette structure :
{
  "intro": "string",
  "actions": [{"text": "string", "sub_bullets": ["string"]}],
  "summary_sentence": "string",
  "callout": {"severity": "info", "text": "string"}
}
"intro" : un paragraphe expliquant le pourquoi de cette étape (2-4 phrases). "actions" : une liste ordonnée d'actions concrètes et opérationnelles (le tableau EST déjà l'ordre à suivre — "text" ne doit JAMAIS commencer par un numéro ou une puce, ce sera ajouté automatiquement à l'affichage), avec "sub_bullets" (tableau, éventuellement vide) pour le détail d'une action qui le justifie. "summary_sentence" : UNE SEULE phrase résumant ce que cette sous-section couvre, pour donner du contexte aux sous-sections suivantes. "callout" : null si aucune mise en garde n'est nécessaire ; sinon un encadré avec "severity" valant exactement 'info', 'warning' ou 'danger' selon la gravité réelle, et "text" le contenu de la mise en garde (1-2 phrases). Vise 150 à 300 mots au total pour "intro" + "actions" — un contenu complet et détaillé, jamais un résumé succinct.`;

const PROCEDURE_SUBSECTION_SYSTEM_PROMPT = `Tu es un expert qualité (ISO 9001) qui rédige, sous-section par sous-section, le contenu détaillé d'une procédure documentée complète — assez complet pour qu'un rédacteur n'ait plus qu'à relire, corriger et illustrer de photos.

Rédige un contenu concret et opérationnel pour LA SEULE sous-section demandée, cohérent avec le sujet global, sa place dans le plan d'ensemble, et ce qui a déjà été rédigé pour les sous-sections précédentes (pour assurer la continuité et éviter les répétitions). Jamais de texte générique du type "à définir" — toujours des actions précises et exploitables.

${PROCEDURE_SUBSECTION_RESPONSE_CONTRACT}`;

function buildProcedureSubsectionUserPrompt({
  subject,
  sectionLabel,
  subsectionTitle,
  position,
  total,
  siblingTitles,
  rollingSummary,
  fixedInstructions,
  wantsCallout,
}) {
  return `Sujet global de la procédure : ${subject}
Section du gabarit concernée : ${sectionLabel}
Sous-section à rédiger (${position}/${total} du plan d'ensemble) : ${subsectionTitle}
${siblingTitles?.length ? `\nAutres sous-sections prévues dans le plan (pour situer celle-ci, ne pas les rédiger) : ${siblingTitles.join(', ')}` : ''}
${rollingSummary ? `\nRésumé de ce qui a déjà été rédigé jusqu'ici (pour continuité, éviter les répétitions) : ${rollingSummary}` : "\n(C'est la toute première sous-section rédigée — rien à résumer avant elle.)"}
${fixedInstructions ? `\nConsignes de style propres à cette entreprise, à respecter : ${fixedInstructions}` : ''}
${wantsCallout ? "\nCette sous-section touche à un enjeu de sécurité, de traçabilité, de contrôle ou de gestion d'anomalie : ajoute un encadré \"callout\" pertinent (severity 'warning' ou 'danger' selon la gravité réelle) plutôt que de le laisser à null." : ''}`;
}

// args : { subject, sectionLabel, subsectionTitle, position, total, siblingTitles,
// rollingSummary, fixedInstructions, wantsCallout } — voir
// services/procedureFullDraftJob.js#runProcedureFullDraftJob pour la construction de ces
// arguments à chaque itération de la boucle séquentielle.
export async function generateProcedureSubsectionContent(args) {
  return callGroq(PROCEDURE_SUBSECTION_SYSTEM_PROMPT, buildProcedureSubsectionUserPrompt(args));
}
