import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('groq-sdk', () => ({
  default: class Groq {
    chat = { completions: { create: mocks.create } };
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
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
    steps: [{ name: 'Stockage', hazards: [] }],
  }, ['suggestions[0].routine_frequency: required for non-CCP']);

  const prompt = mocks.create.mock.calls[0][0].messages[0].content;
  expect(prompt).toContain('jamais null ni omis');
  expect(prompt).toContain('routine_monitoring et routine_frequency sont non vides');
  expect(prompt).toContain('sans inventer une maîtrise déjà validée');
  expect(prompt).toContain('"routine_frequency": "Avant la décision');
  expect(prompt).toContain('suggestions[0].routine_frequency: required for non-CCP');
  expect(prompt).toContain('TOUS les dangers');
});
