-- Respuestas de control del ciudadano («sí», «no», «enviar», consultas de estado): quedan en la conversación pero
-- no son evidencia del problema, así que ni Jev ni el LLM las reciben.
alter table messages add column control_reply boolean not null default false;

-- Tope de consultas de estado por sesión y por territorio en la última hora.
create index events_status_lookup_idx on events (created_at) where kind = 'status_lookup';
