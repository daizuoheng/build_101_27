# Radar Urbano — guion del pitch

**Posicionamiento:** un sistema de triage para intendencias y entes públicos. Entra cualquier aviso ciudadano, como lo cuente el vecino; sale un incidente único, priorizado por riesgo, y la orden a la cuadrilla que corresponde. Sin intervención humana en el camino feliz. El vecino es la entrada de datos, no el producto.

**Tesis:** el triage de avisos ciudadanos no escala con personas (miles por día) y no se resuelve con reglas fijas (texto libre, fotos, el mismo problema contado de diez maneras). La IA interpreta y agrupa; las reglas, explícitas y auditables, ordenan y asignan.

Formato build 101: **4:00 en total para pitch y demo** + preguntas del jurado (3 min según la consigna; confirmar si eso también cambió).
Lo que va entre *[corchetes]* es lo que pasa en pantalla, no se lee.

## La demo: tres pantallas, nadie toca la del medio

| Rol | Pantalla | Quién |
|---|---|---|
| Vecino (y el segundo vecino del acto 4, con una sesión nueva) | `/reportar/montevideo` en un celular, proyectado | Alguien del equipo |
| Intendencia | `/operacion` (consola), proyectada | **Nadie.** Se actualiza sola cada 3 s |
| Cuadrilla | `/unidad` en otro celular, logueado como `unidad.cuadrilla-demo` | Alguien del equipo |
| Narrador | — | Vos |

Que nadie toque la consola **es** el mensaje: el triage pasa solo, delante del jurado. Tiempos medidos por el equipo en local: el incidente aparece en la consola ~2 s después de enviar, y la orden llega a la cuadrilla ~3 s después.

## Presupuesto de tiempo

Ritmo de referencia: 150 palabras por minuto (2,5 por segundo). Las esperas son momentos sin hablar.

| Bloque | Hablado | Esperas | Acumulado |
|---|---|---|---|
| 1. El problema | ~31 s | — | 0:31 |
| 2. Qué es | ~16 s | — | 0:47 |
| 3. Acto 1 · El vecino avisa | ~10 s | ~20 s | 1:17 |
| 4. Acto 2 · La Intendencia lo ve | ~16 s | ~6 s | 1:39 |
| 5. Acto 3 · La cuadrilla recibe la orden | ~12 s | ~7 s | 1:58 |
| 6. Acto 4 · Otro vecino avisa lo mismo | ~14 s | ~20 s | 2:32 |
| 7. Por qué IA | ~21 s | — | 2:53 |
| 8. Cierre | ~7 s | — | **~3:00** |

Hablado medido: 324 palabras (~2:10). Quedan ~60 s de colchón sobre los 4:00, que los actos 1 y 4 pueden comerse si la geocodificación o la red tardan. **Regla de corte en vivo:** si a las 3:15 no empezaste el bloque 7, decís solo "Lo medimos…" y vas al cierre.

---

## 1. El problema, como proceso

> Once de la noche. Un contenedor se prende fuego en una esquina. Lo ven diez vecinos, y llegan diez avisos, cada uno contado distinto.
> Solo por contenedores quemados, Bomberos recibió unos cuarenta mil llamados en 2025. Y en Montevideo hay dos mil reclamos de basura por día.
> Cada uno hay que leerlo, entender qué es, ver si ya existe y decidir qué va primero. A un minuto por aviso, son treinta y tres horas por día solo para ordenar.

*Las 33 horas son una cuenta ilustrativa (2.000 × 1 min), no un dato medido.*

## 2. Qué es

> Radar Urbano es un sistema de triage para intendencias y entes públicos. Entra cualquier aviso, como lo cuente el vecino, y sale un incidente priorizado y la orden a la cuadrilla correcta, sin que nadie toque nada.
> Lo vemos en vivo.

## 3. Acto 1 · El vecino avisa

*[Celular del vecino proyectado. Manda la foto del contenedor en llamas y pega: "se está prendiendo fuego el contenedor de la esquina"]*

> Un vecino manda una foto y una frase. Sin formulario, sin elegir categoría.

