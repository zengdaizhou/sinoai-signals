import RssParser from "rss-parser";
import { SubstackClient, PostBuilder, bold, italic, link, text } from "substack-skill";

const parser = new RssParser({
  customFields: { item: [["content:encoded", "contentEncoded"]] },
});

const SOURCES = [
  { name: "Quantum Bit", url: "https://www.qbitai.com/feed" },
  { name: "36Kr", url: "https://36kr.com/feed" },
  { name: "iFanr", url: "https://www.ifanr.com/feed" },
  { name: "IT Home", url: "https://www.ithome.com/rss" },
  { name: "Leiphone", url: "https://www.leiphone.com/feed" },
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
    "电影","综艺","球鞋","618","双11"];
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

function parseInlineMarkdown(mdText) {
  const tokens = [];
  let remaining = text;
  while (remaining.length > 0) {
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) { tokens.push(bold(boldMatch[1])); remaining = remaining.slice(boldMatch[0].length); continue; }
    const italicMatch = remaining.match(/^\*(.+?)\*/);
    if (italicMatch) { tokens.push(italic(italicMatch[1])); remaining = remaining.slice(italicMatch[0].length); continue; }
    const linkMatch = remaining.match(/^\[(.+?)\]\((.+?)\)/);
    if (linkMatch) { tokens.push(link(linkMatch[1], linkMatch[2])); remaining = remaining.slice(linkMatch[0].length); continue; }
    const nextSpecial = remaining.search(/[*\[]/);
    if (nextSpecial > 0) { tokens.push(text(remaining.slice(0, nextSpecial))); remaining = remaining.slice(nextSpecial); }
    else if (nextSpecial === -1) { tokens.push(text(remaining)); remaining = ""; }
    else { tokens.push(text(remaining[0])); remaining = remaining.slice(1); }
  }
  return tokens;
}

function markdownToTipTap(md) {
  const builder = new PostBuilder();
  const lines = md.trim().split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t === "---") { builder.divider(); continue; }
    if (t.startsWith("# ") && !t.startsWith("## ")) { builder.heading(t.slice(2), 1); continue; }
    if (t.startsWith("## ") && !t.startsWith("### ")) { builder.heading(t.slice(3), 2); continue; }
    if (t.startsWith("### ")) {
      const h = t.slice(4);
      const m = h.match(/^\[(.+?)\]\(.+?\)/);
      builder.heading(m ? m[1] : h, 3);
      continue;
    }
    if (t.startsWith("- ") || t.startsWith("* ")) {
      const items = [];
      while (i < lines.length && (lines[i].trim().startsWith("- ") || lines[i].trim().startsWith("* "))) {
        items.push(lines[i].trim().slice(2));
        i++;
      }
      i--;
      builder.bulletList(items);
      continue;
    }
    // Numbered list
    if (t.match(/^\d+\.\s/)) {
      const items = [];
      while (i < lines.length && lines[i].trim().match(/^\d+\.\s/)) {
        items.push(lines[i].trim().replace(/^\d+\.\s/, ""));
        i++;
      }
      i--;
      builder.orderedList(items);
      continue;
    }
    builder.richParagraph(...parseInlineMarkdown(t));
  }
  return builder.build();
}

async function publishToSubstack(bodyMarkdown, newsletterDate) {
  const sessionId = process.env.SUBSTACK_SESSION_ID;
  if (!sessionId) {
    console.error("[SKIP] Substack auto-publish: no SUBSTACK_SESSION_ID set");
    return;
  }
  try {
    const pubUrl = "https://sinoaisignals.substack.com";
    const client = new SubstackClient({ baseUrl: pubUrl });
    await client.authenticate({ sessionId });
    const title = "SinoAI Signals — " + newsletterDate;
    const tipTapBody = markdownToTipTap(bodyMarkdown);
    const draft = await client.createDraft({
      title,
      body: tipTapBody,
      audience: "everyone",
    });
    console.error("[OK] Substack draft created: " + draft.id);
    if (process.env.SUBSTACK_PUBLISH === "true") {
      await new Promise(r => setTimeout(r, 2000));
      const post = await client.publishDraft(draft.id);
      console.error("[OK] Substack published: " + post.canonical_url);
    } else {
      console.error("[INFO] Draft saved (not published). Set SUBSTACK_PUBLISH=true to auto-publish.");
    }
  } catch (e) {
    console.error("[ERR] Substack publish: " + (e.message || "").slice(0, 120));
  }
}

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
  for (let i = 0; i < items.length; i++) {
    console.error("  [" + (i+1) + "/" + items.length + "] " + items[i].title.slice(0, 60));
    const r = await translateArticle(items[i]);
    if (r) translated.push(r);
    await new Promise(r => setTimeout(r, 800));
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
          "Output ONLY the newsletter body, nothing else. Do NOT change the newsletter name.\n" +
          "Use EXACTLY this format with these section headers:\n\n" +
          "---\n\n" +
          "## The Big Story\n\n" +
          "(Pick the most important article. 2-3 paragraphs. Explain its global significance.)\n\n" +
          "---\n\n" +
          "## Signals\n\n" +
          "### [Article Title]\n" +
          "**What happened:** (1-2 sentences)\n" +
          "**Why it matters:** (1-2 sentences, global reader context)\n" +
          "[Read more](link)\n\n" +
          "(Repeat for 3-5 items)\n\n" +
          "---\n\n" +
          "## By the Numbers\n\n" +
          "**Key stat:** explanation\n\n" +
          "---\n\n" +
          "## Worth a Read\n\n" +
          "**Article Title** — 2 sentence recommendation. [Link](url)\n\n" +
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
      translated[0].englishSummary + "\n\n[Read original →](" + translated[0].link + ")\n\n---\n\n## Signals\n\n";
    for (let i = 1; i < translated.length; i++) {
      body += "**" + translated[i].engTitle + "**\n" + translated[i].englishSummary + "\n[Read more](" + translated[i].link + ")\n\n";
    }
  }

  const output =
    "# SinoAI Signals\n\n" +
    "*" + date + " — Your daily briefing on China's AI landscape*\n\n" +
    body + "\n\n---\n\n" +
    "*Built with DeepSeek | [Subscribe](https://sinoaisignals.substack.com)*\n";

  console.log(output);

  // Auto-publish to Substack if credentials are configured
  await publishToSubstack(body, date);
}

main().catch(e => { console.error(e); process.exit(1); });
