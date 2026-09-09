# Notas técnicas — 1.3.1

## Diagnóstico de alcance limitado

El usuario informó un error aproximado de exportación con permiso denegado a `constructor`. No se recibió su pila. Al inspeccionar el código entregado en la 1.3.0 se localizaron dos ramas de `normalizedBytes` que terminaban en `.slice()`, más dos operaciones `.subarray()` en validación/base64.

Los métodos de TypedArray que crean vistas o arrays pueden consultar `constructor[Symbol.species]`. Firefox utiliza compartimentos y envoltorios Xray para aislar objetos de la página de los de un content script. Esa combinación es una explicación compatible, pendiente de verificar contra el error original. El parche no considera la simulación de pruebas una reproducción autenticada en Firefox.

## Cambios

- Constructores binarios tomados explícitamente de `globalThis` del content script.
- Copia por vista con el rango original, asignación de `Uint8Array(byteLength)` y `set`, sin invocar slice/subarray ni leer el constructor del dato recibido.
- Copia también de la salida de TextEncoder. No se convierte un objeto binario no reconocido a String.
- Lectura indexada para cabeceras, hexadecimal y bloques base64.
- Autocomprobación antes de la captura: UTF-8, rango DataView, vector SHA-256 de `abc`, ZIP mínimo, Blob y lectura de sus bytes.
- Fases identificables: binary_preflight, capture, resolve_files, archive_resources, build_documents, integrity, zip, download.
- Diagnóstico persistente del último fallo, sin volcado de conversación. Descarga desde el popup para que esa operación no dependa del generador ZIP del content script.
- Comprobación de versión entre popup y script de pestaña. El esquema del chat permanece en 1.3.
- Manifest idéntico a 1.3.0 salvo el número de versión. Background y adaptadores de extracción sin cambios de funcionalidad en este parche.

## Pruebas

`binary-regression.cjs` ejecuta el código real con instrumentación local de pruebas dentro de contextos VM. Un getter denegado de Uint8Array.prototype.constructor reproduce el mensaje en la expresión antigua; la copia nueva, los offsets, SHA y ZIP lo toleran. Un ensayo adicional niega también ArrayBuffer.prototype.constructor para la copia/hash/ZIP. Se restaura ese getter para el Blob de Node, cuya implementación interna usa ArrayBuffer.slice; no se atribuye esa implementación a Firefox. WebCrypto de Node sí es nativo.

`browser-regression.py` ejecuta el content script sobre documentos inertes de prueba en Chromium. Tanto los getters de Uint8Array como los de ArrayBuffer se deniegan. Blob es el nativo del navegador. Debido a la política local de navegación, se trabaja en about:blank y el digest se implementa por un puente a hashlib. APIs de extensión y ubicación son simuladas. Los archivos se vuelven a leer con zipfile/hashlib para contrastar sus bytes y sus hashes.

La prueba adicional con el DOM aportado conserva 8 turnos y 22 paneles delimitados de herramienta. No se deduce que fueran todos los mensajes o comandos originales. Los datos aportados se usan localmente y no se empaquetan.

Se comprueba el popup: bloqueo de versión antigua, recuperación del último diagnóstico, descarga JSON y visualización del fallo. El resultado incluye 21 casos aprobados más dos comprobaciones independientes ZIP/SHA. No se ejecutó Firefox, la API real de descargas ni una sesión autenticada.

## Documentación consultada

- Mozilla MDN, Content scripts: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts
- Mozilla MDN, Sharing objects with page scripts: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Sharing_objects_with_page_scripts
- Firefox Source Docs, Xray vision: https://firefox-source-docs.mozilla.org/dom/scriptSecurity/xray_vision.html
- Mozilla MDN, TypedArray Symbol.species: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/TypedArray/Symbol.species
- Mozilla MDN, TypedArray set: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/TypedArray/set
- Extension Workshop, Temporary installation: https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/
