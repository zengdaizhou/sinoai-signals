const REPO = "zengdaizhou/sinoai-signals";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const adminKey = req.headers["x-admin-key"];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) {
    return res.status(500).json({ error: "GitHub token not configured" });
  }

  const ghRes = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/daily-newsletter.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "sinoai-signals",
      },
      body: JSON.stringify({ ref: "main" }),
    }
  );

  if (!ghRes.ok) {
    const err = await ghRes.text().catch(() => "");
    return res.status(500).json({ error: `GitHub API error: ${ghRes.status} ${err.slice(0, 100)}` });
  }

  res.json({ ok: true, message: "Workflow triggered" });
}
