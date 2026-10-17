# Radar Urbano — guion del pitch

**Posicionamiento:** un sistema de triage para intendencias y entes públicos. Entra cualquier aviso ciudadano, como lo cuente el vecino; sale una lista de incidentes únicos, ordenados por riesgo, con la cuadrilla que corresponde. El vecino es la entrada de datos, no el producto.

**Tesis:** el triage de avisos ciudadanos no escala con personas (miles por día) y no se resuelve con reglas fijas (texto libre, fotos, el mismo problema contado de diez maneras). La IA interpreta; las reglas, explícitas y auditables, ordenan y asignan.

Formato build 101: **3 min de presentación y demo + 3 min de preguntas**. Habla una persona; otra maneja la demo.
Lo que va entre *[corchetes]* es lo que pasa en pantalla, no se lee.

---

## [0:00–0:30] El problema, como proceso

> Martes, once de la noche. Un contenedor se prende fuego en una esquina. Lo ven diez vecinos, y llegan diez avisos, cada uno contado distinto.
> Solo por contenedores quemados, Bomberos recibió unos cuarenta mil llamados en 2025. Y en Montevideo hubo más de dos mil reclamos de basura por día.
> Cada aviso hay que leerlo, entender qué es, ver si ya existe y decidir qué va primero. Si eso lleva un minuto por aviso, son treinta y tres horas de trabajo por día solo para ordenar, antes de que salga nadie a la calle.

*Las 33 horas son una cuenta ilustrativa (2.000 × 1 min), no un dato medido: decirla con el "si".*

## [0:30–0:45] Qué es

> Radar Urbano es un sistema de triage para intendencias y entes públicos. Entra cualquier aviso, como lo cuente el vecino, y sale una lista de incidentes únicos, ordenados por riesgo, con la cuadrilla que corresponde.
> Les muestro el triage en vivo.

## [0:45–1:20] Paso 1 — Entender

*[Celular 1 proyectado. El compañero manda una foto del contenedor en llamas y escribe: "se está prendiendo fuego el contenedor de la esquina"]*

> Llega un aviso: una foto y una frase. Sin categoría, sin formulario.

*[Aparece la respuesta]*

> El sistema ya entendió: contenedor con fuego, fuego activo, severidad alta. Falta el lugar, así que lo pide.

*[Toca "usar mi ubicación" y confirma]*

## [1:20–1:45] Paso 2 — Agrupar

*[Celular 2. Escribe: "hay mucho humo en la esquina, huele a plástico quemado" y confirma. Después, pantalla del operador; tocar "Actualizar"]*

> Llega otro aviso, de otro vecino. No dice "contenedor", dice "humo".
> Y el operador no ve dos reclamos: ve un incidente con dos reportes. La IA comparó los dos relatos y decidió que es el mismo contenedor.

## [1:45–2:15] Pasos 3 y 4 — Priorizar y asignar

*[Lista del operador: el fuego queda arriba del contenedor desbordado que se cargó antes con tres reportes]*

> Y va primero. Arriba del contenedor desbordado que cargamos antes con tres vecinos, porque acá hay fuego activo. El sistema ordena por riesgo, no por cuántos se quejan.

*[SOLO SI `operacion/t11` está mergeado y probado: vista `/operacion/plan`]*

> Y ya propone quién va: la cuadrilla más cercana que puede atender fuego, no la de limpieza. Con el motivo de cada decisión.

## [2:15–2:45] Por qué IA, y cómo sabemos que funciona

> Esto no se puede hacer con personas: no escala a miles de avisos por día. Y no se puede hacer solo con reglas: la gente escribe como quiere, manda fotos y cuenta lo mismo de diez maneras.
> Por eso la IA hace lo que una regla no puede: entender texto y foto, y decidir si dos relatos son el mismo problema. Y las reglas hacen lo que tiene que ser auditable: el orden y la asignación.
> Lo medimos: en nuestro set de prueba de agrupación acertó las 11 comparaciones. Y cuando duda, no adivina: lo manda a revisión humana.

## [2:45–3:00] Cierre

> Hoy funciona el triage completo: entender, agrupar, priorizar *[y proponer la cuadrilla]*. Lo que sigue es despachar la orden al celular de la cuadrilla.
> Diez avisos, un incidente, lo urgente primero. Eso es Radar Urbano.

*Si el planificador no llegó: sacar "con la cuadrilla que corresponde" del bloque "Qué es", el bloque del plan y el corchete del cierre; y el cierre dice "Lo que sigue es asignar y despachar cuadrillas".*

**Si hay que cortar tiempo, en este orden:** (1) "Y en Montevideo hubo más de dos mil reclamos de basura por día" — ojo: si se corta, las 33 horas pierden su base, así que se cortan las dos frases juntas; (2) "Y las reglas hacen lo que tiene que ser auditable…" (pasa a las preguntas); (3) "Con el motivo de cada decisión".

---

## Notas para quien maneja la demo

- **Antes de subir:** `reset-demo`; la foto ya en la galería del celular 1; los textos copiados para pegarlos, no tipearlos.
- **Contexto para el triage:** antes del pitch, cargar con el flujo real (no por base de datos) un contenedor desbordado con tres reportes de sesiones distintas, en otro punto de la ciudad. Así el fuego entra arriba en la lista. En el pitch se dice que se cargó antes.
- **Refresco:** la lista del operador se actualiza sola cada 10 s; para no esperar, tocar "Actualizar".
- **Ubicación con GPS:** los dos celulares van a estar juntos en el LATU, así que quedan dentro del radio de 30 m y se agrupan solos. Probarlo en el lugar antes del pitch.
- **Riesgo con el vecino 2:** la frase "humo, huele a plástico" sin foto puede salir como evidencia insuficiente. Si en el ensayo pasa eso, que el texto diga "el contenedor está largando mucho humo".
- **Proyección:** tener resuelto cómo se espejan los celulares en la pantalla, y un video de respaldo grabado por si falla internet.
- **Aviso de emergencia:** con fuego activo el chat muestra el texto de `emergency_channel` del seed de Montevideo (`seeds/territory-montevideo.ts`). Hoy dice "consultá el canal de emergencias local de tu zona"; para la demo conviene que diga algo concreto, como "llamá a Bomberos al 104".

