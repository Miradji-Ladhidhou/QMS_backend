import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), insert: vi.fn() }));
vi.mock('./supabase.js', () => ({
  supabase: { from: () => ({ insert: mocks.insert }) },
}));
vi.mock('./groqQuota.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getGroqQuota: vi.fn().mockResolvedValue({ limits: { tokens_minute: 8000 } }),
  reserveGroqCall: vi.fn().mockResolvedValue('test-call'),
  finishGroqCall: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('groq-sdk', () => ({
  default: class Groq {
    static RateLimitError = class extends Error {};
    chat = { completions: { create: mocks.create } };
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.create.mockReset();
});

it('restricts guide recommendations to supplied catalog identifiers with no routes or external tools', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  mocks.create.mockResolvedValue({ choices: [{ message: { content: '{"recommendations":[{"id":"risks","score":100}]}' } }] });
  const { generateProblemGuideRecommendations } = await import('./groq.js');
  expect(await generateProblemGuideRecommendations('Situation inhabituelle', [
    { id: 'risks', label: 'Risques', description: 'Évaluer les risques', path: '/risks', keywords: ['secret'] },
  ])).toEqual({ recommendations: [{ id: 'risks', score: 100 }] });
  const input = mocks.create.mock.calls[0][0];
  expect(JSON.parse(input.messages[1].content)).toEqual({
    problem: 'Situation inhabituelle',
    modules: [{ id: 'risks', label: 'Risques', description: 'Évaluer les risques' }],
  });
  expect(input.messages[0].content).toContain('Aucun module, outil, route ou fonctionnalité supplémentaire');
  expect(input.max_completion_tokens).toBeLessThanOrEqual(1024);
});

it('tailors CCP preparation to the step and separates source/evidence guidance from real validation', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  mocks.create.mockResolvedValue({ choices: [{ message: { content: '{"critical_limits":"Température ≤ 4 °C"}' } }] });
  const { generateHaccpCcpSuggestion } = await import('./groq.js');
  await generateHaccpCcpSuggestion({ hazardType: 'biological', description: 'Croissance microbienne', likelihood: 3, severity: 4, stepName: 'Réception' });
  const { messages } = mocks.create.mock.calls[0][0];
  expect(messages[1].content).toContain('Étape du procédé : Réception');
  expect(messages[0].content).toContain('"validation_source_guidance"');
  expect(messages[0].content).toContain('"validation_evidence_guidance"');
  expect(messages[0].content).toContain('jamais déclarer des essais déjà réalisés');
  expect(messages[0].content).toContain('Ne propose aucun responsable nominatif');
});

it('requires undetermined control decisions for missing product evidence without asserting absent later controls', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  const suggestion = {
    is_significant: true,
    control_type: 'undetermined',
    justification: 'Risque significatif selon la cotation fournie.',
    decision_justification: 'Le dossier produit et les preuves de maîtrise sont manquants.',
  };
  mocks.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(suggestion) } }] });
  const { generateHaccpSignificanceSuggestion } = await import('./groq.js');
  expect(await generateHaccpSignificanceSuggestion({
    hazardType: 'biological',
    description: 'Listeria',
    likelihood: 2,
    severity: 4,
    laterSteps: [],
  })).toEqual(suggestion);

  const { messages } = mocks.create.mock.calls[0][0];
  expect(messages[0].content).toContain("control_type doit être 'undetermined'");
  expect(messages[0].content).toContain('Les mesures proposées par une IA ne sont pas des mesures existantes');
  expect(messages[0].content).toContain('is_significant reste une analyse indépendante');
  expect(messages[1].content).toContain('ne pas supposer que cette étape est la dernière');
});

it('aligns surveillance instructions and JSON example and includes repair feedback', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  mocks.create.mockResolvedValue({ choices: [{ message: { content: '{"summary":"Analyse","suggestions":[]}' } }] });
  const { generateHaccpSurveillanceSuggestion } = await import('./groq.js');
  await generateHaccpSurveillanceSuggestion({
    planTitle: 'Plan test',
    steps: [{ name: 'Stockage', hazards: [{ id: 'hazard-1' }] }],
  }, ['suggestions[0].routine_frequency: required for non-CCP']);

  const prompt = mocks.create.mock.calls[0][0].messages[0].content;
  expect(prompt).toContain('jamais null ni omis');
  expect(prompt).toContain('routine_monitoring et routine_frequency sont non vides');
  expect(prompt).toContain('sans inventer une maîtrise déjà validée');
  expect(prompt).toContain('"routine_frequency": "Avant la décision');
  expect(prompt).toContain('suggestions[0].routine_frequency: required for non-CCP');
  expect(prompt).toContain('TOUS les dangers');
  expect(mocks.create.mock.calls[0][0].max_completion_tokens).toBeLessThanOrEqual(2048);
});

