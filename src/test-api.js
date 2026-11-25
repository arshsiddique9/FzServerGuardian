// src/test-api.js
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config/servers.json"), "utf8"));
const OUT = path.join(ROOT, "diagnose-out");
fs.mkdirSync(OUT, { recursive: true });

const REPORT = { generatedAt: new Date().toISOString(), keyChecks: [], servers: [], verdict: "UNKNOWN" };
const SEP = "=".repeat(90);

function section(t) { console.log(`\n${SEP}\n### ${t}\n${SEP}`); }
function kv(k, v) { console.log(`${k}: ${v}`); }
function maskKey(k) {
  if (!k) return "(MISSING)";
  return `${k.slice(0, 5)}... (len=${k.length})`;
}
function keyType(k) {
  if (!k) return "missing";
  if (k.startsWith("ptlc_")) return "client (ptlc_) ✅";
  if (k.startsWith("ptla_")) return "application (ptla_) ❌ /api/client ke liye galat";
  return "unknown prefix ⚠️";
}

async function http(baseUrl, apiKey, pathname, options = {}) {
  const url = baseUrl.replace(/\/+$/, "") + pathname;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "FzServerGuardian-APITest/1.0",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const contentType = res.headers.get("content-type") || "";
    const cfRay = res.headers.get("cf-ray") || "";
    const text = await res.text();
    let json = null;
    if (contentType.includes("application/json")) { try { json = JSON.parse(text); } catch {} }
    return { url, status: res.status, ok: res.ok, contentType, cfRay, text, json };
  } catch (err) {
    return { url, status: 0, ok: false, contentType: "", cfRay: "", text: `NETWORK_ERROR: ${err.message}`, json: null };
  } finally { clearTimeout(timer); }
}

function classify(r) {
  if (r.status === 0) return "NETWORK_ERROR";
  if (r.status === 401) return "UNAUTHORIZED (key galat/expired)";
  if (r.status === 403) return "FORBIDDEN (IP restriction ya permission nahi)";
  if (r.status === 404) return "NOT_FOUND (serverId galat ya access nahi)";
  if (r.status === 429) return "RATE_LIMITED";
  if (r.contentType.includes("text/html")) return "HTML_RESPONSE (Cloudflare/proxy block ya galat URL)";
  if (!r.ok) return `HTTP_${r.status}`;
  return "OK";
}
function preview(r, n = 400) { return (r.text || "").replace(/\s+/g, " ").slice(0, n); }

