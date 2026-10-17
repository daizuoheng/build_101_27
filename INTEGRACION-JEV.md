# Jev — contrato propuesto para Radar Urbano

Documentación oficial revisada el 17 de octubre de 2026. Investigación documental; todavía no se ejecutaron llamadas autenticadas ni se midió calidad en fotos del piloto.

## 1. Decisión

Usar Jev para evaluación, comparación y reevaluación. El servidor conserva el control de agrupación y despacho. Jev recibe estado y preguntas tipadas; no produce narrativa libre. Un LLM separado redacta motivos y aclaraciones a partir de hechos evaluados y referencias de evidencia; las plantillas configuradas son fallback. La descripción original del ciudadano se conserva. [Introducción](https://docs.typesafe.ai/introduction), [capacidades](https://docs.typesafe.ai/introduction/coding-agents).

SDK: `@typesafe-ai/sdk`, con Node.js ≥22 y `TYPESAFE_API_KEY` en servidor. Invocación mediante `TypeSafeClient.systemOne`. Fijar versión del SDK al implementar. [SDK JavaScript](https://docs.typesafe.ai/sdk/javascript).

Modelo inicial propuesto para la prueba: `jev-1.14.0`, configurado en la política del proveedor. La documentación distingue IDs versionados de aliases móviles; registrar el modelo realmente devuelto y conservar la versión usada para ajustar umbrales. Probar mensajes uruguayos en español: la documentación señala mejor rendimiento en inglés. [Modelos](https://docs.typesafe.ai/models).

## 2. Preguntas para el reporte

Diseño propio del producto, a validar con ejemplos:

| Decisión | Primitiva propuesta | Interpretación |
| --- | --- | --- |
| Aplicabilidad | Choice: aplicable/no relacionado/insuficiente | Elegir resultado y guardar probabilidades/confianza |
| Tipo | Choice con catálogo activo, otro y desconocido | IDs provienen de base; registrar versión del catálogo |
| Severidad | Choice: baja/media/alta/indeterminada | Evitar incluir «desconocida» como un nivel ordinal de gravedad |
| Fuego activo | Choice: sí/no/no determinable | Distinguir ausencia de peligro de falta de evidencia |
| Paso bloqueado | Choice: total/parcial/no/indeterminado | Input para prioridad y capacidad requerida |
| Accesibilidad | Choice: afectada/no/indeterminada | Hecho separado del tipo principal |
| Contradicción texto-foto | Choice: contradicción/consistente/no evaluable | No evaluar como consistente cuando falta una fuente |
| Foto útil | Choice: útil/insuficiente/sin foto | Guiar pedido de evidencia |
| Evidencia de un hecho concreto | Noul por hecho y fuente | Probabilidad de que esa fuente respalde esa afirmación |

Choice devuelve una elección dentro de opciones definidas. Noul sirve para afirmaciones binarias. Si una rúbrica futura usa Score, sus niveles deben ser ordenados y la suficiencia de evidencia se evalúa por separado. [Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score), [Noul](https://docs.typesafe.ai/primitives/noul).

Las preguntas de una llamada se evalúan independientemente sobre el mismo estado. No hacer que severidad dependa de la respuesta de tipo obtenida en esa misma llamada: usar una rúbrica común o una segunda llamada con el tipo ya resuelto. Lo mismo aplica a cualquier pregunta que requiera resultados previos. [Primitivas y composición](https://docs.typesafe.ai/introduction).

## 3. Agrupación y reevaluación

El backend obtiene candidatos por geografía y estado. Para cada candidato, preguntar Choice «mismo evento / distinto / insuficiente», usando datos y fotos identificados en el estado. Preguntar por separado contradicciones de objeto, lugar o tiempo. Si exactamente uno cumple la política y los demás se descartan con evidencia suficiente, asociar. Si hay otro candidato incierto, revisar. El ID del candidato se conserva en el contexto de la pregunta; no se extrae de texto inventado por el modelo.

La reevaluación recibe observaciones originales, hechos evaluados, fechas y métricas calculadas por el backend. Jev vuelve a evaluar tipo, severidad y evolución mediante preguntas acotadas. El backend calcula prioridad y respeta overrides. No exigir al modelo contar fuentes, operar coordenadas o ejecutar reglas de capacidad.

Los motivos se representan mediante códigos como `passage_blocked`, `active_fire`, `conflicting_evidence` o `same_object_supported`, con IDs de reportes y respuestas que los sustentan. Sus etiquetas, criterios y plantillas se guardan en seeds/configuración. Una explicación describe señales utilizadas por el sistema; no se presenta como razonamiento textual generado por Jev.

## 4. Probabilidad y confianza

Choice y Score incluyen `probabilities` y `confidence`; Noul devuelve `noul`, probabilidad de verdadero, sin una confianza separada. La confianza de Choice resume cuánto destaca la opción ganadora frente a una distribución uniforme; no significa por sí sola «porcentaje de acierto». Una respuesta «no relacionado» con confianza alta no habilita despacho. [Confianza](https://docs.typesafe.ai/confidence).

La política exige valor favorable y umbral por pregunta/acción. Guardar el vector completo y la versión del catálogo. Para agrupación y despacho usar umbrales independientes; 0,90 es una hipótesis inicial de seed que requiere evaluación. No aplicar el umbral de `confidence` a un Noul como si ambos campos fueran equivalentes. Una probabilidad de fuego cerca de cero puede apoyar ausencia de fuego; cerca de 0,5 indica incertidumbre.

La existencia documental de estos campos resuelve la duda de compatibilidad de API. La calidad, latencia y umbrales adecuados para Radar Urbano siguen pendientes de validación experimental.

## 5. Fotos

El soporte de imágenes es experimental y requiere `TypeSafe-Danger-Zone-Images: true`. Normalizar con una biblioteca de imágenes en servidor antes de enviar: orientación aplicada a píxeles, PNG/JPEG y dimensiones entre 280 y 1568 por lado. El máximo documentado por archivo es 16 MiB y el cuerpo de solicitud admite 32 MiB; también existen límites después de expandir referencias. Preferir multipart mediante SDK y colocar cada imagen una sola vez en el estado. Jev recibe bytes/assets; no asumir que descarga una URL privada. [Imágenes](https://docs.typesafe.ai/images).

La app puede admitir una foto original mayor y crear un derivado compatible. Mantener relación entre original y derivado. Probar fotos de celular, orientación vertical y formatos reales; cuando no se pueda convertir un formato, solicitar una alternativa claramente. La aceptación del formato en la web no implica que la API de IA lo acepte.

## 6. Coordinación con el LLM generativo

El LLM conversa, propone datos extraídos del mensaje y redacta resúmenes/explicaciones. Jev mantiene la evaluación, comparación y reevaluación. El backend valida propuestas, confirma ubicación y envío, calcula prioridad y ejecuta asignaciones.

La dirección puede extraerse mediante el LLM como propuesta con referencia al mensaje original; geocodificador y ciudadano la verifican. Jev recibe siempre la evidencia original y datos confirmados, no solamente una paráfrasis del LLM. Los textos generados se identifican como derivados y nunca cuentan como una segunda fuente de corroboración.

Las explicaciones del LLM describen resultados y reglas aplicadas con referencias a evidencia. No representan razonamiento interno de Jev. Los mensajes de estado operativo provienen de eventos persistidos; el generador no inventa aceptación, despacho ni tiempos de llegada. Las plantillas quedan como respaldo ante errores de generación. Ver [arquitectura](./ARQUITECTURA-RADAR-URBANO.md).

## 7. Prueba inicial antes de implementar el flujo completo

1. Verificar credencial y llamada de texto con el modelo configurado.
2. Enviar foto normalizada con el header experimental; registrar respuestas y errores sin secretos.
3. Probar las categorías del catálogo, ruido, texto sin foto, contradicción y falta de información.
4. Comparar dos fotos del mismo problema y dos problemas distintos cercanos.
5. Distinguir fuego activo de contenedor quemado, incluyendo evidencia ambigua.
6. Medir latencia, tokens y resultados en español; guardar fixtures y etiquetas esperadas de revisión humana.
7. Ajustar políticas con la muestra y documentar errores observados. La demo debe usar API real e identificar ejemplos precargados.

Si falla una pregunta, conservar el reporte y pasar a revisión. Gestionar los errores y límites a través del adaptador y los jobs; coordinar reintentos del SDK y del worker para no multiplicarlos sin control. [API HTTP](https://docs.typesafe.ai/api).
