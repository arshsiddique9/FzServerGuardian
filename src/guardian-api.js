// src/guardian-api.js
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config/servers.json"), "utf8"));
const STATE_FILE = path.join(ROOT, "state/guardian-state.json");

const env = {
  webhook: process.env.DISCORD_WEBHOOK_URL || "",
  offlineConfirmations: Number(process.env.OFFLINE_CONFIRMATIONS || 2),
  cooldownMs: Number(process.env.START_COOLDOWN_MINUTES || 60) * 60 * 1000,
  startVerifyWaitMs: Number(process.env.START_VERIFY_WAIT_MS || 120000),
  requestTimeoutMs: Number(process.env.API_TIMEOUT_MS || 20000),
  pollIntervalMs: Number(process.env.API_POLL_INTERVAL_MS || 5000),
};
const RUNNING_STATES = new Set(["running", "starting", "stopping"]);

function log(m) { console.log(`[FzServerGuardian] ${new Date().toISOString()} ${m}`); }
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { servers: {}, updatedAt: null }; } }
function writeState(s) { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); s.updatedAt = new Date().toISOString(); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function discord(title, description, color = 0x5865F2) {
  if (!env.webhook) return;
  try {
    const res = await fetch(env.webhook, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ embeds: [{ title, description, color, timestamp: new Date().toISOString(), footer: { text: "FzServerGuardian • API mode" } }] }),
    });
    if (!res.ok) log(`Discord HTTP ${res.status}`);
  } catch (e) { log(`Discord failed: ${e.message}`); }
}

async function api(server, pathname, options = {}) {
  const key = process.env[server.apiKeyEnv];
  if (!key) throw new Error(`Missing ${server.apiKeyEnv} for ${server.name}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.requestTimeoutMs);
  try {
    const res = await fetch(server.panelUrl.replace(/\/+$/, "") + pathname, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${key}`, Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();
    let json = null;
    if (contentType.includes("application/json")) { try { json = JSON.parse(text); } catch {} }
    return { status: res.status, ok: res.ok, contentType, json, text };
  } finally { clearTimeout(timer); }
}

function describeFailure(r) {
  if (r.contentType.includes("text/html")) return "HTML response (Cloudflare/proxy block ya galat panel URL)";
  if (r.status === 401) return "401 Unauthorized (API key galat/expired; ptlc_ Client key hona chahiye)";
  if (r.status === 403) return "403 Forbidden (IP restriction ya is server par permission nahi)";
  if (r.status === 404) return "404 Not Found (serverId galat ya access nahi)";
  if (r.status === 429) return "429 Rate limited";
  return `HTTP ${r.status}`;
}

async function getResources(s) { return api(s, `/api/client/servers/${s.serverId}/resources`); }
async function sendPower(s, signal) { return api(s, `/api/client/servers/${s.serverId}/power`, { method: "POST", body: { signal } }); }

