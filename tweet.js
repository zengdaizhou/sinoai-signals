// ─── Twitter/X auto-tweet for SinoAI Signals ──────────────
// Posts a tweet about the latest newsletter issue.
// Gracefully exits if any required key is missing.
// Uses Twitter API v2 with OAuth 1.0a User Context.

import { readFileSync, existsSync } from "node:fs";
import { createHmac } from "node:crypto";

const APP_KEY = process.env.TWITTER_APP_KEY;
const APP_SECRET = process.env.TWITTER_APP_SECRET;
const ACCESS_TOKEN = process.env.TWITTER_ACCESS_TOKEN;
const ACCESS_SECRET = process.env.TWITTER_ACCESS_SECRET;

// ─── Graceful skip if keys missing ────────────────────────
if (!APP_KEY || !APP_SECRET || !ACCESS_TOKEN || !ACCESS_SECRET) {
  console.error("[tweet] Twitter keys not configured, skipping.");
  process.exit(0);
}

// ─── OAuth 1.0a signature ─────────────────────────────────
function oauthSignature(method, url, params, secret) {
  const sorted = Object.keys(params).sort();
  const paramStr = sorted
    .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
    .join("&");
  const base = method.toUpperCase() + "&" +
    encodeURIComponent(url) + "&" +
    encodeURIComponent(paramStr);
  const signingKey = encodeURIComponent(APP_SECRET) + "&" + encodeURIComponent(secret || ACCESS_SECRET);
  return createHmac("sha1", signingKey).update(base).digest("base64");
}

function oauthHeader(method, url, params = {}) {
  const oauthParams = {
    oauth_consumer_key: APP_KEY,
    oauth_nonce: Buffer.from(Date.now().toString() + Math.random()).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: ACCESS_TOKEN,
    oauth_version: "1.0",
    ...params,
  };
  oauthParams.oauth_signature = oauthSignature(method, url, oauthParams, ACCESS_SECRET);
  return "OAuth " + Object.keys(oauthParams).sort()
    .map(k => encodeURIComponent(k) + '="' + encodeURIComponent(oauthParams[k]) + '"')
    .join(", ");
}

// ─── Read newsletter for tweet text ───────────────────────
const MD_PATH = "newsletter-output/newsletter.md";
if (!existsSync(MD_PATH)) {
  console.error("[tweet] newsletter.md not found, skipping.");
  process.exit(0);
}

const md = readFileSync(MD_PATH, "utf-8");
const dateLine = md.split("\n")[1]?.replace(/\*/g, "").trim() || "today";

// Extract headline/summary for tweet
const bigStory = md.match(/## The Big Story\n\n([^\n]+)/)?.[1] || "China's AI landscape today";

const tweetText = `SinoAI Signals ${dateLine} 🚀
        
${bigStory.slice(0, 140)}...

Read the full briefing → https://sinoaisignals.substack.com`;

console.error("[tweet] Posting:", tweetText.slice(0, 60) + "...");

// ─── Post to Twitter API v2 ───────────────────────────────
const url = "https://api.twitter.com/2/tweets";
const method = "POST";

try {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: oauthHeader(method, url),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: tweetText }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.error("[tweet] API error:", res.status, err.slice(0, 200));
    // Don't fail the workflow — tweet is optional
    process.exit(0);
  }

  const data = await res.json();
  console.error("[tweet] Posted! id:", data?.data?.id);
} catch (e) {
  console.error("[tweet] Network error:", e.message.slice(0, 100));
  process.exit(0);
}
