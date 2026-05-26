# SinoAI Signals

> Your daily briefing on China's AI landscape — automated newsletter pipeline

## Architecture

```
RSS Feeds (8 Chinese sources)
    │
    ▼
index.js ─── DeepSeek/OpenRouter AI
    │         ├─ Translate (8 articles)
    │         └─ Curate (newsletter body)
    │
    ▼
newsletter-output/
    ├── newsletter.md
    ├── newsletter.html
    ├── rss.xml
    └── .quality (gate: passed/failed)
        │
        ▼
GitHub Actions (daily 8:00 AM Beijing)
    ├── Archive → git repo
    ├── Publish → Substack (Puppeteer)
    ├── Tweet → Twitter/X (tweet.js)
    └── Telegram notify
        │
        ▼
Vercel Dashboard
    ├── /api/latest → latest newsletter
    ├── /api/list → all newsletters
    └── Copy MD / Copy HTML → Substack paste
```

## Quick Start

```bash
git clone https://github.com/zengdaizhou/sinoai-signals.git
cd sinoai-signals

# Copy env template
cp .env.example .env

# Set API key in .env
# OPENROUTER_API_KEY=sk-or-v1-xxx

# Install & run
npm install
node index.js
```

## Environment Variables

### Required for generation
| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter API key (preferred) |
| `DEEPSEEK_API_KEY` | Direct DeepSeek API key (fallback) |

### Optional integrations
| Variable | Description |
|----------|-------------|
| `SUBSTACK_SID` | Substack session cookie for auto-publish |
| `TWITTER_APP_KEY` | Twitter API app key for auto-tweet |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for notifications |

## Daily Workflow

1. **Automatic** (8 AM Beijing): GitHub Actions generates the newsletter
2. **Publish**: Copy MD from [Dashboard](https://sinoai-signals.vercel.app) → paste to Substack
3. **Monitor**: Telegram receives the newsletter content

## Files

| Path | Purpose |
|------|---------|
| `index.js` | Core generator (RSS → AI → newsletter) |
| `publish.js` | Substack auto-publisher (Puppeteer) |
| `tweet.js` | Twitter/X auto-tweeter |
| `public/index.html` | Vercel management dashboard |
| `api/*.js` | Vercel serverless API endpoints |
| `.github/workflows/` | CI/CD pipelines |

## License

MIT
