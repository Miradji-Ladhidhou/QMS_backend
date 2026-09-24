import { Router } from 'express';
import fs from 'fs';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';
import { logSuperAdminAction } from '../services/superAdminAudit.js';
import { logActivity } from '../services/activityLog.js';
import {
  runDatabaseBackup,
  restoreFromFile,
  getBackupPathByFilename,
  getLastLocalBackup,
} from '../services/backupService.js';
import { uploadBackupToDrive, listDriveBackups, downloadFromDrive } from '../services/googleDriveService.js';
import { slugify } from './auth.js';
import { ASSIGNABLE_ROLES, sendInviteEmail } from './users.js';

const router = Router();
const PLANS = ['free', 'starter', 'pro', 'enterprise'];
const TENANT_EXPORT_TABLES = [
  'users', 'document_categories', 'documents', 'document_versions', 'document_workflows', 'document_approvals',
  'capas', 'capa_comments', 'trainings', 'training_records', 'kpis', 'kpi_records', 'groups', 'group_members',
  'audits', 'audit_findings', 'audit_checklist_items', 'risks', 'risk_assessments', 'suppliers', 'supplier_evaluations',
  'complaints', 'customer_satisfaction', 'pdca_projects', 'qqoqccp_analyses', 'management_reviews',
  'management_review_actions', 'haccp_plans', 'haccp_hazards', 'haccp_ccps', 'tasks',
];

router.use(requireAuth);
router.use(requireSuperAdmin);

// GET /api/super-admin/tenants — tous les tenants de la plateforme, avec le nombre
// d'utilisateurs de chacun. Contourne volontairement le filtre tenant_id habituel (c'est
// tout le sens de cette route) — le client supabase du backend utilise déjà service_role et
// n'est jamais bridé par RLS, seul requireSuperAdmin protège l'accès ici.
router.get('/tenants', async (req, res) => {
  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('id, name, slug, plan, is_suspended, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les tenants.' });
  }

  const { data: users, error: usersError } = await supabase.from('users').select('tenant_id');

  if (usersError) {
    return res.status(500).json({ error: 'Impossible de récupérer les utilisateurs.' });
  }

  const userCountByTenant = {};
  for (const { tenant_id: tenantId } of users) {
    userCountByTenant[tenantId] = (userCountByTenant[tenantId] || 0) + 1;
  }

  res.json(tenants.map((tenant) => ({ ...tenant, user_count: userCountByTenant[tenant.id] || 0 })));
});

// Export métier d'un tenant pour le support et la portabilité — liste blanche de tables,
// aucune donnée d'authentification Supabase ni secret de stockage n'est incluse.
router.get('/tenants/:id/export', async (req, res) => {
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, name, slug, plan, is_suspended, timezone, created_at')
    .eq('id', req.params.id)
    .single();
  if (tenantError || !tenant) return res.status(404).json({ error: 'Tenant introuvable.' });

  const tables = {};
  for (const table of TENANT_EXPORT_TABLES) {
    const { data, error } = await supabase.from(table).select('*').eq('tenant_id', tenant.id);
    if (!error) tables[table] = data || [];
  }
  await logSuperAdminAction({
    actorId: req.user.id,
    action: 'tenant_exported',
    targetType: 'tenant',
    targetId: tenant.id,
    details: { tenant_name: tenant.name, table_count: Object.keys(tables).length },
  });
  res.setHeader('Content-Disposition', `attachment; filename="qms-tenant-${tenant.slug}.json"`);
  res.json({ exported_at: new Date().toISOString(), tenant, tables });
});

// Comptes par module pour la fiche détaillée d'un tenant — un count(head:true) par table
// plutôt qu'une seule requête agrégée : ces tables n'ont aucune relation entre elles qui
// permettrait un count groupé unique côté PostgREST.
const MODULE_COUNT_TABLES = [
  ['documents', 'documents'],
  ['capas', 'capas'],
  ['qqoqccp_analyses', 'qqoqccp'],
  ['trainings', 'trainings'],
  ['kpis', 'kpis'],
  ['tasks', 'tasks'],
  ['employees', 'employees'],
  ['services', 'services'],
];

async function fetchModuleCounts(tenantId) {
  const results = await Promise.all(
    MODULE_COUNT_TABLES.map(([table]) =>
      supabase.from(table).select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
    )
  );

  const counts = {};
  MODULE_COUNT_TABLES.forEach(([, key], index) => {
    counts[key] = results[index].count || 0;
  });
  return counts;
}

// actor_id n'est pas une clé étrangère (voir schema.sql) : pas d'embed PostgREST possible,
// jointure faite à la main — même pattern que document_audit_log dans documents.js. Un
// actor_id sans utilisateur retrouvé (compte supprimé depuis) donne simplement actor: null.
async function resolveActors(logRows) {
  const actorIds = [...new Set(logRows.map((row) => row.actor_id).filter(Boolean))];
  const actorsById = new Map();

  if (actorIds.length > 0) {
    const { data: actors } = await supabase.from('users').select('id, full_name').in('id', actorIds);
    for (const actor of actors || []) {
      actorsById.set(actor.id, actor);
    }
  }

  return logRows.map((row) => ({ ...row, actor: actorsById.get(row.actor_id) || null }));
}

