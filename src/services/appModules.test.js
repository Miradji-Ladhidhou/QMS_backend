import { expect, it, vi } from 'vitest';
import { APP_MODULES, effectiveAppModules, validAppModules } from './appModules.js';
import { requireMenuVisible, requireModuleForWrites } from '../middleware/menuVisibility.js';

it('active les modules absents des réglages historiques sans écraser les désactivations explicites', () => {
  const modules = effectiveAppModules({ documents: false });
  expect(Object.keys(modules)).toHaveLength(APP_MODULES.length);
  expect(modules.documents).toBe(false);
  expect(modules.capas).toBe(true);
  expect(Object.keys(modules)).toEqual(APP_MODULES);
});

it('valide une configuration booléenne complète sans clé inconnue', () => {
  const allEnabled = effectiveAppModules({});
  expect(validAppModules(allEnabled)).toBe(true);
  expect(validAppModules({ ...allEnabled, unknown: false })).toBe(false);
  expect(validAppModules({ ...allEnabled, documents: 'false' })).toBe(false);
  const incomplete = { ...allEnabled };
  delete incomplete.documents;
  expect(validAppModules(incomplete)).toBe(false);
  expect(validAppModules([])).toBe(false);
});

it('bloque un module désactivé pour le tenant et autorise un module actif', async () => {
  const req = {
    tenantId: 'tenant-id',
    user: { id: 'user-id' },
    userRole: 'admin',
    appModules: effectiveAppModules({ documents: false }),
  };
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const next = vi.fn();

  await requireMenuVisible('documents')(req, { status, json }, next);
  expect(status).toHaveBeenCalledWith(403);
  expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'APP_MODULE_DISABLED', module: 'documents' }));
  expect(next).not.toHaveBeenCalled();

  req.appModules.documents = true;
  await requireMenuVisible('documents')(req, { status, json }, next);
  expect(next).toHaveBeenCalledOnce();
});

it('garde disponibles les lectures de référentiels et bloque leurs modifications', async () => {
  const guard = requireModuleForWrites('services');
  const req = {
    tenantId: 'tenant-id',
    user: { id: 'user-id' },
    userRole: 'admin',
    appModules: effectiveAppModules({ services: false }),
    method: 'GET',
  };
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const next = vi.fn();

  guard(req, { status, json }, next);
  expect(next).toHaveBeenCalledOnce();

  req.method = 'POST';
  await guard(req, { status, json }, next);
  expect(status).toHaveBeenCalledWith(403);
});
