# Radar Urbano — guion del pitch

**Posicionamiento:** un sistema de triage para intendencias y entes públicos. Entra cualquier aviso ciudadano, como lo cuente el vecino; sale una lista de incidentes únicos, ordenados por riesgo, con la cuadrilla que corresponde. El vecino es la entrada de datos, no el producto.

**Tesis:** el triage de avisos ciudadanos no escala con personas (miles por día) y no se resuelve con reglas fijas (texto libre, fotos, el mismo problema contado de diez maneras). La IA interpreta; las reglas, explícitas y auditables, ordenan y asignan.

Formato build 101: **3:00 en total para pitch y demo** + 3 min de preguntas. Habla una persona; otra maneja la demo.
Lo que va entre *[corchetes]* es lo que pasa en pantalla, no se lee.

## Presupuesto de tiempo

Ritmo de referencia: 150 palabras por minuto (2,5 por segundo). Las esperas son momentos sin hablar: respuesta de Jev, toques en el celular, cambio de pantalla.

| Bloque | Hablado | Esperas | Acumulado |
|---|---|---|---|
| 1. El problema | ~31 s | — | 0:31 |
| 2. Qué es | ~13 s | — | 0:44 |
| 3. Entender | ~10 s | ~10 s | 1:04 |
| 4. Agrupar | ~12 s | ~10 s | 1:26 |
| 5. Priorizar y asignar | ~14 s | ~5 s | 1:45 |
| 6. Por qué IA | ~22 s | — | 2:07 |
| 7. Cierre | ~11 s | — | **~2:18** |

Hablado medido: 288 palabras (~1:55). Quedan ~40 s de colchón. **Regla de corte en vivo:** si a las 2:15 no empezaste el bloque 6, decís solo la última frase del bloque 6 ("Lo medimos…") y vas al cierre.

---

## 1. El problema, como proceso · ~30 s

> Once de la noche. Un contenedor se prende fuego en una esquina. Lo ven diez vecinos, y llegan diez avisos, cada uno contado distinto.
> Solo por contenedores quemados, Bomberos recibió unos cuarenta mil llamados en 2025. Y en Montevideo hay dos mil reclamos de basura por día.
> Cada uno hay que leerlo, entender qué es, ver si ya existe y decidir qué va primero. A un minuto por aviso, son treinta y tres horas por día solo para ordenar.

*Las 33 horas son una cuenta ilustrativa (2.000 × 1 min), no un dato medido.*

## 2. Qué es · ~15 s

> Radar Urbano es un sistema de triage para intendencias y entes públicos. Entra cualquier aviso, como lo cuente el vecino, y sale una lista de incidentes únicos, ordenados por riesgo.
> Lo vemos en vivo.

## 3. Entender · ~10 s + ~10 s de espera

*[Celular 1 proyectado. El compañero manda la foto del contenedor en llamas y pega: "se está prendiendo fuego el contenedor de la esquina"]*

> Llega un aviso: una foto y una frase, sin formulario.

*[Espera la respuesta]*

> Ya entendió: contenedor con fuego, fuego activo, severidad alta. Falta el lugar, y lo pide.

*[Toca "usar mi ubicación" y confirma — sin narrar]*

## 4. Agrupar · ~14 s + ~10 s de espera

*[Celular 2. Pega: "hay mucho humo en la esquina, huele a plástico quemado"]*

> Otro vecino. No dice "contenedor", dice "humo".

*[Confirma. Cambio a la pantalla del operador; toca "Actualizar"]*

> El operador no ve dos reclamos: ve un incidente con dos reportes. La IA comparó los relatos y decidió que es el mismo.

## 5. Priorizar y asignar · ~15 s + ~5 s de espera

*[Lista del operador: el fuego arriba del contenedor desbordado que se cargó antes con tres reportes]*

> Y va primero, arriba del contenedor desbordado que cargamos antes con tres vecinos. Ordena por riesgo, no por cantidad de quejas.