*[Llega la respuesta: aviso de emergencia y pedido de ubicación]*

> Entendió que hay fuego: le dice que llame a emergencias, y le pregunta dónde.

*[Escribe "18 de Julio y Ejido", confirma el pin con «Sí, es ahí» y toca Enviar — sin narrar]*

## 4. Acto 2 · La Intendencia lo ve, sin tocar nada

*[Consola proyectada. Nadie la toca. El incidente aparece resaltado a los ~2 s]*

> Esta es la consola de la Intendencia. Nadie la está tocando.
> Ahí apareció: contenedor con fuego, peligro activo, prioridad alta.

*[Un toque en el incidente: se abre el detalle con la foto y el texto del vecino]*

> Lo abro solo para mirar la evidencia: la foto y lo que escribió el vecino. No hay nada que aprobar.

## 5. Acto 3 · La cuadrilla recibe la orden

*[Celular de la cuadrilla. Suena, vibra y aparece "Llegó una orden nueva"]*

> Y a los segundos, a la cuadrilla le llega la orden. La que puede atender fuego, no la de limpieza. Nadie la asignó.

*[La cuadrilla toca Aceptar. La consola muestra el cambio de estado sola]*

> Acepta, y la consola se entera sola.

## 6. Acto 4 · Otro vecino avisa lo mismo

*[Celular del vecino, sesión nueva. Pega: "el contenedor de 18 de Julio y Ejido está largando mucho humo, huele a plástico quemado", confirma el pin y envía]*

> Ahora otro vecino avisa del mismo fuego, con otras palabras: no dice "fuego", dice "humo".

*[Espera. Consola: el incidente pasa a 2 reportes. Celular de la cuadrilla: nada nuevo]*

> En la consola sigue siendo un solo incidente, ahora con dos reportes. Y la cuadrilla no recibió una segunda orden.

## 7. Por qué IA, y cómo sabemos que funciona

> Con personas, esto no escala. Con reglas fijas, no se entiende, porque cada vecino lo cuenta distinto.
> Por eso la IA interpreta y agrupa, y las reglas ordenan y asignan.
> Lo medimos con la API real: acertó las cinco decisiones de agrupación de nuestra prueba. Y cuando duda, lo manda a revisión humana.

## 8. Cierre

> Del aviso a la orden, de punta a punta. Diez avisos, un incidente, una cuadrilla. Eso es Radar Urbano.

**Si hay que cortar tiempo, en este orden:** (1) "Acepta, y la consola se entera sola"; (2) el toque al detalle y su frase; (3) "Y en Montevideo hay dos mil reclamos de basura por día" junto con la frase de las 33 horas, que depende de esa. **El acto 4 no se corta:** es la prueba en vivo de lo que hace la IA.

---

## Notas para la demo

Procedimiento completo y comandos: `docs/superpowers/notes/demo-en-vivo.md` (en `main`). Lo que importa para el escenario:

- **Dónde corre.** No hay despliegue con https (Railway está preparado, no desplegado). Se corre en una máquina del equipo con el **plan B por red local**: `ALLOWED_DEV_ORIGINS=<ip> next dev` + `pnpm worker`, y los celulares entran por `http://<ip>:3000`. Con plan B:
  - **No hay GPS** (el navegador lo bloquea por http): el vecino **escribe la dirección**. Usar una que ya se probó y geocodifica bien, como "18 de Julio y Ejido". Probarla en el ensayo.
  - La primera carga de cada pantalla tarda: **abrir las tres pantallas antes de empezar**.
  - Se ve el indicador de Next abajo a la izquierda.
