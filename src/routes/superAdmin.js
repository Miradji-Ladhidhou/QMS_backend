import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';
import { logSuperAdminAction } from '../services/superAdminAudit.js';

const router = Router();

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

  res.json({ tenant, users, module_counts: moduleCounts, recent_actions: recentActions });
});

// PATCH /api/super-admin/tenants/:id — suspend ou réactive un tenant. Ne supprime ni ne
// modifie aucune autre donnée : requireAuth bloque simplement ses utilisateurs tant que
// is_suspended est vrai (voir middleware/auth.js).
router.patch(
  '/tenants/:id',
  [body('is_suspended').isBoolean().withMessage('Valeur invalide.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('tenants')
      .update({ is_suspended: req.body.is_suspended })
      .eq('id', req.params.id)
      .select('id, name, slug, plan, is_suspended, created_at')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Tenant introuvable.' });
    }

    await logSuperAdminAction({
      actorId: req.user.id,
      action: req.body.is_suspended ? 'tenant_suspended' : 'tenant_reactivated',
      targetType: 'tenant',
      targetId: data.id,
      details: { tenant_name: data.name },
    });

    res.json(data);
  }
);

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

export default router;