it('batches all 50 hazards with at most five per completion and preserves downstream steps', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  mocks.create.mockImplementation(async ({ messages }) => {
    const input = JSON.parse(messages[1].content);
    const hazards = input.steps.flatMap((step) => step.hazards);
    return { choices: [{ message: { content: JSON.stringify({
      summary: 'Analyse',
      suggestions: hazards.map((hazard) => ({ hazard_id: hazard.hazard_id })),
    }) } }] };
  });
  const { generateHaccpSurveillanceSuggestion } = await import('./groq.js');
  const ids = Array.from({ length: 50 }, (_, index) => `hazard-${index}`);
  const result = await generateHaccpSurveillanceSuggestion({
    planTitle: 'Plan test',
    productDescription: 'Produit test',
    steps: [
      { name: 'Stockage', hazards: ids.map((id) => ({ id })) },
      { name: 'Cuisson', description: 'Étape ultérieure', hazards: [] },
    ],
  });
  expect(mocks.create).toHaveBeenCalledTimes(10);
  expect(result.suggestions.map((item) => item.hazard_id)).toEqual(ids);
  for (const [options] of mocks.create.mock.calls) {
    const input = JSON.parse(options.messages[1].content);
    expect(input.product).toBe('Produit test');
    expect(input.steps).toHaveLength(2);
    const hazards = input.steps.flatMap((step) => step.hazards);
    expect(hazards).toHaveLength(5);
    expect(hazards[0].later_steps).toEqual([{ name: 'Cuisson', description: 'Étape ultérieure' }]);
    expect(options.max_completion_tokens).toBeLessThanOrEqual(2048);
  }
});

it('does not return partial results when a later batch is malformed', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  mocks.create
    .mockResolvedValueOnce({ choices: [{ message: { content: '{"summary":"Analyse","suggestions":[]}' } }] })
    .mockResolvedValueOnce({ choices: [{ message: { content: 'null' } }] });
  const { generateHaccpSurveillanceSuggestion } = await import('./groq.js');
  expect(await generateHaccpSurveillanceSuggestion({
    planTitle: 'Plan test',
    steps: [{ name: 'Stockage', hazards: Array.from({ length: 6 }, (_, index) => ({ id: `hazard-${index}` })) }],
  })).toBeNull();
});

it('classifies Groq JSON token exhaustion instead of reporting an unexpected error', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  mocks.insert.mockResolvedValue({ error: null });
  const error = new Error('max completion tokens reached before generating a valid document');
  error.error = { error: { code: 'json_validate_failed' } };
  mocks.create.mockRejectedValue(error);
  const { generateHaccpSurveillanceSuggestion } = await import('./groq.js');
  await expect(generateHaccpSurveillanceSuggestion({
    planTitle: 'Plan test',
    steps: [{ name: 'Stockage', hazards: [{ id: 'hazard-1' }] }],
  })).rejects.toThrow("Groq n'a pas pu terminer une réponse JSON valide");
  expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
    feature: 'haccp_surveillance', category: 'generation_limit',
  }));
  expect(mocks.create.mock.calls[1][0].max_completion_tokens).toBeLessThanOrEqual(4096);
});

it('rejects a length-limited completion even when its JSON parses', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  mocks.insert.mockResolvedValue({ error: null });
  mocks.create.mockResolvedValue({ choices: [{
    finish_reason: 'length',
    message: { content: '{"summary":"Partial","suggestions":[]}' },
  }] });
  const { generateHaccpSurveillanceSuggestion } = await import('./groq.js');
  await expect(generateHaccpSurveillanceSuggestion({
    planTitle: 'Plan test',
    steps: [{ name: 'Stockage', hazards: [{ id: 'hazard-1' }] }],
  })).rejects.toThrow('limite de génération');
  expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ category: 'generation_limit' }));
  expect(mocks.create).toHaveBeenCalledTimes(2);
});

