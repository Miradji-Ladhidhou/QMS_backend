import crypto from 'crypto';

export const GUEST_CODE_TTL_MINUTES = 15;
export const GUEST_CODE_RESEND_COOLDOWN_SECONDS = 60;
export const GUEST_MAX_CODE_SENDS = 3;
export const GUEST_MAX_FAILED_ATTEMPTS = 5;
export const GUEST_EXPIRY_DAYS = [1, 7, 30];

export function generateGuestToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateGuestCode() {
  return crypto.randomInt(0, 100_000_000).toString().padStart(8, '0');
}

export function hashGuestToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function hashGuestCode(code) {
  return crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_KEY).update(String(code)).digest('hex');
}

export function normalizeGuestEmail(email) {
  return String(email || '').trim().toLowerCase();
}
