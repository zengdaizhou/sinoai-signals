import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
puppeteer.use(StealthPlugin());

const EMAIL = process.env.SUBSTACK_EMAIL;
const PASSWORD = process.env.SUBSTACK_PASSWORD;
const SID = process.env.SUBSTACK_SID;
const PUBLICATION = process.env.SUBSTACK_URL || "https://sinoaisignals.substack.com";

// ─── Helper: sleep ────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Helper: detect Cloudflare challenge page ─────────────
function isCloudflareBlocked(page) {
  return page.evaluate(() => {
    const title = document.title || "";
    const body = document.body?.innerText || "";
    return (
      title.includes("Just a moment") ||
      title.includes("Attention Required") ||
      title.includes("Cloudflare") ||
      title.includes("Checking") ||
      body.includes("Checking your browser") ||
      body.includes("DDoS protection") ||
      body.includes("cf-browser-verification") ||
      !!document.querySelector("#challenge-form") ||
      !!document.querySelector("#cf-challenge") ||
      !!document.querySelector('[id*="challenge"]')
    );
  });
}

// ─── Helper: wait for Cloudflare challenge to resolve ────
async function waitForCloudflare(page, maxWaitMs = 90000) {
  console.error("  Cloudflare challenge detected, waiting up to " + (maxWaitMs / 1000) + "s...");
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await sleep(5000 + Math.random() * 2000);
    try {
      const stillBlocked = await page.evaluate(() => {
        const t = document.title || "";
        const b = document.body?.innerText || "";
        return t.includes("Just a moment") || t.includes("Cloudflare") ||
               b.includes("Checking your browser") || !!document.querySelector("#challenge-form");
      }).catch(() => true);
      if (!stillBlocked) {
        console.error("  Cloudflare challenge resolved after " + ((Date.now() - start) / 1000).toFixed(0) + "s");
        return true;
      }
      console.error("  Still waiting... (" + ((Date.now() - start) / 1000).toFixed(0) + "s)");
    } catch { /* keep waiting */ }
  }
  console.error("  Cloudflare challenge timed out after " + (maxWaitMs / 1000) + "s");
  return false;
}

// ─── Helper: save debug screenshot ────────────────────────
async function saveDebugScreenshot(page, name) {
  try {
    mkdirSync(".debug", { recursive: true });
    const p = `.debug/${name}-${Date.now()}.png`;
    await page.screenshot({ path: p, fullPage: false });
    console.error("  Screenshot saved:", p);
  } catch (e) { /* ignore */ }
}

