// src/diagnose.js
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config/servers.json"), "utf8"));
const OUT = path.join(ROOT, "diagnose-out");
fs.mkdirSync(OUT, { recursive: true });

const env = {
  panelUrl: process.env.PANEL_URL,
  username: process.env.PANEL_USERNAME,
  password: process.env.PANEL_PASSWORD,
  headless: process.env.HEADLESS !== "false",
  navigationTimeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
};

const line = () => console.log("=".repeat(90));
const section = (n) => { console.log(""); line(); console.log("### " + n); line(); };
const log = (k, v) => console.log(k + ": " + v);

async function dumpPage(page, tag) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const bodyText = (await page.locator("body").innerText().catch(() => ""))
    .replace(/\s+/g, " ").slice(0, 2000);

  const inputs = await page.$$eval("input, textarea", els => els.map(el => ({
    tag: el.tagName.toLowerCase(),
    type: el.type || "",
    name: el.name || "",
    id: el.id || "",
    placeholder: el.placeholder || "",
    ariaLabel: el.getAttribute("aria-label") || "",
    value: (el.value || "").slice(0, 40),
    visible: !!(el.offsetParent || el.getClientRects().length),
  }))).catch(e => ({ error: e.message }));

  const buttons = await page.$$eval("button, a[role='button'], input[type='submit'], input[type='button']", els => els.map(el => ({
    tag: el.tagName.toLowerCase(),
    type: el.type || "",
    id: el.id || "",
    text: (el.innerText || el.value || "").trim().replace(/\s+/g, " ").slice(0, 80),
    ariaLabel: el.getAttribute("aria-label") || "",
    title: el.getAttribute("title") || "",
    visible: !!(el.offsetParent || el.getClientRects().length),
  }))).catch(e => ({ error: e.message }));

  const forms = await page.$$eval("form", els => els.map(el => ({
    id: el.id || "",
    action: el.action || "",
    method: el.method || "",
    inputCount: el.querySelectorAll("input").length,
  }))).catch(e => ({ error: e.message }));

  section("PAGE DUMP: " + tag);
  log("URL", url);
  log("TITLE", title);
  log("INPUT_COUNT", Array.isArray(inputs) ? inputs.length : "ERR");
  log("BUTTON_COUNT", Array.isArray(buttons) ? buttons.length : "ERR");
  log("FORM_COUNT", Array.isArray(forms) ? forms.length : "ERR");
  console.log("INPUTS_JSON:", JSON.stringify(inputs, null, 2));
  console.log("BUTTONS_JSON:", JSON.stringify(buttons, null, 2));
  console.log("FORMS_JSON:", JSON.stringify(forms, null, 2));
  log("BODY_TEXT", bodyText);

  const base = tag.replace(/\W+/g, "_");
  const shot = path.join(OUT, base + ".png");
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  log("SCREENSHOT", shot);

  const html = path.join(OUT, base + ".html");
  fs.writeFileSync(html, await page.content().catch(() => ""));
  log("HTML", html);
}

async function trySelector(page, name, selector) {
  if (!selector) { console.log("  " + name + ' = (empty)'); return; }
  try {
    const loc = page.locator(selector);
    const count = await loc.count();
    let vis = false;
    if (count > 0) vis = await loc.first().isVisible({ timeout: 1500 }).catch(() => false);
    console.log("  " + name + ' = "' + selector + '"  -> count=' + count + " firstVisible=" + vis);
  } catch (e) {
    console.log("  " + name + ' = "' + selector + '"  -> ERROR ' + e.message);
  }
}

