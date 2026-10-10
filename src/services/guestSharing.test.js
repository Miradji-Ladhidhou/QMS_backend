import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GUEST_CODE_TTL_MINUTES,
  GUEST_EXPIRY_DAYS,
  GUEST_MAX_FAILED_ATTEMPTS,
  generateGuestCode,
  generateGuestToken,
  hashGuestCode,
  hashGuestToken,
  normalizeGuestEmail,
} from './guestSharing.js';
import { APP_MODULES } from './appModules.js';
import { SHAREABLE_RESOURCES } from './shareableResources.js';

let originalServiceKey;

describe('guest sharing credentials', () => {
  beforeEach(() => {
    originalServiceKey = process.env.SUPABASE_SERVICE_KEY;
    process.env.SUPABASE_SERVICE_KEY = 'test-secret-key';
  });

  afterEach(() => {
    if (originalServiceKey === undefined) delete process.env.SUPABASE_SERVICE_KEY;
    else process.env.SUPABASE_SERVICE_KEY = originalServiceKey;
  });

  it('generates an 8-digit numeric verification code', () => {
    expect(generateGuestCode()).toMatch(/^\d{8}$/);
  });

  it('generates a high-entropy URL-safe token and stores only its digest', () => {
    const token = generateGuestToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashGuestToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashGuestToken(token)).not.toBe(token);
  });

  it('keys verification-code digests with the server secret', () => {
    const digest = hashGuestCode('01234567');
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    process.env.SUPABASE_SERVICE_KEY = 'different-secret';
    expect(hashGuestCode('01234567')).not.toBe(digest);
  });

  it('normalizes invited email addresses and keeps access limits explicit', () => {
    expect(normalizeGuestEmail('  Audit@Example.COM ')).toBe('audit@example.com');
    expect(GUEST_EXPIRY_DAYS).toEqual([1, 7, 30]);
    expect(GUEST_CODE_TTL_MINUTES).toBe(15);
    expect(GUEST_MAX_FAILED_ATTEMPTS).toBe(5);
  });

  it('supports guest sharing for every record-based application module', () => {
    const coveredModules = new Set([
      ...Object.values(SHAREABLE_RESOURCES).map(({ module }) => module),
      'my-approvals',
    ]);
    const uncoveredModules = APP_MODULES.filter((module) => module !== 'dashboard' && !coveredModules.has(module));
    expect(uncoveredModules).toEqual([]);
  });
});
