import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), insert: vi.fn() }));
vi.mock('./supabase.js', () => ({
  supabase: { from: () => ({ insert: mocks.insert }) },
}));
vi.mock('groq-sdk', () => ({
  default: class Groq {
    chat = { completions: { create: mocks.create } };
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.create.mockReset();
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
  expect(mocks.create.mock.calls[0][0].max_completion_tokens).toBe(8192);
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
    expect(options.max_completion_tokens).toBe(8192);
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
});
