-- Corridas de IA (Jev y LLM), evaluaciones, decisiones de agrupación y textos derivados.

create table ai_runs (
  id uuid primary key default gen_random_uuid(),
  purpose text not null check (purpose in ('evaluate', 'compare', 'assess')),
  provider text not null,
  model_requested text not null,
  model_returned text,
  request_id text,
  input_refs jsonb not null default '{}'::jsonb,
  request jsonb not null,
  response jsonb,
  usage jsonb,
  latency_ms int,
  status text not null check (status in ('ok', 'error', 'timeout', 'invalid')),
  error text,
  created_at timestamptz not null default now()
);

create table report_evaluations (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id),
  report_revision int not null,
  ai_run_id uuid not null references ai_runs(id),
  policy_version_id uuid not null references policy_versions(id),
  catalog_hash text not null,
  intent text not null check (intent in ('report', 'status_query', 'other')),
  applicability text not null check (applicability in ('applicable', 'unrelated', 'insufficient')),
  problem_type_id uuid references problem_types(id),
  problem_type_choice text not null,
  severity text not null check (severity in ('low', 'medium', 'high', 'undetermined')),
  active_fire text not null check (active_fire in ('yes', 'no', 'undeterminable')),
  passage text not null check (passage in ('total', 'partial', 'none', 'undetermined')),
  accessibility text not null check (accessibility in ('affected', 'not_affected', 'undetermined')),
  location_in_text text not null check (location_in_text in ('precise', 'vague', 'absent')),
  photo_quality text not null check (photo_quality in ('useful', 'insufficient', 'no_photo')),
  contradiction text not null check (contradiction in ('consistent', 'contradiction', 'not_evaluable')),
  answers jsonb not null,
  needs_review boolean not null,
  review_reasons text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (report_id, report_revision)
);

create table grouping_decisions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id),
  ai_run_id uuid references ai_runs(id),
  candidates jsonb not null default '[]'::jsonb,
  outcome text not null check (outcome in ('same', 'different', 'uncertain', 'no_candidates')),
  chosen_incident_id uuid,
  policy_version_id uuid references policy_versions(id),
  origin text not null check (origin in ('auto', 'manual')),
  actor_id uuid,
  created_at timestamptz not null default now()
);

create table incident_assessments (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null,
  incident_revision int not null,
  ai_run_id uuid references ai_runs(id),
  reports_considered uuid[] not null,
  problem_type_id uuid references problem_types(id),
  severity text not null check (severity in ('low', 'medium', 'high', 'undetermined')),
  active_hazard boolean not null,
  evidence_summary jsonb not null default '{}'::jsonb,
  changes jsonb not null default '[]'::jsonb,
  source_counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (incident_id, incident_revision)
);

create table llm_runs (
  id uuid primary key default gen_random_uuid(),
  purpose text not null check (purpose in ('extract_address', 'clarify', 'interpret_correction', 'title', 'summary', 'explain')),
  provider text not null,
  model text not null,
  instructions_version text not null,
  entity_ref jsonb not null default '{}'::jsonb,
  input_tokens int,
  output_tokens int,
  latency_ms int,
  status text not null check (status in ('ok', 'error', 'timeout', 'invalid')),
  error text,
  output jsonb,
  created_at timestamptz not null default now()
);

alter table messages add constraint messages_llm_run_fk foreign key (llm_run_id) references llm_runs(id);

create table generated_texts (
  id uuid primary key default gen_random_uuid(),
  purpose text not null,
  entity_type text not null,
  entity_id uuid not null,
  entity_revision int not null,
  body text not null,
  "references" jsonb not null default '[]'::jsonb,
  llm_run_id uuid references llm_runs(id),
  created_at timestamptz not null default now(),
  unique (purpose, entity_type, entity_id, entity_revision)
);