// ─── Puppeteer publish (with Cloudflare bypass) ───────────
async function publishViaPuppeteer(fullTitle, bodyHtml, fullHtml) {
  const CHROME_PATHS = [
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
  ];
  const executablePath = process.env.PUPPETEER_EXEC_PATH
    || CHROME_PATHS.find(p => existsSync(p));

  console.error("[Puppeteer] Launching browser" + (executablePath ? ": " + executablePath : "") + "...");

  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-web-security",
      "--disable-features=BlockInsecurePrivateNetworkRequests",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=TranslateUI",
      "--disable-ipc-flooding-protection",
      "--window-size=1280,800",
    ],
    // ignoreDefaultArgs: ["--enable-automation"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // More realistic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    );

    // Pre-inject comprehensive WebDriver evasion before any page loads
    await page.evaluateOnNewDocument(() => {
      // WebDriver detection
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      delete Object.getPrototypeOf(navigator).webdriver;

      // Plugins (Chrome typically has PDF Viewer, Chrome PDF Plugin, Native Client)
      Object.defineProperty(navigator, "plugins", {
        get: () => {
          const plugins = [
            { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
            { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
            { name: "Native Client", filename: "internal-nacl-plugin", description: "" },
          ];
          plugins.length = 3;
          plugins.item = (i) => plugins[i];
          plugins.namedItem = (n) => plugins.find(p => p.name === n);
          plugins.refresh = () => {};
          return plugins;
        },
      });
      Object.defineProperty(navigator, "plugins", { configurable: true, enumerable: true });

      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });

      // Hardware concurrency (realistic for GitHub Actions 2-core runner)
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 2 });

      // Device memory
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });

      // Permissions override
      const origQuery = window.navigator.permissions.query.bind(navigator.permissions);
      window.navigator.permissions.query = (parameters) => (
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : origQuery(parameters)
      );

      // Chrome runtime
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };

      // Override toString for common detection methods
      const origToStr = Function.prototype.toString;
      Function.prototype.toString = function() {
        if (this === window.navigator.permissions.query) return "function query() { [native code] }";
        return origToStr.call(this);
      };
    });

    // Step 1: Warm up + set auth cookie on substack.com first
    console.error("[Puppeteer] Warming up on substack.com...");
    await page.goto("https://substack.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(3000 + Math.random() * 2000);

    // Set cookie NOW — before visiting the publication
    if (SID) {
      await page.setCookie({
        name: "connect.sid",
        value: decodeURIComponent(SID),
        domain: ".substack.com",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      });
      console.error("[Puppeteer] Cookie set");
    } else if (EMAIL && PASSWORD) {
      console.error("[Puppeteer] Logging in...");
      await page.goto("https://substack.com/sign-in", { waitUntil: "networkidle2", timeout: 30000 });
      if (await isCloudflareBlocked(page)) {
        await waitForCloudflare(page);
      }
      await page.type('input[type="email"]', EMAIL, { delay: 50 });
      await page.type('input[type="password"]', PASSWORD, { delay: 50 });
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
      console.error("[Puppeteer] Logged in");
    } else {
      throw new Error("Set SUBSTACK_SID or SUBSTACK_EMAIL + SUBSTACK_PASSWORD");
    }

    // Step 3: Navigate to publish page with retries
    let editorFound = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.error(`[Puppeteer] Publish page attempt ${attempt}/3...`);
      await page.goto(PUBLICATION + "/publish", { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(2000);

      if (await isCloudflareBlocked(page)) {
        const passed = await waitForCloudflare(page);
        if (!passed) {
          await saveDebugScreenshot(page, `cf-blocked-attempt-${attempt}`);
          if (attempt < 3) continue;
          throw new Error("Cloudflare block persists after 3 attempts");
        }
        // Retry navigation after challenge passes
        await page.goto(PUBLICATION + "/publish", { waitUntil: "networkidle0", timeout: 30000 });
      }

      console.error("[Puppeteer] Current URL:", page.url());

      // Wait for editor
      try {
        await page.waitForSelector('[contenteditable]', { timeout: 20000 });
        editorFound = true;
        break;
      } catch {
        await saveDebugScreenshot(page, `no-editor-attempt-${attempt}`);
        console.error("[Puppeteer] Editor not found on attempt " + attempt);
        if (attempt < 3) {
          console.error("[Puppeteer] Waiting 10s before retry...");
          await sleep(10000);
        }
      }
    }

    if (!editorFound) {
      // Final debug: dump page state
      console.error("[Puppeteer] Final URL:", page.url());
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || "no body").catch(() => "eval failed");
      console.error("[Puppeteer] Body text:", bodyText);
      throw new Error("Editor not found after 3 attempts — cookie may be expired or Substack changed UI");
    }

    // Step 4: Set title
    const titleSelectors = [
      'input[placeholder*="Title"]',
      '[contenteditable][placeholder*="Title"]',
      'input[placeholder*="title"]',
      '[data-testid="post-title"]',
    ];
    for (const sel of titleSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(fullTitle, { delay: 20 });
        console.error("[Puppeteer] Title set");
        break;
      }
    }

    // Step 5: Insert HTML body into editor
    const bodyEl = await page.$('[contenteditable]');
    if (bodyEl) {
      await bodyEl.click();
      await bodyEl.evaluate(el => { el.innerHTML = ""; });
      // Substack uses ProseMirror; insertHTML works as a fallback
      await bodyEl.evaluate((html) => {
        try {
          document.execCommand("insertHTML", false, html);
        } catch (e) {
          // fallback: set innerHTML directly
          const el = document.querySelector('[contenteditable]');
          if (el) el.innerHTML = html;
        }
      }, fullHtml);
      console.error("[Puppeteer] Content set");
    }

    await sleep(2000);

    // Step 6: Publish
    const [publishBtn] = await page.$x('//button[contains(text(), "Publish")]');
    if (!publishBtn) throw new Error("Publish button not found");

    await publishBtn.click();
    await sleep(2000);

    // Handle confirmation dialog
    const [confirmBtn] = await page.$x('//button[contains(text(), "Confirm") or contains(text(), "Publish now") or contains(text(), "Continue")]');
    if (confirmBtn) {
      await confirmBtn.click();
      console.error("[Puppeteer] Confirmed publish");
    }

    // Wait for publish to complete
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
    await sleep(3000);

    const url = page.url();
    console.error("[Puppeteer] Published! URL:", url);
    return url;

  } finally {
    await browser.close();
  }
}

