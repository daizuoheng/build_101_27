-- Atención: unidades de respuesta, responsabilidades por zona, planes y órdenes.

create table response_units (
  id uuid primary key default gen_random_uuid(),
  territory_id uuid not null references territories(id),
  slug text not null,
  name text not null,
  unit_kind text not null,
  status text not null default 'enabled' check (status in ('enabled', 'out_of_service')),
  capacity int not null check (capacity >= 1),
  location geography(Point, 4326),
  location_updated_at timestamptz,
  service_radius_m int,
  is_demo boolean not null default false,
  delivery_target text not null default 'web_inbox',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (territory_id, slug)
);
create index response_units_location_gix on response_units using gist (location);

create table unit_capabilities (
  unit_id uuid not null references response_units(id),
  capability_id uuid not null references capabilities(id),
  primary key (unit_id, capability_id)
);

create table area_responsibilities (
  id uuid primary key default gen_random_uuid(),
  area_id uuid not null references areas(id),
  problem_type_id uuid not null references problem_types(id),
  unit_id uuid not null references response_units(id),
  precedence int not null default 0,
  created_at timestamptz not null default now(),
  unique (area_id, problem_type_id, unit_id)
);

create table plan_runs (
  id uuid primary key default gen_random_uuid(),
  territory_id uuid not null references territories(id),
  policy_version_id uuid not null references policy_versions(id),
  computed_at timestamptz not null,
  trigger text not null,
  snapshot_refs jsonb not null default '{}'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index plan_runs_territory_idx on plan_runs (territory_id, computed_at desc);

create table plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_run_id uuid not null references plan_runs(id),
  incident_id uuid not null references incidents(id),
  position int not null,
  proposed_unit_id uuid references response_units(id),
  score_breakdown jsonb not null default '{}'::jsonb,
  reasons jsonb not null default '[]'::jsonb,
  status text not null check (status in ('proposed', 'executed', 'obsolete', 'blocked', 'queued')),
  blocked_reason text,
  created_at timestamptz not null default now(),
  unique (plan_run_id, position)
);

create table assignments (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id),
  unit_id uuid not null references response_units(id),
  plan_item_id uuid references plan_items(id),
  status text not null default 'offered' check (status in ('offered', 'accepted', 'in_progress', 'completed', 'rejected', 'cancelled')),
  version int not null default 1,
  distance_m int,
  reasons jsonb not null default '[]'::jsonb,
  assessment_id uuid references incident_assessments(id),
  policy_version_id uuid references policy_versions(id),
  review_blocked boolean not null default false,
  offered_at timestamptz not null default now(),
  accepted_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  closed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index assignments_one_active_per_incident on assignments (incident_id)
  where status in ('offered', 'accepted', 'in_progress');
create index assignments_unit_active_idx on assignments (unit_id)
  where status in ('offered', 'accepted', 'in_progress');