// GET /api/super-admin/tenants/:id — fiche détaillée : infos tenant, utilisateurs (avec
// rôle et statut), volumes par module. Remplace le compteur global unique de GET /tenants
// par une vue exploitable pour le support/l'investigation.
router.get('/tenants/:id', async (req, res) => {
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, name, slug, plan, logo_url, is_suspended, created_at')
    .eq('id', req.params.id)
    .single();

  if (tenantError || !tenant) {
    return res.status(404).json({ error: 'Tenant introuvable.' });
  }

  const { data: users, error: usersError } = await supabase
    .from('users')
    .select('id, full_name, role, is_active, is_super_admin, created_at')
    .eq('tenant_id', tenant.id)
    .order('created_at', { ascending: true });

  if (usersError) {
    return res.status(500).json({ error: 'Impossible de récupérer les utilisateurs de ce tenant.' });
  }

  const moduleCounts = await fetchModuleCounts(tenant.id);

  const { data: recentActionRows } = await supabase
    .from('super_admin_audit_log')
    .select('id, actor_id, action, target_type, target_id, details, created_at')
    .eq('target_type', 'tenant')
    .eq('target_id', tenant.id)
    .order('created_at', { ascending: false })
    .limit(10);

  const recentActions = await resolveActors(recentActionRows || []);

  // Diagnostic de la connexion Google Drive de ce tenant (voir driveTokenRefreshJob.js côté
  // planification, JobRunsPanel côté frontend pour la vue d'ensemble) — jamais access_token/
  // refresh_token eux-mêmes (secrets), seulement de quoi diagnostiquer un ticket "mes exports
  // Drive ne partent plus" sans avoir à interroger la base directement. updated_at reflète le
  // dernier rafraîchissement RÉUSSI du jeton d'accès (voir refreshAccessTokenIfNeeded,
  // services/googleDrive.js) — un connected_by resté silencieux depuis bien plus que les 15
  // minutes du job planifié, alors que is_active vaut true, est le signal qu'un rafraîchissement
  // échoue silencieusement pour CE tenant précis (le calcul de "trop vieux" reste côté frontend,
  // même convention que STALE_BACKUP_THRESHOLD_MS dans SuperAdmin.jsx).
  const { data: driveConnectionRow } = await supabase
    .from('google_drive_connections')
    .select('google_email, is_active, token_expires_at, connected_by, created_at, updated_at')
    .eq('tenant_id', tenant.id)
    .maybeSingle();

  let driveConnection = driveConnectionRow;
  if (driveConnectionRow?.connected_by) {
    const { data: connectedByUser } = await supabase.from('users').select('full_name').eq('id', driveConnectionRow.connected_by).maybeSingle();
    driveConnection = { ...driveConnectionRow, connected_by_name: connectedByUser?.full_name || null };
  }

  res.json({ tenant, users, module_counts: moduleCounts, recent_actions: recentActions, drive_connection: driveConnection || null });
});

