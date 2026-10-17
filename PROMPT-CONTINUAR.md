# Prompt para la nueva sesión

```text
Continuemos Radar Urbano en /Users/fededallo/Desktop/hackaton.

Primero leé HANDOFF.md y los documentos que referencia: ALCANCE-RADAR-URBANO.md, ARQUITECTURA-RADAR-URBANO.md e INTEGRACION-JEV.md. Verificá el estado actual de Git y preservá los cambios existentes. Los documentos contienen el alcance acordado; todavía no hay aplicación implementada.

Quiero pasar a implementación, empezando por validar las integraciones de IA y construir un recorrido completo funcional. Trabajá de forma incremental sin reabrir todo el brainstorming. Pedime temprano el tiempo restante y cualquier credencial o acceso imprescindible; mientras tanto avanzá con el trabajo local que no dependa de eso.

Prioridades que tenés que respetar:
- Producto generalizable; Montevideo es solo el piloto, con GeoJSON local disponible.
- LLM para conversación y generación de texto, Jev para decisiones, backend para políticas y acciones.
- Datos operativos exclusivamente en base/configuración mediante seeds idempotentes: nada hardcodeado.
- Agrupación automática de reportes, reevaluación con evidencia, planificador de atención y asignación a ResponseUnit.
- El volumen de fuentes aporta un bonus acotado dentro de la banda de prioridad; no supera riesgos mayores ni cuenta repeticiones.
- Conservar correcciones humanas, evidencia original, permisos, idempotencia y capacidad transaccional.
- WhatsApp/SMS, QR y reputación de fuentes pertenecen al roadmap, no al MVP actual.

Usá la arquitectura recomendada como punto de partida: Next.js/TypeScript, PostgreSQL, web y worker, Railway/Supabase, Jev y un LLM vía OpenAI. Elegí el modelo generativo y geocodificador con documentación actual y las credenciales disponibles. No simules integraciones reales sin indicarlo ni publiques o crees recursos pagos sin concretar previamente qué se necesita.

Empezá con un resumen breve de lo entendido y las decisiones operativas pendientes; después avanzá con la validación y el primer recorrido: conversación → borrador → confirmación → job persistido → evaluación real → incidente visible. Seguí las instrucciones del workspace y prefijá comandos shell con rtk.
```
