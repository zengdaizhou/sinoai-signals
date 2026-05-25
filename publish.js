import { readFileSync, existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const EMAIL = process.env.SUBSTACK_EMAIL;
const PASSWORD = process.env.SUBSTACK_PASSWORD;
const SID = process.env.SUBSTACK_SID;
const PUBLICATION = process.env.SUBSTACK_URL || "https://sinoaisignals.substack.com";

async function main() {
  const md = readFileSync("newsletter.md", "utf-8");
  const lines = md.trim().split("\n");
  const titleLine = lines[0].replace(/^#\s*/, "").trim();
  const dateLine = lines[2]?.replace(/^\*|\*.*$/g, "").trim() || "";
  const content = lines.slice(4).join("\n").trim();

  // Convert markdown to HTML for Substack
  const bodyHtml = mdToHtml(content);
  const coverSvg = coverSvg_(dateLine);
  const fullHtml = '<div style="max-width:640px;margin:0 auto;padding:20px 20px 40px;font-family:Georgia,\'Times New Roman\',Times,serif;font-size:20px;line-height:1.6;color:#111">'
    + '<img src="data:image/svg+xml,' + encodeURIComponent(coverSvg) + '" style="display:block;width:100%;height:auto;margin:0 auto 32px;border-radius:8px">'
    + bodyHtml
    + '<p style="text-align:center;color:#6b6b6b;font-size:14px;margin-top:48px;border-top:1px solid #e5e5e5;padding-top:24px;font-style:italic">Built with DeepSeek · <a href="https://sinoaisignals.substack.com" style="color:inherit">Subscribe</a></p>'
    + '</div>';

  const CHROME_PATHS = [
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  const executablePath = process.env.PUPPETEER_EXEC_PATH
    || CHROME_PATHS.find(p => existsSync(p));

  console.error("Launching browser...");
  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Login or set cookie
    if (SID) {
      await page.setCookie({
        name: "connect.sid",
        value: decodeURIComponent(SID),
        domain: ".substack.com",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      });
      console.error("Cookie set, navigating to publish...");
    } else if (EMAIL && PASSWORD) {
      console.error("Logging in...");
      await page.goto("https://substack.com/sign-in", { waitUntil: "networkidle2" });
      await page.type('input[type="email"]', EMAIL);
      await page.type('input[type="password"]', PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: "networkidle2" });
      console.error("Logged in.");
    } else {
      throw new Error("Set SUBSTACK_SID or SUBSTACK_EMAIL + SUBSTACK_PASSWORD");
    }

    // Navigate to publish page
    await page.goto(PUBLICATION + "/publish", { waitUntil: "networkidle2" });
    console.error("On publish page.");

    // Wait for editor to load
    await page.waitForSelector('[contenteditable]', { timeout: 15000 });

    // Set title
    const titleEl = await page.$('input[placeholder*="Title"], [contenteditable][placeholder*="Title"]');
    if (titleEl) {
      await titleEl.click({ clickCount: 3 });
      await titleEl.type(titleLine + " — " + dateLine);
    }

    // Click into body and paste HTML
    const bodyEl = await page.$('[contenteditable]');
    if (bodyEl) {
      // Focus and clear
      await bodyEl.click();
      await bodyEl.evaluate(el => el.innerHTML = "");

      // Set HTML content
      await bodyEl.evaluate((html) => {
        document.execCommand("insertHTML", false, html);
      }, fullHtml);
    }

    console.error("Content set.");

    // Click Publish button (using XPath — :contains is not native CSS)
    const [publishBtn] = await page.$x('//button[contains(text(), "Publish")]');
    if (publishBtn) {
      await publishBtn.click();
      // Maybe confirm in dialog
      await new Promise(r => setTimeout(r, 2000));
      const [confirmBtn] = await page.$x('//button[contains(text(), "Confirm") or contains(text(), "Publish now")]');
      if (confirmBtn) await confirmBtn.click();
      // Wait for navigation after publish
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
      console.error("Published!");
    }

    // Get the published post URL
    await new Promise(r => setTimeout(r, 2000));
    const url = page.url();
    console.log(url);

  } finally {
    await browser.close();
  }
}

// ---- Markdown to HTML ----
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

main().catch(e => { console.error(e); process.exit(1); });
