import RssParser from "rss-parser";

const parser = new RssParser({
  customFields: { item: [["content:encoded", "contentEncoded"]] },
});

const SOURCES = [
  { name: "Quantum Bit", url: "https://www.qbitai.com/feed" },
  { name: "36Kr", url: "https://36kr.com/feed" },
  { name: "iFanr", url: "https://www.ifanr.com/feed" },
  { name: "IT Home", url: "https://www.ithome.com/rss" },
  { name: "Leiphone", url: "https://www.leiphone.com/feed" },
  { name: "TMTpost", url: "https://www.tmtpost.com/rss" },
];

const API_KEY = process.env.DEEPSEEK_API_KEY;
const OR_KEY = process.env.OPENROUTER_API_KEY;

// Use OpenRouter if available (works from GitHub Actions), fall back to direct DeepSeek
function getApiConfig() {
  if (OR_KEY) {
    return {
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: OR_KEY,
      model: "deepseek/deepseek-chat",
      headers: {
        "HTTP-Referer": "https://sinoaisignals.substack.com",
        "X-Title": "SinoAI Signals",
      },
    };
  }
  return {
    url: "https://api.deepseek.com/chat/completions",
    key: API_KEY,
    model: "deepseek-chat",
    headers: {},
  };
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  if (!a || !b) return false;
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  for (let i = 0; i < short.length - 5; i++) {
    if (long.includes(short.slice(i, i + 12))) return true;
  }
  return false;
}

async function fetchFeeds() {
  const all = [];
  for (const s of SOURCES) {
    try {
      const feed = await parser.parseURL(s.url);
      console.error("[OK] " + s.name + ": " + (feed.items?.length || 0) + " items");
      for (const item of feed.items || []) {
        const raw = item.contentEncoded || item.content || item.contentSnippet || item.description || "";
        all.push({
          source: s.name,
          title: (item.title || "").trim(),
          link: item.link || "",
          rawContent: stripHtml(raw),
          pubDate: item.pubDate || item.isoDate || "",
        });
      }
    } catch (e) {
      console.error("[ERR] " + s.name + ": " + e.message);
    }
  }
  return all;
}

function filterRelevant(items) {
  const RELEVANT = ["AI","ai","人工智能","大模型","LLM","deepseek","DeepSeek","openai","OpenAI",
    "gpt","GPT","Claude","机器人","robot","Robot","芯片","chip","GPU","融资","funding",
    "自动驾驶","code","Codex","Copilot","华为","字节","百度","阿里","腾讯","鸿蒙","Harmony",
    "开源","open source","开源鸿蒙","OpenHarmony",
    "算力","model","Model","training","inference","data center","storage","SSD",
    "agent","Agent","autonomous","embodied","space intelligence"];
  const SKIP = ["SUV","手机","耳机","手表","宝马","奔驰","游戏","电视剧",
    "电影","综艺","球鞋","618","双11","评测","开箱","外观","配色","续航测试",
    "相机","拍照","摄影","镜头","腕表","跑车","赛车","F1","NBA","欧冠",
    "英超","西甲","中超","二手车","试驾","探店","装修","家居","穿搭",];
  return items.filter(item => {
    const t = item.title;
    if (SKIP.some(k => t.includes(k))) return false;
    return RELEVANT.some(k => t.includes(k));
  });
}

function dedup(items) {
  const out = [];
  for (const item of items) {
    if (!out.some(u => similarity(u.title, item.title))) out.push(item);
  }
  return out;
}

function filterRecent(items, days) {
  const cutoff = Date.now() - days * 86400000;
  return items.filter(item => {
    const d = new Date(item.pubDate);
    return !isNaN(d.getTime()) && d.getTime() > cutoff;
  });
}

