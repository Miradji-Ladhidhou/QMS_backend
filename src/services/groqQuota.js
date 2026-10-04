import { supabase } from './supabase.js';
import { setTimeout as sleep } from 'node:timers/promises';

export const GROQ_LIMIT_KEYS = ['requests_minute', 'requests_day', 'tokens_minute', 'tokens_day'];
export const DEFAULT_GROQ_COMPLETION_BUDGET = 2048;

export function fitGroqCompletionBudget(systemPrompt, userPrompt, requestedBudget, tokensMinute) {
  const inputBudget = groqTokenBudget(systemPrompt, userPrompt, 0);
  const budget = tokensMinute === null ? requestedBudget : Math.min(requestedBudget, tokensMinute - inputBudget);
  if (budget < 512) return null;
  return budget;
}

export function groqTokenBudget(systemPrompt, userPrompt, completionBudget) {
  // UTF-8 bytes deliberately overestimate text tokens; the margin covers message framing.
  return Buffer.byteLength(systemPrompt, 'utf8') + Buffer.byteLength(userPrompt, 'utf8') + 1024 + completionBudget;
}

export async function getGroqQuota() {
  const { data, error } = await supabase.rpc('groq_quota_snapshot');
  if (error) throw new Error(`Lecture des limites Groq impossible : ${error.message}`);
  return { ...data, model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b' };
}

export async function reserveGroqCall(model, tokenBudget, { waitForMinute = false } = {}) {
  const deadline = Date.now() + 65000;
  while (true) {
    const { data, error } = await supabase.rpc('reserve_groq_call', { p_model: model, p_token_budget: tokenBudget });
    if (error) {
      console.error('[quota Groq] réservation impossible :', error.message);
      throw new Error('Le contrôle des limites globales IA est indisponible. Aucun appel envoyé à Groq.');
    }
    if (!data.allowed) {
      const limits = data.quota.limits;
      const usage = data.quota.usage;
      const dayExceeded = (limits.requests_day !== null && usage.requests_day + 1 > limits.requests_day) ||
        (limits.tokens_day !== null && usage.tokens_day + tokenBudget > limits.tokens_day);
      const impossible = (limits.tokens_minute !== null && tokenBudget > limits.tokens_minute) ||
        limits.requests_minute === 0;
      if (waitForMinute && data.scope.endsWith('_minute') && !dayExceeded && !impossible && Date.now() < deadline) {
        await sleep(Math.min(2000, deadline - Date.now()));
        continue;
      }
      const labels = {
        requests_minute: 'requêtes par minute', requests_day: 'requêtes par jour',
        tokens_minute: 'tokens par minute', tokens_day: 'tokens par jour',
      };
      throw new Error(`Plafond global IA (${labels[data.scope]}) insuffisant pour cet appel. Aucun appel envoyé à Groq. Réessayez plus tard ou contactez le super-admin.`);
    }
    return data.call_id;
  }
}

export async function finishGroqCall(callId, usage) {
  const tokens = Number.isInteger(usage?.total_tokens) && usage.total_tokens >= 0 ? usage.total_tokens : null;
  const { error } = await supabase.rpc('finish_groq_call', { p_call_id: callId, p_tokens: tokens });
  if (error) {
    console.error('[quota Groq] finalisation impossible :', error.message);
    throw new Error('Impossible de finaliser la consommation IA. Le budget réservé reste retenu par prudence.');
  }
}