## Para las preguntas

**"¿No es un chat?"** La conversación es solo la entrada. El producto es el triage: Jev clasifica cada aviso (tipo, severidad, fuego activo, paso bloqueado, contradicción texto/foto), compara contra los incidentes cercanos con texto y foto y decide si es el mismo. El LLM ni siquiera decide: solo extrae la dirección del texto. Es lo opuesto al chat genérico que la consigna descalifica.

**"¿Cómo priorizan?"** Jev extrae los hechos; la banda la calcula una regla explícita (`pipeline/priority.ts`): cualquier riesgo alto → Alta; si no, por severidad; una Baja sube a Media por antigüedad. La lista ordena peligro activo primero, después banda, después el más viejo (`incidents/queries.ts`). La cantidad de reportes **no** sube la prioridad, a propósito. El planificador (`operacion/t11`) suma un bonus acotado por fuentes y por espera dentro de la banda, nunca por encima de un peligro activo. Por qué así: la IA interpreta lo que un formulario no puede, y qué va primero queda auditable y ajustable por política, sin tocar el modelo.

**"¿Cómo asignan cuadrillas?"** *(si t11 está mergeado)* Asignación voraz en el orden de la cola: solo cuadrillas con la capacidad requerida (fuego ≠ limpieza), por distancia si es móvil o por zona si es responsable de zona, descontando capacidad, y evitando dejar sin unidad a otro incidente que solo esa podría atender. Es determinista: misma entrada, mismo plan.

**"¿Qué pasa cuando la IA se equivoca?"** Umbrales por política: duplicado dudoso, contradicción o baja confianza van a la cola de revisión y bloquean el despacho de ese incidente; no se adivina. Las correcciones humanas se conservan y una reevaluación no las pisa.

**"¿Cómo es hoy?"** Hay muchos canales (teléfono 1950, WhatsApp, formulario web del SUR, chatbot, Buzón Ciudadano, presencial). Del lado del proceso: mediana de resolución de 8 días y 11,8% de reclamos que tarda más de 90 (análisis independiente de datos abiertos). Decirlo como dato de proceso, no como crítica a la gestión. No afirmar cómo se hace hoy el triage por dentro: no lo sabemos.

**"¿Por qué importa?"** (opcional) La Cachimba del Piojo: una calle de La Teja que se asfaltó recién en septiembre de 2026, después de años de reclamo, cuando el caso se hizo viral. Usar solo si preguntan, y sin tono político.

**"¿Privacidad?"** No se piden datos de identidad (sesión con token opaco), fotos en storage privado con URLs firmadas, el operador nunca ve un identificador de persona. Anonimización de rostros y matrículas: roadmap (ver diseño §7b).

## Qué no prometer como hecho

Al momento de escribir esto no existen: el despacho de órdenes y la bandeja de la cuadrilla (`/unidad`), la pantalla para resolver la cola de revisión (el operador solo ve los avisos), y la geocodificación de esquinas tipo "Rivera y Comercio" (hay que poner un pin). El planificador está en `operacion/t11`, sin mergear: solo mostrarlo si está mergeado y probado. **Revisar esta lista contra el estado del sistema antes del pitch.**

## Datos y fuentes

| Dato | Fuente |
|---|---|
| ~40.000 llamados a Bomberos por quema de contenedores en 2025 | [Subrayado, 10/2/2026](https://www.subrayado.com.uy/contenedores-incendiados-bomberos-recibio-mas-50-mil-llamados-imm-espera-que-disminuya-el-plan-residuos-n999752) |
| 727.637 reclamos de basura en 2025 (~2.000 por día) | [El Observador, 9/9/2026](https://www.elobservador.com.uy/nacional/basura-montevideo-mas-700000-denuncias-un-ano-la-meta-que-no-logro-cumplir-la-im-y-el-plan-piloto-450-contenedores-llave-digital-n6056766) |
| 33 horas/día de triage | Cuenta ilustrativa: 2.000 avisos × 1 min. No es un dato medido. |
| Mediana de resolución de reclamos: 8 días; 11,8% tarda más de 90 (cerrados 2024–2026) | [Análisis independiente de datos abiertos del SUR](https://github.com/EmilianoGonLas/reclamos-montevideo) |
| Canales actuales: teléfono 1950, WhatsApp, formulario web del SUR, chatbot, Buzón Ciudadano, presencial | [Trámites IM](https://tramites.montevideo.gub.uy/tramite/contenedor-lleno-o-residuos-fuera-de-el) |
| Agrupación: 5/5 decisiones y 11/11 respuestas por candidato correctas, estables en dos corridas | `docs/superpowers/notes/jev-smoke.md` (rama `nucleo/agrupacion`) |

**No usar en el pitch:** "50.000 llamados en enero de 2026" y "más de 70 incendios entre el 1 de enero y mediados de febrero" (misma nota de Subrayado). Juntos dan unos 700 llamados por incendio: no cierran, y probablemente miden cosas distintas. Si sale en las preguntas: los números públicos de Bomberos y de la Intendencia no coinciden, por eso usamos el de 2025, y que no coincidan también muestra que falta un registro único.
