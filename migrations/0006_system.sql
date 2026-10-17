-- Sistema: cola de jobs con lease, cola de revisión, eventos y usuarios internos.

create table jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  entity_type text not null,
  entity_id uuid not null,
  entity_revision int not null default 0,
  dedupe_key text not null unique,
  territory_id uuid references territories(id),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default now(),
  lease_until timestamptz,
  locked_by text,
  last_error text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_claimable_idx on jobs (run_after) where status in ('pending', 'running');

create table review_items (
  id uuid primary key default gen_random_uuid(),
  territory_id uuid references territories(id),
  kind text not null check (kind in ('insufficient_evidence', 'uncertain_duplicate', 'contradiction', 'low_confidence',
    'unknown_type', 'no_compatible_unit', 'rejected_assignment', 'incompatible_assignment', 'provider_failure', 'out_of_coverage')),
  entity_type text not null,
  entity_id uuid not null,
  reasons jsonb not null default '[]'::jsonb,
  evidence_refs jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolution jsonb,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index review_items_one_open on review_items (kind, entity_type, entity_id) where status = 'open';
create index review_items_open_idx on review_items (territory_id, created_at) where status = 'open';

create table events (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  kind text not null,
  actor_type text not null check (actor_type in ('system', 'operator', 'unit', 'citizen')),
  actor_id uuid,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index events_entity_idx on events (entity_type, entity_id, created_at);

create table internal_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  role text not null check (role in ('operator', 'unit')),
  territory_id uuid not null references territories(id),
  response_unit_id uuid references response_units(id),
  created_at timestamptz not null default now(),
  check (role <> 'unit' or response_unit_id is not null)
);
