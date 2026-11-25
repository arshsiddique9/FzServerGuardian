const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config/servers.json"), "utf8"));
const STATE_FILE = path.join(ROOT, "state/guardian-state.json");

const env = {
  panelUrl: process.env.PANEL_URL,
  username: process.env.PANEL_USERNAME,
  password: process.env.PANEL_PASSWORD,
  webhook: process.env.DISCORD_WEBHOOK_URL || "",
  headless: process.env.HEADLESS !== "false",
  navigationTimeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
  statusWait: Number(process.env.STATUS_WAIT_MS || 1200),
  startVerifyWait: Number(process.env.START_VERIFY_WAIT_MS || 12000),
  offlineConfirmations: Number(process.env.OFFLINE_CONFIRMATIONS || 2),
  cooldownMs: Number(process.env.START_COOLDOWN_MINUTES || 60) * 60 * 1000
};

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { servers: {}, updatedAt: null };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(message) {
  console.log(`[FzServerGuardian] ${new Date().toISOString()} ${message}`);
}

async function discord(title, description, color = 0x5865F2) {
  if (!env.webhook) return;
  try {
    const response = await fetch(env.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title,
          description,
          color,
          timestamp: new Date().toISOString(),
          footer: { text: "FzServerGuardian • Flick ZZ (Arsh)" }
        }]
      })
    });
    if (!response.ok) log(`Discord webhook returned HTTP ${response.status}`);
  } catch (error) {
    log(`Discord notification failed: ${error.message}`);
  }
}

function phraseFound(text, phrases) {
  const lower = text.toLowerCase();
  return (phrases || []).some(p => lower.includes(p.toLowerCase()));
}

async function tcpCheck(host, port, timeoutMs = 4500) {
  if (!host || !port) return { reachable: null, reason: "No Minecraft host/port configured" };
  return new Promise(resolve => {
    const socket = new net.Socket();
    let finished = false;
    const done = result => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done({ reachable: true, reason: "TCP reachable" }));
    socket.once("timeout", () => done({ reachable: false, reason: "TCP timeout" }));
    socket.once("error", err => done({ reachable: false, reason: err.code || err.message }));
    socket.connect(Number(port), host);
  });
}

async function visible(locator) {
  try { return await locator.first().isVisible({ timeout: 1200 }); }
  catch { return false; }
}

async function loginIfNeeded(page, config) {
  await page.goto(env.panelUrl, { waitUntil: "domcontentloaded", timeout: env.navigationTimeout });
  await page.waitForTimeout(env.statusWait);

  const loginField = page.locator(config.selectors.username).first();
  if (await visible(loginField)) {
    log("Panel login page detected; signing in through the browser UI.");
    await loginField.fill(env.username);
    await page.locator(config.selectors.password).first().fill(env.password);
    await page.locator(config.selectors.loginButton).first().click();
    await page.waitForLoadState("domcontentloaded", { timeout: env.navigationTimeout }).catch(() => {});
    await page.waitForTimeout(1800);

    if (await visible(page.locator(config.selectors.username))) {
      throw new Error("Login did not complete. Check credentials, selectors, CAPTCHA or MFA.");
    }
  }
}

