# OmniChat Complete Exporter 1.3.0 — Firefox

Exportador local de conversaciones visibles de ChatGPT y Claude. Esta actualización corrige fallos reproducidos con el archivo exportado por la versión 1.2.0. El adaptador de ChatGPT se ha probado sobre el DOM guardado de esa conversación, con pruebas adicionales de interfaz simulada. No se ha realizado una prueba de integración con una sesión autenticada de ChatGPT en Firefox. No certifica captura completa de una conversación.

## Instalación temporal

1. Quita la versión anterior desde `about:debugging` → Este Firefox.
2. Descomprime este ZIP en una carpeta nueva.
3. Pulsa Cargar complemento temporal y selecciona `manifest.json`.
4. Vuelve a la conversación y recarga la pestaña.
5. Abre OmniChat, selecciona ZIP completo y pulsa Exportar conversación.

El XPI suministrado no está firmado por Mozilla. La carga temporal termina al reiniciar Firefox. La instalación permanente normal necesita firma de Mozilla. No es necesario desactivar ninguna protección para la carga temporal.

## Cambios comprobados

- Los recursos binarios se reconocen con `ArrayBuffer.isView` y se copian respetando `byteOffset` y `byteLength`. Un objeto inesperado provoca un error, nunca una conversión silenciosa a texto.
- Cada ZIP incluye `integrity.json` y `SHA256SUMS.txt` con el tamaño y SHA-256 de sus entradas. Se comprueban tamaños de archivo cuando están disponibles y cabeceras PNG, JPEG, ZIP y PDF.
- Los bloques de ejemplo no toman salidas de otros bloques de la respuesta. Se exige una pareja acotada de entrada/salida o un marcador de herramienta explícito. En el DOM real de referencia: 22 paneles de ejecución, frente a 37 clasificaciones de la versión anterior; la primera respuesta explicativa produce cero ejecuciones.
- El código conserva indentación, saltos de línea y repeticiones. Los delimitadores de Markdown se adaptan al contenido.
- Las URLs de infraestructura redactan firmas y parámetros de autenticación antes de guardarse como metadatos. No se guarda el token de sesión usado temporalmente para resolver archivos.
- Se conserva la referencia a tarjetas y botones de archivo sin pulsarlos. Las páginas HTML de GitHub que terminan en `.md` permanecen como enlaces, no se descargan como si fueran el archivo Markdown.
- El recorrido descubre nuevamente los contenedores conforme avanza y combina secciones y artículos. Las capturas nuevas incluyen el identificador estable del turno.
- Hay un control Cancelar en la página y en el popup. La captura visual se rechaza cuando otra pestaña está activa.
- El visor HTML incluye enlaces locales a los archivos descargados y una política que bloquea scripts y cargas remotas automáticas. Los documentos bajo `raw/` también se generan con una política restrictiva.

## Qué guarda

El ZIP contiene el visor `conversation.html`, Markdown, JSON, el inventario de código y paneles de herramientas, informes, referencias de archivos, instantáneas DOM saneadas y los recursos recuperados. Las imágenes de respaldo están en `visual/`. Los adjuntos están en `files/` y los medios en `assets/`.

La etiqueta «salida visible combinada» conserva exactamente el texto del panel. No se deduce stdout, stderr, éxito, fallo ni código de salida buscando palabras dentro del texto. Un panel puede imprimir esas palabras como parte de un ejemplo.

## Resolución de archivos y permisos

Para recuperar adjuntos visibles, el adaptador puede consultar referencias de la conversación activa desde la sesión del usuario. No guarda la respuesta completa de la API ni recupera razonamiento privado. El token permanece en memoria y solo se envía al mismo origen para las rutas de resolución autorizadas.

El adaptador de enlaces `sandbox:/mnt/data/...` usa una ruta de descarga de compatibilidad que no constituye una API pública estable. Sus pruebas son simuladas: los fallos de sesión, disponibilidad o cambios de API aparecen como referencias sin copia local. No se declara recuperado un archivo solo por haber encontrado su URL.

Las descargas externas pasan al proceso de la extensión y se limitan a los dominios ya autorizados en el manifest. No se solicita acceso a todas las webs, no hay backend ni telemetría. Los iconos decorativos de citas se conservan como referencia; no se descargan automáticamente.

## Límites explícitos

La captura depende de lo que la página monte y permita desplegar. Las vistas visuales son muestras limitadas: máximo 12 por turno y 240 por exportación; no recorren íntegramente todos los paneles con scroll interno. El informe señala límites, fallos y archivos pendientes. Los eventos históricos solo existen si esta pestaña los observó. Cambiar de conversación durante la exportación cancela la captura.

Los archivos adjuntos se preservan íntegros: pueden contener información confidencial, URLs firmadas propias, macros o scripts. Descargarlos no implica ejecutarlos ni sanear su contenido. No compartas una conversación exportada sin revisar también sus adjuntos.

## Verificación opcional

Con Python 3:

```sh
python tests/verify_export.py /ruta/a/conversacion.zip
```

El verificador comprueba tamaños, hashes y CRC del paquete, no certifica que la conversación esté completa ni la autenticidad de sus mensajes.

`tests/RESULTADOS.json` documenta el entorno y el alcance de las pruebas realizadas. Las pruebas del navegador se ejecutaron en Chromium local mediante Playwright con APIs simuladas. Las pruebas de bytes y SHA-256 también se ejecutaron con Node.js y se verificaron con Python. Firefox no estuvo disponible para una prueba de integración.
