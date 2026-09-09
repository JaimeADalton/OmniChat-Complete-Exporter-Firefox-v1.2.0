# Notas técnicas — 1.3.0

## Defectos confirmados en el archivo de referencia

El ZIP exterior pasaba CRC, pero cuatro recursos internos contenían texto decimal separado por comas. La reconstrucción de esas listas produce exactamente los archivos originales de esta conversación. El empaquetador anterior usaba `instanceof Uint8Array` y una rama alternativa `String(file.data)`; una vista binaria de otro contexto reproduce la conversión observada. Se reemplaza esa comprobación y se prohíbe convertir objetos arbitrarios a texto.

El extractor anterior ascendía desde un bloque de código hasta encontrar otros `pre`. Esto podía asociar un ejemplo JSON o JavaScript con los demás ejemplos de una respuesta. El extractor nuevo limita la pareja a un contenedor de entrada/salida, impide cruzar otro editor o el mensaje completo y conserva el índice DOM de ambos. En el DOM guardado hay 22 parejas identificables: 3 en el turno 4, 4 en el turno 6 y 15 en el turno 8. No se infiere que sean todas las ejecuciones originales.

`cleanText` ya no se usa para las entradas/salidas de código. El texto preformateado conserva espacios y saltos; el documento Markdown usa delimitadores con longitud suficiente para bloques que contienen otros delimitadores.

El escaneo original registró seis contenedores y el archivo final incluyó ocho turnos, dos de ellos recuperados de la caché de observación. Las capturas estaban etiquetadas con ordinales del recorrido, no necesariamente con los ordinales finales. El recorrido nuevo vuelve a descubrir contenedores e incorpora el identificador estable a cada imagen. Los selectores combinan todos los tipos conocidos. Esto no demuestra que todas las formas futuras de virtualización estén soportadas.

## Integridad y privacidad

`integrity.json` cubre todas las entradas excepto el propio manifiesto de integridad y `SHA256SUMS.txt`. Cada entrada incluye tamaño y SHA-256. El formato ZIP utilizado es ZIP32 sin compresión y rechaza nombres duplicados, rutas ascendentes y tamaños fuera de ese formato.

La comparación de tipos no depende de compartir un constructor JavaScript. Las vistas se copian a bytes propios, respetando sus offsets. Las descargas se acotan por tamaño y tiempo. El background valida emisor y dominios; no acepta un proxy arbitrario de URLs ni envía cookies de sesión a un CDN externo.

El saneamiento de URLs de metadatos no depende de iteradores de `URLSearchParams`. Se retiran parámetros de firmas y autenticación incluso si su nombre está codificado. Las rutas de archivos e identificadores visibles se conservan. El token de autenticación no se serializa. Esto no equivale a eliminar secretos que el usuario haya escrito en sus mensajes o que existan dentro de un adjunto.

Los HTML exportados tienen CSP sin scripts, sin formularios activos y sin recursos de terceros automáticos. Los controles propios de la plataforma no se ejecutan en el visor; los `details` del visor funcionan de forma nativa.

## Adaptador de archivos

Se consultan solo referencias de la rama activa para emparejarlas con evidencia visible. Un nombre o etiqueta ambiguos no autorizan asociar el archivo a un turno arbitrario. El endpoint de descarga sandbox es una integración de compatibilidad, no una API pública documentada. Sus pruebas usan respuestas simuladas de éxito y fallo. Los archivos que no se resuelven permanecen señalados como pendientes; el informe no presenta esa situación como captura completa.

## Alcance de pruebas

Hay pruebas con el HTML guardado del ZIP aportado, fixtures de estructura y virtualización, vistas binarias de distintos contextos, redacción de parámetros y respuestas de API simuladas. El ciclo de exportación completa se probó con APIs de navegador/red y SHA en el entorno de pruebas controlado. Separadamente, el cálculo nativo WebCrypto de Node y el empaquetador JS se verificaron con los cuatro archivos originales y un texto UTF-8, extrayendo luego el ZIP en Python.

No se realizó una exportación nueva con una sesión autenticada del usuario. No se obtuvo un Firefox ejecutable en este entorno. No se han validado variantes actuales de Claude con una sesión real. La firma de Mozilla no forma parte de este paquete.

## Documentación de plataforma consultada

- Mozilla MDN, ArrayBuffer.isView: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer/isView
- Mozilla MDN, Content scripts: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts
- Firefox Extension Workshop, Manifest V3 migration: https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/
- Firefox Extension Workshop, Temporary installation: https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/
