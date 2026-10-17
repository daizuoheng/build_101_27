-- Recepción: sesiones ciudadanas, reportes (borrador/confirmado), conversación y adjuntos.

create table citizen_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  channel text not null default 'web',
  external_identity text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table reports (
  id uuid primary key default gen_random_uuid(),
  citizen_session_id uuid not null references citizen_sessions(id),
  territory_id uuid references territories(id),
  area_id uuid references areas(id),
  public_code text unique,
  status text not null default 'draft' check (status in ('draft', 'confirmed')),
  revision int not null default 1,
  description text,
  location_text text,
  location geography(Point, 4326),
  location_source text check (location_source in ('gps', 'map', 'geocoded')),
  location_confirmed boolean not null default false,
  processing text not null default 'pending' check (processing in ('pending', 'running', 'done', 'error')),
  outcome text check (outcome in ('applicable', 'unrelated', 'insufficient', 'out_of_coverage')),
  grouping text not null default 'pending' check (grouping in ('pending', 'linked', 'review')),
  confirm_key text,
  confirmed_at timestamptz,
  confirmed_revision int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status = 'draft' or (public_code is not null and confirmed_revision is not null))
);
create index reports_location_gix on reports using gist (location);
create index reports_session_idx on reports (citizen_session_id, created_at desc);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null unique references reports(id),
  citizen_session_id uuid not null references citizen_sessions(id),
  revision int not null default 1,
  clarification_rounds int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id),
  seq int not null,
  role text not null check (role in ('citizen', 'assistant', 'system')),
  body text not null,
  origin text not null check (origin in ('human', 'template', 'llm')),
  client_message_id text,
  llm_run_id uuid,
  ui jsonb,
  created_at timestamptz not null default now(),
  unique (conversation_id, client_message_id),
  unique (conversation_id, seq)
);

create table attachments (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id),
  message_id uuid references messages(id),
  storage_key text not null,
  content_type text not null,
  bytes int not null,
  sha256 text not null,
  width int,
  height int,
  derived_from_id uuid references attachments(id),
  purpose text not null check (purpose in ('original', 'jev')),
  created_at timestamptz not null default now()
);
create index attachments_report_idx on attachments (report_id);

create table geocode_cache (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  query_norm text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique (provider, query_norm)
);
