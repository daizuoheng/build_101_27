-- Accesibilidad con un valor intermedio: `partial` es una ruta accesible angostada o dañada que todavía se puede usar.
-- `affected` queda para la ruta inutilizable (ALCANCE §5: «rampa o recorrido peatonal inutilizable»).
alter table report_evaluations drop constraint report_evaluations_accessibility_check;
alter table report_evaluations add constraint report_evaluations_accessibility_check
  check (accessibility in ('affected', 'partial', 'not_affected', 'undetermined'));

alter table incidents drop constraint incidents_accessibility_check;
alter table incidents add constraint incidents_accessibility_check
  check (accessibility in ('affected', 'partial', 'not_affected', 'undetermined'));
