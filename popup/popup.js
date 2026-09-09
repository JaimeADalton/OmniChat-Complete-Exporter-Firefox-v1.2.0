const $ = (id) => document.getElementById(id);
const EXTENSION_VERSION = browser.runtime.getManifest().version;
let lastDiagnostic = null;
const optionIds = ["deepScan", "expandCollapsed", "archiveAssets", "archiveFiles", "rawDom", "eventLog", "visualEvidence", "format", "assetLimitMb"];

async function activeTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function setStatus(text, isError = false) {
  $("status").textContent = text || "";
  $("status").classList.toggle("error", isError);
}

async function restoreOptions() {
  const saved = await browser.storage.local.get("omnichatOptions");
  if (!saved.omnichatOptions) return;
  for (const id of optionIds) {
    if (!(id in saved.omnichatOptions)) continue;
    const el = $(id);
    if (el.type === "checkbox") el.checked = Boolean(saved.omnichatOptions[id]);
    else el.value = String(saved.omnichatOptions[id]);
  }
}

function optionsFromForm() {
  return {
    deepScan: $("deepScan").checked,
    expandCollapsed: $("expandCollapsed").checked,
    archiveAssets: $("archiveAssets").checked,
    archiveFiles: $("archiveFiles").checked,
    rawDom: $("rawDom").checked,
    eventLog: $("eventLog").checked,
    visualEvidence: $("visualEvidence").checked,
    format: $("format").value,
    assetLimitMb: Number($("assetLimitMb").value) || 200
  };
}

async function send(message) {
  const tab = await activeTab();
  if (!tab?.id) throw new Error("No se encontró una pestaña activa.");
  return browser.tabs.sendMessage(tab.id, message);
}

function requireCurrentVersion(data) {
  if (data?.version !== EXTENSION_VERSION) {
    throw new Error(`La página conserva otra versión de OmniChat. Recarga la conversación para activar la ${EXTENSION_VERSION}.`);
  }
}

async function refreshDiagnostic() {
  try {
    const saved = await browser.storage.local.get("omnichatLastError");
    lastDiagnostic = saved.omnichatLastError || null;
    const data = await send({ type: "OMNICHAT_GET_LAST_ERROR" });
    if (data?.diagnostic) lastDiagnostic = data.diagnostic;
  } catch { /* a saved diagnostic is still useful after navigating away */ }
  $("diagnostic").hidden = !lastDiagnostic;
}

async function downloadDiagnostic() {
  await refreshDiagnostic();
  if (!lastDiagnostic) { setStatus("Todavía no hay un diagnóstico de error guardado."); return; }
  let url;
  try {
    // Created in the extension popup, not in the web page's content compartment.
    const data = JSON.stringify(lastDiagnostic, null, 2) + "\n";
    url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    await browser.downloads.download({ url, filename: `OmniChat-diagnostico-v${lastDiagnostic.version || EXTENSION_VERSION}.json`, saveAs: false, conflictAction: "uniquify" });
    const oldUrl = url;
    setTimeout(() => URL.revokeObjectURL(oldUrl), 120000);
    setStatus("Diagnóstico guardado. Incluye versión, fase, mensaje y pila del último error; revísalo antes de compartirlo.");
  } catch (error) {
    if (url) URL.revokeObjectURL(url);
    setStatus(`No se pudo descargar el diagnóstico: ${error.message || error}`, true);
  }
}

async function refreshSummary() {
  setStatus("Analizando…");
  try {
    const data = await send({ type: "OMNICHAT_GET_SUMMARY" });
    if (!data?.ok) throw new Error(data?.error || "No se pudo analizar la conversación.");
    requireCurrentVersion(data);
    $("export").disabled = Boolean(data.exporting);
    $("platformLabel").textContent = `${data.platformLabel} · ${data.title || "Conversación sin título"}`;
    $("turnCount").textContent = data.turns;
    $("codeCount").textContent = data.codeBlocks;
    $("mediaCount").textContent = data.media + data.files;
    $("toolCount").textContent = data.toolExecutions ?? 0;
    if (!data.turns) {
      setStatus("No se detectaron turnos todavía. Si acabas de instalar la extensión, recarga esta conversación.", true);
    } else if (Number.isFinite(data.mountedTurns) && data.mountedTurns < data.turns) {
      setStatus(`Listo: ${data.turns} turnos detectados (${data.mountedTurns} montados ahora). El escaneo profundo recorrerá los demás.`);
    } else {
      setStatus("Listo para exportar.");
    }
  } catch (error) {
    $("platformLabel").textContent = "ChatGPT / Claude";
    $("export").disabled = true;
    setStatus(error?.message?.includes("otra versión") ? error.message : "No puedo acceder a esta pestaña. Abre una conversación compatible y recárgala después de instalar la extensión.", true);
  }
}

async function startExport() {
  const options = optionsFromForm();
  await browser.storage.local.set({ omnichatOptions: options });
  $("export").disabled = true;
  $("refresh").disabled = true;
  setStatus("Exportando. El progreso aparece también dentro de la página…");
  try {
    requireCurrentVersion(await send({ type: "OMNICHAT_GET_SUMMARY" }));
    const result = await send({ type: "OMNICHAT_EXPORT", options });
    if (result?.diagnostic) lastDiagnostic = result.diagnostic;
    if (!result?.ok) throw new Error(result?.error || "La exportación falló.");
    const warningText = result.warnings ? ` Advertencias: ${result.warnings}.` : "";
    setStatus(`Exportación creada: ${result.filename}.${warningText}`);
  } catch (error) {
    setStatus(`Error: ${error.message || error}`, true);
  } finally {
    $("export").disabled = false;
    $("refresh").disabled = false;
    await refreshDiagnostic();
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await restoreOptions();
  await refreshSummary();
  await refreshDiagnostic();
  $("diagnostic").addEventListener("click", downloadDiagnostic);
  $("cancel").addEventListener("click", async()=>{try{await send({type:"OMNICHAT_CANCEL"});setStatus("Cancelación solicitada.");}catch(e){setStatus(String(e.message||e),true);}});
  $("refresh").addEventListener("click", refreshSummary);
  $("export").addEventListener("click", startExport);
  for (const id of optionIds) {
    $(id).addEventListener("change", () => browser.storage.local.set({ omnichatOptions: optionsFromForm() }));
  }
});