*[SOLO SI `operacion/t11` está mergeado y probado: vista `/operacion/plan`]*

> Y propone quién va: la cuadrilla más cercana que puede atender fuego, no la de limpieza.

## 6. Por qué IA, y cómo sabemos que funciona · ~24 s

> Con personas, esto no escala. Con reglas fijas, no se entiende: la gente escribe como quiere y cuenta lo mismo de diez maneras.
> Por eso la IA interpreta, y reglas auditables ordenan y asignan.
> Lo medimos: acertó las once comparaciones de nuestro set de agrupación. Y cuando duda, no adivina: lo manda a revisión humana.

## 7. Cierre · ~10 s

> Hoy funciona el triage completo. Lo que sigue es despachar la orden al celular de la cuadrilla.
> Diez avisos, un incidente, lo urgente primero. Eso es Radar Urbano.

*Si el planificador no llegó: se saltea el pedazo de "propone quién va" (−6 s), en el bloque 6 queda "reglas auditables ordenan", y el cierre dice "Lo que sigue es asignar y despachar cuadrillas".*

---

## Notas para quien maneja la demo

- **El reloj lo marca la demo:** tener todo a un toque. Foto ya en la galería del celular 1, textos copiados para pegar, celular 2 con la sesión abierta, pantalla del operador ya logueada en otra pestaña o pantalla.
- **Antes de subir:** `reset-demo`, y después cargar el contexto (abajo).
- **Contexto para el triage:** cargar con el flujo real (no por base de datos) un contenedor desbordado con tres reportes de sesiones distintas, en otro punto de la ciudad. Así el fuego entra arriba en la lista. En el pitch se dice que se cargó antes.
- **Refresco:** la lista del operador se actualiza sola cada 10 s; para no esperar, tocar "Actualizar".
- **Ubicación con GPS:** los dos celulares van a estar juntos en el LATU, así que quedan dentro del radio de 30 m y se agrupan solos. Probarlo en el lugar antes del pitch.
- **Riesgo con el vecino 2:** la frase "humo, huele a plástico" sin foto puede salir como evidencia insuficiente. Si en el ensayo pasa eso, que el texto diga "el contenedor está largando mucho humo" (y en el bloque 4 se dice "lo cuenta distinto" en lugar de "no dice contenedor").
- **Proyección:** tener resuelto cómo se espejan los celulares en la pantalla, y un video de respaldo grabado por si falla internet.
- **Aviso de emergencia:** con fuego activo el chat muestra el texto de `emergency_channel` del seed de Montevideo (`seeds/territory-montevideo.ts`). Hoy dice "consultá el canal de emergencias local de tu zona"; para la demo conviene que diga algo concreto, como "llamá a Bomberos al 104".
- **Ensayo:** al menos dos pasadas completas con cronómetro, con los dos roles. Anotar el tiempo de cada bloque contra la tabla de arriba.

## Preguntas del jurado

Son 3 minutos: entran 4 a 6 preguntas. **Cómo responder:** primero la respuesta en una frase, después un dato o un ejemplo, y cortar (~20 s). Si no sabés, decilo y decí cómo lo medirían. Las técnicas profundas (código, umbrales, queries) las toma quien manejó la demo.

**Alcance declarado** (decirlo si el jurado quiere probar un caso propio): Montevideo, avisos de espacio público de los 10 tipos del catálogo — bache, basura acumulada, accesibilidad obstruida, contenedor dañado, contenedor con fuego, vereda rota, cartelería, alumbrado, árbol o rama caída, desagüe obstruido. Lo que queda afuera no se inventa: va a revisión.

### Las seis más probables

**1. "Si le sacás la IA, ¿qué queda?"** *(es la pregunta de la consigna)*
> Queda un formulario: el vecino elige una categoría de una lista, y al municipio le llegan diez reclamos del mismo fuego que alguien tiene que leer y juntar a mano. Sin IA no hay triage: nadie entiende el texto libre ni la foto, y nadie decide si dos relatos distintos son el mismo incidente.