- **`--near` cerca de la dirección.** `refresh-demo-positions --near <lat>,<lon> --watch 10` en una terminal abierta. La cuadrilla atiende en un radio de 3 km: el punto tiene que estar cerca de "18 de Julio y Ejido" (el `-34.9058,-56.1882` del doc lo está).
- **Cuadrilla:** tocar la pantalla de `/unidad` una vez después de abrirla; si no, el navegador bloquea el tono y la vibración. Con la pestaña visible y el celular desbloqueado.
- **No precargar otros incidentes.** Con `--near` solo `cuadrilla-demo` queda vigente: si ya tiene una orden, la del fuego podría no llegarle. Arrancar con `reset-demo --yes`.
- **No usar alumbrado** para la demo: va por zona a la oficina, no a la cuadrilla.
- **`SESSION_SECRET` de 32 caracteres o más**, si no el login da 500.
- **Antes de subir:** correr `scripts/e2e-demo.mjs` para verificar, y después `reset-demo --yes` (el script deja el incidente resuelto).
- **Aviso de emergencia:** con fuego activo el chat muestra el texto de `emergencyChannel` (`seeds/territory-montevideo.ts`), que hoy dice "consultá el canal de emergencias local de tu zona". Para la demo conviene algo concreto, como "llamá a Bomberos al 104 o al 911".
- **Todo a un toque:** la foto en la galería del celular del vecino, los dos textos copiados para pegar.
- **Acto 4:** tener lista una segunda sesión de vecino (otra pestaña o ventana privada en el mismo celular). El texto ya trae la dirección para ahorrar un paso; igual va a pedir confirmar el pin. Probar en el ensayo que se agrupe (misma esquina, dentro de 30 m) y que no salga como evidencia insuficiente sin foto.
- **Después del pitch:** si el jurado quiere probar otro problema, que la cuadrilla complete antes la orden del fuego (Iniciar → Completar), por si su capacidad es de una sola orden.
- **Video de respaldo** grabado de los tres actos, por si falla la red.
- **Ensayo:** dos pasadas completas con cronómetro y los tres roles.

## Preguntas del jurado

Son 3 minutos: entran 4 a 6 preguntas. **Cómo responder:** primero la respuesta en una frase, después un dato o un ejemplo, y cortar (~20 s). Si no sabés, decilo y decí cómo lo medirían. Las técnicas profundas las toma alguien del equipo.

**Alcance declarado** (decirlo si el jurado quiere probar un caso propio): Montevideo, avisos de espacio público de los 10 tipos del catálogo — bache, basura acumulada, accesibilidad obstruida, contenedor dañado, contenedor con fuego, vereda rota, cartelería, alumbrado, árbol o rama caída, desagüe obstruido. Lo que queda afuera no se inventa: va a revisión.

### Las seis más probables

**1. "Si le sacás la IA, ¿qué queda?"** *(es la pregunta de la consigna)*
> Queda un formulario: el vecino elige una categoría de una lista, y a la Intendencia le llegan diez reclamos del mismo fuego que alguien tiene que leer, juntar y asignar a mano. Sin IA no hay triage: nadie entiende el texto libre ni la foto, y nadie decide si dos relatos distintos son el mismo incidente.

*Respaldo:* sin Jev no hay tipo, severidad, fuego activo ni agrupación; las reglas de prioridad y asignación no tienen hechos sobre los que operar.

**2. "Probemos con un caso nuestro."** *(la rúbrica dice que pueden variar un caso — es la mejor oportunidad)*
> Dale: contale un problema con tus palabras, el que quieras. *(Pasarle el celular del vecino con una sesión nueva.)*

Lo que debería pasar, y conviene narrarlo: otro problema (un bache, basura) crea otro incidente y la orden va a la cuadrilla con esa capacidad; el mismo fuego contado de otra forma se suma al incidente y la cuadrilla no recibe otra orden. Antes, que la cuadrilla complete la orden del fuego. Si dicen algo vago ("hay un problema en mi barrio"), lo esperado es que repregunte: es correcto, decirlo. *Preparar:* sesión nueva lista en el celular del vecino; la dirección escrita (sin GPS en plan B).

**3. "¿Cómo saben que funciona? Es una muestra muy chica."**
> Es chica, y lo decimos así: es una prueba contra la API real, no un benchmark. Pero son casos difíciles a propósito. Distingue un contenedor prendido fuego de uno ya quemado. Cuando el texto dice fuego y la foto muestra un contenedor quemado, detecta la contradicción y lo manda a revisión. Y si alguien reporta fuego donde ayer hubo un contenedor quemado, no los junta: lo manda a revisión. En total, cinco de cinco decisiones de agrupación y dieciocho de dieciocho respuestas de clasificación, iguales en dos corridas.

