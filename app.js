import { parseAny, summarize } from "./lib/engine.js";
import { costOf, noCacheSavingsOf, isKnownModel } from "./lib/pricing.js";
import { initReport, bindAuthOpener, refreshAfterLogin } from "./report.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, CHECKOUT_LINKS } from "./config.js";

const $ = (sel) => document.querySelector(sel);
const usd = (n) => "$" + (n >= 1 ? n.toFixed(2) : n.toFixed(3)).replace(".", ",");
const num = (n) => Math.round(n).toLocaleString("es-ES");
const pct = (n) => (n * 100).toFixed(1).replace(".", ",") + "%";
const millions = (n) =>
  n >= 1e6 ? (n / 1e6).toFixed(1).replace(".", ",") + " M" : Math.round(n).toLocaleString("es-ES");

const drop = $("#drop");
const fileInput = $("#file-input");
const errBox = $("#drop-error");

/* ── lectura de archivos con progreso real ───────────── */
const SOURCE_LABEL = {
  codex: "Codex",
  "claude-code": "Claude Code",
  copilot: "Copilot CLI",
  grok: "Grok Build",
  generic: "JSONL genérico",
  unknown: "desconocido",
};

const progress = $("#progress");
const progressFill = $("#progress-fill");
const progressLabel = $("#progress-label");
const progressCount = $("#progress-count");
const progressSub = $("#progress-sub");

/* ── selector de carpeta (File System Access API) ────── */
async function pickDirectory() {
  if (!window.showDirectoryPicker) {
    fileInput.click(); // navegadores sin API de directorios
    return;
  }
  try {
    const dir = await window.showDirectoryPicker({ mode: "read" });
    const files = [];
    const walk = async (handle) => {
      for await (const entry of handle.values()) {
        if (entry.kind === "file") {
          if (/\.jsonl?$/i.test(entry.name)) files.push(await entry.getFile());
        } else if (entry.kind === "directory") {
          await walk(entry);
        }
      }
    };
    await walk(dir);
    if (!files.length) {
      showError("Esa carpeta no tiene archivos .jsonl. Prueba con ~/.codex/sessions, ~/.copilot/session-state o ~/.grok/sessions.");
      return;
    }
    await readFiles(files);
  } catch (err) {
    if (err && err.name === "AbortError") return; // el usuario canceló
    showError("No he podido abrir la carpeta: " + err.message);
  }
}

function setProgress(done, total, bytes, name) {
  progress.hidden = false;
  const pctDone = total ? (done / total) * 100 : 0;
  progressFill.style.width = pctDone.toFixed(1) + "%";
  progressCount.textContent = `${done}/${total}`;
  progressLabel.textContent = name ? `Leyendo ${name}` : "Leyendo archivos…";
  progressSub.textContent = bytes ? `${formatBytes(bytes)} procesados` : "";
}

const formatBytes = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

// Los timers sí corren en pestañas/iframes ocultos; requestAnimationFrame no siempre.
const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));

async function readFiles(fileList) {
  const all = [...fileList].filter((f) => /\.jsonl?$/i.test(f.name) && f.size > 0);
  if (!all.length) {
    showError("No veo archivos .jsonl. En Codex están en ~/.codex/sessions, en Claude Code en ~/.claude/projects, en Copilot en ~/.copilot/session-state y en Grok Build en ~/.grok/sessions.");
    return;
  }

  const MAX_FILES = 1200;
  const files = all.slice(0, MAX_FILES);
  const total = files.length;
  const started = performance.now();

  let turns = [];
  let used = 0;
  let bytes = 0;
  const formats = new Set();
  const seenSources = new Set();

  errBox.hidden = true;
  $("#dashboard").hidden = true;
  setProgress(0, total, 0, "");
  await yieldToPaint();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const text = await file.text();
    bytes += file.size;

    const rel = file.webkitRelativePath || "";
    const parts = rel.split("/").filter(Boolean);
    const folder = parts.length >= 2 ? parts[parts.length - 2] : "";
    const fallback = folder ? safeDecode(folder) : "unknown";

    const { format, turns: t } = parseAny(text, fallback);
    formats.add(format);
    if (t.length) {
      turns = turns.concat(t);
      used++;
      seenSources.add(format);
    }

    setProgress(i + 1, total, bytes, file.name.length > 28 ? file.name.slice(0, 26) + "…" : file.name);
    if (i % 4 === 0) await yieldToPaint();
  }

  progressLabel.textContent = "Calculando…";
  progressFill.style.width = "100%";
  await yieldToPaint();

  if (!turns.length) {
    progress.hidden = true;
    showError(
      `He leído ${total} archivos y no he encontrado uso de tokens en ninguno. Formatos soportados: Codex, Claude Code, Copilot CLI, Grok Build y cualquier JSONL con contadores de tokens.`
    );
    return;
  }

  const secs = ((performance.now() - started) / 1000).toFixed(1).replace(".", ",");
  progressLabel.textContent = `Listo · ${total} archivos en ${secs}s`;

  render(turns, {
    files: used,
    formats: [...formats],
    sources: [...seenSources].map((f) => SOURCE_LABEL[f] || f),
    skipped: all.length - files.length,
  });
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function showError(msg) {
  errBox.textContent = msg;
  errBox.hidden = false;
}

drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("dragover");
});
drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  drop.classList.remove("dragover");
  const items = e.dataTransfer.items;
  const files = [];
  if (items && items.length && items[0].webkitGetAsEntry) {
    const walk = async (entry) => {
      if (!entry) return;
      if (entry.isFile) {
        const f = await new Promise((res) => entry.file(res));
        files.push(f);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const entries = await new Promise((res) => reader.readEntries(res));
        for (const e2 of entries) await walk(e2);
      }
    };
    for (const it of items) await walk(it.webkitGetAsEntry());
    await readFiles(files);
  } else {
    await readFiles(e.dataTransfer.files);
  }
});
fileInput.addEventListener("change", () => readFiles(fileInput.files));
const pickBtn = $("#pick-dir");
if (pickBtn) pickBtn.addEventListener("click", pickDirectory);

/* ── render ─────────────────────────────────────────── */
let LAST = null;

function render(turns, meta) {
  renderReport(summarize(turns, { costOf, noCacheSavingsOf }), meta);
}

function renderReport(report, meta) {
  LAST = report;
  const t = report.totals;

  $("#dashboard").hidden = false;
  const fuentes = meta.sources && meta.sources.length ? meta.sources.join(" · ") : (meta.formats || []).map((f) => SOURCE_LABEL[f] || f).join(" · ");
  $("#report-meta").textContent = `${num(t.turns)} turnos · ${meta.files} archivos · ${fuentes || "formato desconocido"}${
    meta.skipped ? ` · ${meta.skipped} sin leer (límite 1200)` : ""
  }${meta.demo ? " · informe de ejemplo" : ""}`;

  const cacheShare = t.input ? t.cached / t.input : 0;
  const perTurn = t.turns ? t.cost / t.turns : 0;

  $("#kpis").innerHTML = [
    kpi("Coste estimado", usd(t.cost), "equivalente a precio de API", "accent"),
    kpi("Tokens", millions(t.tokens), `${num(t.turns)} turnos`),
    kpi("Acierto de caché", pct(cacheShare), `${millions(t.cached)} tokens servidos de caché`, cacheShare > 0.8 ? "" : "warn"),
    kpi("Coste por turno", usd(perTurn), "media del periodo"),
  ].join("");

  renderBars("#projects", report.byProject.map((p) => ({ name: p.project, value: p.cost, note: `${num(p.turns)} turnos` })));
  renderBars("#models", report.byModel.map((m) => ({ name: m.model, value: m.cost, note: `${num(m.tokens / 1e3)}k tok` })));
  const sinTarifa = report.byModel.filter((m) => !isKnownModel(m.model)).map((m) => m.model);
  const nota = $("#models-note");
  if (nota) {
    nota.textContent = sinTarifa.length
      ? `Sin tarifa publicada para ${sinTarifa.join(", ")}: esas cifras son una estimación con tarifa genérica.`
      : "";
    nota.hidden = !sinTarifa.length;
  }
  renderDays(report.byDay);
  initReport(report, { ...meta, agent: (meta.formats && meta.formats[0]) || "generic" });

  if (!new URLSearchParams(location.search).has("shot")) {
    $("#dashboard").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function kpi(label, value, sub, cls = "") {
  return `<div class="kpi">
    <span class="kpi-label">${label}</span>
    <span class="kpi-value ${cls}">${value}</span>
    <span class="kpi-sub">${sub}</span>
  </div>`;
}

function renderBars(sel, rows) {
  const el = $(sel);
  if (!rows.length) {
    el.innerHTML = `<p class="micro">Sin datos.</p>`;
    return;
  }
  const max = rows[0].value || 1;
  el.innerHTML = rows
    .slice(0, 8)
    .map(
      (r) => `<div class="bar-row" title="${r.name} — ${usd(r.value)} · ${r.note}">
        <span class="bar-name">${escapeHtml(r.name)}</span>
        <span class="bar-track"><span class="bar-fill ${r.value < max * 0.2 ? "dim" : ""}" style="width:${Math.max(2, (r.value / max) * 100)}%"></span></span>
        <span class="bar-cost">${usd(r.value)}</span>
      </div>`
    )
    .join("");
}

function renderDays(days) {
  const el = $("#days");
  if (!days.length) {
    el.innerHTML = `<p class="micro">Sin fechas en los logs.</p>`;
    return;
  }
  const max = Math.max(...days.map((d) => d.cost)) || 1;
  el.innerHTML = days
    .slice(-14)
    .map(
      (d) => `<div class="day-col" title="${d.day} — ${usd(d.cost)}">
        <span class="day-bar ${d.cost === max ? "hot" : ""}" style="height:${Math.max(6, (d.cost / max) * 100)}%"></span>
        <span class="day-label">${d.day.slice(5)}</span>
      </div>`
    )
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* ── auth (Supabase REST, sin SDK) ───────────────────── */
const dialog = $("#auth-dialog");
let mode = "login";

$("#open-auth").addEventListener("click", () => dialog.showModal());
bindAuthOpener(() => dialog.showModal());
$("#close-auth").addEventListener("click", () => dialog.close());
$("#toggle-mode").addEventListener("click", (e) => {
  e.preventDefault();
  mode = mode === "login" ? "signup" : "login";
  $("#auth-title").textContent = mode === "login" ? "Entrar" : "Crear cuenta";
  $("#auth-submit").textContent = mode === "login" ? "Entrar" : "Crear cuenta";
  $("#toggle-mode").textContent = mode === "login" ? "Crear una" : "Ya tengo cuenta";
});

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const email = form.email.value.trim();
  const password = form.password.value;
  const msg = $("#auth-msg");
  const btn = $("#auth-submit");
  btn.disabled = true;
  msg.hidden = true;

  const url =
    mode === "login"
      ? `${SUPABASE_URL}/auth/v1/token?grant_type=password`
      : `${SUPABASE_URL}/auth/v1/signup`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    if (!res.ok) {
      msg.className = "auth-msg err";
      msg.textContent = body.msg || body.error_description || body.message || "No he podido completar el registro.";
      msg.hidden = false;
      return;
    }
    localStorage.setItem("tg_session", JSON.stringify(body));
    refreshAfterLogin();
    msg.className = "auth-msg ok";
    msg.textContent = mode === "login" ? "Sesión iniciada." : "Cuenta creada. Revisa tu correo si hace falta confirmarla.";
    msg.hidden = false;
    setTimeout(() => dialog.close(), 900);
  } catch (err) {
    msg.className = "auth-msg err";
    msg.textContent = "Error de red: " + err.message;
    msg.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

/* ── modo demo (?demo) ───────────────────────────────── */
async function loadDemo() {
  try {
    const res = await fetch("./demo.json");
    const data = await res.json();
    renderReport(data.report, data.meta);
  } catch (e) {
    showError("No he podido cargar el informe de ejemplo: " + e.message);
  }
}

if (new URLSearchParams(location.search).has("demo")) {
  loadDemo();
}
// modo captura: oculta el hero para fotografiar el informe desde arriba
if (new URLSearchParams(location.search).has("shot")) {
  const hero = document.querySelector(".hero");
  if (hero) hero.style.display = "none";
}
const demoLink = $("#demo-link");
if (demoLink) {
  demoLink.addEventListener("click", (e) => {
    e.preventDefault();
    history.replaceState(null, "", "?demo=1");
    loadDemo();
  });
}

/* ── checkout ──────────────────────────────────────── */
document.querySelectorAll("[data-checkout]").forEach((b) => {
  b.addEventListener("click", () => {
    const plan = b.dataset.checkout;
    const note = $("#checkout-note");
    const link = CHECKOUT_LINKS[plan];
    const session = (() => {
      try {
        return JSON.parse(localStorage.getItem("tg_session") || "null");
      } catch {
        return null;
      }
    })();
    const userId = session && (session.user?.id || session.user_id);

    if (!link) {
      note.textContent = "El cobro está en modo prueba (Stripe sandbox): aún no se puede pagar de verdad.";
      note.hidden = false;
      return;
    }
    // client_reference_id permite acreditar los informes a la cuenta que compra
    const url = userId ? `${link}?client_reference_id=${encodeURIComponent(userId)}` : link;
    window.location.href = url;
  });
});