it('splits truncated batches down to single hazards without losing process context or ordering', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  mocks.insert.mockResolvedValue({ error: null });
  mocks.create.mockImplementation(async ({ messages }) => {
    const input = JSON.parse(messages[1].content);
    const hazards = input.steps.flatMap((step) => step.hazards);
    if (hazards.length > 1) {
      const error = new Error('max completion tokens reached before generating a valid document');
      error.error = { code: 'json_validate_failed' };
      throw error;
    }
    expect(input.steps[1].name).toBe('Cuisson');
    expect(hazards[0].later_steps[0].name).toBe('Cuisson');
    return { choices: [{ message: { content: JSON.stringify({
      summary: 'Analyse',
      suggestions: [{ hazard_id: hazards[0].hazard_id }],
    }) } }] };
  });
  const { generateHaccpSurveillanceSuggestion } = await import('./groq.js');
  const ids = Array.from({ length: 5 }, (_, index) => `hazard-${index}`);
  const result = await generateHaccpSurveillanceSuggestion({
    planTitle: 'Plan test',
    steps: [
      { name: 'Stockage', hazards: ids.map((id) => ({ id })) },
      { name: 'Cuisson', hazards: [] },
    ],
  });
  expect(result.suggestions.map((item) => item.hazard_id)).toEqual(ids);
  expect(mocks.create).toHaveBeenCalledTimes(9);
});

it('increases the singleton budget once and can recover a length-limited completion', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  mocks.insert.mockResolvedValue({ error: null });
  mocks.create
    .mockResolvedValueOnce({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })
    .mockResolvedValueOnce({ choices: [{ message: { content: '{"summary":"Analyse","suggestions":[{"hazard_id":"hazard-1"}]}' } }] });
  const { generateHaccpSurveillanceSuggestion } = await import('./groq.js');
  const result = await generateHaccpSurveillanceSuggestion({
    planTitle: 'Plan test', steps: [{ name: 'Stockage', hazards: [{ id: 'hazard-1' }] }],
  });
  expect(result.suggestions).toEqual([{ hazard_id: 'hazard-1' }]);
  expect(mocks.create.mock.calls[1][0].max_completion_tokens).toBeLessThanOrEqual(4096);
});

it('does not split or retry a JSON error unrelated to token exhaustion', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  mocks.insert.mockResolvedValue({ error: null });
  const error = new Error('Failed to generate JSON: invalid output');
  error.error = { code: 'json_validate_failed' };
  mocks.create.mockRejectedValue(error);
  const { generateHaccpSurveillanceSuggestion } = await import('./groq.js');
  await expect(generateHaccpSurveillanceSuggestion({
    planTitle: 'Plan test', steps: [{ name: 'Stockage', hazards: [{ id: 'hazard-1' }, { id: 'hazard-2' }] }],
  })).rejects.toThrow('produire une réponse JSON valide');
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ category: 'malformed_response' }));
});

it('does not retry or split when the provider quota is exhausted', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  mocks.insert.mockResolvedValue({ error: null });
  const { default: Groq } = await import('groq-sdk');
  mocks.create.mockRejectedValue(new Groq.RateLimitError('Rate limit exceeded'));
  const { generateHaccpSurveillanceSuggestion } = await import('./groq.js');
  await expect(generateHaccpSurveillanceSuggestion({
    planTitle: 'Plan test', steps: [{ name: 'Stockage', hazards: [{ id: 'hazard-1' }, { id: 'hazard-2' }] }],
  })).rejects.toThrow('Quota Groq dépassé');
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ category: 'rate_limit' }));
});

it('rejects the whole analysis if a split batch still exhausts its singleton budget', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  mocks.insert.mockResolvedValue({ error: null });
  mocks.create.mockImplementation(async ({ messages }) => {
    const hazards = JSON.parse(messages[1].content).steps.flatMap((step) => step.hazards);
    if (hazards.length === 1 && hazards[0].hazard_id === 'hazard-1') {
      return { choices: [{ message: { content: '{"summary":"Analyse","suggestions":[{"hazard_id":"hazard-1"}]}' } }] };
    }
    return { choices: [{ finish_reason: 'length', message: { content: '{}' } }] };
  });
  const { generateHaccpSurveillanceSuggestion } = await import('./groq.js');
  await expect(generateHaccpSurveillanceSuggestion({
    planTitle: 'Plan test', steps: [{ name: 'Stockage', hazards: [{ id: 'hazard-1' }, { id: 'hazard-2' }] }],
  })).rejects.toThrow('limite de génération');
  expect(mocks.create).toHaveBeenCalledTimes(4);
});

