import crypto from 'crypto';
import request from 'supertest';
import { createClient } from '@supabase/supabase-js';
import app from '../app.js';
import { slugify } from '../routes/auth.js';

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

// Crée un tenant réel (fondateur = admin), puis invite un utilisateur par entrée de
// `extraUsers` (ex. [{ role: 'manager' }, { role: 'member' }]). Retourne les tokens prêts à
// l'emploi et un cleanup() qui supprime tout (le cascade ON DELETE de tenant_id efface les
// tables métier ; les comptes auth.users, qui ne cascadent pas depuis public.users, sont
// supprimés explicitement).
//
// Écrit directement via le client service-role `admin` (ci-dessus) plutôt que via une route
// HTTP : POST /api/auth/register (l'ancien point d'entrée) a été retiré — la création de
// compte en production passe désormais exclusivement par POST /super-admin/tenants, réservée
// au super admin. Reproduit ici la même séquence (créer le compte Auth, créer le tenant avec
// repli de slug en cas de collision, créer le profil public.users) que cette route effectuait
// autrefois, avec le même nettoyage en cas d'échec à une étape.
export async function createTenant({ extraUsers = [] } = {}) {
  const stamp = unique('tenant');
  const adminEmail = `${stamp}-admin@example.com`;
  const adminPassword = 'TestPassword123';
  const companyName = `Test Co ${stamp}`;

  // email_confirm: true (contrairement à la production, qui laisse false + un lien de
  // confirmation) : les tests n'ont pas besoin d'exercer ce parcours, et requireAuth ne
  // vérifie jamais email_confirmed_at (seulement que le jeton est valide et qu'un profil
  // public.users existe) — tokenFor() ci-dessus signe de toute façon un JWT valide localement.
  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email: adminEmail,
    password: adminPassword,
    email_confirm: true,
  });

  if (authError) {
    throw new Error(`createTenant: création du compte Auth a échoué : ${authError.message}`);
  }

  const adminId = authData.user.id;
  const baseSlug = slugify(companyName);

  let tenant = null;
  let tenantError = null;
  for (let attempt = 0; attempt < 5 && !tenant; attempt += 1) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await admin.from('tenants').insert({ name: companyName, slug }).select().single();
    if (!error) {
      tenant = data;
    } else if (error.code === '23505') {
      tenantError = error;
    } else {
      tenantError = error;
      break;
    }
  }

  if (!tenant) {
    await admin.auth.admin.deleteUser(adminId);
    throw new Error(`createTenant: création du tenant a échoué : ${tenantError?.message}`);
  }

  const tenantId = tenant.id;

  const { error: profileError } = await admin
    .from('users')
    .insert({ id: adminId, tenant_id: tenantId, full_name: 'Test Admin', role: 'admin' });

  if (profileError) {
    await admin.from('tenants').delete().eq('id', tenantId);
    await admin.auth.admin.deleteUser(adminId);
    throw new Error(`createTenant: création du profil admin a échoué : ${profileError.message}`);
  }

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
