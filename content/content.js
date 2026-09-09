(() => {
  "use strict";

  const VERSION = "1.3.0";
  const SCHEMA_VERSION = "1.3";
  const MAX_LIVE_EVENTS = 1000;
  const MAX_SCAN_STEPS = 320;
  const RESOURCE_FETCH_TIMEOUT_MS = 12000;
  const MAX_VISUAL_SNAPSHOTS = 240;
  const MAX_VISUAL_TILES_PER_TURN = 12;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const encoder = new TextEncoder();

  const state = {
    weakIds: new WeakMap(),
    nextWeakId: 1,
    liveLog: [],
    liveSignatures: new Map(),
    liveTimers: new WeakMap(),
    evictedTurns: new Map(),
    observer: null,
    exporting: false,
    visualSnapshots: [],
    cancelled: false,
    navigationKey: location.origin + location.pathname,
    visualCoverage: [],
    diagnostics: []
  };

  function hashString(input) {
    let h = 2166136261 >>> 0;
    const s = String(input || "");
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  function cleanText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();
  }

  function safeInnerText(el) {
    if (!el) return "";
    try {
      return cleanText(el.innerText || el.textContent || "");
    } catch {
      return cleanText(el.textContent || "");
    }
  }

  function absoluteUrl(value) {
    if (!value) return "";
    if (/^(data:|blob:|about:|moz-extension:)/i.test(value)) return value;
    try {
      return new URL(value, document.baseURI).href;
    } catch {
      return String(value);
    }
  }

  function sanitizeExternalUrlForMetadata(value) {
    const url = absoluteUrl(value);
    if (!/^https?:/i.test(url)) return url;
    // Avoid URLSearchParams iteration across Firefox content-script compartments.
    // A decoding failure is fail-closed; never fall back to the original secret.
    return url.replace(/([?&]|&amp;)([^=&#\s]+)=([^&#\s]*)/gi, (match, sep, rawKey, rawValue) => {
      let key;
      try { key = decodeURIComponent(rawKey).toLowerCase(); }
      catch { return `${sep}redacted=REDACTED`; }
      const secret = /^(?:token|sig|signature|auth|authorization|jwt|access_token|refresh_token|id_token|api[_-]?key|key|policy|key-pair-id|x-amz-(?:signature|credential|security-token)|x-goog-(?:signature|credential))$/i.test(key);
      return secret ? `${sep}${rawKey}=REDACTED` : match;
    });
  }

  function codeText(node) {
    const code = node?.querySelector?.('code') || node;
    if (!code) return '';
    const lines = code.querySelectorAll?.('.cm-line');
    return String(lines?.length ? [...lines].map(n => n.textContent || '').join('\n') : code.textContent || '').replace(/\r\n?/g, '\n');
  }

  function fenced(text, language = '') {
    const body = String(text ?? '');
    const runs = body.match(/`+/g) || [];
    const tick = '`'.repeat(Math.max(3, ...runs.map(v => v.length + 1)));
    const lang = String(language).replace(/[^\w+.#-]/g, '');
    return `${tick}${lang === 'text' ? '' : lang}\n${body}${body.endsWith('\n') ? '' : '\n'}${tick}`;
  }

  function normalizedBytes(value) {
    if (typeof value === 'string') return encoder.encode(value);
    // instanceof Uint8Array is NOT a cross-realm byte test.
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value).slice();
    throw new TypeError('Se rechazó un recurso que no es texto ni un búfer binario. No se convierte a String.');
  }

  async function sha256Bytes(value) {
    const digest = await crypto.subtle.digest('SHA-256', normalizedBytes(value));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  function ensureCurrentConversation() {
    const key = location.origin + location.pathname;
    if (key === state.navigationKey) return;
    if (state.exporting) { state.cancelled = true; throw new Error('La conversación cambió durante la captura.'); }
    state.navigationKey = key;
    state.liveLog = []; state.liveSignatures.clear(); state.evictedTurns.clear();
    state.weakIds = new WeakMap(); state.liveTimers = new WeakMap();
  }

  function checkCancelled() {
    if (state.cancelled || state.navigationKey !== location.origin + location.pathname) throw new Error('Exportación cancelada.');
  }

  function platformInfo() {
    const host = location.hostname.toLowerCase();
    if (host === "chatgpt.com" || host === "chat.openai.com") {
      return { id: "chatgpt", label: "ChatGPT" };
    }
    if (host === "claude.ai" || host.endsWith(".claude.ai")) {
      return { id: "claude", label: "Claude" };
    }
    return { id: "unknown", label: host || "Sitio desconocido" };
  }

  function conversationTitle() {
    const platform = platformInfo().id;
    const candidates = platform === "claude"
      ? [
          document.querySelector('[data-testid="chat-header"]'),
          document.querySelector("main h1"),
          document.querySelector("header h1")
        ]
      : [
          document.querySelector("main h1"),
          document.querySelector("header h1"),
          document.querySelector('[data-testid*="conversation-title"]')
        ];
    for (const el of candidates) {
      const text = safeInnerText(el);
      if (text && text.length < 250) return text;
    }
    return cleanText(document.title.replace(/\s*[|–—-]\s*(ChatGPT|Claude).*$/i, "")) || "Conversación";
  }

  function documentOrderSort(a, b) {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function dedupeElements(elements) {
    return [...new Set(elements.filter((el) => el && el.nodeType === 1))].sort(documentOrderSort);
  }

  function chatGptPersistentShells() {
    const all = dedupeElements([...document.querySelectorAll([
      'section[data-testid^="conversation-turn-"]', 'article[data-testid^="conversation-turn-"]',
      '[data-turn-id-container][data-turn]', 'section[data-turn][data-turn-id]', 'article[data-turn][data-turn-id]'
    ].join(','))]);
    // Sections and articles coexist in the supplied real export. Do not return only
    // the first selector that matches: that silently skipped two of eight turns.
    return all.filter(node => !all.some(parent => parent !== node && parent.contains(node)));
  }

  function chatGptTurns() {
    const shells = chatGptPersistentShells();
    if (shells.length) return shells;

    const articles = dedupeElements([...document.querySelectorAll('article[data-turn="user"], article[data-turn="assistant"]')]);
    if (articles.length) return articles;

    const roles = dedupeElements([...document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')]);
    return dedupeElements(roles.map((el) => el.closest('section[data-testid^="conversation-turn-"], article[data-testid^="conversation-turn-"], article[data-turn], section[data-turn]') || el));
  }

  function claudeTurns() {
    const renderContainers = [...document.querySelectorAll("[data-test-render-count]")].filter((el) =>
      el.matches('[data-testid="user-message"]') ||
      el.querySelector('[data-testid="user-message"], [data-testid="human-message"], .font-user-message, .font-claude-response, [data-testid="ai-message"], [data-is-streaming], .standard-markdown, .progressive-markdown')
    );
    if (renderContainers.length) {
      const all = dedupeElements(renderContainers);
      return all.filter((el) => !all.some((other) => other !== el && other.contains(el) && detectRole(other) === detectRole(el)));
    }

    const messageNodes = dedupeElements([
      ...document.querySelectorAll('[data-testid="user-message"], [data-testid="human-message"], .font-user-message'),
      ...document.querySelectorAll('.font-claude-response, [data-testid="ai-message"], [data-testid="message-assistant"], [data-is-streaming] .standard-markdown')
    ]);

    const grouped = messageNodes.map((el) => el.closest("[data-test-render-count]") || el);
    return dedupeElements(grouped);
  }

  function genericTurns() {
    const candidates = dedupeElements([
      ...document.querySelectorAll("main article"),
      ...document.querySelectorAll("main [data-message-author-role]"),
      ...document.querySelectorAll('main [data-testid*="message"]')
    ]);
    return candidates.filter((el) => safeInnerText(el).length > 0);
  }

  function getTurnElements() {
    const platform = platformInfo().id;
    const turns = platform === "chatgpt" ? chatGptTurns() : platform === "claude" ? claudeTurns() : genericTurns();
    return turns.length ? turns : genericTurns();
  }

  function detectRole(el) {
    if (!el) return "unknown";
    const direct = (
      el.getAttribute("data-turn") ||
      el.getAttribute("data-message-author-role") ||
      el.getAttribute("data-role") ||
      ""
    ).toLowerCase();
    if (direct.includes("user") || direct.includes("human")) return "user";
    if (direct.includes("assistant") || direct.includes("ai")) return "assistant";

    const roleNode = el.querySelector("[data-message-author-role]");
    const nested = roleNode?.getAttribute("data-message-author-role")?.toLowerCase() || "";
    if (nested.includes("user")) return "user";
    if (nested.includes("assistant")) return "assistant";

    if (el.matches('[data-testid="user-message"], [data-testid="human-message"], .font-user-message') ||
        el.querySelector('[data-testid="user-message"], [data-testid="human-message"], .font-user-message')) return "user";
    if (el.matches('.font-claude-response, [data-testid="ai-message"], [data-testid="message-assistant"], [data-is-streaming]') ||
        el.querySelector('.font-claude-response, [data-testid="ai-message"], [data-testid="message-assistant"], [data-is-streaming]')) return "assistant";

    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    if (/\b(user|you|usuario|tú)\b/.test(aria)) return "user";
    if (/\b(assistant|chatgpt|claude|asistente)\b/.test(aria)) return "assistant";
    return "unknown";
  }

  function stableTurnId(el) {
    const attrs = [
      "data-turn-id", "data-message-id", "data-testid", "data-test-render-count", "id", "data-id"
    ];
    for (const attr of attrs) {
      const value = el.getAttribute?.(attr);
      if (value && value !== "user" && value !== "assistant") return `${platformInfo().id}:${attr}:${value}`;
    }

    const descendants = [
      ["[data-message-id]", "data-message-id", "message"],
      ["[data-turn-id]", "data-turn-id", "turn"],
      ['[data-testid^="conversation-turn-"]', "data-testid", "testid"],
      ["[data-test-render-count]", "data-test-render-count", "render"]
    ];
    for (const [selector, attr, label] of descendants) {
      const node = el.querySelector?.(selector);
      const value = node?.getAttribute?.(attr);
      if (value) return `${platformInfo().id}:${label}:${value}`;
    }

    // Último recurso: una identidad estable por contenido. Evita perder turnos cuando
    // una interfaz virtualizada recicla el mismo nodo DOM para mensajes distintos.
    const role = detectRole(el);
    const text = cleanText(el.textContent || "");
    if (text) return `${platformInfo().id}:content:${role}:${hashString(text.slice(0, 12000))}`;
    if (!state.weakIds.has(el)) state.weakIds.set(el, `${platformInfo().id}:node:${state.nextWeakId++}`);
    return state.weakIds.get(el);
  }

  function deriveOrderHint(el, id) {
    const testId = el.getAttribute?.('data-testid') || '';
    const match = testId.match(/^conversation-turn-(\d+)$/);
    if (match) return Number(match[1]);
    const count = el.getAttribute?.('data-test-render-count');
    return count != null && /^\d+$/.test(count) ? Number(count) : null;
  }

  function modelInfo(el) {
    const node = el.matches?.("[data-message-model-slug]") ? el : el.querySelector?.("[data-message-model-slug]");
    return node?.getAttribute("data-message-model-slug") || null;
  }

  function shortLabelNear(el) {
    const parent = el.parentElement;
    if (!parent) return "";
    const texts = [];
    for (const child of [...parent.children].slice(0, 5)) {
      if (child === el || child.contains(el)) continue;
      const t = safeInnerText(child);
      if (t && t.length <= 80) texts.push(t);
    }
    const prev = el.previousElementSibling;
    if (prev) {
      const t = safeInnerText(prev);
      if (t && t.length <= 80) texts.unshift(t);
    }
    return texts[0] || "";
  }

  function detectCodeLanguage(pre) {
    const code = pre.querySelector("code") || pre;
    const classText = `${pre.className || ""} ${code.className || ""}`;
    const match = classText.match(/(?:language-|lang-)([a-z0-9_+#.-]+)/i);
    if (match) return match[1].toLowerCase();
    const attrs = ["data-language", "data-lang", "data-code-language"];
    for (const node of [pre, code, pre.parentElement, pre.parentElement?.parentElement].filter(Boolean)) {
      for (const attr of attrs) {
        const value = node.getAttribute?.(attr);
        if (value) return value.toLowerCase();
      }
    }
    const label = shortLabelNear(pre).toLowerCase();
    const known = ["python", "bash", "shell", "sh", "zsh", "javascript", "typescript", "json", "html", "css", "sql", "powershell", "yaml", "xml", "rust", "go", "java", "c", "c++", "c#", "text"];
    const found = known.find((lang) => new RegExp(`\\b${lang.replace(/[+]/g, "\\+")}\\b`, "i").test(label));
    return found || "text";
  }

  function classifyCode(text, language, label) {
    const first = cleanText(text).split("\n").slice(0, 16).join("\n");
    const lang = String(language || "").toLowerCase();
    const context = `${label || ""} ${first}`.toLowerCase();
    const shellLike = ["bash", "shell", "sh", "zsh", "powershell", "terminal", "console"].some((v) => lang.includes(v));
    const commandLike = /(^|\n)\s*(?:\$\s*)?(?:bash\b|sh\b|zsh\b|python(?:3)?\b|node\b|npm\b|npx\b|pnpm\b|yarn\b|git\b|curl\b|wget\b|cd\b|ls\b|cat\b|sed\b|awk\b|grep\b|find\b|docker\b|kubectl\b|pip(?:3)?\b|uv\b|cargo\b|go\b|make\b|cmake\b|pwsh\b|powershell\b)/im.test(first);
    const contextSaysShell = /\b(command|comando|cli|terminal|shell|bash|powershell)\b/i.test(context);
    return shellLike || (commandLike && contextSaysShell) ? "shell_code" : "code";
  }

  function leafPreNodes(el) {
    return [...el.querySelectorAll("pre")].filter((pre) => !pre.querySelector("pre"));
  }

  function nearestOuterPre(pre, boundary) {
    let node = pre?.parentElement;
    while (node && node !== boundary) {
      if (node.tagName === "PRE") return node;
      node = node.parentElement;
    }
    return null;
  }

  function toolLabelFromOuterPre(outerPre, commandText) {
    if (!outerPre) return "";
    const whole = cleanText(outerPre.textContent || "");
    const command = cleanText(commandText || "");
    if (!whole || !command) return "";
    const at = whole.indexOf(command);
    const withoutCommand = at >= 0 ? `${whole.slice(0, at)} ${whole.slice(at + command.length)}` : whole;
    return cleanText(withoutCommand).slice(0, 120);
  }

  function extractToolExecutions(el) {
    const executions = [];
    const leaves = leafPreNodes(el);
    for (const commandPre of leaves) {
      if (!commandPre.closest('#code-block-viewer, .cm-editor') && !commandPre.matches('[data-tool-command]')) continue;
      const outer = nearestOuterPre(commandPre, el);
      const explicit = commandPre.closest('[data-testid="tool-execution"], [data-tool-execution]');
      const command = codeText(commandPre);
      if (!command.trim()) continue;
      const label = explicit?.getAttribute('data-tool-name') || toolLabelFromOuterPre(outer, command);
      if (!/^(?:Python|Bash|Shell|Terminal|Console|Computer|Node(?:\.js)?|Container|container\.(?:exec|feed_chars)|python(?:_user_visible)?(?:\.exec)?|JavaScript tool|Herramienta)(?:\s*\d+)?$/i.test(label)) continue;
      let container = outer?.parentElement || commandPre.parentElement;
      let outputNodes = [];
      let matched = false;
      for (let depth = 0; container && container !== el && depth < 12; depth++, container = container.parentElement) {
        // Never climb out of one execution and borrow output from another block
        // or from the final prose response.
        if (container.matches('[data-message-author-role], article[data-turn], section[data-turn]')) break;
        const localLeaves = leafPreNodes(container);
        const editors = localLeaves.filter(p => p.closest('#code-block-viewer, .cm-editor') || p.matches('[data-tool-command]'));
        if (editors.length > 1) break;
        const others = localLeaves.filter(p => p !== commandPre && !outer?.contains(p));
        if (others.length) {
          const cmdBranch = [...container.children].find(c => c.contains(commandPre));
          const separate = cmdBranch && others.every(p => !cmdBranch.contains(p));
          const resultLike = others.every(p => !p.closest('#code-block-viewer, .cm-editor') && !p.querySelector('code'));
          if (separate && resultLike && !container.matches('.markdown, .prose')) {
            outputNodes = others; matched = true;
          }
          break;
        }
        if (container === explicit) { matched = true; break; }
      }
      if (!matched) continue;
      const outputs = outputNodes.map(codeText);
      const output = outputs.join('\n\n');
      const commandLanguage = /^\s*(?:bash|sh|zsh)\b/.test(command) ? 'bash' : /^python/i.test(label) ? 'python' : /bash|shell|terminal/i.test(label) ? 'sh' : 'text';
      executions.push({
        index: executions.length, tool: label, command, commandLanguage, output, outputs,
        outputKind: 'combined_visible_output',
        status: !outputNodes.length ? 'output_not_visible' : output.length ? 'output_visible' : 'empty_output_panel',
        exitCode: null, source: 'visible_tool_panel',
        commandBlockIndex: leaves.indexOf(commandPre), outputBlockIndices: outputNodes.map(n => leaves.indexOf(n)),
        hash: hashString(`${label}\n${command}\n${output}`)
      });
    }
    return executions;
  }

  function extractCodeBlocks(el, toolExecutions = []) {
    const blocks = [];
    const leaves = leafPreNodes(el);
    for (const [preIndex, pre] of leaves.entries()) {
      const text = codeText(pre);
      if (!text.length) continue;
      const cmd = toolExecutions.find(e => e.commandBlockIndex === preIndex);
      const out = toolExecutions.find(e => e.outputBlockIndices.includes(preIndex));
      const kind = cmd ? 'tool_command' : out ? 'tool_output' : classifyCode(text, detectCodeLanguage(pre), shortLabelNear(pre));
      const language = cmd ? cmd.commandLanguage : out ? 'text' : detectCodeLanguage(pre);
      const label = cmd?.tool || (out ? `${out.tool} · salida visible` : shortLabelNear(pre)) || null;
      blocks.push({index: blocks.length, preIndex, kind, language, label, text, source: 'pre', hash: hashString(`${kind}\n${language}\n${text}`)});
    }
    // Inline examples remain examples. Identical commands at different positions
    // are distinct occurrences, not duplicates to discard by text.
    for (const code of el.querySelectorAll('code')) {
      if (code.closest('pre')) continue;
      const text = codeText(code);
      if (text) blocks.push({index: blocks.length, kind:'inline_code', language:null, label:null, text, source:'code', hash:hashString(text)});
    }
    for (const node of el.querySelectorAll('[data-tool-command], [data-terminal-output]')) {
      if (node.closest('pre') || node.querySelector('pre')) continue;
      const text = codeText(node);
      if (text) blocks.push({index:blocks.length, kind:'code', language:'text', label:null, text, source:'explicit_monospace_fallback', hash:hashString(text)});
    }
    return blocks;
  }

  function extractExpandables(el) {
    const result = [];
    const seen = new Set();
    const nodes = [
      ...el.querySelectorAll("button[aria-expanded], [role='button'][aria-expanded], button[data-state], details > summary")
    ];
    for (const node of nodes) {
      const isSummary = node.tagName === "SUMMARY";
      const details = isSummary ? node.parentElement : null;
      const label = safeInnerText(node) || node.getAttribute("aria-label") || node.getAttribute("title") || "";
      const expanded = isSummary ? Boolean(details?.open) :
        node.getAttribute("aria-expanded") != null ? node.getAttribute("aria-expanded") === "true" : node.getAttribute("data-state") === "open";
      const key = `${label}|${expanded}|${node.getAttribute("aria-controls") || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        label: label || null,
        expanded,
        ariaControls: node.getAttribute("aria-controls") || null,
        dataState: node.getAttribute("data-state") || null
      });
    }
    return result;
  }

  function extractActivities(el) {
    const selectors = [
      "button[aria-expanded]",
      "details > summary",
      "[role='status']",
      "[aria-live='polite']",
      "[aria-live='assertive']",
      "[data-testid*='tool']",
      "[data-testid*='thinking']",
      "[data-testid*='reasoning']",
      "[data-testid*='execution']",
      "[data-testid*='artifact']",
      "[data-testid*='computer']"
    ];
    const seen = new Set();
    const activities = [];
    for (const node of el.querySelectorAll(selectors.join(","))) {
      if (node.closest("[role='toolbar'], [data-message-action-bar]")) continue;
      const text = safeInnerText(node) || node.getAttribute("aria-label") || "";
      if (!text || text.length > 200000) continue;
      if (node.matches("button[aria-expanded]")) {
        const normalized = cleanText(`${node.getAttribute("aria-label") || ""} ${text}`).toLowerCase();
        if (/\b(copy|copiar|share|compartir|switch model|cambiar modelo|more actions|más acciones|open image|abrir imagen|download|descargar|edit message|editar mensaje|show more|show less)\b/i.test(normalized)) continue;
      }
      const type = node.matches("button[aria-expanded],details > summary") ? "expandable" :
        node.matches("[role='status'],[aria-live]") ? "status" : "tool_or_activity";
      const key = `${type}|${text}|${node.getAttribute("data-testid") || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      activities.push({
        type,
        text,
        expanded: node.getAttribute("aria-expanded") === "true" || node.parentElement?.open === true || null,
        testId: node.getAttribute("data-testid") || null,
        ariaLabel: node.getAttribute("aria-label") || null
      });
    }
    return activities;
  }

  function mediaKindFromTag(tag) {
    if (tag === "IMG") return "image";
    if (tag === "VIDEO") return "video";
    if (tag === "AUDIO") return "audio";
    if (tag === "SOURCE") return "source";
    if (tag === "CANVAS") return "canvas";
    return "media";
  }

  function extractMedia(el) {
    const media = [];
    const seen = new Set();
    for (const node of el.querySelectorAll("img, video, audio, source")) {
      const src = node.currentSrc || node.getAttribute("src") || node.getAttribute("poster") || "";
      if (!src) continue;
      const abs = absoluteUrl(src);
      if (seen.has(abs)) continue;
      seen.add(abs);
      media.push({
        kind: mediaKindFromTag(node.tagName),
        decorative: /\/s2\/favicons(?:[?#]|$)|favicon\.(?:ico|png)/i.test(abs),
        url: abs,
        urlForMetadata: sanitizeExternalUrlForMetadata(abs),
        alt: node.getAttribute("alt") || null,
        title: node.getAttribute("title") || null,
        width: node.naturalWidth || node.videoWidth || node.width || null,
        height: node.naturalHeight || node.videoHeight || node.height || null
      });
    }

    for (const canvas of el.querySelectorAll("canvas")) {
      try {
        const url = canvas.toDataURL("image/png");
        const key = hashString(url.slice(0, 5000));
        if (!seen.has(key)) {
          seen.add(key);
          media.push({
            kind: "canvas",
            url,
            urlForMetadata: "data:image/png;base64,[embedded-canvas]",
            alt: canvas.getAttribute("aria-label") || "Canvas capturado",
            title: canvas.getAttribute("title") || null,
            width: canvas.width || null,
            height: canvas.height || null
          });
        }
      } catch {
        media.push({ kind: "canvas", url: null, urlForMetadata: null, alt: "Canvas no exportable (origen protegido)", title: null, width: canvas.width || null, height: canvas.height || null });
      }
    }
    return media;
  }

  const FILE_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|csv|tsv|zip|xpi|7z|rar|tar|gz|json|jsonl|txt|md|rtf|py|js|mjs|cjs|ts|tsx|jsx|html?|css|xml|ya?ml|sql|ipynb|png|jpe?g|gif|webp|svg|mp3|wav|m4a|mp4|webm|mov)(?:$|[?#])/i;

  function isLikelyFileLink(a, href) {
    if (!href || /^(?:javascript|vbscript):/i.test(href)) return false;
    if (a.hasAttribute('download')) return true;
    try {
      const u = new URL(href);
      if ((u.hostname==='github.com' && /\/(?:blob|tree)\//.test(u.pathname)) || u.hostname==='gist.github.com') return false;
      if (a.closest('[data-testid*="citation"]')) return false;
    } catch { /* sandbox: and blob: may not have a web host */ }
    return /^(?:sandbox:|blob:)/.test(href) || FILE_EXT_RE.test(href);
  }

  function extractUiFileTiles(el) {
    const files = [];
    const seen = new Set();

    const tileNodes = [...el.querySelectorAll('[role="group"][aria-label], [class*="group/file-tile"]')];
    for (const node of tileNodes) {
      const hasFileSignal = Boolean(
        node.querySelector('[data-testid="library-file-icon"], [data-library-file-icon-kind], [data-default-action]')
      ) || String(node.className || "").includes("group/file-tile");
      if (!hasFileSignal) continue;

      const name = cleanText(node.getAttribute("aria-label") || safeInnerText(node).split("\n")[0] || "");
      if (!name || !FILE_EXT_RE.test(name)) continue;
      const secondary = [...node.querySelectorAll("div,span")].map((n) => safeInnerText(n)).find((t) => t && t !== name && t.length <= 80) || null;
      const key = `ui:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({
        text: name,
        href: null,
        hrefForMetadata: null,
        title: secondary,
        downloadName: name,
        kind: "ui_attachment",
        source: "visible_file_tile",
        fileId: null
      });
    }

    const artifactRows = [...el.querySelectorAll('[class*="group/artifact-row"]')];
    for (const row of artifactRows) {
      const openButton = [...row.querySelectorAll("button[aria-label]")].find((button) => {
        const label = cleanText(button.getAttribute("aria-label") || "");
        return label && FILE_EXT_RE.test(label) && !/^download\b/i.test(label);
      });
      if (!openButton) continue;
      const name = cleanText(openButton.getAttribute("aria-label") || "");
      const key = `artifact:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({
        text: name,
        href: null,
        hrefForMetadata: null,
        title: "Archivo generado visible",
        downloadName: name,
        kind: "generated_artifact",
        source: "visible_artifact_row",
        fileId: null
      });
    }

    for (const button of el.querySelectorAll('button.behavior-btn')) {
      if (button.closest('pre,code')) continue;
      const text = cleanText(button.textContent || button.getAttribute('aria-label') || '');
      if (!text || !/(?:descargar|download|\bxpi\b|\bzip\b|sha-?256|exporter|archivo|file)/i.test(text)) continue;
      if (files.some(f=>f.text===text)) continue;
      files.push({text, href:null, hrefForMetadata:null, title:'Referencia interactiva visible; pendiente de resolver', downloadName:null, kind:'file_button_reference', source:'visible_behavior_button', fileId:null});
    }
    return files;
  }

  function extractLinks(el) {
    const links = [];
    const files = [];
    const seenLinks = new Set();
    const seenFiles = new Set();
    for (const a of el.querySelectorAll("a[href]")) {
      const href = absoluteUrl(a.getAttribute("href"));
      if (!href || /^javascript:/i.test(href)) continue;
      const text = safeInnerText(a);
      const record = {
        text: text || null,
        href,
        hrefForMetadata: sanitizeExternalUrlForMetadata(href),
        title: a.getAttribute("title") || null,
        downloadName: a.getAttribute("download") || null
      };
      const linkKey = `${record.hrefForMetadata}|${record.text || ""}`;
      if (!seenLinks.has(linkKey)) {
        seenLinks.add(linkKey);
        links.push(record);
      }
      if (isLikelyFileLink(a, href)) {
        const fileKey = href;
        if (!seenFiles.has(fileKey)) {
          seenFiles.add(fileKey);
          files.push({ ...record, kind: "linked_file", source: "anchor" });
        }
      }
    }

    for (const uiFile of extractUiFileTiles(el)) {
      const key = uiFile.href || `${uiFile.kind}:${uiFile.downloadName || uiFile.text || ""}`;
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      files.push(uiFile);
    }
    return { links, files };
  }

  function conversationIdFromLocation() {
    const match = location.pathname.match(/\/c\/([a-z0-9-]{20,})/i);
    return match ? match[1] : null;
  }

  function fileIdFromValue(value) {
    const raw = String(value || "");
    const pointer = raw.match(/^(?:file-service|sediment):\/\/(file_[a-z0-9_-]+)/i);
    if (pointer) return pointer[1];
    const direct = raw.match(/\b(file_[a-z0-9_-]{8,})\b/i);
    return direct ? direct[1] : null;
  }

  function normalizedVisibleName(value) {
    return safeFileName(String(value || "").split(/[\\/]/).pop() || "").toLowerCase();
  }

  function activeConversationNodes(convo) {
    const mapping = convo?.mapping || {};
    if (!convo?.current_node || !mapping[convo.current_node]) return Object.values(mapping);
    const path = [];
    const seen = new Set();
    let id = convo.current_node;
    while (id && mapping[id] && !seen.has(id)) {
      seen.add(id);
      path.push(mapping[id]);
      id = mapping[id].parent;
    }
    return path.reverse();
  }

  function extractSafeFileRefsFromConversation(convo) {
    const refs = [];
    const sandboxLinks = [];
    const seen = new Set();

    const add = (record) => {
      if (!record?.fileId) return;
      const key = `${record.fileId}|${record.messageId || ""}|${record.type || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      refs.push(record);
    };

    for (const node of activeConversationNodes(convo)) {
      const msg = node?.message;
      if (!msg) continue;
      const role = msg.author?.role || "unknown";
      const messageId = msg.id || node.id || null;
      const content = msg.content || {};
      const parts = Array.isArray(content.parts) ? content.parts : [];

      // Solo usamos texto de mensajes user/assistant para descubrir enlaces sandbox
      // que forman parte de la respuesta visible. No se conserva el texto del API.
      if (role === "user" || role === "assistant") {
        for (const part of parts) {
          if (typeof part !== "string") continue;
          const re = /\[([^\]]+)\]\(sandbox:\/mnt\/data\/((?:[^()]|\([^()]*\))+)\)/g;
          let match;
          while ((match = re.exec(part))) {
            sandboxLinks.push({
              messageId,
              role,
              label: cleanText(match[1]),
              filename: safeFileName(decodeURIComponent(match[2].split("/").pop() || "archivo")),
              sandboxPath: `sandbox:/mnt/data/${match[2]}`
            });
          }
        }
      }

      for (const att of msg.metadata?.attachments || []) {
        const fileId = fileIdFromValue(att.id || att.file_id || att.asset_pointer);
        if (!fileId) continue;
        add({
          fileId,
          name: att.name || att.filename || null,
          mime: att.mime_type || att.mime || null,
          size: att.size || att.file_size || null,
          type: "attachment",
          messageId,
          role,
          source: "message_metadata_attachment"
        });
      }

      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const fileId = fileIdFromValue(part.asset_pointer || part.file_id || part.id);
        if (!fileId) continue;
        add({
          fileId,
          name: part.metadata?.filename || part.metadata?.name || null,
          mime: part.metadata?.mime_type || null,
          size: part.metadata?.size || null,
          type: part.content_type || "asset_pointer",
          messageId,
          role,
          source: "message_content_asset"
        });
      }

      for (const citation of msg.metadata?.citations || []) {
        const fileId = fileIdFromValue(citation?.metadata?.file_id || citation?.file_id);
        if (!fileId) continue;
        add({
          fileId,
          name: citation?.metadata?.title || citation?.title || null,
          mime: null,
          size: null,
          type: "citation_file",
          messageId,
          role,
          source: "message_metadata_citation"
        });
      }
    }

    return { refs, sandboxLinks };
  }

  async function chatGptApiJson(path, token = null) {
    checkCancelled();
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin || !/^\/(?:backend-api|api\/auth)\//.test(url.pathname)) throw new Error('Ruta de API fuera de la conversación autorizada.');
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),RESOURCE_FETCH_TIMEOUT_MS);
    try {
      const headers={Accept:'application/json'};
      if(token) headers.Authorization=`Bearer ${token}`;
      const response=await fetch(url.href,{credentials:'include',cache:'no-store',headers,signal:controller.signal});
      if(!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {clearTimeout(timer);}
  }

  async function resolveVisibleSandbox(link, conversationId, token) {
    // Optional compatibility adapter for a visible sandbox link. This endpoint is
    // not a public API contract. Failure is recorded, never treated as success.
    const path=link.sandboxPath.replace(/^sandbox:/,'');
    if(!path.startsWith('/mnt/data/') || path.split('/').includes('..')) throw new Error('Ruta sandbox no válida.');
    const query=`message_id=${encodeURIComponent(link.messageId)}&sandbox_path=${encodeURIComponent(path)}`;
    const meta=await chatGptApiJson(`/backend-api/conversation/${encodeURIComponent(conversationId)}/interpreter/download?${query}`,token);
    if(!meta?.download_url) throw new Error('La referencia visible no proporcionó URL de descarga.');
    return meta;
  }

  async function chatGptAccessToken() {
    try {
      const session = await chatGptApiJson("/api/auth/session");
      return session?.accessToken || null;
    } catch {
      return null;
    }
  }

  async function resolveChatGptFileDownload(fileId, conversationId, token) {
    const encodedId = encodeURIComponent(fileId);
    const encodedConversation = encodeURIComponent(conversationId);
    const candidates = [
      `/backend-api/files/download/${encodedId}?conversation_id=${encodedConversation}&inline=false`,
      `/backend-api/files/download/${encodedId}?inline=false`,
      `/backend-api/files/download/${encodedId}`
    ];
    let lastError = null;
    for (const path of candidates) {
      try {
        const meta = await chatGptApiJson(path, token);
        if (meta?.download_url) return meta;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("No se recibió download_url");
  }

  function visibleFileEvidence(turns) {
    const names = new Map();
    const ids = new Set();
    for (const turn of turns) {
      for (const file of turn.files || []) {
        const key = normalizedVisibleName(file.downloadName || file.text || "");
        if (key) {
          if (!names.has(key)) names.set(key, []);
          names.get(key).push({ turn, file });
        }
        const id = fileIdFromValue(file.href || file.hrefForMetadata || "");
        if (id) ids.add(id);
      }
      for (const media of turn.media || []) {
        const id = fileIdFromValue(media.url || media.urlForMetadata || "");
        if (id) ids.add(id);
        const key = normalizedVisibleName(media.alt || media.title || "");
        if (key) {
          if (!names.has(key)) names.set(key, []);
          names.get(key).push({ turn, media });
        }
      }
    }
    return { names, ids };
  }

  async function enrichChatGptVisibleFiles(turns, options, warnings) {
    const result = {
      attempted: false,
      status: "not_applicable",
      conversationId: null,
      referencesFound: 0,
      visibleReferencesMatched: 0,
      downloadUrlsResolved: 0,
      sandboxLinksFound: 0,
      files: []
    };
    if (platformInfo().id !== "chatgpt" || (!options.archiveFiles && !options.archiveAssets)) return result;

    const conversationId = conversationIdFromLocation();
    if (!conversationId) {
      result.status = "no_conversation_id";
      return result;
    }

    result.attempted = true;
    result.conversationId = conversationId;
    try {
      const token = await chatGptAccessToken();
      const convo = await chatGptApiJson(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, token);
      const extracted = extractSafeFileRefsFromConversation(convo);
      const evidence = visibleFileEvidence(turns);
      extracted.refs = [...new Map(extracted.refs.map(r=>[r.fileId,r])).values()].map(r => {
        const named=extractSafeFileRefsFromConversation(convo).refs.find(x=>x.fileId===r.fileId && x.name); return named||r;
      });
      result.referencesFound = extracted.refs.length;
      result.sandboxLinksFound = extracted.sandboxLinks.length;

      // Los nombres presentes en enlaces sandbox de mensajes user/assistant son evidencia
      // de visibilidad equivalente a una tarjeta de archivo.
      for (const link of extracted.sandboxLinks) {
        const key = normalizedVisibleName(link.filename);
        if (key && !evidence.names.has(key)) evidence.names.set(key, []);
      }

      const resolvedById = new Map();
      for (const ref of extracted.refs) {
        const refName = normalizedVisibleName(ref.name || "");
        const matchingEntries = refName ? (evidence.names.get(refName) || []) : [];
        const idVisible = evidence.ids.has(ref.fileId);
        const sandboxMatch = extracted.sandboxLinks.find((link) => {
          const a = normalizedVisibleName(link.filename);
          const b = refName;
          return a && b && a === b;
        });
        const visible = idVisible || matchingEntries.length > 0 || Boolean(sandboxMatch);
        if (!visible) continue;

        result.visibleReferencesMatched += 1;
        let meta = resolvedById.get(ref.fileId);
        if (!meta) {
          try {
            meta = await resolveChatGptFileDownload(ref.fileId, conversationId, token);
            resolvedById.set(ref.fileId, meta);
            result.downloadUrlsResolved += 1;
          } catch (error) {
            result.files.push({
              fileId: ref.fileId,
              name: ref.name || sandboxMatch?.filename || null,
              type: ref.type,
              messageId: ref.messageId,
              role: ref.role,
              visible: true,
              resolved: false,
              error: error.message || String(error)
            });
            continue;
          }
        }

        const visibleName = ref.name || sandboxMatch?.filename || meta.file_name || ref.fileId;
        const sanitizedUrl = sanitizeExternalUrlForMetadata(meta.download_url);
        result.files.push({
          fileId: ref.fileId,
          name: visibleName,
          type: ref.type,
          messageId: ref.messageId,
          role: ref.role,
          visible: true,
          resolved: true,
          downloadUrl: sanitizedUrl,
          size: meta.file_size_bytes || ref.size || null
        });

        let applied = false;
        for (const entry of matchingEntries) {
          if (!entry.file) continue;
          entry.file.fileId = ref.fileId;
          entry.file.expectedSize = Number(meta.file_size_bytes || ref.size) || null;
          entry.file.href = meta.download_url;
          entry.file.hrefForMetadata = sanitizedUrl;
          entry.file.downloadName = entry.file.downloadName || visibleName;
          entry.file.source = `${entry.file.source || "visible"}+chatgpt_api`;
          applied = true;
        }

        if (!applied && sandboxMatch) {
          // Busca el turno que contiene la etiqueta visible del enlace; si no, usa el último
          // turno del mismo rol para conservar el archivo sin inventar contenido.
          const turn = turns.find((candidate) => candidate.role === sandboxMatch.role && candidate.text?.includes(sandboxMatch.label))
            ;
          if (turn) {
            turn.files.push({
              text: sandboxMatch.label || visibleName,
              href: meta.download_url,
              hrefForMetadata: sanitizedUrl,
              title: "Archivo enlazado visible en el mensaje",
              downloadName: sandboxMatch.filename || visibleName,
              kind: "sandbox_attachment",
              source: "visible_sandbox_link+chatgpt_api",
              fileId: ref.fileId
            });
          }
        }
      }

      result.generatedLinks = [];
      for (const link of extracted.sandboxLinks) {
        const filename = link.filename;
        const byId = turns.filter(t=>t.role===link.role && (t.id.includes(link.messageId)||(t.rawHtml||'').includes(link.messageId)));
        const matches = byId.length===1 ? byId : turns.filter(t=>t.role===link.role && (t.files||[]).some(f=>f.text===link.label || f.downloadName===filename));
        if(matches.length!==1) { result.generatedLinks.push({name:filename,label:link.label,status:'unmatched_or_ambiguous_dom',messageId:link.messageId}); continue; }
        const turn = matches[0];
        let file = turn.files.find(f=>f.downloadName===filename) || turn.files.find(f=>f.text===link.label);
        if(file) turn.files = turn.files.filter(f=>f===file || !(f.text===link.label && !f.href));
        if(!file) { file={text:link.label,href:null,hrefForMetadata:null,downloadName:filename,kind:'sandbox_attachment',source:'visible_sandbox_link'}; turn.files.push(file); }
        file.downloadName=filename; file.sandboxPath=link.sandboxPath; file.messageId=link.messageId;
        if(file.href) continue;
        const record={name:filename,label:link.label,messageId:link.messageId,turnId:turn.id,sandboxPath:link.sandboxPath,status:'unresolved'};
        if(options.archiveFiles) {
          try {
            const meta=await resolveVisibleSandbox(link,conversationId,token);
            file.href=meta.download_url; file.hrefForMetadata=sanitizeExternalUrlForMetadata(meta.download_url);
            file.expectedSize=Number(meta.file_size_bytes)||null;
            file.source+=' + sandbox_download_adapter';
            record.status='download_url_resolved'; result.downloadUrlsResolved++;
          } catch(error) { record.error=error.name==='AbortError'?'timeout':String(error.message||error); }
        }
        result.generatedLinks.push(record);
      }
      result.unresolvedGeneratedLinks = result.generatedLinks.filter(f=>f.status!=='download_url_resolved').length;
      result.status = result.unresolvedGeneratedLinks ? 'partial' : 'ok';
      state.diagnostics.push({
        kind: "chatgpt-source-enrichment",
        timestamp: new Date().toISOString(),
        referencesFound: result.referencesFound,
        visibleReferencesMatched: result.visibleReferencesMatched,
        downloadUrlsResolved: result.downloadUrlsResolved,
        sandboxLinksFound: result.sandboxLinksFound
      });
    } catch (error) {
      result.status = "failed";
      result.error = error.message || String(error);
      state.diagnostics.push({ kind: "chatgpt-source-enrichment-error", timestamp: new Date().toISOString(), message: result.error });
      // No se considera fallo de exportación: el DOM sigue siendo la fuente principal.
      warnings.push(`No se pudo enriquecer la exportación con referencias de archivos de ChatGPT (${result.error}). Las tarjetas y el DOM visibles sí se conservaron.`);
    }
    return result;
  }

  function extractInteractive(el) {
    const items = [];
    for (const node of el.querySelectorAll("button, [role='button'], input, textarea, select, summary")) {
      if (node.closest("[role='toolbar'], [data-message-action-bar]") && !node.matches("[aria-expanded]")) continue;
      const text = safeInnerText(node) || node.getAttribute("aria-label") || node.getAttribute("placeholder") || "";
      if (!text && !node.getAttribute("aria-expanded")) continue;
      items.push({
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role") || null,
        text: text || null,
        ariaLabel: node.getAttribute("aria-label") || null,
        ariaExpanded: node.getAttribute("aria-expanded") || null,
        ariaPressed: node.getAttribute("aria-pressed") || null,
        disabled: Boolean(node.disabled || node.getAttribute("aria-disabled") === "true")
      });
      if (items.length >= 200) break;
    }
    return items;
  }

  function sanitizeClone(original) {
    const clone = original.cloneNode(true);
    const originalCanvases = [...original.querySelectorAll("canvas")];
    const cloneCanvases = [...clone.querySelectorAll("canvas")];
    cloneCanvases.forEach((canvas, i) => {
      const source = originalCanvases[i];
      if (!source) return;
      try {
        const img = clone.ownerDocument.createElement("img");
        img.setAttribute("src", source.toDataURL("image/png"));
        img.setAttribute("alt", source.getAttribute("aria-label") || "Canvas capturado");
        img.setAttribute("data-omnichat-canvas", "true");
        canvas.replaceWith(img);
      } catch {
        const placeholder = clone.ownerDocument.createElement("div");
        placeholder.textContent = "[Canvas no exportable: origen protegido]";
        canvas.replaceWith(placeholder);
      }
    });

    clone.querySelectorAll("#omnichat-export-toast, .chatgptbox-toolbar-container").forEach(n=>n.remove());
    const forbidden = clone.querySelectorAll("script, style, link, meta, object, embed, base, template, svg foreignObject, svg animate, svg set");
    forbidden.forEach((node) => node.remove());

    for (const iframe of clone.querySelectorAll("iframe")) {
      const placeholder = clone.ownerDocument.createElement("div");
      const src = iframe.getAttribute("src");
      placeholder.textContent = `[iframe${src ? `: ${sanitizeExternalUrlForMetadata(src)}` : ""}]`;
      iframe.replaceWith(placeholder);
    }

    for (const node of [clone, ...clone.querySelectorAll("*")]) {
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || ["nonce", "integrity", "srcdoc", "action", "formaction", "ping", "autofocus", "autoplay", "form"].includes(name)) {
          node.removeAttribute(attr.name);
          continue;
        }
        if (name === "style") {
          node.removeAttribute(attr.name);
          continue;
        }
        if (["href", "src", "poster", "xlink:href"].includes(name)) {
          const abs = absoluteUrl(attr.value);
          if (/^(?:javascript|vbscript):/i.test(abs) || (name !== "src" && /^data:/i.test(abs))) node.removeAttribute(attr.name);
          else node.setAttribute(attr.name, sanitizeExternalUrlForMetadata(abs));
        }
        if (name === "srcset") node.removeAttribute(attr.name);
      }
      if (node.tagName === "INPUT" && ["password", "hidden"].includes(node.type)) { node.remove(); continue; }
      if (node.tagName === "INPUT") {
        if (node.type === "checkbox" || node.type === "radio") {
          if (node.checked) node.setAttribute("checked", "checked");
          else node.removeAttribute("checked");
        } else if (node.value) {
          node.setAttribute("value", node.value);
        }
      }
      if (node.tagName === "TEXTAREA") node.textContent = node.value || node.textContent || "";
      if (node.tagName === "SELECT") {
        [...node.options].forEach((option) => {
          if (option.selected) option.setAttribute("selected", "selected");
          else option.removeAttribute("selected");
        });
      }
    }
    return clone;
  }

  function escapeMd(text) {
    return String(text || "").replace(/([\\`*_{}\[\]()#+.!|>-])/g, "\\$1");
  }

  function domToMarkdown(root) {
    const protectedBlocks = [];
    function protect(value) { const key = `OMNICHATPROTECTEDBLOCK${protectedBlocks.length}END`; protectedBlocks.push(value); return `\n\n${key}\n\n`; }
    function walk(node, listDepth = 0) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.tagName.toLowerCase();
      if (['script','style','noscript','svg','template'].includes(tag)) return '';
      const children = () => [...node.childNodes].map(n => walk(n,listDepth)).join('');
      if (tag === 'pre') {
        const leaf = node.querySelector('pre') ? [...node.querySelectorAll('pre')].filter(p=>!p.querySelector('pre'))[0] : node;
        const label = leaf !== node ? toolLabelFromOuterPre(node,codeText(leaf)) : '';
        return protect((label ? label+'\n\n' : '') + fenced(codeText(leaf), detectCodeLanguage(leaf)));
      }
      if (tag === 'code') return '`'+(node.textContent||'').replace(/`/g,'\\`')+'`';
      if (/^h[1-6]$/.test(tag)) return `\n${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`;
      if (['p','div','section','article'].includes(tag)) return `${children()}\n`;
      if (tag === 'br') return '\n';
      if (tag === 'strong'||tag === 'b') return `**${children()}**`;
      if (tag === 'em'||tag === 'i') return `*${children()}*`;
      if (tag === 'hr') return '\n---\n';
      if (tag === 'img') { const src=sanitizeExternalUrlForMetadata(node.getAttribute('src')||''); return src?`![${escapeMd(node.getAttribute('alt')||'imagen')}](${src.replace(/\)/g,'%29')})`:''; }
      if (tag === 'a') { const href=sanitizeExternalUrlForMetadata(node.getAttribute('href')||''); return href?`[${children().trim()||href}](${href.replace(/\)/g,'%29')})`:children(); }
      if (tag === 'ul'||tag === 'ol') return '\n'+[...node.children].filter(c=>c.tagName==='LI').map((li,i)=>'  '.repeat(listDepth)+(tag==='ol'?`${i+1}. `:'- ')+[...li.childNodes].map(n=>walk(n,listDepth+1)).join('').trim()).join('\n')+'\n';
      if (tag === 'blockquote') return '\n'+children().trim().split('\n').map(v=>'> '+v).join('\n')+'\n';
      if (tag === 'table') {
        const rows=[...node.querySelectorAll('tr')].map(tr=>[...tr.children].map(c=>(c.textContent||'').trim().replace(/\|/g,'\\|').replace(/\n/g,'<br>')));
        if (!rows.length) return '';
        return '\n| '+rows[0].join(' | ')+' |\n| '+rows[0].map(()=>'---').join(' | ')+' |\n'+rows.slice(1).map(r=>'| '+r.join(' | ')+' |').join('\n')+'\n';
      }
      if (tag === 'button' || node.getAttribute('role')==='button') return (children().trim() || node.getAttribute('aria-label') || '')+'\n';
      return children();
    }
    let result = walk(root).replace(/\n{4,}/g,'\n\n\n').trim();
    result = result.replace(/OMNICHATPROTECTEDBLOCK(\d+)END/g,(_,n)=>protectedBlocks[Number(n)]);
    return result;
  }

  function extractTurnSnapshot(el, options = {}) {
    const id = stableTurnId(el);
    const role = detectRole(el);
    const sanitized = options.rawDom === false ? null : sanitizeClone(el);
    const toolExecutions = extractToolExecutions(el);
    const codeBlocks = extractCodeBlocks(el, toolExecutions);
    const { links, files } = extractLinks(el);
    const media = extractMedia(el);
    const expandables = extractExpandables(el);
    const activities = extractActivities(el);
    const markdownSource = sanitizeClone(el);
    const markdown = domToMarkdown(markdownSource);
    const text = safeInnerText(el);
    const allText = cleanText(el.textContent || "");
    return {
      id,
      role,
      model: modelInfo(el),
      orderHint: deriveOrderHint(el, id),
      capturedAt: new Date().toISOString(),
      text,
      allText: allText === text ? null : allText,
      markdown,
      codeBlocks,
      toolExecutions,
      expandables,
      activities,
      links,
      files,
      media,
      interactive: extractInteractive(el),
      rawHtml: sanitized ? sanitized.outerHTML : null,
      captureCoverage: {source:"visible_dom", fullConversationVerified:false, toolStreamsSeparated:false},
      domFingerprint: hashString(`${role}|${allText}|${codeBlocks.map((b) => b.hash).join(",")}|${expandables.map((e) => `${e.label}:${e.expanded}`).join("|")}`)
    };
  }

  function getSummary() {
    const turns = getTurnElements();
    let codeBlocks = 0;
    let toolExecutions = 0;
    let media = 0;
    let files = 0;
    let expandables = 0;
    for (const turn of turns) {
      const executions = extractToolExecutions(turn);
      toolExecutions += executions.length;
      codeBlocks += extractCodeBlocks(turn, executions).length;
      media += extractMedia(turn).length;
      files += extractLinks(turn).files.length;
      expandables += turn.querySelectorAll("button[aria-expanded],details > summary,[role='button'][aria-expanded]").length;
    }
    const platform = platformInfo();
    const mountedTurns = turns.filter((turn) => cleanText(turn.textContent || "") || turn.querySelector?.("pre,img,video,audio,canvas,[data-message-author-role]")).length;
    return {
      ok: true,
      platform: platform.id,
      platformLabel: platform.label,
      title: conversationTitle(),
      turns: turns.length,
      mountedTurns,
      persistentShells: platform.id === "chatgpt" ? chatGptPersistentShells().length : null,
      codeBlocks,
      toolExecutions,
      media,
      files,
      expandables,
      liveEvents: state.liveLog.length
    };
  }

  function toast(title, progress = "") {
    let box = document.getElementById("omnichat-export-toast");
    if (!box) {
      box = document.createElement("div");
      box.id = "omnichat-export-toast";
      box.innerHTML = '<div class="omnichat-title"></div><div class="omnichat-progress"></div><button type="button" class="omnichat-cancel">Cancelar</button>';
      box.querySelector('.omnichat-cancel').addEventListener('click',()=>{state.cancelled=true;box.querySelector('.omnichat-progress').textContent='Cancelando…';});
      document.documentElement.appendChild(box);
    }
    box.hidden = false;
    const cancel=box.querySelector('.omnichat-cancel');
    if(cancel)cancel.hidden=!state.exporting || /terminada|error|cancelada/.test(title);
    box.querySelector(".omnichat-title").textContent = title;
    box.querySelector(".omnichat-progress").textContent = progress;
  }

  function hideToast(delay = 2200) {
    const box = document.getElementById("omnichat-export-toast");
    if (!box) return;
    setTimeout(() => { if (box) box.hidden = true; }, delay);
  }

  function findScrollContainer() {
    const turns = getTurnElements();
    const candidates = new Set();
    const first = turns[0];
    const last = turns[turns.length - 1];

    for (const probe of [first, last].filter(Boolean)) {
      let node = probe.parentElement;
      while (node) {
        candidates.add(node);
        if (node === document.body || node === document.documentElement) break;
        node = node.parentElement;
      }
    }
    if (document.scrollingElement) candidates.add(document.scrollingElement);
    for (const node of document.querySelectorAll('main, [class*="overflow-y-auto"], [class*="overflow-auto"], [data-scroll-root], [data-testid*="scroll"]')) {
      candidates.add(node);
    }

    const scored = [...candidates].map((node) => {
      let range = 0;
      let overflow = "";
      try {
        range = Math.max(0, node.scrollHeight - node.clientHeight);
        overflow = getComputedStyle(node).overflowY || "";
      } catch { /* noop */ }
      const containsFirst = first ? node.contains(first) : true;
      const containsLast = last ? node.contains(last) : true;
      const likely = /(auto|scroll|overlay)/.test(overflow) || node === document.scrollingElement;
      const score = (containsFirst && containsLast ? 1e9 : 0) + (likely ? 1e8 : 0) + range;
      return { node, range, score };
    }).filter((entry) => entry.range > 100);

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.node || document.scrollingElement || document.documentElement;
  }

  function scrollMetrics(scroller) {
    return {
      top: Number(scroller.scrollTop || 0),
      height: Number(scroller.scrollHeight || 0),
      viewport: Math.max(1, Number(scroller.clientHeight || innerHeight || 1))
    };
  }

  function setScrollTop(scroller, top) {
    const value = Math.max(0, Number(top) || 0);
    try { scroller.scrollTo({ top: value, behavior: "instant" }); }
    catch { try { scroller.scrollTop = value; } catch { /* noop */ } }
  }

  async function settleAtTop(scroller) {
    let lastHeight = -1;
    let stable = 0;
    for (let i = 0; i < 18; i += 1) {
      setScrollTop(scroller, 0);
      await wait(260);
      const h = Number(scroller.scrollHeight || 0);
      if (Math.abs(h - lastHeight) <= 2) stable += 1;
      else stable = 0;
      lastHeight = h;
      if (stable >= 3) break;
    }
  }

  function riskyExpandableButton(button) {
    if (!button || button.disabled || button.getAttribute('aria-disabled')==='true') return true;
    if (button.closest("[role='toolbar'], [data-message-action-bar], nav, form, .chatgptbox-toolbar-container, [class*='group/artifact-row']")) return true;
    if (button.getAttribute('aria-haspopup') || button.matches('.behavior-btn,[data-testid*="copy"],[data-testid*="clipboard"]')) return true;
    const label=cleanText(`${button.getAttribute('aria-label')||''} ${button.getAttribute('title')||''} ${safeInnerText(button)}`);
    // "Inspected exporters and created updated copy" is an activity, not Copy.
    return /^(?:copy|copiar|clipboard|portapapeles|share|compartir|edit(?: message)?|editar|retry|reintentar|regenerate|regenerar|delete|eliminar|download|descargar|open file|abrir archivo|switch model|cambiar modelo|more actions|más acciones|menu|menú|like|dislike)\b/i.test(label);
  }

  function likelyDisclosureButton(button) {
    if (riskyExpandableButton(button)) return false;
    const expanded = button.getAttribute("aria-expanded");
    const stateValue = button.getAttribute("data-state");
    if (expanded !== "false" && stateValue !== "closed") return false;

    const controls = button.getAttribute("aria-controls");
    if (controls && document.getElementById(controls)) return true;

    const testId = `${button.getAttribute("data-testid") || ""} ${button.closest("[data-testid]")?.getAttribute("data-testid") || ""}`.toLowerCase();
    if (/thinking|reasoning|tool|execution|activity|artifact|computer|analysis|code|terminal|result/.test(testId)) return true;

    const label = cleanText(`${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${safeInnerText(button)}`).toLowerCase();
    if (/\b(show|hide|expand|collapse|details?|thinking|reasoning|analysis|activity|tool|python|terminal|code|result|output|ver|mostrar|ocultar|expandir|contraer|detalles?|actividad|herramienta|resultado|salida|pensando|razonamiento)\b/i.test(label)) return true;

    // Los paneles de actividad de ChatGPT a menudo son disclosures sin texto ARIA explícito.
    // Solo aceptamos el fallback cuando están dentro de un turno y no parecen una acción.
    return Boolean(button.closest('[data-testid*="conversation-turn"], article[data-turn], section[data-turn]')) &&
      (button.hasAttribute("aria-expanded") || button.hasAttribute("data-state"));
  }

  async function expandTurnsSafely(turns) {
    const restorers = [];
    const processed = new Set();
    let totalClicks = 0;
    for (let pass = 0; pass < 8; pass += 1) {
      checkCancelled();
      let changed = 0;
      for (const turn of turns) {
        if (!turn?.isConnected) continue;
        for (const details of turn.querySelectorAll("details:not([open])")) {
          if (processed.has(details)) continue;
          processed.add(details);
          details.open = true;
          restorers.push(() => { if (details.isConnected) details.open = false; });
          changed += 1;
        }

        const buttons = [...turn.querySelectorAll('button[aria-expanded="false"], [role="button"][aria-expanded="false"], button[data-state="closed"]')];
        for (const button of buttons) {
          if (processed.has(button) || !likelyDisclosureButton(button) || totalClicks >= 180) continue;
          processed.add(button);
          totalClicks += 1;
          const beforeExpanded = button.getAttribute("aria-expanded");
          const beforeState = button.getAttribute("data-state");
          try {
            button.click();
            await wait(90);
            const opened = button.getAttribute("aria-expanded") === "true" || button.getAttribute("data-state") === "open";
            if (opened) {
              restorers.push(() => {
                try {
                  if (button.isConnected && (button.getAttribute("aria-expanded") === "true" || button.getAttribute("data-state") === "open")) button.click();
                } catch { /* noop */ }
              });
              changed += 1;
            } else {
              // Si el control no se comportó como disclosure, no lo volvemos a tocar.
              state.diagnostics.push({kind:"disclosure-not-opened", label:safeInnerText(button)||button.getAttribute("aria-label"), beforeExpanded, beforeState});
            }
          } catch { /* noop */ }
        }
      }
      if (!changed) break;
      await wait(120);
    }
    return restorers;
  }

  async function restoreExpanded(restorers) {
    for (const restore of [...restorers].reverse()) {
      try { restore(); } catch { /* noop */ }
      await wait(12);
    }
  }

  function snapshotScore(snapshot) {
    if (!snapshot) return -1;
    return (snapshot.text?.length || 0) +
      (snapshot.markdown?.length || 0) * 0.25 +
      (snapshot.codeBlocks?.reduce((n, b) => n + (b.text?.length || 0), 0) || 0) * 2 +
      (snapshot.activities?.length || 0) * 600 +
      (snapshot.media?.length || 0) * 400 +
      (snapshot.files?.length || 0) * 250 +
      (snapshot.expandables?.length || 0) * 80;
  }

  function mergeSnapshot(map, snapshot, orderMap, nextOrderRef) {
    if (!snapshot?.id) return;
    if (!orderMap.has(snapshot.id)) orderMap.set(snapshot.id, nextOrderRef.value++);
    const prior = map.get(snapshot.id);
    if (!prior || snapshotScore(snapshot) >= snapshotScore(prior)) {
      map.set(snapshot.id, { ...snapshot, scanOrder: orderMap.get(snapshot.id) });
    }
  }

  async function captureElementInto(map, el, options, orderMap, nextOrderRef) {
    if (!el) return false;
    const hasMaterial = Boolean(
      cleanText(el.textContent || "") ||
      el.querySelector?.("img,video,audio,canvas,pre,code,[data-testid*='tool'],[data-testid*='thinking'],[data-testid*='reasoning'],[data-testid*='artifact']")
    );
    if (!hasMaterial) return false;
    try {
      mergeSnapshot(map, extractTurnSnapshot(el, options), orderMap, nextOrderRef);
      return true;
    } catch (error) {
      console.warn("OmniChat: no se pudo capturar un turno", error);
      return false;
    }
  }

  async function captureCurrentInto(map, options, orderMap, nextOrderRef) {
    const turns = getTurnElements();
    for (const el of turns) await captureElementInto(map, el, options, orderMap, nextOrderRef);
    return turns.length;
  }

  async function waitForTurnMount(turn, timeoutMs = 1600) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = cleanText(turn.textContent || "");
      const material = turn.querySelector?.('[data-message-author-role], .markdown, .prose, pre, img, [data-testid*="tool"], [data-testid*="thinking"], [data-testid*="reasoning"], [data-testid*="artifact"]');
      if (text || material) return true;
      await wait(80);
    }
    return false;
  }

  function dataUrlToBytes(dataUrl) {
    const comma = String(dataUrl || "").indexOf(",");
    if (comma < 0) throw new Error("Data URL visual inválida");
    const head = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    const mime = (head.match(/^data:([^;,]+)/i) || [])[1] || "image/jpeg";
    const binary = /;base64/i.test(head) ? atob(body) : decodeURIComponent(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 255;
    return { bytes, mime };
  }

  async function captureVisualEvidence(label, warnings, meta = {}) {
    if (state.visualSnapshots.length >= MAX_VISUAL_SNAPSHOTS) return false;
    const toastBox = document.getElementById("omnichat-export-toast");
    const wasHidden = toastBox?.hidden;
    if (toastBox) toastBox.hidden = true;
    try {
      await wait(35);
      const response = await browser.runtime.sendMessage({ type: "OMNICHAT_CAPTURE_VISIBLE", format: "jpeg", quality: 72 });
      if (!response?.ok || !response.dataUrl) throw new Error(response?.error || "Captura visual no disponible");
      const { bytes, mime } = dataUrlToBytes(response.dataUrl);
      state.visualSnapshots.push({
        index: state.visualSnapshots.length + 1,
        label: cleanText(label || "") || `Vista ${state.visualSnapshots.length + 1}`,
        capturedAt: new Date().toISOString(),
        mime,
        bytes,
        turnOrdinal: meta.turnOrdinal ?? null,
        turnId: meta.turnId || null,
        viewportRect: meta.viewportRect || null,
        tile: meta.tile ?? null,
        scrollTop: Number.isFinite(meta.scrollTop) ? meta.scrollTop : null
      });
      return true;
    } catch (error) {
      if (!state.diagnostics.some((d) => d.kind === "visual-capture-error")) {
        state.diagnostics.push({ kind: "visual-capture-error", message: error.message || String(error), timestamp: new Date().toISOString() });
        warnings.push(`La captura visual de respaldo no pudo iniciarse (${error.message || error}). El contenido DOM/JSON seguirá exportándose.`);
      }
      return false;
    } finally {
      if (toastBox) toastBox.hidden = Boolean(wasHidden);
    }
  }

  async function captureTurnVisualEvidence(turn, ordinal, total, warnings) {
    if (!turn?.isConnected || state.visualSnapshots.length >= MAX_VISUAL_SNAPSHOTS) return 0;
    const scroller = findScrollContainer();
    let captured = 0;

    // Reserva capacidad para que los turnos posteriores reciban al menos una captura
    // cuando el total cabe dentro del presupuesto global. Así un turno muy largo no
    // consume todas las capturas antes de llegar al final de la conversación.
    const remainingSnapshots = Math.max(0, MAX_VISUAL_SNAPSHOTS - state.visualSnapshots.length);
    const remainingTurns = Math.max(1, total - ordinal + 1);
    const fairShare = total <= MAX_VISUAL_SNAPSHOTS
      ? Math.max(1, Math.floor(remainingSnapshots / remainingTurns))
      : 1;
    const perTurnLimit = Math.max(1, Math.min(MAX_VISUAL_TILES_PER_TURN, fairShare));

    try { turn.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" }); }
    catch { try { turn.scrollIntoView(); } catch { /* noop */ } }
    await wait(80);

    for (let tile = 1; tile <= perTurnLimit && state.visualSnapshots.length < MAX_VISUAL_SNAPSHOTS; tile += 1) {
      checkCancelled();
      const metrics = scrollMetrics(scroller);
      const r=turn.getBoundingClientRect();
      const ok = await captureVisualEvidence(
        `Turno ${ordinal} de ${total} · vista ${tile}`,
        warnings,
        { turnOrdinal: ordinal, turnId:stableTurnId(turn), tile, scrollTop: metrics.top, viewportRect:{turnTop:r.top,turnBottom:r.bottom,height:innerHeight} }
      );
      if (!ok) break;
      captured += 1;

      const rect = turn.getBoundingClientRect();
      const viewportBottom = Math.max(1, Math.min(innerHeight || metrics.viewport, metrics.viewport));
      if (rect.bottom <= viewportBottom - 24) break;

      const before = metrics.top;
      const advance = Math.max(320, Math.floor(metrics.viewport * 0.78));
      setScrollTop(scroller, before + advance);
      await wait(95);
      const after = scrollMetrics(scroller).top;
      if (Math.abs(after - before) < 2) break;
    }
    const finalRect=turn.getBoundingClientRect();
    const reachedBottom=finalRect.bottom <= innerHeight-24;
    state.visualCoverage.push({turnId:stableTurnId(turn),captures:captured,reachedBottom,limited:!reachedBottom,innerScrollAreasFullyCaptured:false});
    if(!reachedBottom) warnings.push(`Capturas parciales del turno ${ordinal}: se alcanzó el presupuesto o no se pudo continuar. El texto DOM se conserva por separado.`);
    return captured;
  }

  function shouldCaptureVisual(index, total) {
    if (total <= MAX_VISUAL_SNAPSHOTS) return true;
    const stride = Math.max(1, Math.ceil(total / MAX_VISUAL_SNAPSHOTS));
    return index === 0 || index === total - 1 || index % stride === 0;
  }

  async function capturePersistentChatGptShells(map, options, warnings, orderMap, nextOrderRef) {
    let shells=chatGptPersistentShells();
    if(shells.length<2) return {used:false,total:shells.length,missed:0};
    const visited=new Set(); let missed=0; let steps=0;
    state.diagnostics.push({kind:'capture-strategy',strategy:'mixed-shells-dynamic',initialShellCount:shells.length,timestamp:new Date().toISOString()});
    while(steps<MAX_SCAN_STEPS) {
      checkCancelled();
      shells=chatGptPersistentShells();
      const shell=shells.find(n=>!visited.has(stableTurnId(n)));
      if(!shell) break;
      const id=stableTurnId(shell); visited.add(id); steps++;
      shell.scrollIntoView({block:'start',inline:'nearest',behavior:'instant'});
      await wait(180);
      const mounted=await waitForTurnMount(shell,2200);
      let restorers=[];
      try {
        if(options.expandCollapsed && mounted) restorers=await expandTurnsSafely([shell]);
        if(!await captureElementInto(map,shell,options,orderMap,nextOrderRef)) missed++;
        if(options.visualEvidence && options.format==='zip') await captureTurnVisualEvidence(shell,shells.indexOf(shell)+1,shells.length,warnings);
        // Capture once more after visual scrolling to retain newly rendered code.
        await captureElementInto(map,shell,options,orderMap,nextOrderRef);
      } finally {await restoreExpanded(restorers);}
      toast('OmniChat: capturando conversación',`${visited.size} turnos recorridos · ${map.size} conservados`);
    }
    state.diagnostics.push({kind:'shell-scan-result',detected:chatGptPersistentShells().length,visited:visited.size,missed,limitReached:steps>=MAX_SCAN_STEPS});
    if(steps>=MAX_SCAN_STEPS) warnings.push('Se alcanzó el límite de recorrido. La cobertura es parcial.');
    return {used:true,total:visited.size,missed};
  }

  async function deepCapture(options, warnings) {
    const map = new Map(state.evictedTurns);
    const orderMap = new Map();
    const nextOrderRef = { value: 0 };
    const scroller = findScrollContainer();
    const originalTop = Number(scroller.scrollTop || 0);
    let steps = 0;

    if (options.deepScan && platformInfo().id === "chatgpt") {
      toast("OmniChat: escaneo profundo", "Detectando todos los turnos persistentes…");
      const shellResult = await capturePersistentChatGptShells(map, options, warnings, orderMap, nextOrderRef);
      if (shellResult.used) {
        if (shellResult.missed) warnings.push(`${shellResult.missed} de ${shellResult.total} turnos persistentes no llegaron a montar contenido durante el primer recorrido.`);
        try { setScrollTop(scroller, originalTop); } catch { /* noop */ }
        const turns = [...map.values()].sort((a, b) => {
          if (Number.isFinite(a.orderHint) && Number.isFinite(b.orderHint)) return a.orderHint - b.orderHint;
          if (Number.isFinite(a.scanOrder) && Number.isFinite(b.scanOrder)) return a.scanOrder - b.scanOrder;
          return String(a.id).localeCompare(String(b.id));
        });
        return turns;
      }
    }

    if (options.deepScan) {
      state.diagnostics.push({ kind: "capture-strategy", strategy: "scroll-fallback", timestamp: new Date().toISOString() });
      toast("OmniChat: escaneo profundo", "Cargando el inicio de la conversación…");
      await settleAtTop(scroller);
    }

    try {
      let lastTop = -1;
      let repeated = 0;
      while (steps < (options.deepScan ? MAX_SCAN_STEPS : 1)) {
        checkCancelled();
        const currentTurns = getTurnElements().filter((turn) => cleanText(turn.textContent || "") || turn.querySelector?.("pre,img,video,audio,canvas,[data-message-author-role]"));
        const restorers = options.expandCollapsed ? await expandTurnsSafely(currentTurns) : [];
        await captureCurrentInto(map, options, orderMap, nextOrderRef);

        const m = scrollMetrics(scroller);
        const bottom = Math.max(0, m.height - m.viewport);
        const percent = bottom <= 1 ? 100 : Math.min(100, Math.round((m.top / bottom) * 100));
        toast("OmniChat: capturando conversación", `${map.size} turnos recuperados · ${percent}%`);
        if (options.visualEvidence && options.format === "zip" && state.visualSnapshots.length < MAX_VISUAL_SNAPSHOTS) {
          await captureVisualEvidence(`Vista de desplazamiento ${steps + 1}`, warnings);
        }
        if (restorers.length) await restoreExpanded(restorers);
        steps += 1;

        if (!options.deepScan) break;
        if (m.top >= bottom - 4) {
          await wait(320);
          const after = scrollMetrics(scroller);
          if (after.height <= m.height + 4) break;
        }

        const next = Math.min(bottom, m.top + Math.max(360, Math.floor(m.viewport * 0.78)));
        setScrollTop(scroller, next);
        await wait(220);
        const actual = Number(scroller.scrollTop || 0);
        if (Math.abs(actual - lastTop) < 2) repeated += 1;
        else repeated = 0;
        lastTop = actual;
        if (repeated >= 4) break;
      }
      if (steps >= MAX_SCAN_STEPS) warnings.push(`El escaneo alcanzó el límite de ${MAX_SCAN_STEPS} pasos; una conversación extremadamente larga podría tener contenido adicional.`);
    } finally {
      try { setScrollTop(scroller, originalTop); } catch { /* noop */ }
    }

    for (const [id, snapshot] of state.evictedTurns) {
      if (!map.has(id)) map.set(id, { ...snapshot, scanOrder: orderMap.has(id) ? orderMap.get(id) : nextOrderRef.value++ });
    }

    const turns = [...map.values()];
    turns.sort((a, b) => {
      if (Number.isFinite(a.orderHint) && Number.isFinite(b.orderHint)) return a.orderHint - b.orderHint;
      if (Number.isFinite(a.scanOrder) && Number.isFinite(b.scanOrder)) return a.scanOrder - b.scanOrder;
      return String(a.id).localeCompare(String(b.id));
    });
    return turns;
  }

  function guessExtension(mime, url) {
    const map = {
      "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg",
      "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/mp4": ".m4a",
      "application/pdf": ".pdf", "application/json": ".json", "text/plain": ".txt", "text/markdown": ".md",
      "application/zip": ".zip", "text/csv": ".csv"
    };
    const cleanMime = String(mime || "").split(";")[0].toLowerCase();
    if (map[cleanMime]) return map[cleanMime];
    try {
      const path = new URL(url).pathname;
      const match = path.match(/\.[a-z0-9]{1,8}$/i);
      if (match) return match[0].toLowerCase();
    } catch { /* noop */ }
    return ".bin";
  }

  function safeFileName(name, fallback = "archivo") {
    const cleaned = String(name || "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140);
    return cleaned || fallback;
  }

  function basenameFromUrl(url, fallback) {
    if (String(url).startsWith("data:")) return fallback;
    try {
      const part = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
      return safeFileName(part, fallback);
    } catch {
      return fallback;
    }
  }

  async function fetchResource(url, maxBytes, timeoutMs = RESOURCE_FETCH_TIMEOUT_MS) {
    checkCancelled();
    if(!url) throw new Error('URL vacía');
    if(url.startsWith('data:')) {
      const {bytes,mime}=dataUrlToBytes(url);
      if(bytes.byteLength>maxBytes) throw new Error('Supera el límite de recursos');
      return {bytes:normalizedBytes(bytes),mime};
    }
    const parsed=new URL(url,location.href);
    if(!['https:','blob:'].includes(parsed.protocol)) throw new Error('Protocolo de recurso no permitido');
    if(parsed.protocol==='https:' && parsed.origin!==location.origin) {
      const reply=await browser.runtime.sendMessage({type:'OMNICHAT_FETCH_RESOURCE',url:parsed.href,maxBytes});
      if(!reply?.ok) throw new Error(reply?.error||'No se pudo descargar el recurso externo');
      return {bytes:normalizedBytes(reply.buffer),mime:reply.mime};
    }
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetch(url,{credentials:'include',cache:'force-cache',signal:controller.signal});
      if(!response.ok) throw new Error(`HTTP ${response.status}`);
      if(Number(response.headers.get('content-length'))>maxBytes) throw new Error('Supera el límite de recursos');
      const reader=response.body.getReader(); const chunks=[];let total=0;
      try {
        while(true) {checkCancelled();const {done,value}=await reader.read();if(done)break;
          total+=value.byteLength;
          if(total>maxBytes) throw new Error('Supera el límite de recursos');
          chunks.push(normalizedBytes(value));
        }
      } catch(error) {await reader.cancel().catch(()=>{});throw error;}
      return {bytes:concatBytes(chunks),mime:response.headers.get('content-type')||'application/octet-stream'};
    } finally {clearTimeout(timer);}
  }

  function validateResource(bytes,mime,name,expectedSize) {
    if(expectedSize && bytes.byteLength!==expectedSize) throw new Error(`Tamaño inesperado: ${bytes.byteLength}, esperado ${expectedSize}`);
    const head=Array.from(bytes.subarray(0,8));
    if(/\.png$/i.test(name) && head.join(',')!=='137,80,78,71,13,10,26,10') throw new Error('El recurso no contiene una cabecera PNG válida');
    if(/\.(?:zip|xpi|docx|xlsx|pptx)$/i.test(name) && !(head[0]===80 && head[1]===75 && [3,5,7].includes(head[2]))) throw new Error('El recurso no contiene una cabecera ZIP válida');
    if(/\.jpe?g$/i.test(name) && !(head[0]===255 && head[1]===216 && head[2]===255)) throw new Error('El recurso no contiene una cabecera JPEG válida');
    if(/\.pdf$/i.test(name) && String.fromCharCode(...head.slice(0,5))!=='%PDF-') throw new Error('El recurso no contiene una cabecera PDF válida');
    if(/text\/html/i.test(mime) && !/\.html?$/i.test(name)) throw new Error('El servidor devolvió HTML en lugar del archivo esperado');
  }

  function collectResourceRequests(turns, options) {
    const requests = [];
    const seen = new Set();
    if (options.archiveAssets) {
      for (const turn of turns) {
        for (const item of turn.media) {
          if (!item.url || item.decorative || seen.has(item.url)) continue;
          seen.add(item.url);
          requests.push({ url: item.url, type: item.kind || "media", suggestedName: item.alt || item.title || null });
        }
      }
    }
    if (options.archiveFiles) {
      for (const turn of turns) {
        for (const item of turn.files) {
          if (!item.href || seen.has(item.href)) continue;
          seen.add(item.href);
          requests.push({ url: item.href, type: "file", expectedSize:item.expectedSize||null, suggestedName: item.downloadName || item.text || null });
        }
      }
    }
    return requests;
  }

  async function archiveResources(turns, options, warnings) {
    const maxTotal = Math.max(1, Number(options.assetLimitMb) || 200) * 1024 * 1024;
    const requests = collectResourceRequests(turns, options);
    const archived = new Map();
    let total = 0;
    let index = 1;
    const ledger=[];
    for (const req of requests) {
      checkCancelled();
      if (total >= maxTotal) {
        warnings.push(`Se alcanzó el límite total de recursos (${options.assetLimitMb || 200} MB).`);
        ledger.push({url:sanitizeExternalUrlForMetadata(req.url),status:"budget_exceeded"});
        continue;
      }
      toast("OmniChat: archivando recursos", `${archived.size}/${requests.length} completados · ${Math.round(total / 1024 / 1024)} MB`);
      try {
        const { bytes, mime } = await fetchResource(req.url, maxTotal-total);
        validateResource(bytes,mime,req.suggestedName||basenameFromUrl(req.url,""),req.expectedSize);
        const sha256=await sha256Bytes(bytes);
        if (total + bytes.byteLength > maxTotal) {
          warnings.push(`Se omitió un recurso de ${Math.round(bytes.byteLength / 1024 / 1024)} MB porque superaría el límite configurado.`);
          continue;
        }
        const ext = guessExtension(mime, req.url);
        let base = safeFileName(req.suggestedName || basenameFromUrl(req.url, `${req.type}-${String(index).padStart(3, "0")}${ext}`));
        if (!/\.[a-z0-9]{1,8}$/i.test(base)) base += ext;
        const folder = req.type === "file" ? "files" : "assets";
        const localPath = `${folder}/${String(index).padStart(3, "0")}-${base}`;
        archived.set(req.url, {
          url: req.url,
          urlForMetadata: sanitizeExternalUrlForMetadata(req.url),
          localPath,
          mime,
          size: bytes.byteLength,
          sha256,
          bytes
        });
        total += bytes.byteLength;
        ledger.push({url:sanitizeExternalUrlForMetadata(req.url),status:"archived",localPath,size:bytes.byteLength,sha256});
        index += 1;
      } catch (error) {
        ledger.push({url:sanitizeExternalUrlForMetadata(req.url),status:"failed",error:String(error.message||error)});
        warnings.push(`No se pudo archivar ${sanitizeExternalUrlForMetadata(req.url)} (${error.message || error}).`);
      }
    }
    return { archived, totalBytes: total, requested: requests.length, ledger };
  }

  function bytesToDataUrl(bytes, mime) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return `data:${mime || "application/octet-stream"};base64,${btoa(binary)}`;
  }

  function rewriteRawHtml(rawHtml, archived, mode = 'zip') {
    if(!rawHtml)return '';
    const doc=new DOMParser().parseFromString(`<body>${rawHtml}</body>`,'text/html');
    for(const node of doc.querySelectorAll('[src],[href],[poster],[xlink\\:href]')) {
      for(const attr of ['src','href','poster','xlink:href']) {
        const value=node.getAttribute(attr);if(!value)continue;
        const abs=absoluteUrl(value);
        const res=[...archived.values()].find(r=>r.url===abs||r.urlForMetadata===sanitizeExternalUrlForMetadata(abs)||r.localPath===value);
        if(res)node.setAttribute(attr,mode==='single'?bytesToDataUrl(res.bytes,res.mime):encodeURI(res.localPath));
        else if(attr==='src'||attr==='poster'||node.tagName.toLowerCase()==='use') {
          node.setAttribute('data-omnichat-original-url',sanitizeExternalUrlForMetadata(abs));
          node.removeAttribute(attr);
          if(node.tagName==='IMG' && !node.getAttribute('alt'))node.setAttribute('alt','Recurso no archivado');
        } else node.setAttribute(attr,sanitizeExternalUrlForMetadata(abs));
      }
      if(node.tagName==='A') {node.setAttribute('rel','noopener noreferrer');node.setAttribute('target','_blank');}
    }
    return doc.body.innerHTML;
  }

  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function buildConversationObject(turns, options, resourceInfo, warnings, sourceLayer = null) {
    const platform = platformInfo();
    const events = options.eventLog ? [...state.liveLog] : [];
    const resources = [...resourceInfo.archived.values()].map((r) => ({
      url: r.urlForMetadata,
      localPath: r.localPath,
      mime: r.mime,
      size: r.size,
      sha256:r.sha256
    }));
    return {
      schema: "omnichat-complete-export",
      schemaVersion: SCHEMA_VERSION,
      exporter: { name: "OmniChat Complete Exporter", version: VERSION },
      metadata: {
        platform: platform.id,
        platformLabel: platform.label,
        title: conversationTitle(),
        sourceUrl: location.href,
        exportedAt: new Date().toISOString(),
        documentTitle: document.title,
        pageLanguage: document.documentElement.lang || null,
        userAgent: navigator.userAgent,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: devicePixelRatio || 1 },
        options: { ...options }
      },
      summary: summarizeTurns(turns, events, resources),
      sourceLayer,
      completeness: {
        certifiedComplete: false,
        source: "visible_dom_with_optional_visible_file_resolution",
        unresolvedFiles: turns.reduce((n,t)=>n+(t.files||[]).filter(f=>f.archiveStatus!=="archived").length,0),
        visualCoverage: "bounded_viewport_samples_not_full_page_or_inner_scroll_capture",
        historicalEvents: "observed_in_this_tab_only"
      },
      resourceLedger: resourceInfo.ledger || [],
      visualCoverage: state.visualCoverage,
      turns: turns.map((turn, i) => ({
        ...turn,
        ordinal: i + 1,
        markdown: String(turn.markdown || ""),
        links: turn.links.map((link) => ({ ...link, href: link.hrefForMetadata, hrefForMetadata: undefined })),
        files: turn.files.map((file) => ({ ...file, href: file.hrefForMetadata, hrefForMetadata: undefined })),
        media: turn.media.map((item) => ({ ...item, url: item.urlForMetadata, urlForMetadata: undefined }))
      })),
      sessionEvents: events,
      archivedResources: resources,
      visualEvidence: state.visualSnapshots.map((shot) => ({
        index: shot.index,
        label: shot.label,
        capturedAt: shot.capturedAt,
        mime: shot.mime,
        turnOrdinal: shot.turnId ? turns.findIndex(t=>t.id===shot.turnId)+1 : shot.turnOrdinal ?? null,
        turnId:shot.turnId||null,
        viewportRect:shot.viewportRect||null,
        tile: shot.tile ?? null,
        scrollTop: shot.scrollTop ?? null,
        localPath: `visual/viewport-${String(shot.index).padStart(4, "0")}.jpg`,
        size: shot.bytes.byteLength
      })),
      diagnostics: [...state.diagnostics],
      warnings
    };
  }

  function summarizeTurns(turns, events = [], resources = []) {
    return {
      turns: turns.length,
      userTurns: turns.filter((t) => t.role === "user").length,
      assistantTurns: turns.filter((t) => t.role === "assistant").length,
      unknownTurns: turns.filter((t) => t.role === "unknown").length,
      codeBlocks: turns.reduce((n, t) => n + t.codeBlocks.length, 0),
      terminalExecutions: turns.reduce((n, t) => n + (t.toolExecutions?.length || 0), 0),
      toolExecutions: turns.reduce((n, t) => n + (t.toolExecutions?.length || 0), 0),
      activities: turns.reduce((n, t) => n + t.activities.length, 0),
      expandables: turns.reduce((n, t) => n + t.expandables.length, 0),
      media: turns.reduce((n, t) => n + t.media.length, 0),
      linkedFiles: turns.reduce((n, t) => n + t.files.length, 0),
      resolvedFiles: turns.reduce((n, t) => n + t.files.filter((f) => Boolean(f.href || f.hrefForMetadata)).length, 0),
      uiAttachments: turns.reduce((n, t) => n + t.files.filter((f) => f.kind === "ui_attachment" || f.kind === "generated_artifact").length, 0),
      links: turns.reduce((n, t) => n + t.links.length, 0),
      liveEvents: events.length,
      archivedResources: resources.length,
      visualSnapshots: state.visualSnapshots.length
    };
  }

  function markdownRole(role) {
    if (role === "user") return "Usuario";
    if (role === "assistant") return "Asistente";
    return "Elemento de conversación";
  }

  function buildMarkdown(conversation, archived, zipMode = false) {
    const lines=[`# ${conversation.metadata.title}`,'',`Plataforma: ${conversation.metadata.platformLabel}`,`Captura: ${conversation.metadata.exportedAt}`,
      `Turnos conservados: ${conversation.turns.length}. La cobertura completa no está certificada.`,''];
    for(const turn of conversation.turns) {
      lines.push(`## ${turn.ordinal}. ${markdownRole(turn.role)}`,'');
      let body=turn.markdown||turn.text||'';
      if(zipMode) for(const r of archived.values()) for(const url of [r.url,r.urlForMetadata].filter(Boolean)) body=body.split(url).join(encodeURI(r.localPath));
      lines.push(body,'');
      if(turn.files?.length) {
        lines.push('### Archivos','');
        for(const file of turn.files) {
          const res=[...archived.values()].find(r=>r.url===file.href||r.urlForMetadata===file.href||r.localPath===file.localPath);
          const label=file.downloadName||file.text||'archivo';
          const href=zipMode&&res?encodeURI(res.localPath).replace(/\(/g,'%28').replace(/\)/g,'%29'):file.href;
          lines.push(href?`[${label}](${href})${res?'':' — sin copia local'}`:`${label} — referencia sin copia local`);
        }
      }
      lines.push('','---','');
    }
    if(conversation.warnings?.length) lines.push('## Advertencias','',...conversation.warnings.map(w=>'- '+w),'');
    return lines.join('\n');
  }

  function buildCommandsMarkdown(conversation) {
    const lines=[`# Comandos y código — ${conversation.metadata.title}`,'',
      'Los paneles de herramientas se identifican por su estructura DOM. La salida combinada no permite distinguir stdout de stderr ni confirmar un código de salida.','',
      '## Paneles de ejecución identificados',''];
    let n=0;
    for(const turn of conversation.turns) for(const e of turn.toolExecutions||[]) {
      lines.push(`### ${++n}. Turno ${turn.ordinal} · ${e.tool}`,'',`Estado de captura: ${e.status}`,'','#### Comando / entrada','',fenced(e.command,e.commandLanguage),'','#### Salida visible','',fenced(e.output||'', 'text'),'');
    }
    if(!n) lines.push('No se identificaron paneles de ejecución.','');
    lines.push('## Otros bloques de código (incluye ejemplos; no implica ejecución)','');
    n=0;
    for(const turn of conversation.turns) for(const block of turn.codeBlocks||[]) {
      if(['inline_code','tool_command','tool_output'].includes(block.kind))continue;
      lines.push(`### ${++n}. Turno ${turn.ordinal} · ${block.language||'texto'}`,'',fenced(block.text,block.language),'');
    }
    return lines.join('\n');
  }

  function viewerCss() {
    return `
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1115;color:#eceff4}*{box-sizing:border-box}body{margin:0;background:#0f1115;color:#eceff4}.wrap{max-width:1120px;margin:0 auto;padding:32px 20px 80px}.hero{padding:24px;border:1px solid #2a2f3a;border-radius:18px;background:#161a21;margin-bottom:20px}.hero h1{margin:0 0 10px;font-size:26px}.meta{display:flex;gap:12px;flex-wrap:wrap;font-size:13px;color:#aeb6c5}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-top:18px}.stat{padding:10px 12px;border-radius:10px;background:#202630}.stat b{display:block;font-size:18px}.stat span{font-size:11px;color:#aeb6c5}.turn{border:1px solid #2a2f3a;border-radius:16px;margin:14px 0;overflow:hidden;background:#151920}.turn.user{border-color:#32466a}.turn.assistant{border-color:#33483d}.turn-head{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 14px;background:#1b2028;border-bottom:1px solid #2a2f3a;font-size:12px}.role{font-weight:800;text-transform:uppercase;letter-spacing:.06em}.model{color:#9ba5b5}.snapshot{padding:16px;overflow-wrap:anywhere}.snapshot pre{white-space:pre-wrap;overflow:auto;background:#0c0f13;border:1px solid #2b313b;border-radius:10px;padding:12px}.snapshot code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.snapshot img,.snapshot video{max-width:100%;height:auto;border-radius:10px}.snapshot table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}.snapshot th,.snapshot td{border:1px solid #3a414d;padding:6px 8px}.snapshot blockquote{border-left:3px solid #68758a;margin-left:0;padding-left:12px;color:#c6ccd6}.snapshot button,.snapshot input,.snapshot select,.snapshot textarea{pointer-events:none}.details{margin:12px 16px 16px;border-top:1px dashed #343b47;padding-top:10px}.details summary{cursor:pointer;font-size:12px;color:#aeb6c5}.details pre{white-space:pre-wrap;font-size:11px}.warning{padding:10px 12px;border:1px solid #665a2e;background:#282314;border-radius:10px;margin:8px 0}.footer{margin-top:26px;color:#8e98a8;font-size:12px}@media print{body{background:#fff;color:#111}.hero,.turn{background:#fff;border-color:#ccc}.turn-head{background:#f3f3f3;border-color:#ccc}.snapshot pre{background:#f7f7f7;border-color:#ddd}.details{border-color:#ddd}.meta,.model,.stat span,.footer{color:#555}}
`;
  }

  function buildHtml(conversation, archived, mode = 'zip') {
    const esc=escapeHtml;
    const single=mode==='single';
    const localResource=file=>[...archived.values()].find(r=>r.url===file.href||r.urlForMetadata===file.href||r.localPath===file.localPath);
    const turns=conversation.turns.map(turn=>{
      const raw=turn.rawHtml?rewriteRawHtml(turn.rawHtml,archived,mode):`<pre>${esc(turn.text)}</pre>`;
      const files=(turn.files||[]).map(file=>{
        const resource=localResource(file);const name=file.downloadName||file.text||'Archivo';
        if(resource) {const href=single?bytesToDataUrl(resource.bytes,resource.mime):encodeURI(resource.localPath);return `<li><a download="${esc(name)}" href="${esc(href)}">${esc(name)}</a> — ${resource.size.toLocaleString('es-ES')} bytes</li>`;}
        return `<li>${esc(name)} — <strong>sin copia local</strong></li>`;
      }).join('');
      const executions=(turn.toolExecutions||[]).map((e,i)=>`<details class="execution"><summary>${i+1}. ${esc(e.tool)} · ${esc(e.status)}</summary><h4>Entrada</h4><pre>${esc(e.command)}</pre><h4>Salida visible combinada</h4><pre>${esc(e.output||'')}</pre></details>`).join('');
      return `<section class="turn ${esc(turn.role)}" id="turn-${turn.ordinal}"><header class="turn-head"><b>${turn.ordinal}. ${esc(markdownRole(turn.role))}</b><span>${esc(turn.model||'')}</span></header><div class="snapshot">${raw}</div>${files?`<div class="files"><h3>Archivos de este turno</h3><ul>${files}</ul></div>`:''}${executions?`<details class="details"><summary>${turn.toolExecutions.length} paneles de ejecución estructurados</summary>${executions}</details>`:''}<details class="details"><summary>Datos estructurados</summary><pre>${esc(JSON.stringify({activities:turn.activities,files:turn.files,codeBlocks:turn.codeBlocks,toolExecutions:turn.toolExecutions},null,2))}</pre></details></section>`;
    }).join('\n');
    const snapshots=single?'':(conversation.visualEvidence||[]).map(s=>`<a href="${esc(encodeURI(s.localPath))}" target="_blank" rel="noopener">Vista ${s.index}${s.turnOrdinal?` · turno ${s.turnOrdinal}`:''}</a>`).join(' · ');
    const s=conversation.summary;
    const css=viewerCss()+'.files{padding:0 16px 16px}.files li{margin:8px 0}a{color:#a7c8ff}.execution{margin:12px 0}.execution pre{white-space:pre;overflow:auto;background:#090c11;padding:12px;max-height:600px}details>summary{cursor:pointer}.snapshot [role="toolbar"],.snapshot [data-message-action-bar]{display:none}.snapshot svg{max-width:24px;max-height:24px}.snapshot pre pre{border:0;padding:0}.snapshot button{font:inherit;color:inherit;background:transparent;border:0;text-align:left}.details>pre{max-height:600px;overflow:auto}.coverage{margin:16px 0;padding:12px;background:#262013;border:1px solid #82672c;border-radius:8px}.snapshot [hidden]{display:block!important}';
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>${esc(conversation.metadata.title)} — OmniChat</title><style>${css}</style></head><body><main class="wrap"><section class="hero"><h1>${esc(conversation.metadata.title)}</h1><p>${esc(conversation.metadata.platformLabel)} · ${esc(conversation.metadata.exportedAt)}</p><p>${s.turns} turnos · ${s.toolExecutions} paneles de ejecución · ${s.archivedResources} recursos locales · ${s.visualSnapshots||0} capturas</p><div class="coverage">El archivo conserva lo capturado. Los paneles no cargados, los archivos sin copia local y las capturas limitadas se señalan en el informe. No certifica la recuperación de todo el contenido de la conversación.</div><nav>${conversation.turns.map(t=>`<a href="#turn-${t.ordinal}">${t.ordinal}. ${esc(markdownRole(t.role))}</a>`).join(' · ')}</nav></section>${conversation.warnings?.length?`<details class="hero"><summary>${conversation.warnings.length} advertencias de captura</summary><ul>${conversation.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details>`:''}${turns}${snapshots?`<section class="hero"><h2>Capturas de respaldo (cobertura parcial)</h2><p>${snapshots}</p></section>`:''}<footer class="footer">OmniChat ${VERSION}. Archivo local sin scripts activos ni carga automática de recursos de terceros. Los archivos adjuntos conservan su contenido original; pueden contener información confidencial.</footer></main></body></html>`;
  }

  function buildReport(conversation, resourceInfo) {
    const s = conversation.summary;
    return [
      "OMNICHAT COMPLETE EXPORTER — INFORME",
      "===================================",
      "",
      `Título: ${conversation.metadata.title}`,
      `Plataforma: ${conversation.metadata.platformLabel}`,
      `URL: ${conversation.metadata.sourceUrl}`,
      `Exportado: ${conversation.metadata.exportedAt}`,
      "",
      `Turnos: ${s.turns} (${s.userTurns} usuario, ${s.assistantTurns} asistente, ${s.unknownTurns} sin clasificar)`,
      `Bloques de código: ${s.codeBlocks}`,
      `Ejecuciones/CLI detectadas: ${s.terminalExecutions}`,
      `Actividades/herramientas: ${s.activities}`,
      `Desplegables: ${s.expandables}`,
      `Medios detectados: ${s.media}`,
      `Archivos/adjuntos visibles detectados: ${s.linkedFiles}`,
      `Archivos con URL resoluble: ${s.resolvedFiles || 0}`,
      `Tarjetas de archivo sin href detectadas: ${s.uiAttachments || 0}`,
      `Enlaces: ${s.links}`,
      `Eventos capturados en vivo: ${s.liveEvents}`,
      `Recursos archivados: ${s.archivedResources}`,
      `Capturas visuales de respaldo: ${s.visualSnapshots || 0}`,
      `Bytes archivados: ${resourceInfo.totalBytes}`,
      `Enriquecimiento ChatGPT: ${conversation.sourceLayer?.status || "no aplicable"}`,
      "Cobertura completa de la conversación: no certificada",
      "stdout/stderr/códigos de salida: no se infieren del texto de salida",
      `Archivos sin copia local: ${conversation.turns.reduce((n,t)=>n+(t.files||[]).filter(f=>f.archiveStatus!=="archived").length,0)}`,
      `Referencias de archivo encontradas en capa fuente: ${conversation.sourceLayer?.referencesFound || 0}`,
      `Referencias visibles emparejadas: ${conversation.sourceLayer?.visibleReferencesMatched || 0}`,
      `URLs de descarga resueltas: ${conversation.sourceLayer?.downloadUrlsResolved || 0}`,
      "",
      "ADVERTENCIAS",
      "------------",
      ...(conversation.warnings.length ? conversation.warnings.map((w) => `- ${w}`) : ["Ninguna."]),
      ""
    ].join("\n");
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
    const day = ((year - 1980) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
    return { time, date: day };
  }

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function concatBytes(parts) {
    const size = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function zipFileHeader(nameBytes, data, crc, dt) {
    const header = new Uint8Array(30);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0800, true);
    v.setUint16(8, 0, true);
    v.setUint16(10, dt.time, true);
    v.setUint16(12, dt.date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, data.length, true);
    v.setUint32(22, data.length, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true);
    return header;
  }

  function zipCentralHeader(nameBytes, data, crc, dt, offset) {
    const header = new Uint8Array(46);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 20, true);
    v.setUint16(8, 0x0800, true);
    v.setUint16(10, 0, true);
    v.setUint16(12, dt.time, true);
    v.setUint16(14, dt.date, true);
    v.setUint32(16, crc, true);
    v.setUint32(20, data.length, true);
    v.setUint32(24, data.length, true);
    v.setUint16(28, nameBytes.length, true);
    v.setUint16(30, 0, true);
    v.setUint16(32, 0, true);
    v.setUint16(34, 0, true);
    v.setUint16(36, 0, true);
    v.setUint32(38, 0, true);
    v.setUint32(42, offset, true);
    return header;
  }

  function createZip(files) {
    if(files.length>65535 || new Set(files.map(f=>f.name)).size!==files.length) throw new Error("Entradas ZIP duplicadas o demasiadas entradas.");
    const locals = [];
    const centrals = [];
    let offset = 0;
    const dt = dosDateTime(new Date());
    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const data = normalizedBytes(file.data);
      if(data.byteLength>0xffffffff || offset+data.byteLength>0xffffffff) throw new Error("El ZIP supera el límite ZIP32.");
      if(!file.name || file.name.startsWith("/") || file.name.split("/").includes("..")) throw new Error("Nombre ZIP no válido.");
      const crc = crc32(data);
      const localHeader = zipFileHeader(nameBytes, data, crc, dt);
      locals.push(localHeader, nameBytes, data);
      const centralHeader = zipCentralHeader(nameBytes, data, crc, dt, offset);
      centrals.push(centralHeader, nameBytes);
      offset += localHeader.length + nameBytes.length + data.length;
    }
    const central = concatBytes(centrals);
    const local = concatBytes(locals);
    const eocd = new Uint8Array(22);
    const v = new DataView(eocd.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(4, 0, true);
    v.setUint16(6, 0, true);
    v.setUint16(8, files.length, true);
    v.setUint16(10, files.length, true);
    v.setUint32(12, central.length, true);
    v.setUint32(16, local.length, true);
    v.setUint16(20, 0, true);
    return concatBytes([local, central, eocd]);
  }

  async function downloadBlob(blob, filename) {
    checkCancelled();
    const url = URL.createObjectURL(blob);
    try {
      const result = await browser.runtime.sendMessage({ type: "OMNICHAT_DOWNLOAD_URL", url, filename });
      if (!result?.ok) throw new Error(result?.error || "La API de descargas no confirmó el archivo");
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      return result.downloadId || null;
    } catch (error) {
      console.warn("OmniChat: descarga mediante background no disponible; usando enlace local", error);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return null;
    }
  }

  function exportBaseName() {
    const base = safeFileName(conversationTitle().replace(/\.[a-z0-9]{1,8}$/i, ""), "conversation");
    const date = new Date().toISOString().replace(/[:.]/g, "-");
    return `${base} - OmniChat ${date}`;
  }

  async function performExport(rawOptions = {}) {
    ensureCurrentConversation();
    if (state.exporting) throw new Error("Ya hay una exportación en curso.");
    state.exporting = true;
    state.cancelled = false;
    state.visualCoverage = [];
    state.visualSnapshots = [];
    state.diagnostics = [{
      kind: "export-start",
      timestamp: new Date().toISOString(),
      platform: platformInfo().id,
      selectorCounts: {
        persistentChatGptShells: platformInfo().id === "chatgpt" ? chatGptPersistentShells().length : null,
        detectedTurns: getTurnElements().length,
        roleNodes: document.querySelectorAll("[data-message-author-role]").length
      }
    }];
    const options = {
      deepScan: rawOptions.deepScan !== false,
      expandCollapsed: rawOptions.expandCollapsed !== false,
      archiveAssets: rawOptions.archiveAssets !== false,
      archiveFiles: rawOptions.archiveFiles !== false,
      rawDom: rawOptions.rawDom !== false,
      eventLog: rawOptions.eventLog !== false,
      visualEvidence: rawOptions.visualEvidence !== false,
      format: ["zip", "html", "json", "markdown"].includes(rawOptions.format) ? rawOptions.format : "zip",
      assetLimitMb: Number(rawOptions.assetLimitMb) || 200
    };
    const warnings = [];
    try {
      toast("OmniChat: preparando exportación", "Detectando conversación…");
      let turns;
      const initialScroller=findScrollContainer(), initialTop=initialScroller.scrollTop;
      try {turns = await deepCapture(options, warnings);} finally {setScrollTop(initialScroller,initialTop);}
      if (!turns.length) throw new Error("No se detectaron turnos de conversación en esta página.");

      toast("OmniChat: resolviendo adjuntos", "Buscando referencias visibles de archivos…");
      const sourceLayer = await enrichChatGptVisibleFiles(turns, options, warnings);

      const resourceInfo = (options.archiveAssets || options.archiveFiles)
        ? await archiveResources(turns, options, warnings)
        : { archived: new Map(), totalBytes: 0, requested: 0 };

      for(const turn of turns) {
        for(const file of turn.files||[]) {
          const res=file.href ? resourceInfo.archived.get(file.href) : null;
          file.archiveStatus=res?'archived':!file.href?'unresolved':'not_archived';
          file.localPath=res?.localPath||null;
          if(!res) warnings.push(`Archivo sin copia local: ${file.downloadName||file.text||'sin nombre'} (${file.archiveStatus}).`);
        }
      }
      const conversation = buildConversationObject(turns, options, resourceInfo, warnings, sourceLayer);
      const base = exportBaseName();
      toast("OmniChat: generando archivo", `${conversation.summary.turns} turnos · ${conversation.summary.codeBlocks} bloques de código`);

      let filename;
      if (options.format === "zip") {
        const html = buildHtml(conversation, resourceInfo.archived, "zip");
        const md = buildMarkdown(conversation, resourceInfo.archived, true);
        const commands = buildCommandsMarkdown(conversation);
        const report = buildReport(conversation, resourceInfo);
        const json = JSON.stringify(conversation, null, 2);
        const files = [
          { name: "conversation.html", data: html },
          { name: "conversation.md", data: md },
          { name: "conversation.json", data: json },
          { name: "commands-and-code.md", data: commands },
          { name: "export-report.txt", data: report },
          { name: "diagnostics.json", data: JSON.stringify(conversation.diagnostics, null, 2) },
          { name: "source-layer.json", data: JSON.stringify(conversation.sourceLayer, null, 2) },
          { name: "README.txt", data: "Abre conversation.html para una vista legible. conversation.json contiene la estructura completa. commands-and-code.md separa ejecuciones reales de herramientas de los bloques de código normales. source-layer.json documenta únicamente el enriquecimiento de referencias de archivos visibles. Los recursos descargados están en assets/ y files/. Las capturas visuales de respaldo están en visual/.\n" }
        ];
        if (options.eventLog) files.push({ name: "session-events.json", data: JSON.stringify(conversation.sessionEvents, null, 2) });
        for (const shot of state.visualSnapshots) {
          files.push({ name: `visual/viewport-${String(shot.index).padStart(4, "0")}.jpg`, data: shot.bytes });
        }
        if (state.visualSnapshots.length) files.push({ name: "visual/index.json", data: JSON.stringify(conversation.visualEvidence, null, 2) });
        if (options.rawDom) {
          for (const turn of conversation.turns) {
            if (turn.rawHtml) {
              const local = rewriteRawHtml(turn.rawHtml, resourceInfo.archived, "zip").replace(/(src|href|poster)="(assets|files)\//g, '$1="../$2/');
              const rawDocument = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; media-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"><title>Turno ${turn.ordinal}</title>${local}`;
              files.push({ name: `raw/turn-${String(turn.ordinal).padStart(4, "0")}-${turn.role}.html`, data: rawDocument });
            }
          }
        }
        for (const res of resourceInfo.archived.values()) files.push({ name: res.localPath, data: res.bytes });
        const integrity=[];
        for(const file of files) {
          checkCancelled();
          const bytes=normalizedBytes(file.data);
          integrity.push({path:file.name,bytes:bytes.byteLength,sha256:await sha256Bytes(bytes)});
        }
        files.push({name:'integrity.json',data:JSON.stringify({algorithm:'SHA-256',scope:'all_other_entries_except_integrity_and_SHA256SUMS',entries:integrity},null,2)});
        files.push({name:'SHA256SUMS.txt',data:integrity.map(e=>`${e.sha256}  ${e.path}`).join('\n')+'\n'});
        const zipBytes = createZip(files);
        filename = `${base}.zip`;
        await downloadBlob(new Blob([zipBytes], { type: "application/zip" }), filename);
      } else if (options.format === "html") {
        const html = buildHtml(conversation, resourceInfo.archived, "single");
        filename = `${base}.html`;
        await downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), filename);
      } else if (options.format === "json") {
        filename = `${base}.json`;
        await downloadBlob(new Blob([JSON.stringify(conversation, null, 2)], { type: "application/json;charset=utf-8" }), filename);
      } else {
        filename = `${base}.md`;
        await downloadBlob(new Blob([buildMarkdown(conversation, resourceInfo.archived, false)], { type: "text/markdown;charset=utf-8" }), filename);
      }

      toast("OmniChat: exportación terminada", `${filename}${warnings.length ? ` · ${warnings.length} advertencias en el informe` : ""}`);
      hideToast(3500);
      return { ok: true, filename, warnings: warnings.length, summary: conversation.summary };
    } catch (error) {
      toast("OmniChat: error de exportación", error.message || String(error));
      hideToast(6000);
      return { ok: false, error: error.message || String(error) };
    } finally {
      state.exporting = false;
    }
  }

  function liveEventSignature(turn) {
    const pieces = [];
    for (const node of turn.querySelectorAll("pre, button[aria-expanded], details > summary, [role='status'], [aria-live], [data-testid*='tool'], [data-testid*='thinking'], [data-testid*='reasoning'], [data-testid*='execution'], [data-testid*='artifact']")) {
      if (node.closest("[role='toolbar'], [data-message-action-bar]")) continue;
      const text = safeInnerText(node);
      if (text) pieces.push(`${node.tagName}:${node.getAttribute("data-testid") || ""}:${node.getAttribute("aria-expanded") || ""}:${text.slice(0, 3000)}`);
      if (pieces.length >= 80) break;
    }
    return hashString(pieces.join("\n"));
  }

  function captureLiveEvent(turn) {
    if (!turn || turn.nodeType !== 1) return;
    const id = stableTurnId(turn);
    const signature = liveEventSignature(turn);
    if (!signature || signature === state.liveSignatures.get(id)) return;
    state.liveSignatures.set(id, signature);
    const toolExecutions = extractToolExecutions(turn);
    const event = {
      timestamp: new Date().toISOString(),
      turnId: id,
      role: detectRole(turn),
      signature,
      activities: extractActivities(turn),
      toolExecutions,
      codeBlocks: extractCodeBlocks(turn, toolExecutions).filter((b) => b.kind !== "inline_code")
    };
    if (!event.activities.length && !event.codeBlocks.length && !event.toolExecutions.length) return;
    state.liveLog.push(event);
    if (state.liveLog.length > MAX_LIVE_EVENTS) state.liveLog.splice(0, state.liveLog.length - MAX_LIVE_EVENTS);
  }

  function closestTurn(node) {
    if (!node || node.nodeType !== 1) return null;
    const platform = platformInfo().id;
    const selector = platform === "chatgpt"
      ? 'article[data-turn], [data-testid^="conversation-turn-"], [data-message-author-role]'
      : platform === "claude"
        ? '[data-test-render-count], [data-testid="user-message"], [data-testid="human-message"], .font-claude-response, [data-testid="ai-message"], [data-is-streaming]'
        : "main article, main [data-message-author-role]";
    return node.matches(selector) ? node : node.closest(selector);
  }

  function candidateTurnsInside(node) {
    if (!node || node.nodeType !== 1) return [];
    const candidates = [];
    const direct = closestTurn(node);
    if (direct && (direct === node || node.contains(direct))) candidates.push(direct);
    const platform = platformInfo().id;
    const selector = platform === "chatgpt"
      ? 'article[data-turn], [data-testid^="conversation-turn-"]'
      : platform === "claude"
        ? '[data-test-render-count]'
        : "article,[data-message-author-role]";
    if (node.querySelectorAll) candidates.push(...node.querySelectorAll(selector));
    return dedupeElements(candidates);
  }

  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver((mutations) => {
      try {ensureCurrentConversation();} catch {return;}
      const touched = new Set();
      for (const mutation of mutations) {
        const targetEl = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
        const turn = closestTurn(targetEl);
        if (turn) touched.add(turn);
        for (const removed of mutation.removedNodes) {
          if (removed.nodeType !== 1) continue;
          for (const candidate of candidateTurnsInside(removed)) {
            try {
              const snapshot = extractTurnSnapshot(candidate, { rawDom: true });
              state.evictedTurns.set(snapshot.id, snapshot);
              if (state.evictedTurns.size > 600) state.evictedTurns.delete(state.evictedTurns.keys().next().value);
            } catch { /* noop */ }
          }
        }
      }
      for (const turn of touched) {
        const old = state.liveTimers.get(turn);
        if (old) clearTimeout(old);
        const timer = setTimeout(() => {
          state.liveTimers.delete(turn);
          if (turn.isConnected && state.navigationKey===location.origin+location.pathname) captureLiveEvent(turn);
        }, 900);
        state.liveTimers.set(turn, timer);
      }
    });
    state.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-expanded", "data-state"] });
    setTimeout(() => getTurnElements().forEach(captureLiveEvent), 1200);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return undefined;
    if (message.type === "OMNICHAT_CANCEL") {state.cancelled=true;return Promise.resolve({ok:true});}
    if (message.type === "OMNICHAT_GET_SUMMARY") {ensureCurrentConversation();return Promise.resolve(getSummary());}
    if (message.type === "OMNICHAT_EXPORT") return performExport(message.options || {});
    return undefined;
  });

  startObserver();
})();
