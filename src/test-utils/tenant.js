import crypto from 'crypto';
import request from 'supertest';
import { createClient } from '@supabase/supabase-js';
import app from '../app.js';

// Garde-fou : ces helpers créent et suppriment de vrais tenants/utilisateurs. On refuse de
// tourner si SUPABASE_URL ne pointe pas vers une instance locale, pour ne jamais risquer de
// le faire contre un environnement réel par erreur de configuration.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(SUPABASE_URL)) {
  throw new Error(
    `SUPABASE_URL ("${SUPABASE_URL}") ne ressemble pas à une instance locale — tests d'intégration bloqués par sécurité.`
  );
}

// Secret JWT fixe de l'instance Supabase CLI locale (voir `supabase status`), identique pour
// toute installation locale — ce n'est pas un secret de ce projet.
const LOCAL_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

export const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJwt(payload, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${body}.${signature}`;
}

export function tokenFor(userId, email) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    { sub: userId, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, iat: now, exp: now + 7200 },
    LOCAL_JWT_SECRET
  );
}

let counter = 0;
function unique(label) {
  counter += 1;
  return `${label}-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 7)}`;
}

// Crée un tenant réel via POST /api/auth/register (fondateur = admin), puis invite un
// utilisateur par entrée de `extraUsers` (ex. [{ role: 'manager' }, { role: 'member' }]).
// Retourne les tokens prêts à l'emploi et un cleanup() qui supprime tout (le cascade
// ON DELETE de tenant_id efface les tables métier ; les comptes auth.users, qui ne
// cascadent pas depuis public.users, sont supprimés explicitement).
export async function createTenant({ extraUsers = [] } = {}) {
  const stamp = unique('tenant');
  const adminEmail = `${stamp}-admin@example.com`;
  const adminPassword = 'TestPassword123';
  const companyName = `Test Co ${stamp}`;

  const registerRes = await request(app)
    .post('/api/auth/register')
    .send({ email: adminEmail, password: adminPassword, fullName: 'Test Admin', companyName });

  if (registerRes.status !== 201) {
    throw new Error(`createTenant: /auth/register a échoué (${registerRes.status}): ${JSON.stringify(registerRes.body)}`);
  }

  const tenantId = registerRes.body.tenant.id;
  const adminId = registerRes.body.user.id;
  const adminToken = tokenFor(adminId, adminEmail);
  const authUserIds = [adminId];

  const users = [];
  for (const { role } of extraUsers) {
    const email = `${stamp}-${role}-${users.length}@example.com`;
    const inviteRes = await request(app)
      .post('/api/users/invite')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email, full_name: `Test ${role}`, role });

    if (inviteRes.status !== 201) {
      throw new Error(`createTenant: invite (${role}) a échoué (${inviteRes.status}): ${JSON.stringify(inviteRes.body)}`);
    }

    const id = inviteRes.body.id;
    authUserIds.push(id);
    users.push({ id, email, role, token: tokenFor(id, email) });
  }

  async function cleanup() {
    await admin.from('tenants').delete().eq('id', tenantId);
    await Promise.all(authUserIds.map((id) => admin.auth.admin.deleteUser(id).catch(() => {})));
  }

  return {
    tenantId,
    companyName,
    admin: { id: adminId, email: adminEmail, password: adminPassword, token: adminToken },
    users,
    cleanup,
  };
}
