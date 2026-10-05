import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ single: vi.fn() }));
vi.mock('../services/supabase.js', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.single }) }) }) },
}));
import { getVisibleMenuKeys } from './menuVisibility.js';

afterEach(() => vi.restoreAllMocks());

it('does not expose default modules when user permission storage fails', async () => {
  mocks.single.mockResolvedValue({ data: null, error: { message: 'Storage unavailable' } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(getVisibleMenuKeys({
    tenantId: 'tenant', userId: 'user', userRole: 'member', appModules: {},
  })).rejects.toThrow('Impossible de vérifier les permissions');
});

it('keeps defaults for an absent config and honors explicit user restrictions', async () => {
  mocks.single.mockResolvedValueOnce({ data: null, error: null });
  const defaults = await getVisibleMenuKeys({ tenantId: 'tenant', userId: 'user', userRole: 'member', appModules: {} });
  expect(defaults.has('employees')).toBe(false);
  expect(defaults.has('risks')).toBe(true);
  mocks.single.mockResolvedValueOnce({ data: { role_hidden_items: { member: ['risks'] }, user_overrides: { user: { capas: false } } }, error: null });
  const configured = await getVisibleMenuKeys({
    tenantId: 'tenant', userId: 'user', userRole: 'member', appModules: { complaints: false },
  });
  for (const id of ['risks', 'capas', 'complaints']) expect(configured.has(id)).toBe(false);
});
