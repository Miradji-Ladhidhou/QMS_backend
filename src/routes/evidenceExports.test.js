import 'express-async-errors';
import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import JSZip from 'jszip';

const state = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../services/supabase.js', () => ({ supabase: { from: state.from } }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => { req.tenantId = 'tenant-id'; req.user = { id: 'user-id' }; req.userRole = 'admin'; next(); },
  requireRole: () => (req, res, next) => next(),
}));
vi.mock('../middleware/menuVisibility.js', () => ({ requireMenuVisible: () => (req, res, next) => next() }));
vi.mock('../middleware/genericCategoryPermissions.js', async (importOriginal) => ({
  ...(await importOriginal()),
  hasGenericCategoryPermission: async () => true,
}));

import capas from './capas.js';
import audits from './audits.js';
import complaints from './complaints.js';
import accidents from './accidents.js';
import nonconformingOutputs from './nonconformingOutputs.js';
import haccp from './haccp.js';
import risks from './risks.js';
import suppliers from './suppliers.js';
import pdca from './pdca.js';
import qqoqccp from './qqoqccp.js';

const app = express();
app.use(express.json());
for (const [name, router] of Object.entries({ capas, audits, complaints, accidents, 'nonconforming-outputs': nonconformingOutputs, haccp, risks, suppliers, pdca, qqoqccp })) {
  app.use(`/api/${name}`, router);
}
app.use((error, req, res, next) => res.status(500).json({ error: error.message }));

const RECORD = '11111111-1111-4111-8111-111111111111';
const endpoints = [
  ...['capas', 'audits', 'complaints', 'risks', 'suppliers', 'pdca', 'qqoqccp'].flatMap((moduleKey) => ['pdf', 'word'].map((format) => `/api/${moduleKey}/${RECORD}/${format}`)),
  ...['accidents', 'nonconforming-outputs'].flatMap((moduleKey) => ['pdf', 'word'].map((format) => `/api/${moduleKey}/${RECORD}/report.${format}`)),
  ...['pdf', 'word'].map((format) => `/api/haccp/plans/${RECORD}/${format}`),
];

it.each(endpoints)('validates photo selection immediately on %s without first opening a record', async (endpoint) => {
  const res = await request(app).get(endpoint).query({ evidenceSelections: 'invalid-json' });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('La sélection des photos à exporter est invalide.');
});

it('validates selections for combined HACCP exports too', async () => {
  const res = await request(app).post('/api/haccp/plans/pdf').query({ evidenceSelections: 'invalid-json' }).send({});
  expect(res.status).toBe(400);
});

it.each([
  ['accidents', 'report.pdf'],
  ['accidents', 'report.word'],
  ['nonconforming-outputs', 'report.pdf'],
  ['nonconforming-outputs', 'report.word'],
  ['pdca', 'pdf'],
  ['pdca', 'word'],
  ['qqoqccp', 'pdf'],
  ['qqoqccp', 'word'],
])('exports %s %s without photos directly, preserving document content', async (moduleKey, format) => {
  const record = {
    id: RECORD, title: 'Titre conservé', description: 'Description conservée', status: 'draft',
    created_at: '2026-10-08', plan_content: 'Plan conservé', qui: 'Réponse conservée',
  };
  state.from.mockImplementation((table) => {
    const query = {
      select: () => query,
      eq: () => query,
      single: async () => ({ data: table === 'tenants' ? { name: 'Entreprise de test' } : table === 'users' ? { full_name: 'Test' } : record, error: null }),
      maybeSingle: async () => ({ data: record, error: null }),
    };
    return query;
  });
  const res = await request(app).get(`/api/${moduleKey}/${RECORD}/${format}`).query({
    evidenceSelections: JSON.stringify({ [`${moduleKey}:${RECORD}`]: [] }),
  }).responseType('blob');
  expect(res.status).toBe(200);
  if (format.endsWith('pdf')) {
    expect(Buffer.from(res.body).subarray(0, 4).toString()).toBe('%PDF');
  } else {
    const zip = await JSZip.loadAsync(res.body);
    const xml = await zip.file('word/document.xml').async('string');
    expect(xml).toContain('Titre conservé');
    if (moduleKey !== 'qqoqccp') expect(xml).toContain('Description conservée');
    if (moduleKey === 'pdca') expect(xml).toContain('Plan conservé');
    if (moduleKey === 'qqoqccp') expect(xml).toContain('Réponse conservée');
    expect(Object.keys(zip.files).filter((path) => /^word\/media\/.+/.test(path))).toHaveLength(0);
  }
});
