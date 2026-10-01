import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { supabase } = await import('../src/services/supabase.js');

const TENANT_NAME = 'Entreprise Test';
const TENANT_SLUG = 'entreprise-test';
const DEFAULT_PASSWORD = 'TestPassword123!';

const ACCOUNTS = [
  {
    email: 'admin@test.local',
    fullName: 'Admin Test',
    role: 'admin',
    isSuperAdmin: false,
  },
  {
    email: 'manager@test.local',
    fullName: 'Manager Test',
    role: 'manager',
    isSuperAdmin: false,
  },
  {
    email: 'membre@test.local',
    fullName: 'Membre Test',
    role: 'member',
    isSuperAdmin: false,
  },
  {
    email: 'superadmin@test.local',
    fullName: 'Super Admin Test',
    role: 'admin',
    isSuperAdmin: true,
  },
];

async function getOrCreateTenant() {
  const { data: existing } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', TENANT_SLUG)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from('tenants')
    .insert({ name: TENANT_NAME, slug: TENANT_SLUG })
    .select('id')
    .single();

  if (error) throw new Error(`Erreur création tenant : ${error.message}`);
  return created.id;
}

async function upsertAccount(account, tenantId) {
  let user;

  // 1. Chercher si l'utilisateur auth existe déjà
  let page = 1;
  while (true) {
    const { data } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (!data?.users || data.users.length === 0) break;
    const match = data.users.find((u) => u.email?.toLowerCase() === account.email.toLowerCase());
    if (match) {
      user = match;
      break;
    }
    page += 1;
  }

  if (!user) {
    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email: account.email,
      password: DEFAULT_PASSWORD,
      email_confirm: true,
    });
    if (createError) throw new Error(`Erreur création auth ${account.email} : ${createError.message}`);
    user = created.user;
    console.log(`✓ Utilisateur auth créé : ${account.email}`);
  } else {
    // Mettre à jour le mot de passe pour être certain qu'il soit connu
    const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
      password: DEFAULT_PASSWORD,
      email_confirm: true,
    });
    if (updateError) console.warn(`! Attention mise à jour mot de passe pour ${account.email} : ${updateError.message}`);
    else console.log(`✓ Mot de passe réinitialisé pour : ${account.email}`);
  }

  // 2. Profil public.users
  const { data: existingProfile } = await supabase
    .from('users')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();

  if (existingProfile) {
    const { error: profError } = await supabase
      .from('users')
      .update({
        tenant_id: tenantId,
        full_name: account.fullName,
        role: account.role,
        is_super_admin: account.isSuperAdmin,
        is_active: true,
      })
      .eq('id', user.id);
    if (profError) throw new Error(`Erreur mise à jour profil ${account.email} : ${profError.message}`);
    console.log(`✓ Profil public.users mis à jour : ${account.email} (${account.role})`);
  } else {
    const { error: profError } = await supabase.from('users').insert({
      id: user.id,
      tenant_id: tenantId,
      full_name: account.fullName,
      role: account.role,
      is_super_admin: account.isSuperAdmin,
      is_active: true,
    });
    if (profError) throw new Error(`Erreur création profil ${account.email} : ${profError.message}`);
    console.log(`✓ Profil public.users créé : ${account.email} (${account.role})`);
  }
}

async function main() {
  console.log('=== Configuration des comptes locaux de test ===');
  const tenantId = await getOrCreateTenant();
  console.log(`Tenant cible : ${TENANT_NAME} (ID: ${tenantId})`);

  for (const account of ACCOUNTS) {
    await upsertAccount(account, tenantId);
  }

  console.log('\n--- Tous les comptes locaux sont prêts ---');
  console.log(`Mot de passe commun : ${DEFAULT_PASSWORD}`);
}

main().catch((err) => {
  console.error('Erreur :', err);
  process.exit(1);
});
