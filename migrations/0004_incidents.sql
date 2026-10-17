-- Incidentes, vínculos reporte-incidente y overrides humanos por campo.

create table incidents (
  id uuid primary key default gen_random_uuid(),
  territory_id uuid not null references territories(id),
  area_id uuid references areas(id),
  revision int not null default 1,
  problem_type_id uuid references problem_types(id),
  severity text not null default 'undetermined' check (severity in ('low', 'medium', 'high', 'undetermined')),
  active_hazard boolean not null default false,
  passage text not null default 'undetermined' check (passage in ('total', 'partial', 'none', 'undetermined')),
  accessibility text not null default 'undetermined' check (accessibility in ('affected', 'not_affected', 'undetermined')),
  location geography(Point, 4326) not null,
  location_text text,
  title text,
  summary text,
  priority_band text not null default 'unknown' check (priority_band in ('high', 'medium', 'low', 'unknown')),
  priority_breakdown jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'assigned', 'in_progress', 'resolved', 'archived')),
  dispatch_blocked boolean not null default false,
  resolved_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index incidents_location_gix on incidents using gist (location);
create index incidents_territory_status_idx on incidents (territory_id, status);

create table report_incident_links (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id),
  incident_id uuid not null references incidents(id),
  active boolean not null default true,
  origin text not null check (origin in ('auto', 'manual')),
  grouping_decision_id uuid references grouping_decisions(id),
  created_at timestamptz not null default now(),
  deactivated_at timestamptz,
  deactivation_reason text
);
create unique index report_incident_links_one_active on report_incident_links (report_id) where active;
create index report_incident_links_incident_idx on report_incident_links (incident_id) where active;

create table incident_overrides (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id),
  field text not null check (field in ('problem_type_id', 'severity', 'priority_band', 'location', 'status')),
  value jsonb not null,
  reason text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid
);
create unique index incident_overrides_one_live on incident_overrides (incident_id, field) where removed_at is null;

alter table grouping_decisions add constraint grouping_decisions_incident_fk
  foreign key (chosen_incident_id) references incidents(id);
alter table incident_assessments add constraint incident_assessments_incident_fk
  foreign key (incident_id) references incidents(id);