// ─── Markdown to HTML converters ──────────────────────────
function mdToHtml(text) {
  const lines = text.split("\n");
  let html = "", inList = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (inList) { html += "</ul>\n"; inList = false; } continue; }
    if (t === "---") { if (inList) { html += "</ul>\n"; inList = false; } html += "<hr>\n"; continue; }
    if (t.startsWith("# ") && !t.startsWith("## ")) { html += "<h1>" + esc(t.slice(2)) + "</h1>\n"; continue; }
    if (t.startsWith("## ") && !t.startsWith("### ")) { html += "<h2>" + esc(t.slice(3)) + "</h2>\n"; continue; }
    if (t.startsWith("### ")) { html += "<h3>" + esc(t.slice(4)) + "</h3>\n"; continue; }
    if (t.startsWith("- ") || t.startsWith("* ")) {
      if (!inList) { html += "<ul>\n"; inList = true; }
      html += "  <li>" + inl(clean(t.slice(2))) + "</li>\n"; continue;
    }
    if (inList) { html += "</ul>\n"; inList = false; }
    if (t.startsWith("|")) continue;
    html += "<p>" + inl(clean(t)) + "</p>\n";
  }
  if (inList) html += "</ul>\n";
  return html;
}
function esc(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function inl(s) { return esc(s).replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/\*(.+?)\*/g,"<em>$1</em>").replace(/\[(.+?)\]\(.+?\)/g,"$1"); }
function clean(s) { return s.replace(/\.?\s*\[?\s*[Rr]ead\s+(more|original|article)\s*\]?\.?\s*/g, "").replace(/\s*\[\.?\]?\s*$/g, "").trim(); }

function coverSvg_(date) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320" viewBox="0 0 640 320">
    <defs><linearGradient id="b" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0f0f1a"/><stop offset="100%" style="stop-color:#1a1a2e"/>
    </linearGradient></defs>
    <rect width="640" height="320" fill="url(#b)"/>
    <text x="320" y="140" text-anchor="middle" font-family="Georgia,serif" font-size="42" fill="#fff">SinoAI Signals</text>
    <text x="320" y="185" text-anchor="middle" font-family="Georgia,serif" font-size="18" fill="#888" font-style="italic">Your daily briefing on China's AI landscape</text>
    <text x="320" y="258" text-anchor="middle" font-family="Georgia,serif" font-size="15" fill="#666">${esc(date)}</text>
  </svg>`;
}

// ─── Main ─────────────────────────────────────────────────
async function main() {
  if (!existsSync("newsletter-output/newsletter.md")) {
    console.error("newsletter-output/newsletter.md not found — run index.js first");
    process.exit(1);
  }

  const md = readFileSync("newsletter-output/newsletter.md", "utf-8");
  const lines = md.trim().split("\n");
  const titleLine = lines[0].replace(/^#\s*/, "").trim();
  const dateLine = lines[2]?.replace(/^\*|\*.*$/g, "").trim() || "";
  const content = lines.slice(4).join("\n").trim();
  const fullTitle = titleLine + " — " + dateLine;

  const bodyHtml = mdToHtml(content);
  const svgCover = coverSvg_(dateLine);
  const fullHtml = '<div style="max-width:640px;margin:0 auto;padding:20px 20px 40px;font-family:Georgia,\'Times New Roman\',Times,serif;font-size:20px;line-height:1.6;color:#111">' +
    '<img src="data:image/svg+xml,' + encodeURIComponent(svgCover) + '" style="display:block;width:100%;height:auto;margin:0 auto 32px;border-radius:8px">' +
    bodyHtml +
    '<p style="text-align:center;color:#6b6b6b;font-size:14px;margin-top:48px;border-top:1px solid #e5e5e5;padding-top:24px;font-style:italic">Built with DeepSeek · <a href="https://sinoaisignals.substack.com" style="color:inherit">Subscribe</a></p>' +
    '</div>';

  // ── Publish via Puppeteer ──
  let url = null;
  try {
    url = await publishViaPuppeteer(fullTitle, bodyHtml, fullHtml);
  } catch (e) {
    console.error("[Puppeteer] Exception:", e.message);
    console.error("[FAIL] Publish failed");
    process.exit(1);
  }

  console.log(url);
}

main().catch(e => { console.error(e); process.exit(1); });
