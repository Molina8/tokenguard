// TokenGuard — informe: hallazgos, arreglos y paywall.
// El diagnóstico se calcula en local (aquí). Las SOLUCIONES vienen del servidor:
// pasos + prompt listo para pegar, y se cobra 1 crédito por revelarlas.
import { buildFindings, totalSaving } from "./lib/diagnostics.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const $ = (s) => document.querySelector(s);
const usd = (n) => "$" + (n >= 1 ? n.toFixed(2) : n.toFixed(3)).replace(".", ",");
const pct = (n) => (Math.round(n * 1000) / 10).toString().replace(".", ",") + "%";

const TEASER = {
  cache_miss: "Contexto pagado a precio completo",
  expensive_turn: "Cada turno arrastra contexto muerto",
  reasoning_share: "Razonamiento pagado a precio de salida",
  project_concentration: "Un proyecto se come el presupuesto",
  model_mix: "Modelo caro para trabajo barato",
};

function getSession() {
  try {
    return JSON.parse(localStorage.getItem("tg_session") || "null");
  } catch {
    return null;
  }
}

function accessToken() {
  const s = getSession();
  return (s && (s.access_token || (s.session && s.session.access_token))) || null;
}

async function rpc(fn, args, { auth = true } = {}) {
  const headers = { "Content-Type": "application/json", apikey: SUPABASE_PUBLISHABLE_KEY };
  const t = accessToken();
  if (auth && t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(typeof data === "string" ? data : JSON.stringify(data).slice(0, 200));
  return data;
}

/* ── estado del informe ───────────────────────────────── */
let FINDINGS = [];
let SOLUTIONS = null;
let AGENT = "generic";

export function initReport(report, meta = {}) {
  AGENT = meta.agent || "generic";
  FINDINGS = buildFindings(report, { agent: AGENT });

  renderTeaser(FINDINGS);
  // los arreglos se solapan: no sumamos alegremente, topamos el recorte al 50% del gasto
  const saving = Math.min(totalSaving(FINDINGS), (report.totals.cost || 0) * 0.5);
  $("#solutions-saving").textContent = saving > 0 ? `recorte estimado · hasta ${usd(saving)}` : "sin fugas claras";

  const box = $("#solutions");
  box.innerHTML = "";
  $("#solutions-lock").hidden = false;
  $("#solutions-message").hidden = true;

  if (meta.demo) {
    // informe de ejemplo: se muestran los arreglos sin cobrar (modo escaparate)
    dryRun();
  } else {
    updateLockUI();
  }
}

function renderTeaser(findings) {
  const el = $("#findings");
  if (!findings.length) {
    el.innerHTML = `<li><span class="ico">✓</span><div><p>No veo fugas claras.</p><small>Caché funcionando y sin proyectos desproporcionados.</small></div></li>`;
    return;
  }
  el.innerHTML = findings
    .map(
      (f) => `<li>
      <span class="ico">◆</span>
      <div>
        <p>${TEASER[f.code] || f.code}</p>
        <small>${detalle(f)}</small>
      </div>
      <span class="amt">${usd(f.amount)}</span>
    </li>`
    )
    .join("");
}

function detalle(f) {
  const d = f.data || {};
  switch (f.code) {
    case "cache_miss":
      return `${d.cacheMissPct ?? 0}% del input se pagó a precio completo (${Number(d.tokensFullPrice || 0).toLocaleString("es-ES")} tokens).`;
    case "expensive_turn":
      return `${usd(d.perTurn || 0)} por turno en ${d.turns || 0} turnos. Ahorro estimado si compactas: ${d.savingPct || 50}%.`;
    case "reasoning_share":
      return `${Number(d.reasoningTokens || 0).toLocaleString("es-ES")} tokens de razonamiento = ${d.sharePct || 0}% del gasto.`;
    case "project_concentration":
      return `"${d.project}" concentra el ${d.sharePct || 0}% del gasto del periodo.`;
    case "model_mix":
      return `"${d.model}" es el ${d.sharePct || 0}% del gasto; parte de ese trabajo lo hace igual un modelo más barato.`;
    default:
      return "";
  }
}

/* ── soluciones ───────────────────────────────────────── */
async function dryRun() {
  try {
    const data = await rpc("unlock_report", { p_findings: FINDINGS, p_meta: { demo: true }, p_dry_run: true }, { auth: false });
    SOLUTIONS = data.solutions || [];
    renderSolutions();
    $("#solutions-lock").hidden = true;
    note("Informe de ejemplo: así se ve el arreglo completo. Con tu cuenta, sobre tus propios datos.");
  } catch (e) {
    note("No he podido cargar el ejemplo: " + e.message);
  }
}

async function unlock() {
  const btn = $("#lock-cta");
  btn.disabled = true;
  btn.textContent = "Desbloqueando…";
  try {
    const data = await rpc("unlock_report", {
      p_findings: FINDINGS,
      p_meta: { agent: AGENT, totalCost: totalSaving(FINDINGS) },
      p_dry_run: false,
    });

    if (!data.ok && data.reason === "AUTH_REQUIRED") {
      openAuth();
      return;
    }
    if (!data.ok && data.reason === "NO_CREDITS") {
      note("No te quedan informes. Compra uno suelto o un pack abajo.");
      updateLockUI(0);
      document.querySelector("#precios")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    SOLUTIONS = data.solutions || [];
    renderSolutions();
    $("#solutions-lock").hidden = true;
    note(`Informe desbloqueado. Te quedan ${data.balance} informe(s).`);
  } catch (e) {
    note("Error al desbloquear: " + e.message);
  } finally {
    btn.disabled = false;
    updateLockUI();
  }
}

function updateLockUI(balanceHint) {
  const btn = $("#lock-cta");
  const title = $("#lock-title");
  const sub = $("#lock-sub");
  const authed = !!accessToken();

  if (!authed) {
    title.textContent = "Los arreglos están a un registro";
    sub.textContent = "Creas cuenta gratis y ves los pasos exactos y el prompt para tu agente. Incluye 1 informe.";
    btn.textContent = "Crear cuenta y ver el arreglo";
    btn.dataset.mode = "auth";
  } else if (balanceHint === 0) {
    title.textContent = "Sin informes disponibles";
    sub.textContent = "Compra un informe suelto o un pack. Los créditos no caducan.";
    btn.textContent = "Comprar informe · $4,99";
    btn.dataset.mode = "buy";
  } else {
    title.textContent = "Arreglos listos para pegar";
    sub.textContent = "Incluye pasos concretos y un prompt para tu agente. Consume 1 informe.";
    btn.textContent = "Usar 1 informe";
    btn.dataset.mode = "unlock";
  }
}

function renderSolutions() {
  const box = $("#solutions");
  box.innerHTML = (SOLUTIONS || [])
    .map((s) => {
      const steps = Array.isArray(s.steps) ? s.steps : [];
      const prompt = (s.prompts && (s.prompts[AGENT] || s.prompts.generic)) || "";
      return `<article class="solution">
        <header>
          <h4>${escapeHtml(s.title)}</h4>
          <span class="sol-tag">${escapeHtml(agentLabel(AGENT))}</span>
        </header>
        <p class="why">${escapeHtml(s.why)}</p>
        <ol class="fix-steps">${steps.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ol>
        <div class="prompt-block">
          <div class="prompt-head">
            <span class="micro">Pégalo tal cual en tu agente</span>
            <button class="btn btn-ghost copy-btn" data-copy="${encodeURIComponent(prompt)}">Copiar prompt</button>
          </div>
          <pre class="prompt">${escapeHtml(prompt)}</pre>
        </div>
      </article>`;
    })
    .join("");

  box.querySelectorAll(".copy-btn").forEach((b) => {
    b.addEventListener("click", async () => {
      const text = decodeURIComponent(b.dataset.copy);
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = "Copiado ✓";
        setTimeout(() => (b.textContent = "Copiar prompt"), 1600);
      } catch {
        b.textContent = "Copia manualmente";
      }
    });
  });
}

function agentLabel(a) {
  return { codex: "Codex", "claude-code": "Claude Code", copilot: "Copilot CLI", grok: "Grok Build", generic: "tu agente" }[a] || "tu agente";
}

function note(msg) {
  const el = $("#solutions-message");
  el.textContent = msg;
  el.hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* ── eventos ─────────────────────────────────────────── */
let authOpener = null;
export function bindAuthOpener(fn) {
  authOpener = fn;
}
function openAuth() {
  if (authOpener) authOpener();
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("#lock-cta");
  if (!btn) return;
  const mode = btn.dataset.mode;
  if (mode === "auth") openAuth();
  else if (mode === "unlock") unlock();
  else if (mode === "buy") document.querySelector("#precios")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

// tras iniciar sesión, refresca el estado del candado
export function refreshAfterLogin() {
  if (!SOLUTIONS) updateLockUI();
}