*Respaldo:* además, el equipo corrió la demo completa con seis relatos distintos (fuego con y sin dirección, bache, basura, rama caída, foto de contenedor quemado) y en todos la orden llegó a la cuadrilla (`demo-en-vivo.md`). Cada llamada queda registrada, así que el siguiente paso es un set etiquetado con avisos reales. **Límite a declarar si preguntan por las fotos:** son de Wikimedia Commons, no de reportes reales, y el "mismo bache" usa dos recortes de una misma foto (`jev-smoke.md`).

**4. "¿Qué pasa cuando la IA se equivoca?"**
> No decide sola cuando duda. Cada respuesta de Jev viene con una probabilidad; si no supera el umbral, o hay contradicción, o el duplicado es dudoso, va a una cola de revisión y ese incidente queda bloqueado para despacho. El operador lo resuelve ahí, y si corrige el tipo o la severidad, una reevaluación de la IA no pisa su corrección.

*Respaldo:* umbrales de agrupación 0,90 "mismo" y 0,80 "distinto" (`seeds/policies.ts`). Cola de revisión en `/operacion/revision`; correcciones desde el detalle del incidente (`incidents/overrides.ts`).

**5. "¿Qué es Jev? ¿Por qué no un LLM para todo?"**
> Jev es un clasificador: le hacemos preguntas cerradas — ¿hay fuego activo?, ¿es el mismo incidente? — y devuelve una opción con su probabilidad. No escribe texto, así que no puede inventar una categoría, y la probabilidad nos deja poner umbrales. Además es rápido: menos de medio segundo sin foto, alrededor de un segundo con foto. El LLM redacta: la repregunta al vecino, la dirección y el resumen para el operador. Pero nunca decide el tipo, la gravedad ni a quién se manda.

*Respaldo:* latencia por evaluación completa 230–400 ms solo texto, 640–1.100 ms con una foto; la comparación para agrupar 0,5–1,4 s. Costo por aviso: no lo medimos todavía; decirlo así.

**6. "¿Qué está simulado?"** *(la rúbrica pide declarar las simulaciones)*
> La IA no: todas las llamadas son a la API real. Lo simulado son las posiciones GPS de las cuadrillas, que están marcadas como demo. Y hoy corre en una máquina nuestra por la red local, no en un servidor público.

### Otras que pueden salir

**"¿No es un chat?"** La conversación es solo la entrada. El producto es el triage: clasificar, agrupar, priorizar, asignar y despachar. Es lo opuesto al chat genérico que la consigna descalifica.

**"¿Cómo le llega la orden a la cuadrilla?"** La página de la cuadrilla consulta cada 3 segundos; cuando llega una orden, la resalta, suena y vibra. La cuadrilla la acepta, la inicia y la completa, y todo queda registrado. Límite: hoy necesita la página abierta; una notificación con el celular bloqueado, o por WhatsApp, es lo siguiente.

**"¿Cómo priorizan? ¿Por qué no por cantidad de quejas?"** Jev extrae los hechos (fuego activo, paso bloqueado, accesibilidad, severidad) y una regla explícita calcula la banda (`pipeline/priority.ts`). Que se quejen más no hace más grave el problema; si no, el barrio que más se queja gana siempre. La cantidad suma, como mucho, un bonus acotado dentro de la banda, nunca por encima de un peligro activo. Es auditable y la intendencia lo ajusta por política sin tocar el modelo.

**"¿Cómo asignan cuadrillas?"** En el orden de la cola, solo cuadrillas con la capacidad requerida (fuego no es limpieza), por distancia si es móvil o por zona, descontando capacidad, y evitando dejar sin unidad a otro incidente que solo esa podría atender. Determinista: misma entrada, mismo plan. Un segundo reporte del mismo incidente no genera otra orden (hay un test para eso).

**"¿Y si dos contenedores distintos están en la misma esquina?"** La cercanía solo elige candidatos (30 m); decide Jev comparando texto y foto. En la prueba, un bache y basura a 12 m quedaron separados, y con dos candidatos eligió el correcto aunque era el más lejano. Si duda, revisión.

