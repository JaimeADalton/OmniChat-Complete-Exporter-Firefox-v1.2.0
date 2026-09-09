# OmniChat Complete Exporter 1.3.2 — Firefox

Exportador local de conversaciones de ChatGPT y Claude: HTML, Markdown, JSON y ZIP
con mensajes, actividad visible, paneles de herramientas, código, recursos accesibles,
DOM saneado y capturas de respaldo acotadas.

## Instalar para probar

Paquete de desarrollo SIN firma de Mozilla. En Firefox abre `about:debugging`,
entra en **Este Firefox**, retira la versión anterior, pulsa **Cargar complemento
temporal…** y selecciona este ZIP. También puedes descomprimirlo y seleccionar
`manifest.json`. Recarga la pestaña de ChatGPT/Claude y comprueba la versión 1.3.2.
La instalación temporal termina al reiniciar Firefox. No se incluyen instrucciones
para desactivar protecciones. La instalación permanente normal requiere firma.

## Cambios de 1.3.2

- Inventario inicial mediante desplazamientos solapados: conserva todos los turnos
  montados en cada ventana antes de saltar a paneles largos. No pulsa controles ni
  toma capturas en este primer recorrido.
- Conservación adicional de vecinos montados y de instantáneas retiradas del DOM.
- Inclusión de mensajes de usuario/asistente sin contenedor persistente cuando
  coexisten con otros que sí lo tienen.
- `turn-coverage.json`: índices observados, huecos internos y límites del recorrido.
  No infiere un total de mensajes ni certifica extremos, ramas o paneles no cargados.
- Los enlaces a documentación `.html/.htm` permanecen como enlaces web. Un HTML con
  descarga explícita o una referencia `sandbox:` conserva su tratamiento de archivo.
- Etiquetas de imágenes por identidad estable y ordinal final; se conserva también
  la etiqueta de descubrimiento original para trazabilidad.
- Cobertura visual calculada sobre el último viewport fotografiado. Sin avance
  adicional no fotografiado al agotar el presupuesto por turno.
- Se mantienen las copias binarias explícitas y el preflight de la 1.3.1.
- Mismos permisos de 1.3.1, sin servidor propio ni telemetría.

## Utilización

En la conversación, abre el icono de la extensión, elige **ZIP completo** y pulsa
**Exportar conversación**. Mantén la pestaña activa para las capturas de respaldo.
El inventario añade un recorrido inicial y puede alargar la captura. Puedes cancelar
con el botón de la página o el popup. `turn-coverage.json`, `export-report.txt`,
`diagnostics.json` e `integrity.json` documentan el resultado y sus límites.

## Límites

Se captura contenido accesible al navegador. No se recupera razonamiento privado ni
se utilizan alternativas de conversaciones no seleccionadas. La resolución de archivos
usa la sesión actual y puede fallar si cambian sus rutas o permisos. El DOM y los
controles de las plataformas también pueden cambiar.

Las capturas son muestras del viewport: máximo 12 por turno y 240 globales. No son
una reproducción completa de zonas con desplazamiento interno. El historial de eventos
solo abarca lo observado mientras la extensión estaba activa. La ausencia de huecos
numéricos no prueba que todo el contenido de la conversación haya sido recuperado.

Las firmas/tokens de URL conocidos se ocultan en metadatos; el texto visible de código,
las salidas, las imágenes y los archivos adjuntos conservan su contenido. Revisa la copia
antes de compartirla. Los archivos archivados no se ejecutan por la extensión.

## Pruebas incluidas

`tests/RESULTADOS.json` documenta las pruebas realmente ejecutadas. Son pruebas Node.js
y Chromium con servicios simulados y red bloqueada, incluida la reproducción de una
omisión de mensaje corto y el análisis del HTML real guardado en una exportación.
No se ha hecho una prueba 1.3.2 en Firefox ni en una sesión autenticada de ChatGPT/Claude.

Los scripts en `tests/` son opcionales y no los carga la extensión. Para reproducir:

```
node tests/binary-regression.cjs /tmp/omnichat-binary
python tests/browser-regression.py --out /tmp/omnichat-browser
python tests/continuity-regression.py --out /tmp/omnichat-continuity
python tests/popup-regression.py
python tests/visual-coverage-regression.py
```

Las pruebas Python requieren Playwright, Chromium, BeautifulSoup y Pillow. El análisis
con `--source-zip` requiere una exportación local que tú proporciones; no se incluye
ninguna conversación privada en este paquete.
