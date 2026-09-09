# OmniChat Complete Exporter 1.2.0 — Firefox

Exportador local de conversaciones para **ChatGPT** y **Claude**, orientado a conservar tanto la conversación como la actividad visible asociada: paneles de trabajo, herramientas, ejecuciones, código, resultados, imágenes, archivos y estado de la interfaz.

## Qué captura

- Mensajes de usuario y asistente, incluidos turnos virtualizados que ChatGPT mantiene como shells persistentes aunque el contenido esté desmontado fuera de pantalla.
- Texto, listas, tablas, citas, enlaces, fórmulas y código visible.
- Ejecuciones reales de herramientas/CLI agrupadas como **herramienta + comando + salida**, separadas de los simples ejemplos de código escritos en una respuesta.
- Paneles de actividad/herramientas y secciones desplegables visibles en la interfaz.
- Imágenes, vídeo, audio y canvas accesibles.
- Tarjetas de archivos subidos por el usuario y filas de artefactos generados aunque la interfaz no exponga un `<a href>` directo.
- En ChatGPT, enriquecimiento local y selectivo de referencias de archivos visibles para intentar resolver su descarga e incluir el contenido real en `files/` o `assets/`.
- Instantánea DOM saneada de cada turno.
- Registro de cambios significativos detectados mientras la extensión está activa.
- Capturas visuales de respaldo; los turnos altos pueden generar varias vistas, con presupuesto repartido para no dejar sin evidencia visual los turnos finales.
- Diagnóstico de la estrategia de captura usada.

## Qué corrige 1.2.0

La versión 1.2.0 se ajustó a partir de una exportación real de ChatGPT que mostraba varios problemas de 1.1.0:

- El extractor anterior contaba como ejecuciones CLI algunos ejemplos escritos dentro de respuestas y también podía contar por separado comando y salida. Ahora exige la estructura de un panel de ejecución visible y guarda una sola ejecución estructurada con su salida.
- Se eliminan duplicados provocados por `<pre>` anidados en los visores de código actuales de ChatGPT.
- Las tarjetas de archivos sin enlace directo, como un `.md` subido por el usuario, se registran como adjuntos visibles.
- Las filas de archivos generados por ChatGPT se registran aunque solo tengan botones de abrir/descargar.
- En ChatGPT se intenta resolver los identificadores de esos archivos usando únicamente referencias de la conversación activa que coinciden con evidencia visible. El token de sesión, si se obtiene, permanece en memoria y no se incluye en el exportado.
- `commands-and-code.md` separa ejecuciones reales de herramientas de otros bloques de código.
- Se filtra ruido de interfaz como Copy, Share, Switch model, More actions, Open image y Show more/Show less de la lista de actividades.
- Las capturas visuales pasan de una única vista por turno a cobertura por mosaicos cuando el turno es más alto que el viewport, hasta un límite global de 240 capturas.
- El ZIP añade `source-layer.json`, que documenta únicamente la resolución local de archivos visibles.

## Contenido del ZIP exportado

- `conversation.html`: vista legible del contenido capturado.
- `conversation.md`: versión Markdown.
- `conversation.json`: estructura completa y metadatos.
- `commands-and-code.md`: ejecuciones reales de herramientas/CLI y, aparte, otros bloques de código.
- `session-events.json`: actividad observada mientras la extensión estuvo activa.
- `diagnostics.json`: estrategia y recuentos de diagnóstico.
- `source-layer.json`: información de resolución de archivos visibles, sin credenciales.
- `export-report.txt`: resumen y advertencias.
- `raw/`: HTML saneado de cada turno.
- `assets/`: imágenes y medios archivados.
- `files/`: archivos/adjuntos archivados.
- `visual/`: capturas visuales JPEG de respaldo e índice JSON.

## Privacidad

Todo el procesamiento se realiza localmente en Firefox. No hay telemetría, analytics ni backend propio. La extensión no sube la conversación a terceros.

Cuando está activado el archivado de archivos/medios, la extensión puede hacer peticiones a los mismos servicios de ChatGPT/Claude que sirven los recursos de la conversación para incluir localmente los elementos que ya están visibles o referenciados en ella. En ChatGPT, la 1.2.0 puede consultar localmente la conversación activa para relacionar una tarjeta de archivo visible con su identificador de descarga. No exporta el token de sesión ni conserva una copia bruta de la respuesta privada de esa API.

Los parámetros de URL con nombres típicos de token/firma se redactan en los metadatos exportados. Las URLs de descarga originales se mantienen solamente en memoria el tiempo necesario para descargar el recurso.

## Instalación temporal para probarla

1. Descomprime el ZIP de la extensión.
2. Abre `about:debugging` en Firefox.
3. Entra en **Este Firefox**.
4. Pulsa **Cargar complemento temporal...**.
5. Selecciona `manifest.json` dentro de la carpeta descomprimida.
6. Recarga la pestaña de ChatGPT o Claude que quieras exportar.
7. Pulsa el icono de **OmniChat Complete Exporter**.
8. Para máxima cobertura, deja activados escaneo profundo, paneles plegados, recursos, DOM, registro de actividad y capturas visuales.
9. Selecciona **ZIP completo** y pulsa **Exportar conversación**.

Los complementos temporales desaparecen al reiniciar Firefox. Para una instalación permanente normal en Firefox Release/Beta, el paquete debe estar firmado por Mozilla.

## Límite técnico

La extensión conserva información que el navegador ha recibido y que está representada o accesible desde la conversación. No puede extraer razonamiento privado del modelo, secretos internos del servidor ni información que nunca haya llegado al navegador. Los frontends de ChatGPT y Claude cambian con frecuencia, por lo que `diagnostics.json`, el DOM saneado y la evidencia visual sirven también como capas de respaldo ante componentes nuevos.