*Respaldo:* sin Jev, no hay tipo, severidad, fuego activo ni agrupación; las reglas de prioridad no tienen hechos sobre los que operar.

**2. "¿Cómo saben que funciona? Once casos es poco."**
> Es poco, y lo decimos así: es una prueba contra la API real, no un benchmark. Pero son casos difíciles a propósito. Distingue un contenedor prendido fuego de uno quemado hace dos días. Cuando el texto dice fuego y la foto muestra un contenedor quemado, detecta la contradicción y lo manda a revisión. Y de seis pares de agrupación, acertó los seis, igual en dos corridas.

*Respaldo:* cada llamada queda registrada (entrada, respuesta, latencia), así que el siguiente paso es un set etiquetado con avisos reales y medir precisión por tipo. Los casos de clasificación: 9 de 9 con el tipo o la rama correcta (`docs/superpowers/notes/jev-smoke.md`).

**3. "Probemos con un caso nuestro."** *(la rúbrica dice que pueden variar un caso)*
> Dale. *(Pasarle el celular o tipear lo que diga.)* Si está en el catálogo lo clasifica; si es ambiguo o no alcanza la evidencia, lo pide o lo manda a revisión, no inventa.

*Preparar:* el celular 2 listo con una sesión nueva. Si dicen algo vago ("hay un problema en mi barrio"), el resultado esperado es evidencia insuficiente y repregunta: eso es correcto, decirlo.

**4. "¿Qué pasa cuando la IA se equivoca?"**
> No decide sola cuando duda. Cada respuesta de Jev viene con una probabilidad; si no supera el umbral, o hay contradicción, o el duplicado es dudoso, va a una cola de revisión humana y ese incidente no se despacha. Y si un operador corrige algo, esa corrección se respeta: una reevaluación no la pisa.

*Respaldo:* umbrales de agrupación: 0,90 para "mismo incidente", 0,80 para "distinto" (`seeds/policies.ts`). Hoy la cola existe en datos y el operador la ve como aviso; la pantalla para resolverla no está.

**5. "¿Qué es Jev? ¿Por qué no un LLM para todo?"**
> Jev es un clasificador: le hacemos preguntas cerradas — ¿hay fuego activo?, ¿es el mismo incidente? — y devuelve una opción con su probabilidad. No escribe texto, así que no puede inventar una categoría, y la probabilidad nos deja poner umbrales. Además es rápido: medio segundo sin foto, poco más de un segundo con foto. El LLM lo usamos solo para extraer la dirección del texto, y no decide nada.

*Respaldo:* latencia medida 230–400 ms texto, 0,6–1,4 s con foto. Costo por aviso: no lo medimos todavía; decirlo así.

**6. "¿Qué está simulado?"** *(la rúbrica pide declarar las simulaciones)*
> La IA no: todas las llamadas son a la API real. Lo simulado son las posiciones GPS de las cuadrillas, que están marcadas como demo. Y el contenedor desbordado del principio lo cargamos antes, pero por el mismo flujo, no a mano en la base.

### Otras que pueden salir

**"¿No es un chat?"** La conversación es solo la entrada. El producto es el triage: clasificar, agrupar, priorizar y asignar. El LLM ni siquiera decide. Es lo opuesto al chat genérico que la consigna descalifica.

**"¿Cómo priorizan? ¿Por qué no por cantidad de quejas?"** Jev extrae los hechos (fuego activo, paso bloqueado, accesibilidad, severidad) y una regla explícita calcula la banda (`pipeline/priority.ts`). Que se quejen más no hace más grave el problema; si no, el barrio que más se queja gana siempre. La cantidad suma, como mucho, un bonus acotado dentro de la banda en el planificador, nunca por encima de un peligro activo. Es auditable y la intendencia lo ajusta por política sin tocar el modelo.