**"¿Quién lo usa? ¿Por qué lo adoptaría una intendencia?"** El operador del ente público, y las cuadrillas. Cambia leer, juntar y asignar avisos uno por uno por incidentes únicos que llegan ya ordenados y asignados; el operador solo mira lo que el sistema no pudo decidir. No reemplaza los canales actuales: el triage es lo que viene después de recibir el aviso. *(No afirmar integraciones con sistemas de la IM: no existen.)*

**"¿Esto ya existe?"** *(originalidad)* Hay plataformas de reporte ciudadano, pero en general piden elegir una categoría y dejan los duplicados y la asignación a una persona. Lo nuestro es el triage automático de punta a punta. *(No nombrar productos concretos si no los conocen bien.)*

**"¿Escala a otra ciudad?"** Montevideo es configuración: barrios, catálogo, umbrales y textos viven en la base, no en el código. Lo probamos con un segundo territorio sintético.

**"¿Y si se cae el proveedor de IA?"** El aviso se guarda antes de cualquier llamada. Si Jev no responde a tiempo, el vecino ve "recibido, analizando", la evaluación sigue en segundo plano con reintentos, y si falla queda en revisión. Si el LLM falla, se usa una plantilla. No se pierde ningún aviso.

**"¿Y avisos falsos o manipulación?"** El texto del vecino es evidencia, no instrucciones: probamos meterle una instrucción oculta al extractor de direcciones y no la siguió. Una foto que no coincide se marca como contradicción. Y como la cantidad no sube la prioridad, inundar de reportes no adelanta nada.

**"¿Cómo es hoy?"** Hay muchos canales (teléfono 1950, WhatsApp, formulario web, chatbot, Buzón Ciudadano, presencial). Del lado del proceso, con los datos abiertos del Sistema Único de Reclamos, calculado por nosotros: un reclamo tarda en cerrarse una mediana de 13 días, y uno de cada cinco tarda más de 90 (cerrados entre 2024 y septiembre de 2026). Dato de proceso, no crítica. No afirmar cómo se hace hoy el triage por dentro.

*Respaldo si repreguntan:* depende mucho del tipo: arbolado, mediana de 168 días; viales (baches y similares), 58; estado de los contenedores, 15; problemas de limpieza, 3. Cómo se calculó: días entre el ingreso y la fecha en que pasó a "Finalizado", sobre 315.782 reclamos; los anulados no cuentan. Límite: el dataset no guarda el historial de estados, así que un reclamo reabierto se mide desde su último cierre. Script: `docs/pitch/datos/sur_tiempos.py`.

**"¿Por qué no coinciden los números de incendios?"** Los números públicos de Bomberos y de la Intendencia no coinciden; por eso usamos el de Bomberos de 2025. Que no coincidan muestra que falta un registro único.

**"¿Por qué importa?"** Solo si preguntan, sin tono político: La Cachimba del Piojo asfaltó su calle principal en septiembre de 2026, después de años de reclamo, cuando el caso se hizo viral.

**"¿Privacidad?"** No se piden datos de identidad (sesión con token opaco; solo se guarda su hash), fotos en storage privado, nunca con URL pública: solo las ve un operador logueado de ese territorio. El operador nunca ve quién reportó. Anonimizar rostros y matrículas es roadmap (diseño §7b).

### Qué no decir

- "Es un chat", "es como ChatGPT para reclamos".
- Un costo por aviso, un porcentaje de precisión o un ahorro en dinero: no los medimos.
- Que está integrado con la Intendencia o con el SUR.
- Que está desplegado o que se puede usar desde cualquier lado: hoy corre en la red local.
- Que la cuadrilla recibe una notificación con el celular bloqueado, o por WhatsApp.
- Críticas a la gestión de la Intendencia.

## Qué no prometer como hecho