async function fetchArticleContent(url) {
  try {
    const res = await fetch("https://r.jina.ai/" + url, {
      headers: {
        "Accept": "text/plain",
        "User-Agent": "Mozilla/5.0"
      },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const text = await res.text();
      // Find the markdown content after the URL line
      const lines = text.split("\n").filter(l => l.trim());
      // Skip first few lines (metadata) and take actual content
      const contentStart = lines.findIndex(l => l.includes("http") || l.includes("|")) + 1;
      const content = lines.slice(contentStart).join("\n").trim();
      return content.slice(0, 3000);
    }
  } catch (e) {
    // silently fail
  }
  return "";
}

async function callDeepSeek(messages) {
  const cfg = getApiConfig();
  const body = { model: cfg.model, messages, stream: false };
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + cfg.key,
      "Content-Type": "application/json",
      ...cfg.headers,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || data?.error?.code || res.status);
  return data?.choices?.[0]?.message?.content || "";
}

async function translateArticle(item) {
  // Try to fetch full content if RSS snippet is too short
  let content = item.rawContent;
  if (content.length < 500 && item.link) {
    console.error("    └─ fetching full article...");
    const full = await fetchArticleContent(item.link);
    if (full.length > content.length) content = full;
  }
  content = content.slice(0, 2500);

  const input = content
    ? "Title: " + item.title + "\nContent:\n" + content
    : "Title: " + item.title + "\nLink: " + item.link;

  try {
    const text = await callDeepSeek([
      {
        role: "system",
        content: "Read Chinese tech news. Output in English for a global reader (use 'China's' not 'domestic' or '国内').\n" +
          "Format:\nEnglish Title: <one line>\nSummary: <2-3 sentences explaining what happened and why it matters>\nData Point: <one specific number or statistic from the article, if any>",
      },
      { role: "user", content: input },
    ]);
    const lines = text.split("\n");
    const engTitle = lines.find(l => l.startsWith("English Title:"))?.replace("English Title:", "").trim() || item.title;
    const summary = lines.find(l => l.startsWith("Summary:"))?.replace("Summary:", "").trim() || text;
    const dataPoint = lines.find(l => l.startsWith("Data Point:"))?.replace("Data Point:", "").trim() || "";
    return { ...item, engTitle, englishSummary: summary, dataPoint };
  } catch (e) {
    if (e.message?.includes("Content Exists Risk")) {
      console.error("    └─ filtered, skipping");
      return null;
    }
    console.error("    └─ error: " + e.message.slice(0, 50));
    return null;
  }
}

function htmlBody(bodyMarkdown) {
  const lines = bodyMarkdown.trim().split("\n");
  let html = "";
  let inList = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (inList) { html += "</ul>\n"; inList = false; } continue; }
    if (t === "---") { if (inList) { html += "</ul>\n"; inList = false; } html += "<hr>\n"; continue; }
    if (t.startsWith("# ") && !t.startsWith("## ")) { html += "<h1>" + esc(t.slice(2)) + "</h1>\n"; continue; }
    if (t.startsWith("## ") && !t.startsWith("### ")) { html += "<h2>" + esc(t.slice(3)) + "</h2>\n"; continue; }
    if (t.startsWith("### ")) { html += "<h3>" + esc(t.slice(4)) + "</h3>\n"; continue; }
    if (t.startsWith("- ") || t.startsWith("* ")) {
      if (!inList) { html += "<ul>\n"; inList = true; }
      html += "  <li>" + inl(cleanTrailing(cleanReadMore(t.slice(2)))) + "</li>\n";
      continue;
    }
    if (inList) { html += "</ul>\n"; inList = false; }
    html += "<p>" + inl(cleanTrailing(cleanReadMore(t))) + "</p>\n";
  }
  if (inList) html += "</ul>\n";
  return html;
}
function esc(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function inl(s) { return esc(s).replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/\*(.+?)\*/g,"<em>$1</em>").replace(/\[(.+?)\]\(.+?\)/g,"$1"); }
function cleanReadMore(s) { return s.replace(/\.?\s*\[?\s*[Rr]ead\s+(more|original|article)\s*\]?\.?\s*/gi, "").trim(); }
function cleanTrailing(s) { return s.replace(/\s*\[\.?\]?\s*$/g, "").trim(); }