**"¿Cómo asignan cuadrillas?"** *(si t11 está mergeado)* En el orden de la cola, solo cuadrillas con la capacidad requerida (fuego no es limpieza), por distancia si es móvil o por zona, descontando capacidad, y evitando dejar sin unidad a otro incidente que solo esa podría atender. Determinista: misma entrada, mismo plan.

**"¿Y si dos contenedores distintos están en la misma esquina?"** La cercanía solo elige candidatos (30 m); la decisión la toma Jev comparando texto y foto. En la prueba, un bache y basura a 12 m quedaron separados, y con dos candidatos eligió el correcto aunque era el más lejano. Si duda, revisión.

**"¿Quién lo usa? ¿Por qué lo adoptaría una intendencia?"** El usuario es el operador del ente público. Cambia leer y juntar avisos uno por uno por una lista de incidentes únicos ya ordenados. No pretendemos reemplazar los canales actuales; el triage es lo que viene después de recibir el aviso. *(No afirmar integraciones con sistemas de la IM: no existen.)*

**"¿Esto ya existe?"** *(originalidad)* Hay plataformas de reporte ciudadano, pero en general piden elegir una categoría y dejan los duplicados al vecino o a un operador. Lo nuestro es el triage automático: entender texto y foto, agrupar relatos distintos y priorizar por riesgo. *(No nombrar productos concretos si no los conocen bien.)*

**"¿Escala a otra ciudad?"** Montevideo es configuración: barrios, catálogo, umbrales y textos viven en la base, no en el código. *(Si `feat/territorio-b` está mergeado: "lo probamos con un segundo territorio".)*

**"¿Y si se cae el proveedor de IA?"** El aviso se guarda antes de cualquier llamada. Si Jev no responde a tiempo, el vecino ve "recibido, analizando", la evaluación sigue como tarea en segundo plano con reintentos, y si falla queda en revisión. No se pierde ningún aviso.

**"¿Y avisos falsos o alguien que intenta manipular el sistema?"** El texto del vecino es evidencia, no instrucciones. Probamos meterle una instrucción oculta al extractor de direcciones y no la siguió. Una foto que no coincide con el texto se marca como contradicción. Y como la cantidad no sube la prioridad, inundar de reportes no adelanta nada.

**"¿Cómo es hoy?"** Hay muchos canales (teléfono 1950, WhatsApp, formulario web, chatbot, Buzón Ciudadano, presencial). Del lado del proceso, con los datos abiertos del Sistema Único de Reclamos, calculado por nosotros: un reclamo tarda en cerrarse una mediana de 13 días, y uno de cada cinco tarda más de 90 (cerrados entre 2024 y septiembre de 2026). Dato de proceso, no crítica. No afirmar cómo se hace hoy el triage por dentro.

*Respaldo si repreguntan:* depende mucho del tipo: arbolado, mediana de 168 días; viales (baches y similares), 58; estado de los contenedores, 15; problemas de limpieza, 3. Cómo se calculó: días entre el ingreso y la fecha en que pasó a "Finalizado", sobre 315.782 reclamos; los anulados no cuentan. Límite: el dataset no guarda el historial de estados, así que un reclamo reabierto se mide desde su último cierre. Script: `docs/pitch/datos/sur_tiempos.py`.

**"¿Por qué no coinciden los números de incendios?"** Los números públicos de Bomberos y de la Intendencia no coinciden; por eso usamos el de Bomberos de 2025. Que no coincidan muestra que falta un registro único.

**"¿Por qué importa?"** Solo si preguntan, sin tono político: La Cachimba del Piojo asfaltó su calle principal en septiembre de 2026, después de años de reclamo, cuando el caso se hizo viral.

**"¿Privacidad?"** No se piden datos de identidad (sesión con token opaco), fotos en storage privado con URLs firmadas, el operador nunca ve quién reportó. Anonimizar rostros y matrículas es roadmap (diseño §7b).

### Qué no decir