async function inspectServer(server, state) {
  const rec = state.servers[server.name] || { offlineCount: 0, lastStartAt: 0 };
  log(`${server.name}: checking API…`);

  const res = await getResources(server);
  if (!res.ok) {
    rec.offlineCount = 0; state.servers[server.name] = rec;
    const reason = describeFailure(res);
    log(`${server.name}: API ERROR — ${reason}`);
    await discord(`⚠️ ${server.name}: API error`, `${reason}\nNo action taken.`, 0xED4245);
    return;
  }

  const attrs = res.json?.attributes || {};
  const currentState = attrs.current_state || "unknown";
  const isSuspended = !!attrs.is_suspended;

  if (isSuspended) {
    rec.offlineCount = 0; state.servers[server.name] = rec;
    log(`${server.name}: SUSPENDED — no action.`);
    await discord(`⛔ ${server.name}: suspended`, "Panel API reports suspended. Guardian will not bypass it.", 0xED4245);
    return;
  }

  if (RUNNING_STATES.has(currentState)) {
    rec.offlineCount = 0; rec.lastState = currentState; state.servers[server.name] = rec;
    log(`${server.name}: ${currentState.toUpperCase()} — no action.`); return;
  }

  if (currentState !== "offline") {
    rec.offlineCount = 0; state.servers[server.name] = rec;
    log(`${server.name}: UNKNOWN state "${currentState}" — no action.`);
    await discord(`❔ ${server.name}: unknown state`, `current_state="${currentState}". No action.`, 0xFEE75C);
    return;
  }

  rec.offlineCount = (rec.offlineCount || 0) + 1;
  rec.lastState = currentState; state.servers[server.name] = rec;
  log(`${server.name}: OFFLINE — confirmation ${rec.offlineCount}/${env.offlineConfirmations}`);
  if (rec.offlineCount < env.offlineConfirmations) return;

  const now = Date.now();
  if (now - (rec.lastStartAt || 0) < env.cooldownMs) {
    const remain = Math.ceil((env.cooldownMs - (now - rec.lastStartAt)) / 60000);
    log(`${server.name}: cooldown active (${remain} min left) — not starting.`); return;
  }

  log(`${server.name}: confirmed offline — sending START via API.`);
  await discord(`🔄 ${server.name}: starting`, "Offline confirmations reached. Sending start signal via Pterodactyl API.", 0xFEE75C);

  const start = await sendPower(server, "start");
  if (!start.ok) {
    const reason = describeFailure(start);
    log(`${server.name}: START FAILED — ${reason}`);
    await discord(`❌ ${server.name}: start failed`, `${reason}\n${(start.text || "").slice(0, 300)}`, 0xED4245);
    return;
  }

  rec.lastStartAt = now; rec.offlineCount = 0; state.servers[server.name] = rec; writeState(state);
  log(`${server.name}: start accepted (HTTP ${start.status}). Verifying…`);

  const deadline = Date.now() + env.startVerifyWaitMs;
  let verified = "unknown";
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, env.pollIntervalMs));
    const v = await getResources(server);
    if (v.ok) { verified = v.json?.attributes?.current_state || "unknown"; if (RUNNING_STATES.has(verified)) break; }
  }

  if (RUNNING_STATES.has(verified)) {
    log(`${server.name}: verified ${verified.toUpperCase()}.`);
    await discord(`✅ ${server.name}: start verified`, `current_state="${verified}".`, 0x57F287);
  } else {
    log(`${server.name}: start accepted but not verified (last="${verified}").`);
    await discord(`⚠️ ${server.name}: start unconfirmed`, `Signal accepted, but current_state stayed "${verified}". Cooldown retained.`, 0xFEE75C);
  }
}

async function run() {
  const servers = CONFIG.servers || [];
  if (!servers.length) throw new Error("config/servers.json mein servers array khaali hai.");
  for (const s of servers) if (!s.name || !s.panelUrl || !s.serverId || !s.apiKeyEnv) throw new Error(`Incomplete entry: ${JSON.stringify(s)}`);

  const state = readState();
  log(`Guardian started (API mode). Servers: ${servers.map(s => s.name).join(", ")}`);
  await discord("🟢 FzServerGuardian check started", `API mode. Checking: ${servers.map(s => s.name).join(", ")}.`, 0x57F287);

  for (const server of servers) {
    if (!process.env[server.apiKeyEnv]) {
      log(`${server.name}: SKIPPED — ${server.apiKeyEnv} not set.`);
      await discord(`⚠️ ${server.name}: skipped`, `${server.apiKeyEnv} secret not set.`, 0xFEE75C);
      continue;
    }
    try { await inspectServer(server, state); writeState(state); }
    catch (e) { log(`${server.name}: ERROR — ${e.message}`); await discord(`⚠️ ${server.name}: error`, e.message, 0xED4245); }
    await new Promise(r => setTimeout(r, 300));
  }
  writeState(state);
  log("Run complete.");
}

module.exports = { run };
if (require.main === module) run().catch(e => { console.error(`[FzServerGuardian] FATAL: ${e.message}`); process.exit(1); });
