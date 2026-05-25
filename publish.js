import { readFileSync } from "node:fs";

const SID = process.env.SUBSTACK_SID;
const EMAIL = process.env.SUBSTACK_EMAIL;
const PASSWORD = process.env.SUBSTACK_PASSWORD;
const PUBLICATION = process.env.SUBSTACK_URL || "https://sinoaisignals.substack.com";

async function getSession() {
  if (SID) return SID;
  if (EMAIL && PASSWORD) {
    console.error("Logging in with email/password...");
    const res = await fetch("https://substack.com/api/v1/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, redirect: "" }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error("Login failed: " + err.slice(0, 200));
    }
    // Extract connect.sid from set-cookie header
    const cookies = res.headers.getSetCookie?.() || [];
    const sidCookie = cookies.find(c => c.startsWith("connect.sid"));
    if (!sidCookie) throw new Error("No connect.sid cookie received after login");
    return sidCookie.split(";")[0].replace("connect.sid=", "");
  }
  throw new Error("Set SUBSTACK_SID (cookie) or SUBSTACK_EMAIL + SUBSTACK_PASSWORD");
}

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

async function main() {
  const md = readFileSync("newsletter.md", "utf-8");
  const lines = md.trim().split("\n");
  const titleLine = lines[0].replace(/^#\s*/, "").trim();
  const dateLine = lines[2]?.replace(/^\*|\*.*$/g, "").trim() || "";
  const content = lines.slice(4).join("\n").trim();

  const bodyHtml = mdToHtml(content);

  const coverSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320" viewBox="0 0 640 320">
    <defs><linearGradient id="b" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0f0f1a"/><stop offset="100%" style="stop-color:#1a1a2e"/>
    </linearGradient></defs>
    <rect width="640" height="320" fill="url(#b)"/>
    <text x="320" y="140" text-anchor="middle" font-family="Georgia,serif" font-size="42" fill="#fff">SinoAI Signals</text>
    <text x="320" y="185" text-anchor="middle" font-family="Georgia,serif" font-size="18" fill="#888" font-style="italic">Your daily briefing on China's AI landscape</text>
    <text x="320" y="258" text-anchor="middle" font-family="Georgia,serif" font-size="15" fill="#666">${esc(dateLine)}</text>
  </svg>`;

  const fullHtml = '<div style="max-width:640px;margin:0 auto;padding:20px 20px 40px;font-family:Georgia,\'Times New Roman\',Times,serif;font-size:20px;line-height:1.6;color:#111">'
    + '<img src="data:image/svg+xml,' + encodeURIComponent(coverSvg) + '" style="display:block;width:100%;height:auto;margin:0 auto 32px;border-radius:8px">'
    + bodyHtml
    + '<p style="text-align:center;color:#6b6b6b;font-size:14px;margin-top:48px;border-top:1px solid #e5e5e5;padding-top:24px;font-style:italic">Built with DeepSeek · <a href="https://sinoaisignals.substack.com" style="color:inherit">Subscribe</a></p>'
    + '</div>';

  console.error("Logging in...");
  const session = await getSession();

  console.error("Creating draft...");
  const draftRes = await fetch("https://substack.com/api/v1/drafts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: "connect.sid=" + session,
    },
    body: JSON.stringify({
      title: titleLine + " — " + dateLine,
      body: { type: "doc", content: [{ type: "paragraph", content: [] }] },
      body_html: fullHtml,
      publication_url: PUBLICATION,
    }),
  });

  if (!draftRes.ok) {
    const err = await draftRes.text();
    console.error("Draft creation failed:", draftRes.status, err.slice(0, 300));
    process.exit(1);
  }

  const draft = await draftRes.json();
  const draftId = draft.id;
  console.error("Draft created:", draftId);

  console.error("Publishing draft...");
  const pubRes = await fetch(`https://substack.com/api/v1/drafts/${draftId}/publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: "connect.sid=" + session,
    },
    body: JSON.stringify({
      audience: "everyone",
      publish_now: true,
      publication_url: PUBLICATION,
    }),
  });

  if (!pubRes.ok) {
    const err = await pubRes.text();
    console.error("Publish failed:", pubRes.status, err.slice(0, 300));
    process.exit(1);
  }

  const result = await pubRes.json();
  console.error("Published! Post URL:", result?.url || "unknown");
  console.log(result?.url || "Published successfully");
}

main().catch(e => { console.error(e); process.exit(1); });