async function main() {
  console.log("FzServerGuardian DIAGNOSE RUN");
  log("PANEL_URL_SET", !!env.panelUrl);
  log("PANEL_USER_SET", !!env.username);
  log("PANEL_PASS_SET", !!env.password);
  log("CONFIG_SERVERS", (CONFIG.servers || []).length);
  if (!env.panelUrl) throw new Error("PANEL_URL missing");

  const browser = await chromium.launch({ headless: env.headless });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(env.navigationTimeout);

  page.on("console", m => console.log("[console:" + m.type() + "] " + m.text().slice(0, 200)));
  page.on("pageerror", e => console.log("[pageerror] " + e.message.slice(0, 200)));
  page.on("requestfailed", r => console.log("[reqfail] " + r.url().slice(0, 140) + " " + (r.failure()?.errorText || "")));
  page.on("response", r => { if (r.status() >= 400) console.log("[http-" + r.status() + "] " + r.url().slice(0, 140)); });

  try {
    const loginUrl = env.panelUrl.replace(/\/+$/, "").endsWith("/auth/login")
      ? env.panelUrl
      : env.panelUrl.replace(/\/+$/, "") + "/auth/login";

    section("STEP 1: Go to login");
    log("TARGET", loginUrl);
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: env.navigationTimeout })
      .catch(e => console.log("goto err: " + e.message));
    await page.waitForTimeout(3500);
    await dumpPage(page, "01-login-page");

    section("STEP 2: Test selectors on login page");
    for (const [k, v] of Object.entries(CONFIG.selectors || {})) await trySelector(page, k, v);

    section("STEP 3: Attempt login");
    const user = page.locator(CONFIG.selectors?.username || "").first();
    const pass = page.locator(CONFIG.selectors?.password || "").first();
    const userVis = await user.isVisible({ timeout: 2000 }).catch(() => false);
    const passVis = await pass.isVisible({ timeout: 2000 }).catch(() => false);
    console.log("usernameVisible=" + userVis + " passwordVisible=" + passVis);

    if (userVis && passVis && env.username && env.password) {
      await user.fill(env.username);
      await pass.fill(env.password);
      const btn = page.locator(CONFIG.selectors?.loginButton || "button[type='submit']").first();
      const btnVis = await btn.isVisible({ timeout: 2000 }).catch(() => false);
      console.log("loginButtonVisible=" + btnVis);
      if (btnVis) {
        await btn.click();
        await page.waitForLoadState("domcontentloaded", { timeout: env.navigationTimeout }).catch(() => {});
        await page.waitForTimeout(4000);
        await dumpPage(page, "02-after-login");
      }
    } else {
      console.log("!! LOGIN FORM NOT VISIBLE -> yahi reason hai");
    }

    for (const server of (CONFIG.servers || [])) {
      section("STEP 4: Server '" + server.name + "'");
      log("URL", server.serverPageUrl);
      await page.goto(server.serverPageUrl, { waitUntil: "domcontentloaded", timeout: env.navigationTimeout })
        .catch(e => console.log("goto err: " + e.message));
      await page.waitForTimeout(4000);
      await dumpPage(page, "03-" + server.name);

      const startRe = new RegExp(CONFIG.selectors?.startButtonText || "^Start$", "i");
      const stopRe  = new RegExp(CONFIG.selectors?.stopButtonText  || "^Stop$",  "i");
      const btns = await page.$$eval("button, a[role='button'], input[type='submit'], input[type='button']",
        els => els.map(el => ({
          text: (el.innerText || el.value || "").trim().replace(/\s+/g, " ").slice(0, 80),
          ariaLabel: el.getAttribute("aria-label") || "",
          visible: !!(el.offsetParent || el.getClientRects().length),
        }))).catch(() => []);
      console.log("START_REGEX_" + startRe.source + " matches=" + JSON.stringify(btns.filter(b => startRe.test(b.text) || startRe.test(b.ariaLabel))));
      console.log("STOP_REGEX_" + stopRe.source + " matches=" + JSON.stringify(btns.filter(b => stopRe.test(b.text) || stopRe.test(b.ariaLabel))));
    }

    section("DONE");
    log("OUTPUT", OUT);
    log("FILES", fs.readdirSync(OUT).join(", "));
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch(e => {
  console.log(""); line(); console.log("FATAL: " + e.message); console.log(e.stack); line();
  process.exit(1);
});