async function inspectServer(page, server, config, state) {
  const record = state.servers[server.name] || { offlineCount: 0, lastStartAt: 0 };
  await page.goto(server.serverPageUrl, {
    waitUntil: "domcontentloaded",
    timeout: env.navigationTimeout
  });
  await page.waitForTimeout(env.statusWait);

  const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 30000);
  const startButton = page.getByRole("button", { name: new RegExp(config.selectors.startButtonText, "i") });
  const stopButton = page.getByRole("button", { name: new RegExp(config.selectors.stopButtonText, "i") });

  if (phraseFound(bodyText, config.suspendedPhrases)) {
    record.offlineCount = 0;
    state.servers[server.name] = record;
    log(`${server.name}: SUSPENDED; no automatic action.`);
    await discord(`⛔ ${server.name}: suspended`, "The panel indicates that this server is suspended. Guardian will not attempt to bypass the restriction.", 0xED4245);
    return;
  }

  if (phraseFound(bodyText, config.nodeUnavailablePhrases)) {
    record.offlineCount = 0;
    state.servers[server.name] = record;
    log(`${server.name}: NODE_UNAVAILABLE suspected from panel UI; waiting.`);
    await discord(`⚠️ ${server.name}: node unavailable`, "The panel UI indicates a node/daemon or gateway problem. Automatic start is paused; Guardian will recheck on the next run.", 0xFEE75C);
    return;
  }

  if (phraseFound(bodyText, config.startingPhrases)) {
    record.offlineCount = 0;
    state.servers[server.name] = record;
    log(`${server.name}: STARTING/TRANSITION state; waiting.`);
    return;
  }

  const isStopVisible = await visible(stopButton);
  const isStartVisible = await visible(startButton);

  if (isStopVisible && !isStartVisible) {
    record.offlineCount = 0;
    state.servers[server.name] = record;
    const tcp = await tcpCheck(server.minecraftHost, server.minecraftPort);
    if (tcp.reachable === false) {
      log(`${server.name}: panel indicates running, Minecraft TCP unreachable (${tcp.reason}); network disruption suspected, NOT clicking Start.`);
      await discord(`⚠️ ${server.name}: network unreachable`, `Panel controls indicate the server is running, but Minecraft TCP is unreachable (${tcp.reason}). This may be routing, filtering, node or DDoS-related; it is not proof of DDoS. No Start click was sent.`, 0xFEE75C);
    } else {
      log(`${server.name}: ONLINE according to panel controls.`);
    }
    return;
  }

  if (!isStartVisible) {
    record.offlineCount = 0;
    state.servers[server.name] = record;
    log(`${server.name}: UNKNOWN status; Start/Stop button not found. No click performed.`);
    await discord(`❔ ${server.name}: status unknown`, "Could not identify the Start/Stop controls. No automatic action was taken. Check the configured panel selectors and server page URL.", 0xFEE75C);
    return;
  }

  record.offlineCount = (record.offlineCount || 0) + 1;
  state.servers[server.name] = record;
  log(`${server.name}: Start button visible; offline confirmation ${record.offlineCount}/${env.offlineConfirmations}.`);

  if (record.offlineCount < env.offlineConfirmations) return;

  const now = Date.now();
  if (now - (record.lastStartAt || 0) < env.cooldownMs) {
    log(`${server.name}: cooldown active; not clicking Start.`);
    return;
  }

  log(`${server.name}: confirmed stopped; clicking the visible Start button.`);
  await discord(`🔄 ${server.name}: starting`, "The panel UI shows the Start control after repeated checks. Guardian is attempting one browser-based Start action.", 0xFEE75C);

  // Re-check immediately before the action to avoid a stale click.
  if (!(await visible(startButton))) {
    log(`${server.name}: Start control disappeared; aborting click.`);
    return;
  }

  await startButton.first().click();
  record.lastStartAt = now;
  record.offlineCount = 0;
  state.servers[server.name] = record;
  writeState(state);

  await page.waitForTimeout(env.startVerifyWait);
  const afterText = (await page.locator("body").innerText().catch(() => "")).slice(0, 30000);
  const afterStart = await visible(startButton);
  const afterStop = await visible(stopButton);

  if (afterStop && !afterStart) {
    log(`${server.name}: panel controls now indicate running.`);
    await discord(`✅ ${server.name}: start accepted`, "The panel UI now shows the running controls. Minecraft connectivity will be checked on the next scheduled run.", 0x57F287);
  } else if (phraseFound(afterText, config.startingPhrases)) {
    log(`${server.name}: panel indicates startup in progress.`);
    await discord(`⏳ ${server.name}: starting`, "The panel indicates that startup is in progress. Guardian will verify again on the next run.", 0xFEE75C);
  } else {
    log(`${server.name}: start result not confirmed; cooldown retained to prevent repeated clicks.`);
    await discord(`⚠️ ${server.name}: start unconfirmed`, "A Start click was sent, but the panel did not clearly confirm a running/starting state. Guardian will respect the cooldown and recheck later.", 0xFEE75C);
  }
}

async function runGuardian() {
  if (!env.panelUrl || !env.username || !env.password) {
    throw new Error("Missing PANEL_URL, PANEL_USERNAME or PANEL_PASSWORD secret.");
  }
  if (!Array.isArray(CONFIG.servers) || CONFIG.servers.length !== 3) {
    throw new Error("config/servers.json must contain exactly the three configured servers.");
  }
  for (const s of CONFIG.servers) {
    if (!s.serverPageUrl || s.serverPageUrl.includes("REPLACE_WITH")) {
      throw new Error(`Set the real Pterodactyl server page URL for ${s.name} in config/servers.json.`);
    }
  }

  const state = readState();
  const browser = await chromium.launch({ headless: env.headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(env.navigationTimeout);

  try {
    await loginIfNeeded(page, CONFIG);
    await discord("🟢 FzServerGuardian check started", "Browser login succeeded. Checking Survival, Lifesteal and Practice.", 0x57F287);

    for (const server of CONFIG.servers) {
      try {
        await inspectServer(page, server, CONFIG, state);
        writeState(state);
      } catch (error) {
        log(`${server.name}: check failed: ${error.message}`);
        await discord(`⚠️ ${server.name}: monitoring error`, `${error.message}\nNo assumption of DDoS or node failure will be made from this error alone.`, 0xED4245);
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    writeState(state);
  }
}

module.exports = { runGuardian };