// POST /api/super-admin/tenants — crée un tenant, avec repli sur un slug suffixé en cas de
// collision. Seul point d'entrée pour créer un compte QMS SaaS (l'inscription publique
// /auth/register a été retirée) : ?admin= (optionnel côté validation, mais toujours envoyé
// par CreateTenantModal côté frontend) crée ET invite dans la foulée le fondateur du tenant,
// par le même mécanisme que POST /tenants/:id/users (sendInviteEmail, voir users.js) — un seul
// geste super admin au lieu de deux routes séparées.
router.post(
  '/tenants',
  [
    body('name').trim().notEmpty().withMessage('Le nom est requis.'),
    body('plan').optional({ values: 'falsy' }).isIn(PLANS).withMessage('Plan invalide.'),
    body('admin').optional().isObject().withMessage('Administrateur invalide.'),
    body('admin.email').if(body('admin').exists()).isEmail().withMessage('Adresse email invalide.'),
    body('admin.full_name').if(body('admin').exists()).trim().notEmpty().withMessage("Le nom complet de l'administrateur est requis."),
    body('admin.role').optional({ values: 'falsy' }).isIn(ASSIGNABLE_ROLES).withMessage('Rôle invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { name, plan, admin: adminInput } = req.body;
    const baseSlug = slugify(name);

    let tenant = null;
    let tenantError = null;

    for (let attempt = 0; attempt < 5 && !tenant; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
      const { data, error } = await supabase
        .from('tenants')
        .insert({ name, slug, plan: plan || 'free' })
        .select('id, name, slug, plan, is_suspended, created_at')
        .single();

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
      const message =
        tenantError?.code === '23505'
          ? "Impossible de générer un identifiant unique pour ce tenant, réessayez."
          : 'Erreur lors de la création du tenant.';
      return res.status(tenantError?.code === '23505' ? 409 : 500).json({ error: message });
    }

    let createdAdmin = null;

    if (adminInput) {
      let inviteResult;
      try {
        inviteResult = await sendInviteEmail({ email: adminInput.email, fullName: adminInput.full_name, tenantId: tenant.id });
      } catch (err) {
        console.error("[super-admin] échec de l'envoi de l'invitation :", err);
        await supabase.from('tenants').delete().eq('id', tenant.id);
        return res.status(500).json({ error: "Erreur lors de l'envoi de l'invitation." });
      }

      if (inviteResult.error) {
        // Le tenant vient d'être créé DANS cette même requête (contrairement à
        // POST /tenants/:id/users, qui opère sur un tenant préexistant à ne jamais toucher) :
        // sur échec de l'invitation, on ne laisse pas un tenant orphelin sans administrateur.
        await supabase.from('tenants').delete().eq('id', tenant.id);
        // Le message réel de Supabase est "has already been registered" ("been" au milieu) —
        // pas juste "already registered" (voir l'ancienne route /auth/register, seule à avoir
        // couvert ce cas correctement jusqu'ici). .code === 'email_exists' est le contrôle le
        // plus fiable, le pattern texte reste en repli.
        if (inviteResult.error.code === 'email_exists' || /already (been )?registered|already exists/i.test(inviteResult.error.message)) {
          return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
        }
        return res.status(500).json({ error: "Erreur lors de l'envoi de l'invitation." });
      }

      const userId = inviteResult.userId;

      // Défaut 'admin' ici (pas 'member' comme sur /tenants/:id/users) : c'est le fondateur du
      // tenant, pas un collègue ajouté après coup.
      const { data: profile, error: profileError } = await supabase
        .from('users')
        .insert({ id: userId, tenant_id: tenant.id, full_name: adminInput.full_name, role: adminInput.role || 'admin' })
        .select('id, full_name, role, is_active, created_at')
        .single();

      if (profileError) {
        await supabase.auth.admin.deleteUser(userId);
        await supabase.from('tenants').delete().eq('id', tenant.id);
        return res.status(500).json({ error: 'Erreur lors de la création du profil utilisateur.' });
      }

      createdAdmin = { ...profile, email: adminInput.email };

      await logSuperAdminAction({
        actorId: req.user.id,
        action: 'user_created',
        targetType: 'user',
        targetId: userId,
        details: { email: adminInput.email, tenant_name: tenant.name },
      });
      await logActivity({
        tenantId: tenant.id,
        actorId: req.user.id,
        actorEmail: req.user.email,
        action: 'USER_CREATED',
        entityType: 'user',
        entityId: userId,
        metadata: { label: adminInput.full_name },
        req,
      });
    }

    await logSuperAdminAction({
      actorId: req.user.id,
      action: 'tenant_created',
      targetType: 'tenant',
      targetId: tenant.id,
      details: adminInput ? { tenant_name: tenant.name, admin_email: adminInput.email } : { tenant_name: tenant.name },
    });
    await logActivity({
      tenantId: tenant.id,
      actorId: req.user.id,
      actorEmail: req.user.email,
      action: 'TENANT_CREATED',
      entityType: 'tenant',
      entityId: tenant.id,
      metadata: { label: tenant.name },
      req,
    });

    res.status(201).json({ ...tenant, user_count: createdAdmin ? 1 : 0, admin: createdAdmin });
  }
);

// PATCH /api/super-admin/tenants/:id — modifie n'importe quel champ du tenant (nom, slug,
// plan, suspension). requireAuth bloque simplement les utilisateurs d'un tenant suspendu,
// aucune autre donnée n'est touchée (voir middleware/auth.js).
router.patch(
  '/tenants/:id',
  [
    body('name').optional().trim().notEmpty().withMessage('Le nom ne peut pas être vide.'),
    body('slug').optional().trim().notEmpty().withMessage('Le slug ne peut pas être vide.'),
    body('plan').optional().isIn(PLANS).withMessage('Plan invalide.'),
    body('is_suspended').optional().isBoolean().withMessage('Valeur invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    if (req.body.is_suspended === true && req.tenantId === req.params.id) {
      return res.status(403).json({ error: 'Vous ne pouvez pas suspendre votre propre tenant.' });
    }

    const update = {};
    for (const field of ['name', 'slug', 'plan', 'is_suspended']) {
      if (field in req.body) update[field] = req.body[field];
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('tenants')
      .update(update)
      .eq('id', req.params.id)
      .select('id, name, slug, plan, is_suspended, created_at')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Ce slug est déjà utilisé par un autre tenant.' });
      }
      return res.status(404).json({ error: 'Tenant introuvable.' });
    }
    if (!data) {
      return res.status(404).json({ error: 'Tenant introuvable.' });
    }

    let action = 'tenant_updated';
    if ('is_suspended' in update) {
      action = update.is_suspended ? 'tenant_suspended' : 'tenant_reactivated';
    }

    await logSuperAdminAction({
      actorId: req.user.id,
      action,
      targetType: 'tenant',
      targetId: data.id,
      details: { tenant_name: data.name, updated_fields: Object.keys(update) },
    });
    await logActivity({
      tenantId: data.id,
      actorId: req.user.id,
      actorEmail: req.user.email,
      action: action.toUpperCase(),
      entityType: 'tenant',
      entityId: data.id,
      metadata: { label: data.name, changed_fields: Object.keys(update) },
      req,
    });

    res.json(data);
  }
);

