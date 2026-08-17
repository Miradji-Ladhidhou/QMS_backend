import Groq from 'groq-sdk';

const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const MODEL = 'openai/gpt-oss-120b';

const SYSTEM_PROMPT = `Tu es un expert qualité (ISO 9001) qui aide à analyser un problème avec la méthode QQOQCCP (Qui, Quoi, Où, Quand, Comment, Combien, Pourquoi).

À partir des 7 réponses fournies par l'utilisateur, produis :
- synthesis : une synthèse concise du problème (2 à 3 phrases)
- root_causes : un tableau de chaînes de caractères, les causes racines probables
- suggested_actions : un tableau d'objets {title, description, suggested_priority}, où suggested_priority vaut exactement 'low', 'medium', 'high' ou 'critical'
- overall_priority : une seule valeur parmi 'low', 'medium', 'high', 'critical'

Réponds STRICTEMENT en JSON, sans texte avant ni après, avec exactement cette structure :
{
  "synthesis": "string",
  "root_causes": ["string", "string"],
  "suggested_actions": [{"title": "string", "description": "string", "suggested_priority": "medium"}],
  "overall_priority": "medium"
}`;

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
  if (!groq) {
    throw new Error('GROQ_API_KEY manquant : impossible de générer une suggestion IA.');
  }

  let completion;
  try {
    completion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(analysisData) },
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
    throw new Error(`Échec de l'appel à Groq : ${err.message}`);
  }

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error('Réponse Groq vide : impossible de générer une suggestion.');
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Réponse Groq mal formée (JSON invalide) : ${err.message}`);
  }
}
