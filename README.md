# OmniChat Complete Exporter 1.3.1 — Firefox

Parche de la 1.3.0 para una ruta de error compatible con `Permission denied to access property "constructor"`. Conserva los formatos ZIP, HTML, JSON y Markdown, el extractor de paneles y los permisos anteriores.

## Instalar esta actualización

1. En `about:debugging` → **Este Firefox**, quita la versión anterior de OmniChat.
2. Descomprime este ZIP en una carpeta nueva.
3. Pulsa **Cargar complemento temporal…** y selecciona su `manifest.json`.
4. Recarga la conversación. El popup debe mostrar **1.3.1**; si el script de la pestaña conserva otra versión, la extensión pide recargarla.
5. Selecciona **ZIP completo** y exporta con las opciones habituales. Mantén activa la pestaña si incluyes capturas.

El paquete no está firmado por Mozilla. La carga temporal desaparece al reiniciar Firefox. No requiere compilar, instalar dependencias ni cambiar las protecciones del navegador.

## Corrección incluida

La copia binaria de la 1.3.0 utilizaba `TypedArray.slice()`, y la validación/base64 usaban `subarray()`. Esas operaciones pueden consultar `constructor[Symbol.species]`. Se han sustituido por asignación explícita de memoria y copia con `set()`, respetando los rangos de ArrayBuffer y DataView. El texto UTF-8 y los datos recibidos desde TextEncoder, streams y mensajes de la extensión se normalizan a bytes propios. No se usan `wrappedJSObject`, eval ni desactivaciones de Xray.

Antes de recorrer el chat, la extensión comprueba la copia de bytes, offsets, SHA-256, construcción ZIP y conversión Blob en el navegador. Esta comprobación no prueba la cobertura del chat, la disponibilidad de adjuntos ni la API de descargas.

## Si vuelve a aparecer un error

El aviso permanece visible y muestra la fase. Abre OmniChat y pulsa **Descargar diagnóstico del último error**. Se guarda un JSON con versión, fecha, fase, mensaje y pila. El último diagnóstico se conserva localmente para que cerrar el popup no lo pierda; no se envía automáticamente a ningún servicio.

El diagnóstico no contiene un volcado de la conversación. Revisa el texto del mensaje y la pila antes de compartirlo. Se ocultan URLs de páginas y valores habituales de autenticación; se conservan nombres de los scripts de la extensión y números de línea. Borrar o desinstalar la extensión elimina su almacenamiento conforme al funcionamiento del navegador.

## Datos y límites

El ZIP conserva documentos legibles, JSON, bloques de código, ejecuciones visibles, informes, DOM saneado y los recursos efectivamente recuperados. Los archivos sin copia local se señalan. Las capturas son muestras parciales, hasta 12 por turno y 240 por exportación, sin garantizar cobertura de paneles con desplazamiento interno. El observador conserva solo actividad que la pestaña haya visto.

La extensión usa la sesión activa para intentar resolver referencias de adjuntos de ChatGPT. Esas rutas de compatibilidad no son una API pública estable. No recupera razonamiento privado ni datos nunca mostrados. Los adjuntos se preservan íntegros y pueden contener información confidencial o contenido ejecutable; archivar un archivo no implica ejecutarlo ni sanearlo.

No se añadieron permisos, telemetría ni servicios remotos en este parche. Las consultas de adjuntos conservan los dominios autorizados en la 1.3.0. El visor generado bloquea scripts y cargas remotas automáticas; los enlaces a documentos conservan el riesgo propio de abrir el documento enlazado.

## Pruebas realizadas y alcance

Se verificaron 21 casos con Node.js y Chromium: reproducción controlada de acceso denegado a `constructor`, conservación de bytes entre contextos, hashes, ZIP, HTML, JSON, Markdown, controles del popup, diagnóstico y el DOM previamente guardado de una conversación real. La 1.3.0 falla en la simulación; la 1.3.1 completa la exportación de prueba.

No hubo prueba de integración en Firefox ni en una sesión autenticada de ChatGPT/Claude. El entorno Chromium empleó APIs de extensión simuladas y un puente a hashlib para SHA; las pruebas independientes de Node utilizaron WebCrypto nativo. Simular un getter denegado no reproduce toda la implementación Xray de Firefox. Sin el mensaje y la pila originales del usuario, la causa concreta en su sesión queda pendiente de confirmación.

Detalles: `tests/RESULTADOS.json`. No se incluyen conversaciones ni adjuntos personales dentro de esta extensión.

## Comprobaciones opcionales para desarrolladores

Estas herramientas son opcionales; la extensión no requiere Node ni Python para utilizarse.

```sh
node tests/binary-regression.cjs /tmp/omnichat-tests
python tests/verify_export.py /tmp/omnichat-tests/binary-regression.zip
```

La prueba de navegador requiere Playwright, BeautifulSoup y Chromium:

```sh
python tests/browser-regression.py --out /tmp/omnichat-tests
```

El verificador comprueba integridad binaria, no autenticidad ni exhaustividad de una conversación.
