-- Una respuesta del asistente por revisión del borrador, aunque el turno sincrónico y el job compitan o se reintenten.
alter table conversations add column replied_revision int not null default 0;
