-- Un instantané par tenant par jour des métriques du dashboard (voir GET /api/dashboard/stats,
-- computeTenantMetrics dans routes/dashboard.js), écrit uniquement par dashboardSnapshotJob.js
-- (tous les jours à 3h) — jamais par la route elle-même, pour éviter toute course entre
-- plusieurs chargements simultanés du dashboard. metrics en jsonb (un blob, pas une colonne
-- par métrique) : un nouveau widget n'a jamais besoin d'une migration pour être suivi dans le
-- temps. Comparé à l'instantané le plus proche d'il y a 30 jours pour calculer les tendances
-- affichées ("↑3 vs le mois dernier") — tenant entier uniquement, jamais par service.
create table dashboard_metric_snapshots (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  snapshot_date date not null,
  metrics       jsonb not null,
  created_at    timestamptz not null default now(),
  unique (tenant_id, snapshot_date)
);

create index idx_dashboard_metric_snapshots_tenant_date on dashboard_metric_snapshots (tenant_id, snapshot_date desc);

alter table dashboard_metric_snapshots enable row level security;

create policy dashboard_metric_snapshots_isolation on dashboard_metric_snapshots
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