async function main() {
  console.error("[1/4] Fetching RSS feeds...");
  let items = await fetchFeeds();

  console.error("\n[2/4] Filtering...");
  items = filterRecent(items, 1);
  items = dedup(items);
  const before = items.length;
  items = filterRelevant(items);
  console.error("  " + items.length + " relevant articles (removed " + (before - items.length) + ")");

  items.sort((a, b) => b.rawContent.length - a.rawContent.length);
  items = items.slice(0, 8);

  console.error("\n[3/4] Translating " + items.length + " articles...");
  const translated = [];
  const concurrency = 4;
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    console.error("  batch " + (Math.floor(i/concurrency)+1) + ": " + batch.map(a => a.title.slice(0,30)).join(" | "));
    const results = await Promise.allSettled(batch.map(a => translateArticle(a)));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) translated.push(r.value);
    }
  }

  if (translated.length === 0) {
    console.error("[ERROR] No articles translated.");
    process.exit(1);
  }

  console.error("\n[4/4] Curating newsletter...");

  // Collect all data points for By the Numbers
  const dataPoints = translated.map(t => t.dataPoint).filter(Boolean);

  const itemsText = translated.map((a, i) =>
    "[" + (i+1) + "]\nTitle: " + a.engTitle + "\nSummary: " + a.englishSummary + "\nLink: " + a.link
  ).join("\n\n---\n\n");

  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  // Try AI curation, fall back to template
  let body;
  try {
    body = await callDeepSeek([
      {
        role: "system",
        content:
          "You write a daily newsletter called 'SinoAI Signals' about Chinese AI/tech for global readers.\n" +
          "Write from an OUTSIDE-China perspective. Never use 'domestic'.\n" +
          "STRICT RULES:\n" +
          "- NO source names, NO company names as sources, NO 'Source:', 'via', 'according to'.\n" +
          "- NO 'Read more', 'Read original', 'Link', URLs, markdown links.\n" +
          "- NO parenthetical citations, NO attribution of any kind.\n" +
          "- NO square brackets [ ] anywhere in your output.\n" +
          "- This is a curated summary, not a link aggregator. Just write the news cleanly.\n" +
          "- DO NOT include the newsletter name 'SinoAI Signals' — it is added separately.\n" +
          "- Start your response directly with --- (the section divider).\n" +
          "Use EXACTLY this format:\n\n" +
          "---\n\n" +
          "## The Big Story\n\n" +
          "(Pick the most important article. 2-3 paragraphs of analysis. Explain the significance.)\n\n" +
          "---\n\n" +
          "## Signals\n\n" +
          "### Article Title\n" +
          "**What happened:** (1-2 sentences)\n" +
          "**Why it matters:** (1-2 sentences)\n\n" +
          "(Repeat for 3-5 items)\n\n" +
          "---\n\n" +
          "## By the Numbers\n\n" +
          "**Key stat:** explanation\n\n" +
          "---\n\n" +
          "## Worth a Read\n\n" +
          "**Article Title** — 2 sentence recommendation.\n\n" +
          "---"
      },
      {
        role: "user",
        content: "Create a SinoAI Signals newsletter from these translated articles:\n\n" + itemsText +
          (dataPoints.length ? "\n\nData points for 'By the Numbers':\n" + dataPoints.map((d, i) => (i+1) + ". " + d).join("\n") : ""),
      },
    ]);
    console.error("[OK] AI curation succeeded.\n");
  } catch (e) {
    console.error("[FALLBACK] " + (e.message || "").slice(0, 50));
    body = "## The Big Story\n\n**" + translated[0].engTitle + "**\n\n" +
      translated[0].englishSummary + "\n\n---\n\n## Signals\n\n";
    for (let i = 1; i < translated.length; i++) {
      body += "**" + translated[i].engTitle + "**\n" + translated[i].englishSummary + "\n\n";
    }
  }

  // Post-process: strip any remaining source/attribution junk
  body = body
    // Strip full markdown links: [text](url) → just the text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Strip bare URLs
    .replace(/https?:\/\/[^\s)]+/g, "")
    // Strip org names used as sources
    .replace(/\([Ss]ource:[^)]*\)/g, "")
    .replace(/\([Vv]ia:[^)]*\)/g, "")
    .replace(/\([Cc]redit[^)]*\)/g, "")
    // Strip remaining brackets (safety net)
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    // Strip "Read more" and trailing text — ONE LINE ONLY, don't eat across paragraphs
    .replace(/[Rr]ead\s+(more|original|article)\b[^.\n]*\.?\s*/gi, "")
    .replace(/according\s+to\s+[^.\n]+\.?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const output =
    "# SinoAI Signals\n\n" +
    "*" + date + " — Your daily briefing on China's AI landscape*\n\n" +
    body + "\n\n---\n\n" +
    "*Built with DeepSeek | [Subscribe](https://sinoaisignals.substack.com)*\n";

  console.log(output);

  // Generate HTML version
  try {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>SinoAI Signals — ${date}</title>
<style>
  body{font-family:Georgia,'Times New Roman',Times,serif;max-width:640px;margin:0 auto;padding:20px 20px 40px;color:#111;line-height:1.6;font-size:20px;background:#fff}
  h1{font-size:32px;font-weight:400;text-align:center;line-height:1.2;margin:0 0 4px}
  h2{font-size:24px;font-weight:500;line-height:1.3;margin:40px 0 12px;color:#111;border:none;padding:0}
  h3{font-size:20px;font-weight:500;margin:32px 0 8px;color:#111}
  a{color:inherit;text-decoration:underline;text-decoration-color:#d0d0d0;text-underline-offset:3px}
  a:hover{text-decoration-color:#111}
  hr{border:none;border-top:1px solid #e5e5e5;margin:40px 0}
  p{margin:20px 0}
  ul{padding-left:24px} li{margin:8px 0}
  .sub{text-align:center;color:#6b6b6b;font-size:16px;margin:-4px 0 32px;font-style:italic}
  .footer{text-align:center;color:#6b6b6b;font-size:14px;margin-top:48px;border-top:1px solid #e5e5e5;padding-top:24px;font-style:italic}
  @media(prefers-color-scheme:dark){
    body{background:#1a1a2e;color:#e0e0e0}
    h1,h2,h3{color:#f0f0f0}
    a{text-decoration-color:#555}a:hover{text-decoration-color:#aaa}
    hr,.footer{border-color:#333}.sub{color:#999}
  }
</style>
</head>
<body>
<h1>SinoAI Signals</h1>
<p class="sub">${date} — Your daily briefing on China's AI landscape</p>
${htmlBody(body)}
<p class="footer"><em>Built with DeepSeek</em> · <a href="https://sinoaisignals.substack.com">Subscribe</a></p>
</body>
</html>`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync("newsletter.html", html);
    console.error("[OK] HTML file saved: newsletter.html");
  } catch (e) {
    console.error("[SKIP] HTML generation: " + (e.message || "").slice(0, 50));
  }

  // Generate RSS feed
  try {
    const now = new Date();
    const rssDate = now.toUTCString();
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>SinoAI Signals</title>
  <link>https://sinoaisignals.substack.com</link>
  <description>Your daily briefing on China's AI landscape</description>
  <language>en</language>
  <lastBuildDate>${rssDate}</lastBuildDate>
  <atom:link href="https://sinoaisignals.substack.com/rss" rel="self" type="application/rss+xml"/>
  <item>
    <title>SinoAI Signals — ${date}</title>
    <link>https://sinoaisignals.substack.com</link>
    <description><![CDATA[${body.replace(/^##/gm, "##").slice(0, 2000)}]]></description>
    <pubDate>${rssDate}</pubDate>
    <guid isPermaLink="false">sinoai-${now.toISOString().slice(0, 10)}</guid>
  </item>
</channel>
</rss>`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync("rss.xml", rss);
    console.error("[OK] RSS feed saved: rss.xml");
  } catch (e) {
    console.error("[SKIP] RSS generation: " + (e.message || "").slice(0, 50));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
