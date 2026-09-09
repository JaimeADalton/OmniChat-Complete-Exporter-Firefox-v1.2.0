# Notas técnicas — OmniChat Complete Exporter 1.2.0

## Estrategia de captura

1. Adaptadores DOM para ChatGPT y Claude con selectores semánticos y fallbacks.
2. En ChatGPT, prioridad para shells persistentes `conversation-turn-*`; se hace `scrollIntoView` turno a turno, se espera el montaje del contenido y se captura antes de continuar.
3. Si no existen shells persistentes, se usa recorrido por el contenedor de scroll.
4. Expansión temporal conservadora de disclosures; se excluyen acciones como Copy/Share/Edit/Retry/Menu/Download.
5. Captura estructurada de texto, Markdown, código, ejecuciones, actividades, enlaces, medios, archivos e interactivos.
6. Los bloques `<pre>` se reducen a hojas para evitar duplicación por wrappers anidados.
7. Una ejecución real requiere la estructura visible de un visor de comando dentro de un panel de herramienta y un panel de resultado asociado. Los ejemplos `bash` de una respuesta quedan como `shell_code`, no como ejecución.
8. Las ejecuciones se guardan en `toolExecutions[]` con `tool`, `command`, `outputs`, `status` y hash.
9. Se detectan tarjetas de adjunto y filas de artefacto sin `href` directo.
10. En ChatGPT, el enriquecimiento de archivos usa la conversación activa y solo intenta resolver referencias que coinciden con nombres/IDs visibles o enlaces `sandbox:` presentes en mensajes user/assistant de la rama activa. No se guarda el texto bruto recuperado del backend ni el token de sesión.
11. Instantánea DOM saneada por turno: sin scripts, handlers, `srcdoc`, objetos embebidos, iframes activos ni estilos inline.
12. `MutationObserver` para registrar actividad significativa y cachear turnos retirados del DOM.
13. Archivado local de recursos con timeout individual y límite total configurable.
14. Evidencia visual mediante `tabs.captureVisibleTab`; los turnos altos se recorren en mosaicos, reservando capacidad para turnos posteriores. Máximo global: 240 capturas; máximo teórico por turno: 12.
15. ZIP generado íntegramente en el navegador, sin dependencias remotas.

## Archivos de diagnóstico

Cada ZIP puede incluir:

- `diagnostics.json`: estrategia de captura, shells detectados y errores no fatales.
- `source-layer.json`: referencias de archivos visibles encontradas/resueltas, con URLs saneadas.
- `visual/index.json`: relación entre cada captura, turno, mosaico y posición de scroll.
- `export-report.txt`: recuentos y advertencias.

## Seguridad y privacidad

- Sin telemetría, backend propio ni analytics.
- Sin uso del portapapeles.
- Las URLs firmadas/tokens se redactan en metadatos.
- Las credenciales de sesión no se escriben en el ZIP.
- La respuesta bruta de `/backend-api/conversation/...` no se persiste; se utiliza en memoria únicamente para descubrir referencias de archivos de la rama activa y visibles por nombre/ID.
- El HTML exportado elimina contenido ejecutable activo.

## Pruebas 1.2.0

Se probaron, en fixtures automatizados de navegador:

- 12 turnos virtualizados con solo 2 montados inicialmente: recuperación 12/12.
- 6 paneles reales simulados de herramienta: 6 ejecuciones estructuradas, sin convertir ejemplos de código normales en ejecuciones.
- Un botón `Copy` con `aria-expanded=false`: 0 clics y restauración del disclosure legítimo.
- Tarjeta de archivo sin `href` + artefacto generado sin `href`: detección, resolución simulada y archivado dentro de `files/`.
- Captura visual y creación del ZIP, incluido `source-layer.json`.

## Compatibilidad

- Firefox Manifest V3, versión mínima declarada 128.
- ChatGPT: `chatgpt.com` y `chat.openai.com`.
- Claude: `claude.ai`.