// DELETE /api/super-admin/tenants/:id — supprime définitivement un tenant et toutes ses
// données (cascade SQL, voir schema.sql). Les comptes auth.users de ses membres ne sont PAS
// supprimés ici, volontairement : le supprimer rendrait toute restauration ultérieure (voir
// /backup, /restore-drive) impossible pour ces lignes — pg_dump --schema=public ne peut pas
// capturer la contrainte users_id_fkey (elle référence auth.users, hors schéma dumpé), donc un
// compte auth.users manquant fait échouer sa recréation après restauration. Un compte orphelin
// (aucun profil public.users) est inoffensif : middleware/auth.js refuse toute requête sans
// profil, donc ce compte ne peut plus rien faire tant qu'aucun profil ne lui est réassigné.
router.delete('/tenants/:id', async (req, res) => {
  if (req.tenantId === req.params.id) {
    return res.status(403).json({ error: 'Vous ne pouvez pas supprimer votre propre tenant.' });
  }

  const { data: members } = await supabase.from('users').select('id').eq('tenant_id', req.params.id);

  const { data: tenant, error } = await supabase
    .from('tenants')
    .delete()
    .eq('id', req.params.id)
    .select('id, name')
    .single();

  if (error || !tenant) {
    return res.status(404).json({ error: 'Tenant introuvable.' });
  }

  await logSuperAdminAction({
    actorId: req.user.id,
    action: 'tenant_deleted',
    targetType: 'tenant',
    targetId: tenant.id,
    details: { tenant_name: tenant.name, member_count: (members || []).length },
  });
  await logActivity({
    tenantId: tenant.id,
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: 'TENANT_DELETED',
    entityType: 'tenant',
    entityId: tenant.id,
    metadata: { label: tenant.name },
    req,
  });

  res.json({ ok: true });
});

// POST /api/super-admin/tenants/:id/users — crée et invite un utilisateur dans n'importe quel
// tenant. Même mécanisme que POST /users/invite (lien Supabase envoyé par email via notre
// pipeline Resend/Gmail), simplement sans la contrainte req.tenantId de la route tenant-scopée.
router.post(
  '/tenants/:id/users',
  [
    body('email').isEmail().withMessage('Adresse email invalide.'),
    body('full_name').trim().notEmpty().withMessage('Le nom complet est requis.'),
    body('role').optional({ values: 'falsy' }).isIn(ASSIGNABLE_ROLES).withMessage('Rôle invalide.'),
    body('is_super_admin').optional().isBoolean().withMessage('Valeur invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: tenant } = await supabase.from('tenants').select('id, name').eq('id', req.params.id).single();
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant introuvable.' });
    }

    const { email, full_name: fullName, role, is_super_admin: isSuperAdmin } = req.body;

    let inviteResult;
    try {
      inviteResult = await sendInviteEmail({ email, fullName, tenantId: tenant.id });
    } catch (err) {
      console.error("[super-admin] échec de l'envoi de l'invitation :", err);
      return res.status(500).json({ error: "Erreur lors de l'envoi de l'invitation." });
    }

    if (inviteResult.error) {
      // Voir POST /tenants ci-dessus : le message réel de Supabase contient "been"
      // ("has already been registered"), .code === 'email_exists' est le contrôle le plus fiable.
      if (inviteResult.error.code === 'email_exists' || /already (been )?registered|already exists/i.test(inviteResult.error.message)) {
        return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
      }
      return res.status(500).json({ error: "Erreur lors de l'envoi de l'invitation." });
    }

    const userId = inviteResult.userId;

    const { data: profile, error: profileError } = await supabase
      .from('users')
      .insert({
        id: userId,
        tenant_id: tenant.id,
        full_name: fullName,
        role: role || 'member',
        is_super_admin: Boolean(isSuperAdmin),
      })
      .select('id, full_name, role, is_active, is_super_admin, created_at')
      .single();

    if (profileError) {
      await supabase.auth.admin.deleteUser(userId);
      return res.status(500).json({ error: 'Erreur lors de la création du profil utilisateur.' });
    }

    await logSuperAdminAction({
      actorId: req.user.id,
      action: 'user_created',
      targetType: 'user',
      targetId: userId,
      details: { email, tenant_name: tenant.name },
    });
    await logActivity({
      tenantId: tenant.id,
      actorId: req.user.id,
      actorEmail: req.user.email,
      action: 'USER_CREATED',
      entityType: 'user',
      entityId: userId,
      metadata: { label: email },
      req,
    });

    res.status(201).json({ ...profile, email });
  }
);

