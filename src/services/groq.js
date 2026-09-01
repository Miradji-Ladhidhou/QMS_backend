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
