-- Configuración: territorios, áreas, catálogo, capacidades, políticas y plantillas.
-- Todo dato operativo vive en estas tablas y se carga por seeds idempotentes.

create extension if not exists postgis;
create extension if not exists pgcrypto;

create table territories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  area_label text not null,
  center geography(Point, 4326) not null,
  default_zoom int not null,
  coverage geometry(MultiPolygon, 4326),
  emergency_channel jsonb not null default '{}'::jsonb,
  locale text not null default 'es',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index territories_coverage_gix on territories using gist (coverage);

create table areas (
  id uuid primary key default gen_random_uuid(),
  territory_id uuid not null references territories(id),
  external_id text not null,
  name text not null,
  geom geometry(MultiPolygon, 4326) not null,
  source_url text,
  source_date date,
  checksum text,
  created_at timestamptz not null default now(),
  unique (territory_id, external_id)
);
create index areas_geom_gix on areas using gist (geom);

create table problem_types (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null,
  evaluation_criteria jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table territory_problem_types (
  territory_id uuid not null references territories(id),
  problem_type_id uuid not null references problem_types(id),
  enabled boolean not null default true,
  transient_window_hours int,
  primary key (territory_id, problem_type_id)
);

create table capabilities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table problem_type_requirements (
  problem_type_id uuid not null references problem_types(id),
  capability_id uuid not null references capabilities(id),
  condition text not null check (condition in ('always', 'active_hazard')),
  primary key (problem_type_id, capability_id, condition)
);

create table policy_versions (
  id uuid primary key default gen_random_uuid(),
  territory_id uuid not null references territories(id),
  kind text not null check (kind in ('intake', 'evaluation', 'grouping', 'priority', 'planning', 'dispatch', 'textgen')),
  version int not null,
  config jsonb not null,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (territory_id, kind, version)
);
create unique index policy_versions_one_active on policy_versions (territory_id, kind) where active;

create table message_templates (
  id uuid primary key default gen_random_uuid(),
  territory_id uuid references territories(id),
  key text not null,
  locale text not null,
  body text not null,
  variables jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index message_templates_natural_key
  on message_templates (coalesce(territory_id, '00000000-0000-0000-0000-000000000000'::uuid), key, locale);