// PATCH /api/super-admin/users/:id — modifie n'importe quel utilisateur, tous tenants
// confondus (rôle, statut actif, statut super admin, ou transfert vers un autre tenant).
router.patch(
  '/users/:id',
  [
    body('full_name').optional().trim().notEmpty().withMessage('Le nom complet ne peut pas être vide.'),
    body('role').optional().isIn(ASSIGNABLE_ROLES).withMessage('Rôle invalide.'),
    body('is_active').optional().isBoolean().withMessage('Valeur invalide.'),
    body('is_super_admin').optional().isBoolean().withMessage('Valeur invalide.'),
    body('tenant_id').optional().isUUID().withMessage('Tenant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const fields = ['full_name', 'role', 'is_active', 'is_super_admin', 'tenant_id'];
    if (!fields.some((field) => field in req.body)) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const isSelf = req.params.id === req.user.id;
    if (isSelf && 'is_active' in req.body && req.body.is_active === false) {
      return res.status(403).json({ error: 'Vous ne pouvez pas désactiver votre propre compte.' });
    }
    if (isSelf && 'is_super_admin' in req.body && req.body.is_super_admin === false) {
      return res.status(403).json({ error: 'Vous ne pouvez pas retirer vos propres droits super admin.' });
    }

    if ('tenant_id' in req.body) {
      const { data: targetTenant } = await supabase.from('tenants').select('id').eq('id', req.body.tenant_id).single();
      if (!targetTenant) {
        return res.status(400).json({ error: 'Tenant cible introuvable.' });
      }
    }

    const update = {};
    for (const field of fields) {
      if (field in req.body) update[field] = req.body[field];
    }

    const { data, error } = await supabase
      .from('users')
      .update(update)
      .eq('id', req.params.id)
      .select('id, full_name, role, is_active, is_super_admin, tenant_id, created_at')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    await logSuperAdminAction({
      actorId: req.user.id,
      action: 'user_updated',
      targetType: 'user',
      targetId: data.id,
      details: { updated_fields: Object.keys(update) },
    });
    await logActivity({
      tenantId: data.tenant_id,
      actorId: req.user.id,
      actorEmail: req.user.email,
      action: 'USER_UPDATED',
      entityType: 'user',
      entityId: data.id,
      metadata: { label: data.full_name, changed_fields: Object.keys(update) },
      req,
    });
    // Distinct de USER_UPDATED (explicitement demandé) : un changement de rôle est le seul
    // champ qu'un auditeur cherche systématiquement, mérite sa propre action filtrable.
    if ('role' in update) {
      await logActivity({
        tenantId: data.tenant_id,
        actorId: req.user.id,
        actorEmail: req.user.email,
        action: 'USER_ROLE_CHANGED',
        entityType: 'user',
        entityId: data.id,
        metadata: { label: data.full_name, role: data.role },
        req,
      });
    }

    res.json(data);
  }
);

// DELETE /api/super-admin/users/:id — suppression DÉFINITIVE d'un utilisateur, tous tenants
// confondus (équivalent cross-tenant de DELETE /api/users/:id — voir routes/users.js pour le
// détail de la cascade : compte Supabase Auth supprimé, ce qui entraîne automatiquement la
// ligne public.users et tout ce qui en dépend, SAUF document_approvals qui survit avec
// approver_id à null). Auparavant ne supprimait que le profil public.users en laissant le
// compte Auth intact — ce qui libérait le profil sans jamais libérer l'email, empêchant de
// recréer un compte avec la même adresse (bug réel rapporté) tout en laissant l'app dans un
// état cassé pour ce compte (connexion Auth possible, mais plus aucun profil pour l'utiliser).
router.delete('/users/:id', async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(403).json({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
  }

  const { data: target, error: targetError } = await supabase
    .from('users')
    .select('id, full_name, tenant_id')
    .eq('id', req.params.id)
    .single();

  if (targetError || !target) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  const { error: deleteError } = await supabase.auth.admin.deleteUser(target.id);
  if (deleteError) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du compte.' });
  }

  await logSuperAdminAction({
    actorId: req.user.id,
    action: 'user_deleted',
    targetType: 'user',
    targetId: target.id,
    details: { full_name: target.full_name, tenant_id: target.tenant_id },
  });
  await logActivity({
    tenantId: target.tenant_id,
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: 'USER_DELETED',
    entityType: 'user',
    entityId: target.id,
    metadata: { label: target.full_name },
    req,
  });

  res.json({ ok: true });
});

// GET /api/super-admin/audit-log — journal plateforme, le plus récent en premier. ?limit=
// borné à 200 : cette route n'a pas vocation à devenir un export complet (voir plutôt
// l'export CSV/PDF des autres outils pour ce besoin), juste une vue de suivi récent.
router.get('/audit-log', async (req, res) => {
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 50;

  const { data, error } = await supabase
    .from('super_admin_audit_log')
    .select('id, actor_id, action, target_type, target_id, details, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    return res.status(500).json({ error: "Impossible de récupérer le journal d'audit." });
  }

  res.json(await resolveActors(data));
});

// sortBy sur liste blanche : jamais une colonne passée telle quelle à .order(), qui accepterait
// n'importe quel nom de colonne (voire une tentative d'injection via un nom de colonne inconnu).
const ACTIVITY_LOG_SORT_COLUMNS = ['created_at', 'action', 'entity_type', 'actor_email', 'tenant_id'];