- "Es un chat", "es como ChatGPT para reclamos".
- Un costo por aviso, un porcentaje de precisión o un ahorro en dinero: no los medimos.
- Que está integrado con la Intendencia o con el SUR.
- Que despacha órdenes o que la cuadrilla recibe la orden en el celular (hasta que exista).
- Críticas a la gestión de la Intendencia.

## Qué no prometer como hecho

Al momento de escribir esto no existen: el despacho de órdenes y la bandeja de la cuadrilla (`/unidad`), la pantalla para resolver la cola de revisión (el operador solo ve los avisos), y la geocodificación de esquinas tipo "Rivera y Comercio" (hay que poner un pin). El planificador está en `operacion/t11`, sin mergear: solo mostrarlo si está mergeado y probado. **Revisar esta lista contra el estado del sistema antes del pitch.**

## Datos y fuentes

| Dato | Fuente |
|---|---|
| ~40.000 llamados a Bomberos por quema de contenedores en 2025 | [Subrayado, 10/2/2026](https://www.subrayado.com.uy/contenedores-incendiados-bomberos-recibio-mas-50-mil-llamados-imm-espera-que-disminuya-el-plan-residuos-n999752) |
| 727.637 reclamos de basura en 2025 | Intendencia (Desarrollo Ambiental) ante la Junta Departamental, rendición de cuentas 2025, vía [El Observador, 9/9/2026](https://www.elobservador.com.uy/nacional/basura-montevideo-mas-700000-denuncias-un-ano-la-meta-que-no-logro-cumplir-la-im-y-el-plan-piloto-450-contenedores-llave-digital-n6056766). Los ~2.000 por día son cuenta nuestra (727.637 ÷ 365). |
| 33 horas/día de triage | Cuenta ilustrativa: 2.000 avisos × 1 min. No es un dato medido. |
| Cierre de reclamos del SUR: mediana 13 días; 21,4% tarda más de 90 (315.782 finalizados entre 2024 y sep. 2026) | Calculado por nosotros con los [datos abiertos del SUR](https://catalogodatos.gub.uy/dataset/reclamos-registrados-en-el-sistema-unico-de-reclamos-de-la-intendencia-de-montevideo) (archivo del 11/10/2026). Script: `docs/pitch/datos/sur_tiempos.py`. |
| Canales actuales: teléfono 1950, WhatsApp, formulario web del SUR, chatbot, Buzón Ciudadano, presencial | [Trámites IM](https://tramites.montevideo.gub.uy/tramite/contenedor-lleno-o-residuos-fuera-de-el) |
| Agrupación: 5/5 decisiones y 11/11 respuestas por candidato correctas, estables en dos corridas | `docs/superpowers/notes/jev-smoke.md` (rama `nucleo/agrupacion`) |

**Descartado:** la "mediana de 8 días y 11,8% más de 90" de un repositorio de GitHub sin revisión ([EmilianoGonLas/reclamos-montevideo](https://github.com/EmilianoGonLas/reclamos-montevideo)). Usa la misma fuente oficial, pero recalculado sobre los cerrados 2024–2026 da 13 días y 21,4%. Su 8 se parece a la mediana por año de ingreso 2025 (8 días), que subestima porque 19.650 reclamos de ese año siguen abiertos.

**Ojo con mezclar fuentes:** el SUR registró 113.743 reclamos en 2025 (unos 310 por día), mucho menos que los 727.637 de basura. Son registros distintos: los de basura entran por otros canales. No presentar uno como parte del otro.

**No usar en el pitch:** "50.000 llamados en enero de 2026" y "más de 70 incendios entre el 1 de enero y mediados de febrero" (misma nota de Subrayado). Juntos dan unos 700 llamados por incendio: no cierran, y probablemente miden cosas distintas. Si sale en las preguntas: los números públicos de Bomberos y de la Intendencia no coinciden, por eso usamos el de 2025, y que no coincidan también muestra que falta un registro único.
