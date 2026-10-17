# Radar Urbano — guion del pitch

Formato build 101: **3 min de presentación y demo + 3 min de preguntas**. Habla una persona; otra maneja la demo.
Lo que va entre *[corchetes]* es lo que pasa en pantalla, no se lee. Son unas 400 palabras: entran en 3 minutos con las pausas de la demo.

---

## [0:00–0:25] El problema

> Martes, once de la noche. Un contenedor se prende fuego en una esquina. Lo ven diez vecinos.
> ¿Cuántos avisan? Capaz ninguno, porque cada uno piensa que ya avisó otro. O capaz los diez, y llegan diez avisos sueltos que alguien tiene que leer, entender y juntar a mano.
> Solo por contenedores quemados, Bomberos recibió unos cuarenta mil llamados en 2025. Y a la Intendencia le llegan más de dos mil reclamos de basura por día.

*Si en el ensayo te pasás de tiempo, la primera frase que se va es la de los dos mil reclamos.*

## [0:25–0:40] Qué es

> Radar Urbano es un chat. Le escribís como le escribirías a un vecino, con una foto si tenés. La inteligencia artificial entiende qué pasa, qué tan grave es y si alguien ya lo reportó.
> Les muestro.

## [0:40–1:20] Demo: vecino 1

*[Celular 1 proyectado. El compañero manda una foto del contenedor en llamas y escribe: "se está prendiendo fuego el contenedor de la esquina"]*

> Lucía manda una foto y una frase. No eligió una categoría ni llenó un formulario.

*[Aparece la respuesta]*

> El sistema ya entendió: contenedor con fuego, fuego activo, severidad alta. Y como no dijo dónde, le pide la ubicación.

*[Toca "usar mi ubicación" y confirma]*

> Confirma, y ya tiene su código de seguimiento.

## [1:20–1:50] Demo: vecino 2

*[Celular 2. Escribe: "hay mucho humo en la esquina, huele a plástico quemado"]*

> Ahora Martín, otro vecino de la misma cuadra. Lo cuenta distinto: no dice "contenedor", dice "humo".

*[Confirma]*

## [1:50–2:10] Lo que ve el municipio

*[Pantalla del operador]*

> Y esto es lo que ve el municipio. No son dos reclamos: es un incidente con dos reportes, prioridad alta, en el mapa.
> Nadie los juntó a mano. La IA comparó lo que dijo cada uno y decidió que es el mismo contenedor.

## [2:10–2:40] Por qué IA, y cómo sabemos que funciona

> Sin IA, esto es un formulario: el vecino tiene que elegir una categoría y el municipio recibe duplicados.
> Acá la IA hace tres cosas que una regla fija no puede: entender un texto libre y una foto, detectar la urgencia y decidir si dos relatos distintos son el mismo problema.
> Lo medimos: en nuestro set de prueba de agrupación acertó las 11 comparaciones. Y cuando la foto contradice el texto, no adivina: lo manda a revisión humana.

## [2:40–3:00] Cierre

> Hoy funcionan el chat, la clasificación, la agrupación y el mapa del operador. Lo que sigue es la bandeja de las cuadrillas y el despacho automático.
> Diez vecinos, un incidente, una cuadrilla. Eso es Radar Urbano.

---

## Notas para quien maneja la demo

- **Antes de subir:** `reset-demo`; la foto ya en la galería del celular 1; los textos copiados para pegarlos, no tipearlos.
- **Ubicación con GPS:** los dos celulares van a estar juntos en el LATU, así que quedan dentro del radio de 30 m y se agrupan solos. Probarlo en el lugar antes del pitch.
- **Riesgo con el vecino 2:** la frase "humo, huele a plástico" sin foto puede salir como evidencia insuficiente. Si en el ensayo pasa eso, que el texto diga "el contenedor está largando mucho humo".
- **Proyección:** tener resuelto cómo se espejan los celulares en la pantalla, y un video de respaldo grabado por si falla internet.
- **Aviso de emergencia:** con fuego activo el chat muestra el texto de `emergency_channel` del seed de Montevideo (`seeds/territory-montevideo.ts`). Hoy dice "consultá el canal de emergencias local de tu zona"; para la demo conviene que diga algo concreto, como "llamá a Bomberos al 104".

## Qué no prometer como hecho

Hoy no existen: la pantalla para resolver la cola de revisión (el operador solo ve los avisos), la bandeja de la unidad, la planificación y el despacho, las respuestas redactadas por el LLM (el bot usa plantillas), y la geocodificación de esquinas tipo "Rivera y Comercio" (hay que poner un pin).

## Datos y fuentes

| Dato | Fuente |
|---|---|
| ~40.000 llamados a Bomberos por quema de contenedores en 2025 | [Subrayado, 10/2/2026](https://www.subrayado.com.uy/contenedores-incendiados-bomberos-recibio-mas-50-mil-llamados-imm-espera-que-disminuya-el-plan-residuos-n999752) |
| 727.637 reclamos de basura en 2025 (~2.000 por día) | [El Observador, 9/9/2026](https://www.elobservador.com.uy/nacional/basura-montevideo-mas-700000-denuncias-un-ano-la-meta-que-no-logro-cumplir-la-im-y-el-plan-piloto-450-contenedores-llave-digital-n6056766) |
| Mediana de resolución de reclamos: 8 días; 11,8% tarda más de 90 (cerrados 2024–2026) | [Análisis independiente de datos abiertos del SUR](https://github.com/EmilianoGonLas/reclamos-montevideo) |
| Canales actuales: teléfono 1950, WhatsApp, formulario web del SUR, chatbot, Buzón Ciudadano, presencial | [Trámites IM](https://tramites.montevideo.gub.uy/tramite/contenedor-lleno-o-residuos-fuera-de-el) |
| Agrupación: 5/5 decisiones y 11/11 respuestas por candidato correctas, estables en dos corridas | `docs/superpowers/notes/jev-smoke.md` (rama `nucleo/agrupacion`) |

**No usar en el pitch:** "50.000 llamados en enero de 2026" y "más de 70 incendios entre el 1 de enero y mediados de febrero" (misma nota de Subrayado). Juntos dan unos 700 llamados por incendio: no cierran, y probablemente miden cosas distintas. Si sale en las preguntas: los números públicos de Bomberos y de la Intendencia no coinciden, por eso usamos el de 2025, y que no coincidan también muestra que falta un registro único.

**Para las preguntas, no para el pitch:** La Cachimba del Piojo (La Teja). Su calle principal se asfaltó recién en septiembre de 2026, después de años de reclamo, cuando un influencer se hizo viral y entró a la Intendencia a los gritos ([montevideo.com.uy, 25/9/2026](https://www.montevideo.com.uy/Noticias/Vecinos-celebraron-que-se-asfalto-una-calle-de-La-Cachimba-del-Piojo--Es-calidad-de-vida--uc976519)). Sirve si preguntan por qué importa que los reclamos no se pierdan.
