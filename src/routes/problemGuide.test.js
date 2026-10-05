import express from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
import { APP_MODULES } from '../services/appModules.js';
import { aiModuleForRequest } from '../services/aiModules.js';

const mocks = vi.hoisted(() => ({
  menus: vi.fn(), generate: vi.fn(), quota: vi.fn(), logFailure: vi.fn(), context: {},
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth(req, res, next) {
    if (!req.headers.authorization) return res.status(401).json({ error: 'Authentication required' });
    req.tenantId = req.headers['x-test-tenant'] || 'tenant-a';
    req.user = { id: req.headers['x-test-user'] || 'user-a' };
    req.userRole = 'member';
    next();
  },
  requireRole: () => (_req, _res, next) => next(),
}));
vi.mock('../middleware/menuVisibility.js', () => ({ getVisibleMenuKeys: mocks.menus }));
vi.mock('../services/groq.js', () => ({
  generateProblemGuideRecommendations: mocks.generate, logAiFailure: mocks.logFailure,
  generateCapaSuggestion: vi.fn(), generateRiskTreatmentSuggestion: vi.fn(),
  generateHaccpSignificanceSuggestion: vi.fn(), generateHaccpCcpSuggestion: vi.fn(),
  generateHaccpSurveillanceSuggestion: vi.fn(),
}));
vi.mock('../services/aiQuota.js', () => ({ attachAiQuota: mocks.quota }));
vi.mock('../services/requestContext.js', () => ({ getRequestContext: () => mocks.context }));
vi.mock('../services/supabase.js', () => ({ supabase: {} }));
vi.mock('../services/aiGenerations.js', () => ({
  prepareAiResult: vi.fn(),
  aiResultRoute: (router, path, ...handlers) => router.post(path, ...handlers.flat()),
}));
import aiRoutes from './ai.js';

const app = express();
app.use(express.json());
app.use('/api/ai', aiRoutes);
const search = (body) => request(app).post('/api/ai/problem-guide-search').set('Authorization', 'test').send(body);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.menus.mockReset().mockResolvedValue(new Set(APP_MODULES));
  mocks.generate.mockReset().mockResolvedValue({ recommendations: [{ id: 'risks', score: 100 }] });
  mocks.quota.mockReset().mockImplementation(async (req) => { req.aiQuotaActionId = 'reservation'; return true; });
});

it('requires authentication and validates text before reserving quota', async () => {
  expect((await request(app).post('/api/ai/problem-guide-search').send({ query: 'situation inconnue' })).status).toBe(401);
  for (const query of ['', 'ab', null, {}, 'a'.repeat(1201)]) {
    expect((await search({ query })).status).toBe(400);
  }
  expect(mocks.quota).not.toHaveBeenCalled();
});

it.each(['produit périmé', 'produit expiré', 'DLC dépassée', 'client mécontent', 'erreur de préparation'])(
  'never calls the provider for sufficient local results: %s', async (query) => {
    const result = await search({ query });
    expect(result.status).toBe(200);
    expect(result.body.recommendations.length).toBeGreaterThan(0);
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  },
);

it('ignores client supplied tenant/modules and prompts only with server-accessible modules', async () => {
  mocks.menus.mockResolvedValue(new Set(['risks']));
  const result = await search({ query: 'Un souci organisationnel inexpliqué', tenantId: 'other', modules: ['capas', 'ishikawa'] });
  expect(result.status).toBe(200);
  expect(mocks.menus).toHaveBeenCalledWith({ tenantId: 'tenant-a', userId: 'user-a', userRole: 'member' });
  expect(mocks.generate.mock.calls[0][1].map(({ id }) => id)).toEqual(['risks']);
  expect(result.body).toEqual({ recommendations: [{ id: 'risks', score: 100 }] });
});

it('does not reserve quota with no accessible module', async () => {
  mocks.menus.mockResolvedValue(new Set());
  expect((await search({ query: 'situation inconnue' })).body).toEqual({ recommendations: [] });
  expect(mocks.quota).not.toHaveBeenCalled();
});

it('rechecks permissions after generation and merges weak local matches without duplicates', async () => {
  mocks.menus.mockResolvedValueOnce(new Set(APP_MODULES)).mockResolvedValueOnce(new Set(['kpis']));
  mocks.generate.mockResolvedValue({ recommendations: [{ id: 'kpis', score: 100 }, { id: 'risks', score: 90 }] });
  const result = await search({ query: 'beaucoup de situations inexpliquées' });
  expect(result.body).toEqual({ recommendations: [{ id: 'kpis', score: 100 }] });
  expect(mocks.quota).toHaveBeenCalledOnce();
});

it('honors disabled assistance and exhausted quotas instead of invoking the provider', async () => {
  for (const status of [403, 429]) {
    mocks.quota.mockImplementation(async (_req, res) => { res.status(status).json({ error: 'Unavailable' }); return false; });
    expect((await search({ query: 'situation inconnue' })).status).toBe(status);
  }
  expect(mocks.generate).not.toHaveBeenCalled();
});

it('explicitly fails for invented modules and provider outages', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mocks.generate.mockResolvedValue({ recommendations: [{ id: 'ishikawa', score: 100 }] });
    expect((await search({ query: 'situation inconnue' })).status).toBe(503);
    mocks.generate.mockRejectedValue(new Error('Provider unavailable'));
    expect((await search({ query: 'situation inconnue' })).status).toBe(503);
    expect(mocks.logFailure).toHaveBeenCalledTimes(2);
  } finally { log.mockRestore(); }
});

it('registers the fallback in the existing quota/module request classifier', () => {
  expect(aiModuleForRequest({ method: 'POST', baseUrl: '/api/ai', path: '/problem-guide-search' })).toBe('problem_guide');
  expect(aiModuleForRequest({ method: 'GET', baseUrl: '/api/ai', path: '/problem-guide-search' })).toBeNull();
});