async function main() {
  console.log("FzServerGuardian — Pterodactyl API TEST");
  const servers = CONFIG.servers || [];
  kv("SERVERS", servers.length);

  section("STEP 0: API key presence & type");
  const envs = [...new Set(servers.map(s => s.apiKeyEnv).filter(Boolean))];
  for (const name of envs) {
    const key = process.env[name];
    const info = { envName: name, present: !!key, masked: maskKey(key), type: keyType(key) };
    REPORT.keyChecks.push(info);
    kv(name, `${info.masked}  →  ${info.type}`);
    if (key && key.startsWith("ptla_")) console.log("  ⚠️  ptla_ Application key hai. /api/client/* reject karega. Account → API Credentials se ptlc_ Client key banao.");
  }

  for (const server of servers) {
    const key = process.env[server.apiKeyEnv];
    const result = { name: server.name, panelUrl: server.panelUrl, serverId: server.serverId,
      apiKeyEnv: server.apiKeyEnv, keyPresent: !!key, keyType: keyType(key), steps: {}, status: "UNKNOWN" };
    REPORT.servers.push(result);
    section(`SERVER: ${server.name}  (${server.panelUrl} / ${server.serverId})`);

    if (!key) { kv("STATUS", "SKIPPED — API key env missing"); result.status = "SKIPPED"; continue; }

    // 1) Account
    console.log("\n-- 1) GET /api/client/account");
    const acc = await http(server.panelUrl, key, "/api/client/account");
    result.steps.account = { status: acc.status, classification: classify(acc), cfRay: acc.cfRay, bodyPreview: preview(acc) };
    kv("HTTP", `${acc.status}  (${classify(acc)})`);
    if (acc.cfRay) kv("CF-RAY", acc.cfRay);
    kv("BODY", preview(acc, 300));
    if (!acc.ok) { result.status = `FAIL:${classify(acc)}`; continue; }
    console.log("  ✅ Key valid. User:", acc.json?.attributes?.username, "/", acc.json?.attributes?.email);

    // 2) List servers
    console.log("\n-- 2) GET /api/client?per_page=100");
    const list = await http(server.panelUrl, key, "/api/client?per_page=100");
    result.steps.list = { status: list.status, classification: classify(list), count: list.json?.data?.length ?? null, bodyPreview: preview(list, 500) };
    kv("HTTP", `${list.status}  (${classify(list)})`);
    if (list.json?.data) {
      kv("COUNT", list.json.data.length);
      for (const item of list.json.data) {
        const a = item.attributes || {};
        console.log(`   - ${a.name}  id=${a.identifier}  uuid=${a.uuid}  status=${a.status ?? "?"}  suspended=${a.is_suspended}`);
      }
    } else kv("BODY", preview(list));

    // 3) Details
    console.log(`\n-- 3) GET /api/client/servers/${server.serverId}`);
    const det = await http(server.panelUrl, key, `/api/client/servers/${server.serverId}`);
    result.steps.details = { status: det.status, classification: classify(det), bodyPreview: preview(det, 500) };
    kv("HTTP", `${det.status}  (${classify(det)})`);
    if (det.ok) {
      const a = det.json?.attributes || {};
      kv("NAME", a.name); kv("IDENTIFIER", a.identifier); kv("UUID", a.uuid);
      kv("NODE", a.node); kv("SUSPENDED", a.is_suspended); kv("STATUS", a.status ?? "(null)");
    } else kv("BODY", preview(det));

    // 4) Resources
    console.log(`\n-- 4) GET /api/client/servers/${server.serverId}/resources`);
    const res = await http(server.panelUrl, key, `/api/client/servers/${server.serverId}/resources`);
    result.steps.resources = {
      status: res.status, classification: classify(res),
      currentState: res.json?.attributes?.current_state ?? null,
      isSuspended: res.json?.attributes?.is_suspended ?? null,
      resources: res.json?.attributes?.resources ?? null,
      bodyPreview: preview(res, 500),
    };
    kv("HTTP", `${res.status}  (${classify(res)})`);
    if (res.ok) {
      kv("CURRENT_STATE", res.json?.attributes?.current_state ?? "(unknown)");
      kv("IS_SUSPENDED", res.json?.attributes?.is_suspended);
      console.log("  RESOURCES:", JSON.stringify(res.json?.attributes?.resources || {}));
    } else kv("BODY", preview(res));

    // 5) Power probe (invalid signal — koi action nahi hota)
    console.log(`\n-- 5) POST /api/client/servers/${server.serverId}/power  (probe: invalid signal, NO action)`);
    const probe = await http(server.panelUrl, key, `/api/client/servers/${server.serverId}/power`, {
      method: "POST", body: { signal: "__probe_no_action__" },
    });
    result.steps.powerProbe = { status: probe.status, classification: classify(probe), bodyPreview: preview(probe, 500) };
    kv("HTTP", `${probe.status}  (${classify(probe)})`);
    kv("BODY", preview(probe, 300));
    if (probe.status === 422) console.log("  ✅ Power endpoint reachable + authorized. Invalid signal validation ne reject kiya (koi action nahi hua).");
    else if (probe.status === 401 || probe.status === 403) console.log("  ❌ Power permission/key issue.");
    else if (probe.status === 500) console.log("  ⚠️ 500 — invalid signal se crash (ignore karo; runtime pe valid signal chalega).");
    else if (probe.ok) console.log("  ⚠️ Invalid signal accept hua? Manually verify karo.");
    else console.log("  ⚠️ Unexpected response; runtime pe dhyan rakhna.");

    result.status = res.ok ? "OK" : `FAIL:${classify(res)}`;
  }

  section("VERDICT");
  const ok = REPORT.servers.filter(s => s.status === "OK").length;
  const failed = REPORT.servers.filter(s => s.status.startsWith("FAIL")).length;
  const skipped = REPORT.servers.filter(s => s.status === "SKIPPED").length;
  kv("OK", ok); kv("FAILED", failed); kv("SKIPPED", skipped);
  REPORT.verdict = ok > 0 && failed === 0 ? "API_WORKS" : ok > 0 ? "API_PARTIAL" : "API_BROKEN";
  kv("VERDICT", REPORT.verdict);

  fs.writeFileSync(path.join(OUT, "api-test-report.json"), JSON.stringify(REPORT, null, 2));
  const lines = [`API TEST REPORT — ${REPORT.generatedAt}`, `VERDICT: ${REPORT.verdict}`, `OK=${ok} FAILED=${failed} SKIPPED=${skipped}`, ""];
  for (const k of REPORT.keyChecks) lines.push(`KEY ${k.envName}: ${k.present ? "present" : "MISSING"} | type=${k.type}`);
  lines.push("");
  for (const s of REPORT.servers) {
    lines.push(`[${s.status}] ${s.name} (${s.panelUrl} / ${s.serverId})`);
    for (const [step, info] of Object.entries(s.steps || {})) {
      lines.push(`   - ${step}: HTTP ${info.status} ${info.classification}${info.currentState != null ? ` state=${info.currentState}` : ""}`);
    }
  }
  fs.writeFileSync(path.join(OUT, "api-test-report.txt"), lines.join("\n"));
  kv("REPORT_TXT", path.join(OUT, "api-test-report.txt"));
}

main().catch(err => { console.error("\nFATAL:", err.message); console.error(err.stack); process.exit(1); });