// GET /api/super-admin/activity-log — journal d'activité plateforme complet (voir
// services/activityLog.js), paginé/filtrable/triable, consommé par SuperAdmin.jsx#AuditTab.
// Remplace GET /audit-log (borné à 200, sans filtre) comme seul endroit à consulter — celui-ci
// reste néanmoins actif (super_admin_audit_log continue d'être écrit tel quel, voir
// dual-write ci-dessus). `search` en ilike sur actor_email/action/entity_type : pas d'index
// dédié (recherche support ponctuelle, pas un besoin de performance à grande échelle comme les
// filtres exacts ci-dessus qui ont chacun leur index, voir add-activity-log-table.sql).
router.get('/activity-log', async (req, res) => {
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 50;
  const requestedPage = Number.parseInt(req.query.page, 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const sortBy = ACTIVITY_LOG_SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : 'created_at';
  const ascending = req.query.sortOrder === 'asc';

  let query = supabase.from('activity_log').select('*', { count: 'exact' });

  if (req.query.action) query = query.eq('action', req.query.action);
  if (req.query.entity) query = query.eq('entity_type', req.query.entity);
  if (req.query.actorId) query = query.eq('actor_id', req.query.actorId);
  if (req.query.tenantId) query = query.eq('tenant_id', req.query.tenantId);
  if (req.query.dateFrom) query = query.gte('created_at', req.query.dateFrom);
  if (req.query.dateTo) query = query.lte('created_at', req.query.dateTo);
  if (req.query.search) {
    const term = `%${req.query.search}%`;
    query = query.or(`actor_email.ilike.${term},action.ilike.${term},entity_type.ilike.${term}`);
  }

  const from = (page - 1) * limit;
  const { data, error, count } = await query.order(sortBy, { ascending }).range(from, from + limit - 1);

  if (error) {
    return res.status(500).json({ error: "Impossible de récupérer le journal d'activité." });
  }

  res.json({ data: await resolveActors(data), total: count || 0, page, limit });
});

// GET /api/super-admin/stats — vue d'ensemble plateforme : comptes tenants par statut/plan,
// utilisateurs totaux, et créations de tenants par mois sur les 6 derniers mois (calculé en
// JS plutôt qu'en SQL date_trunc : le volume de tenants attendu ne justifie pas une requête
// agrégée dédiée, et ça reste lisible/déboguable côté route).
router.get('/stats', async (req, res) => {
  const { data: tenants, error: tenantsError } = await supabase.from('tenants').select('plan, is_suspended, created_at');

  if (tenantsError) {
    return res.status(500).json({ error: 'Impossible de récupérer les statistiques.' });
  }

  const { count: totalUsers, error: usersError } = await supabase
    .from('users')
    .select('id', { count: 'exact', head: true });

  if (usersError) {
    return res.status(500).json({ error: 'Impossible de récupérer les statistiques.' });
  }

  const byPlan = {};
  let suspendedCount = 0;
  for (const tenant of tenants) {
    byPlan[tenant.plan] = (byPlan[tenant.plan] || 0) + 1;
    if (tenant.is_suspended) suspendedCount += 1;
  }

  const monthsBack = 6;
  const growth = [];
  const now = new Date();
  for (let i = monthsBack - 1; i >= 0; i -= 1) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthKey = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`;
    growth.push({ month: monthKey, count: 0 });
  }
  const growthByMonth = new Map(growth.map((entry) => [entry.month, entry]));
  for (const tenant of tenants) {
    const createdAt = new Date(tenant.created_at);
    const monthKey = `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, '0')}`;
    const entry = growthByMonth.get(monthKey);
    if (entry) entry.count += 1;
  }

  res.json({
    total_tenants: tenants.length,
    active_tenants: tenants.length - suspendedCount,
    suspended_tenants: suspendedCount,
    total_users: totalUsers || 0,
    by_plan: byPlan,
    tenants_created_by_month: growth,
  });
});

// GET /api/super-admin/health — vérifie que l'API répond et mesure la latence d'une requête
// triviale vers la base. Pas une vraie supervision d'infrastructure (CPU/mémoire/réseau du
// serveur d'hébergement) : ça nécessiterait les identifiants d'API de l'hébergeur (Render,
// Supabase Management API...), hors de portée de ce que l'application peut mesurer sur
// elle-même. process.uptime() reste utile pour repérer un redémarrage récent inattendu.
router.get('/health', async (req, res) => {
  const startedAt = Date.now();
  const { error } = await supabase.from('tenants').select('id').limit(1);
  const dbLatencyMs = Date.now() - startedAt;

  res.json({
    api_status: 'ok',
    db_status: error ? 'error' : 'ok',
    db_latency_ms: dbLatencyMs,
    process_uptime_seconds: Math.round(process.uptime()),
    checked_at: new Date().toISOString(),
  });
});

// Tâches planifiées connues (voir jobs/*.js) — une entrée par nom ici même si le job n'a encore
// jamais tourné (voir GET /job-runs juste en dessous), pour qu'un job qui ne s'est pas encore
// déclenché (redéploiement récent) reste visible plutôt que de disparaître silencieusement de
// la liste.
const KNOWN_JOB_NAMES = ['notificationJob', 'backupJob', 'driveTokenRefreshJob', 'dashboardSnapshotJob', 'moduleKpiJob', 'haccpReminderJob'];

// GET /api/super-admin/job-runs — dernière exécution de chaque tâche planifiée (voir
// services/jobRunTracker.js), pour repérer une tâche en échec sans éplucher les logs bruts de
// l'hébergeur. Ne renvoie que la DERNIÈRE exécution par job (voir SystemTab côté frontend) —
// pas un historique complet, ce n'est pas ce dont le support a besoin au quotidien.
router.get('/job-runs', async (req, res) => {
  const { data, error } = await supabase
    .from('job_runs')
    .select('id, job_name, started_at, finished_at, status, summary, error')
    .order('started_at', { ascending: false })
    .limit(500);

  if (error) {
    return res.status(500).json({ error: "Impossible de récupérer l'historique des tâches planifiées." });
  }

  const latestByJob = new Map();
  for (const run of data) {
    if (!latestByJob.has(run.job_name)) latestByJob.set(run.job_name, run);
  }

  const results = KNOWN_JOB_NAMES.map((jobName) => latestByJob.get(jobName) || { job_name: jobName, status: 'never_run' });
  // Une tâche renommée/retirée depuis le dernier déploiement reste visible à la suite — mieux
  // vaut un nom de job orphelin affiché qu'une exécution silencieusement invisible.
  for (const [jobName, run] of latestByJob) {
    if (!KNOWN_JOB_NAMES.includes(jobName)) results.push(run);
  }

  res.json(results);
});

async function resolveFailureTenants(rows) {
  const tenantIds = [...new Set(rows.map((row) => row.tenant_id).filter(Boolean))];
  const tenantsById = new Map();

  if (tenantIds.length > 0) {
    const { data: tenants } = await supabase.from('tenants').select('id, name').in('id', tenantIds);
    for (const t of tenants || []) {
      tenantsById.set(t.id, t);
    }
  }

  return rows.map((row) => ({ ...row, tenant: row.tenant_id ? tenantsById.get(row.tenant_id) || null : null }));
}

// GET /api/super-admin/ai-failures — appels IA (Groq) en échec les plus récents, avec le tenant
// concerné résolu (voir services/groq.js#logAiFailure, ai_call_failures dans schema.sql) — pour
// qu'un tenant qui dit "l'IA ne marche pas" puisse être diagnostiqué directement, sans lui
// demander de reproduire devant vous. tenant_id peut être null (échec hors d'une requête HTTP
// authentifiée) : tenant reste alors null aussi, jamais une erreur.
router.get('/ai-failures', async (req, res) => {
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 50;

  const { data, error } = await supabase
    .from('ai_call_failures')
    .select('id, tenant_id, feature, category, message, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    return res.status(500).json({ error: "Impossible de récupérer le journal des échecs IA." });
  }

  res.json(await resolveFailureTenants(data));
});

// GET /api/super-admin/backup-status — dernière sauvegarde locale (lue directement sur
// disque, voir getLastLocalBackup) et dernière sauvegarde Google Drive, pour repérer un job
// planifié silencieusement en échec sans avoir à éplucher les logs Render. La partie Drive est
// tolérante à l'échec (identifiants absents/invalides, API indisponible) : ne doit jamais faire
// échouer l'affichage du statut local, qui lui ne dépend d'aucun service externe.
router.get('/backup-status', async (req, res) => {
  const lastLocalBackup = getLastLocalBackup();

  let lastDriveBackup = null;
  try {
    const [mostRecent] = await listDriveBackups(1);
    if (mostRecent) {
      lastDriveBackup = {
        name: mostRecent.name,
        created_at: mostRecent.createdTime,
        size_bytes: mostRecent.size ? Number(mostRecent.size) : null,
      };
    }
  } catch {
    // Drive non configuré ou indisponible : le statut local reste utile sans lui.
  }

  res.json({ last_local_backup: lastLocalBackup, last_drive_backup: lastDriveBackup });
});

// POST /api/super-admin/backup — sauvegarde locale (schéma public uniquement, voir
// backupService) téléchargeable ensuite via GET /backups/:filename.
router.post('/backup', async (req, res) => {
  let backup;
  try {
    backup = await runDatabaseBackup();
  } catch (err) {
    console.error('[super-admin] échec de la sauvegarde :', err.message);
    return res.status(err.statusCode || 500).json({ error: 'Erreur lors de la sauvegarde.' });
  }

  await logSuperAdminAction({
    actorId: req.user.id,
    action: 'db_backup_created',
    targetType: 'platform',
    details: { filename: backup.filename, size_bytes: backup.sizeBytes, destination: 'local' },
  });
  await logActivity({
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: 'BACKUP_CREATED',
    entityType: 'backup',
    metadata: { label: backup.filename, size_bytes: backup.sizeBytes, destination: 'local' },
    req,
  });

  res.json({
    filename: backup.filename,
    size_bytes: backup.sizeBytes,
    created_at: backup.createdAt,
    download_url: `/super-admin/backups/${backup.filename}`,
  });
});

// GET /api/super-admin/backups/:filename — téléchargement d'une sauvegarde locale.
router.get('/backups/:filename', async (req, res) => {
  const filePath = getBackupPathByFilename(req.params.filename);
  if (!filePath) {
    return res.status(400).json({ error: 'Nom de fichier invalide.' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Sauvegarde introuvable.' });
  }

  await logSuperAdminAction({
    actorId: req.user.id,
    action: 'db_backup_downloaded',
    targetType: 'platform',
    details: { filename: req.params.filename },
  });
  await logActivity({
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: 'BACKUP_DOWNLOADED',
    entityType: 'backup',
    metadata: { label: req.params.filename },
    req,
  });

  res.download(filePath, req.params.filename);
});

// POST /api/super-admin/backup-drive — sauvegarde locale puis envoi sur Google Drive.
router.post('/backup-drive', async (req, res) => {
  let backup;
  try {
    backup = await runDatabaseBackup();
  } catch (err) {
    console.error('[super-admin] échec de la sauvegarde :', err.message);
    return res.status(err.statusCode || 500).json({ error: 'Erreur lors de la sauvegarde.' });
  }

  let driveFile;
  try {
    driveFile = await uploadBackupToDrive(backup.filePath, backup.filename);
  } catch (err) {
    console.error('[super-admin] échec de l\'envoi sur Drive :', err.message);
    return res.status(err.statusCode || 500).json({ error: "Erreur lors de l'envoi sur Google Drive." });
  }

  await logSuperAdminAction({
    actorId: req.user.id,
    action: 'db_backup_created',
    targetType: 'platform',
    details: {
      filename: backup.filename,
      size_bytes: backup.sizeBytes,
      destination: 'google_drive',
      drive_file_id: driveFile.id,
    },
  });
  await logActivity({
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: 'BACKUP_CREATED',
    entityType: 'backup',
    metadata: { label: backup.filename, size_bytes: backup.sizeBytes, destination: 'google_drive' },
    req,
  });

  res.json({
    filename: backup.filename,
    size_bytes: backup.sizeBytes,
    created_at: backup.createdAt,
    drive: { file_id: driveFile.id, name: driveFile.name, web_view_link: driveFile.webViewLink },
  });
});

// GET /api/super-admin/drive-backups — liste des sauvegardes présentes sur Google Drive.
router.get('/drive-backups', async (req, res) => {
  try {
    const files = await listDriveBackups(30);
    res.json(
      files.map((file) => ({
        id: file.id,
        name: file.name,
        size_bytes: file.size ? Number(file.size) : null,
        created_at: file.createdTime,
        web_view_link: file.webViewLink,
      }))
    );
  } catch (err) {
    console.error('[super-admin] échec de la liste des sauvegardes Drive :', err.message);
    res.status(err.statusCode || 500).json({ error: 'Impossible de récupérer les sauvegardes Google Drive.' });
  }
});

// POST /api/super-admin/restore-drive — restaure la base (schéma public) depuis une sauvegarde
// Google Drive. Irréversible : écrase toutes les données actuelles de tous les tenants. Une
// sauvegarde locale de sécurité est prise juste avant, au cas où le fichier restauré serait
// corrompu ou inadapté — elle n'annule pas la restauration en cas d'erreur.
router.post(
  '/restore-drive',
  [body('file_id').trim().notEmpty().withMessage('file_id est requis.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { file_id: fileId } = req.body;

    // Le token OAuth Drive a le scope large `drive`, pas `drive.file` — sans ce contrôle,
    // n'importe quel fichier accessible à ce compte Google (pas seulement nos sauvegardes)
    // pourrait être téléchargé puis exécuté tel quel comme script SQL sur la base.
    let driveFile;
    try {
      const backups = await listDriveBackups(30);
      driveFile = backups.find((file) => file.id === fileId);
    } catch (err) {
      console.error('[super-admin] échec de la vérification du fichier Drive :', err.message);
      return res.status(500).json({ error: 'Impossible de vérifier ce fichier sur Google Drive.' });
    }
    if (!driveFile) {
      return res.status(404).json({ error: 'Ce fichier ne fait pas partie des sauvegardes du dossier configuré.' });
    }

    try {
      await runDatabaseBackup();
    } catch (err) {
      console.error('[super-admin] échec de la sauvegarde de sécurité pré-restauration :', err.message);
      return res.status(500).json({ error: 'Sauvegarde de sécurité impossible : restauration annulée par précaution.' });
    }

    let tempPath;
    let reconcileResult;
    try {
      tempPath = await downloadFromDrive(fileId, driveFile.name);
      reconcileResult = await restoreFromFile(tempPath);
    } catch (err) {
      console.error('[super-admin] échec de la restauration :', err.message);
      return res.status(err.statusCode || 500).json({ error: 'Erreur lors de la restauration.' });
    } finally {
      if (tempPath && fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // fichier temporaire déjà absent
        }
      }
    }

    await logSuperAdminAction({
      actorId: req.user.id,
      action: 'db_restored_from_drive',
      targetType: 'platform',
      details: {
        filename: driveFile.name,
        drive_file_id: fileId,
        orphaned_profiles_removed: reconcileResult?.orphanedProfilesRemoved || 0,
      },
    });
    await logActivity({
      actorId: req.user.id,
      actorEmail: req.user.email,
      action: 'BACKUP_RESTORED',
      entityType: 'backup',
      metadata: {
        label: driveFile.name,
        orphaned_profiles_removed: reconcileResult?.orphanedProfilesRemoved || 0,
      },
      req,
    });

    res.json({ ok: true, orphaned_profiles_removed: reconcileResult?.orphanedProfilesRemoved || 0 });
  }
);

export default router;
