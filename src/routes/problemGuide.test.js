import express from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), quota: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth(req, res, next) {
    if (!req.headers.authorization) return res.status(401).json({ error: 'Authentication required' });
    next();
  },
  requireRole: () => (_req, _res, next) => next(),
}));
vi.mock('../middleware/menuVisibility.js', () => ({ getVisibleMenuKeys: vi.fn() }));
vi.mock('../services/groq.js', () => ({
  generateProblemGuideRecommendations: mocks.generate, logAiFailure: vi.fn(),
  generateCapaSuggestion: vi.fn(), generateRiskTreatmentSuggestion: vi.fn(),
  generateHaccpSignificanceSuggestion: vi.fn(), generateHaccpCcpSuggestion: vi.fn(),
  generateHaccpSurveillanceSuggestion: vi.fn(),
}));
vi.mock('../services/aiQuota.js', () => ({ attachAiQuota: mocks.quota }));
vi.mock('../services/supabase.js', () => ({ supabase: {} }));
vi.mock('../services/aiGenerations.js', () => ({
  prepareAiResult: vi.fn(),
  aiResultRoute: (router, path, ...handlers) => router.post(path, ...handlers.flat()),
}));
import aiRoutes from './ai.js';

const app = express();
app.use(express.json());
app.use('/api/ai', aiRoutes);
beforeEach(() => vi.clearAllMocks());

it('keeps the retired guide endpoint authenticated', async () => {
  expect((await request(app).post('/api/ai/problem-guide-search').send({ query: 'produit périmé' })).status).toBe(401);
});

it.each(['produit périmé', 'situation inconnue', '', null])(
  'disables guide assistance without provider calls or quota reservations: %s', async (query) => {
    const result = await request(app).post('/api/ai/problem-guide-search').set('Authorization', 'test').send({ query });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ code: 'AI_MODULE_DISABLED', module: 'problem_guide' });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.quota).not.toHaveBeenCalled();
  },
);
