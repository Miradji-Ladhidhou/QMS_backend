import 'express-async-errors';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ record: null, failure: null, audit: vi.fn() }));
vi.mock('../services/superAdminAudit.js', () => ({ logSuperAdminAction: state.audit }));
vi.mock('../services/supabase.js', () => ({
  supabase: {
    auth: {
      getUser: async (token) => ({ data: { user: ['super', 'admin', 'member'].includes(token) ? { id: token } : null } }),
    },
    from(table) {
      const filters = {};
      let write;
      let insert = false;
      const query = {
        select: () => query,
        eq: (key, value) => { filters[key] = value; return query; },
        insert: (record) => { write = record; insert = true; return query; },
        update: (record) => { write = record; return query; },
        single: async () => ({
          data: { tenant_id: 'tenant', role: filters.id === 'member' ? 'member' : 'admin', is_super_admin: filters.id === 'super', is_active: true },
          error: null,
        }),
        maybeSingle: async () => {
          if (table !== 'platform_settings') throw new Error('Unexpected table');
          if (filters.key === 'maintenance') return { data: null, error: null };
          if (state.failure) return { data: null, error: state.failure };
          if (write) {
            if (insert && state.record) return { data: null, error: { code: '23505' } };
            if (!insert && (!state.record || state.record.updated_at !== filters.updated_at)) return { data: null, error: null };
            state.record = { ...state.record, ...structuredClone(write) };
          }
          return { data: structuredClone(state.record), error: null };
        },
      };
      return query;
    },
  },
}));

import resourcesRouter, { adminResourcesRouter } from './resources.js';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';
import { DEFAULT_RESOURCE_GROUPS } from '../services/moduleResourceDefaults.js';

const app = express();
app.use(express.json());
app.use('/api/resources', resourcesRouter);
app.use('/api/super-admin/resources', requireAuth, requireSuperAdmin, adminResourcesRouter);
app.use((err, req, res, next) => res.status(500).json({ error: 'Erreur de lecture.' }));
const auth = (req, role = 'super') => req.set('Authorization', `Bearer ${role}`);
const write = (groups, updatedAt = null) => auth(request(app).put('/api/super-admin/resources')).send({ groups, updated_at: updatedAt });

beforeEach(() => { state.record = null; state.failure = null; state.audit.mockReset(); });

describe('API des liens utiles', () => {
  it('requiert une connexion en lecture et réserve toutes les écritures au super-admin', async () => {
    expect((await request(app).get('/api/resources')).status).toBe(401);
    expect((await request(app).put('/api/super-admin/resources')).status).toBe(401);
    for (const role of ['admin', 'member']) {
      expect((await auth(request(app).get('/api/resources'), role)).status).toBe(200);
      expect((await auth(request(app).get('/api/super-admin/resources'), role)).status).toBe(403);
      expect((await auth(request(app).put('/api/super-admin/resources'), role).send({})).status).toBe(403);
    }
    expect(state.record).toBeNull();
  });

  it('publie les ajouts, modifications et suppressions en lecture avec journalisation', async () => {
    const groups = structuredClone(DEFAULT_RESOURCE_GROUPS);
    groups[0].resources.push({ label: 'Nouveau lien', source: 'Exemple', url: 'https://example.com/new' });
    const created = await write(groups);
    expect(created.status).toBe(200);
    expect(created.body.updated_at).toBeTruthy();
    expect(state.record.updated_by).toBe('super');
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'useful_links_updated', actorId: 'super' }));
    const published = await auth(request(app).get('/api/resources'), 'member');
    expect(published.body.groups[0].resources.at(-1).label).toBe('Nouveau lien');

    published.body.groups[0].resources.at(-1).label = 'Titre modifié';
    const updated = await write(published.body.groups, published.body.updated_at);
    expect(updated.status).toBe(200);
    expect(updated.body.groups[0].resources.at(-1).label).toBe('Titre modifié');
    updated.body.groups[0].resources = [];
    const removed = await write(updated.body.groups, updated.body.updated_at);
    expect(removed.status).toBe(200);
    expect((await auth(request(app).get('/api/resources'), 'member')).body.groups[0].resources).toEqual([]);
  });

  it('refuse une publication périmée ou une deuxième création au lieu d’écraser le catalogue', async () => {
    const first = await write(DEFAULT_RESOURCE_GROUPS);
    expect((await write(DEFAULT_RESOURCE_GROUPS)).status).toBe(409);
    const second = await write(DEFAULT_RESOURCE_GROUPS, first.body.updated_at);
    expect(second.status).toBe(200);
    expect(second.body.updated_at).not.toBe(first.body.updated_at);
    expect((await write(DEFAULT_RESOURCE_GROUPS, first.body.updated_at)).status).toBe(409);
  });

  it('refuse les données invalides et signale les erreurs de base sans catalogue de secours', async () => {
    expect((await write([])).status).toBe(400);
    expect((await write(DEFAULT_RESOURCE_GROUPS, 'invalid')).status).toBe(400);
    state.failure = { message: 'database unavailable' };
    expect((await auth(request(app).get('/api/resources'), 'member')).status).toBe(500);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await write(DEFAULT_RESOURCE_GROUPS)).status).toBe(500);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
    expect(state.audit).not.toHaveBeenCalled();
  });
});