Al 18 de octubre (`main` en `45c15f5`) no existen o no están probados: el despliegue con https (Railway está preparado, no desplegado), las notificaciones a un celular bloqueado o por WhatsApp (la cuadrilla necesita `/unidad` abierta), el «Seguimiento con código» del vecino, y la prueba en celulares reales (Safari, fotos HEIC, permisos). Algunas esquinas no geocodifican (p. ej. "Rivera y Comercio" cae al mapa) y las que no están en caché tardan 2,5–6 s. **Revisar esta lista contra el estado del sistema antes del pitch.**

## Datos y fuentes

| Dato | Fuente |
|---|---|
| ~40.000 llamados a Bomberos por quema de contenedores en 2025 | [Subrayado, 10/2/2026](https://www.subrayado.com.uy/contenedores-incendiados-bomberos-recibio-mas-50-mil-llamados-imm-espera-que-disminuya-el-plan-residuos-n999752). Única fuente encontrada; la misma nota trae el "50 mil en enero" que no cierra. |
| 727.637 reclamos de basura en 2025 | Intendencia (Desarrollo Ambiental) ante la Junta Departamental, rendición de cuentas 2025, vía [El Observador, 9/9/2026](https://www.elobservador.com.uy/nacional/basura-montevideo-mas-700000-denuncias-un-ano-la-meta-que-no-logro-cumplir-la-im-y-el-plan-piloto-450-contenedores-llave-digital-n6056766). Los ~2.000 por día son cuenta nuestra (727.637 ÷ 365). |
| 33 horas/día de triage | Cuenta ilustrativa: 2.000 avisos × 1 min. No es un dato medido. |
| Cierre de reclamos del SUR: mediana 13 días; 21,4% tarda más de 90 (315.782 finalizados entre 2024 y sep. 2026) | Calculado por nosotros con los [datos abiertos del SUR](https://catalogodatos.gub.uy/dataset/reclamos-registrados-en-el-sistema-unico-de-reclamos-de-la-intendencia-de-montevideo) (archivo del 11/10/2026). Script: `docs/pitch/datos/sur_tiempos.py`. |
| Canales actuales: teléfono 1950, WhatsApp, formulario web del SUR, chatbot, Buzón Ciudadano, presencial | [Trámites IM](https://tramites.montevideo.gub.uy/tramite/contenedor-lleno-o-residuos-fuera-de-el) |
| Agrupación: 5/5 decisiones (5 pares) y 11/11 respuestas por candidato, iguales en dos corridas | `docs/superpowers/notes/jev-smoke.md` |
| Clasificación: 18/18 respuestas esperadas en 9 casos | Ídem. Fotos de Wikimedia Commons, no de reportes reales. |
| Latencia: 230–400 ms solo texto, 640–1.100 ms con foto; agrupación 0,5–1,4 s | Ídem. |
| Demo: incidente en consola ~2 s después de enviar, orden a la cuadrilla ~3 s después; seis relatos distintos probados | `docs/superpowers/notes/demo-en-vivo.md` (verificado en local el 18/10) |
| Un segundo reporte del mismo incidente no crea otra orden | `tests/db/attention-flow.test.ts` |

**Descartado:** la "mediana de 8 días y 11,8% más de 90" de un repositorio de GitHub sin revisión ([EmilianoGonLas/reclamos-montevideo](https://github.com/EmilianoGonLas/reclamos-montevideo)). Usa la misma fuente oficial, pero recalculado sobre los cerrados 2024–2026 da 13 días y 21,4%. Su 8 se parece a la mediana por año de ingreso 2025 (8 días), que subestima porque 19.650 reclamos de ese año siguen abiertos.

**Ojo con mezclar fuentes:** el SUR registró 113.743 reclamos en 2025 (unos 310 por día), mucho menos que los 727.637 de basura. Son registros distintos: los de basura entran por otros canales. No presentar uno como parte del otro.

**No usar en el pitch:** "50.000 llamados en enero de 2026" y "más de 70 incendios entre el 1 de enero y mediados de febrero" (misma nota de Subrayado). Juntos dan unos 700 llamados por incendio: no cierran, y probablemente miden cosas distintas. Si sale en las preguntas: los números públicos de Bomberos y de la Intendencia no coinciden, por eso usamos el de 2025, y que no coincidan también muestra que falta un registro único.