it('does not send a request when the global quota cannot reserve its budget', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  const { reserveGroqCall, finishGroqCall } = await import('./groqQuota.js');
  reserveGroqCall.mockRejectedValueOnce(new Error('Plafond global IA insuffisant'));
  const { generateHaccpSurveillanceSuggestion } = await import('./groq.js');
  await expect(generateHaccpSurveillanceSuggestion({
    planTitle: 'Plan test', steps: [{ name: 'Stockage', hazards: [{ id: 'hazard-1' }] }],
  })).rejects.toThrow('Plafond global IA');
  expect(mocks.create).not.toHaveBeenCalled();
  expect(finishGroqCall).not.toHaveBeenCalled();
});

it('records actual usage before rejecting invalid JSON content', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  mocks.insert.mockResolvedValue({ error: null });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { finishGroqCall } = await import('./groqQuota.js');
  mocks.create.mockResolvedValue({ usage: { total_tokens: 123 }, choices: [{ message: { content: '{invalid' } }] });
  const { generateHaccpSurveillanceSuggestion } = await import('./groq.js');
  try {
    await expect(generateHaccpSurveillanceSuggestion({
      planTitle: 'Plan test', steps: [{ name: 'Stockage', hazards: [{ id: 'hazard-1' }] }],
    })).rejects.toThrow('Réponse Groq mal formée');
    expect(finishGroqCall).toHaveBeenCalledWith('test-call', { total_tokens: 123 });
  } finally {
    log.mockRestore();
  }
});

it('reserves and finalizes each split attempt separately, including failures', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  mocks.insert.mockResolvedValue({ error: null });
  const { reserveGroqCall, finishGroqCall } = await import('./groqQuota.js');
  mocks.create.mockResolvedValueOnce({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })
    .mockResolvedValueOnce({ usage: { total_tokens: 42 }, choices: [{ message: { content: '{"summary":"Analyse","suggestions":[]}' } }] })
    .mockResolvedValueOnce({ usage: { total_tokens: 43 }, choices: [{ message: { content: '{"summary":"Analyse","suggestions":[]}' } }] });
  const { generateHaccpSurveillanceSuggestion } = await import('./groq.js');
  await generateHaccpSurveillanceSuggestion({
    planTitle: 'Plan test', steps: [{ name: 'Stockage', hazards: [{ id: 'hazard-1' }, { id: 'hazard-2' }] }],
  });
  expect(reserveGroqCall).toHaveBeenCalledTimes(3);
  expect(finishGroqCall).toHaveBeenCalledTimes(3);
  expect(finishGroqCall).toHaveBeenCalledWith('test-call', { total_tokens: 42 });
  expect(finishGroqCall).toHaveBeenCalledWith('test-call', { total_tokens: 43 });
});

it('keeps every sent request within 8000 input-plus-output tokens even on a singleton retry', async () => {
  vi.stubEnv('GROQ_API_KEY', 'test-only-key');
  mocks.insert.mockResolvedValue({ error: null });
  mocks.create.mockResolvedValueOnce({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })
    .mockResolvedValueOnce({ choices: [{ message: { content: '{"summary":"Analyse","suggestions":[]}' } }] });
  const { generateHaccpSurveillanceSuggestion } = await import('./groq.js');
  const { reserveGroqCall, groqTokenBudget } = await import('./groqQuota.js');
  await generateHaccpSurveillanceSuggestion({
    planTitle: 'Plan test',
    steps: [{ name: 'Stockage', hazards: [{ id: 'hazard-1', description: 'Listeria' }] }],
  });
  expect(mocks.create).toHaveBeenCalledTimes(2);
  for (const [options] of mocks.create.mock.calls) {
    expect(options.reasoning_effort).toBe('low');
    expect(groqTokenBudget(options.messages[0].content, options.messages[1].content, options.max_completion_tokens)).toBeLessThanOrEqual(8000);
  }
  for (const [, budget, options] of reserveGroqCall.mock.calls) {
    expect(budget).toBeLessThanOrEqual(8000);
    expect(options.waitForMinute).toBe(true);
  }
});
