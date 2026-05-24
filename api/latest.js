const REPO = "zengdaizhou/sinoai-signals";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const date = req.query.date;
  if (!date) {
    // Get latest - try to list and find the most recent
    const listRes = await fetch(`https://api.github.com/repos/${REPO}/contents/archive`, {
      headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "sinoai-signals" },
    });
    if (!listRes.ok) return res.status(404).json({ error: "No newsletters found" });
    const files = await listRes.json();
    if (!Array.isArray(files)) return res.json({ content: null });
    const mdFiles = files.filter(f => f.name.endsWith(".md")).sort((a, b) => b.name.localeCompare(a.name));
    if (mdFiles.length === 0) return res.json({ content: null });
    const latest = mdFiles[0];
    const contentRes = await fetch(latest.download_url, { headers: { "User-Agent": "sinoai-signals" } });
    if (!contentRes.ok) return res.status(500).json({ error: "Failed to fetch content" });
    const content = await contentRes.text();
    return res.json({ date: latest.name.replace(".md", ""), content, url: latest.download_url });
  }

  // Fetch specific date
  const rawUrl = `https://raw.githubusercontent.com/${REPO}/main/archive/${date}.md`;
  const contentRes = await fetch(rawUrl, { headers: { "User-Agent": "sinoai-signals" } });
  if (!contentRes.ok) return res.status(404).json({ error: `Newsletter ${date} not found` });
  const content = await contentRes.text();
  res.json({ date, content, url: rawUrl });
}
