const REPO = "zengdaizhou/sinoai-signals";
const GH_API = "https://api.github.com";

async function request(url, token) {
  const headers = { Accept: "application/vnd.github.v3+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const data = await request(`${GH_API}/repos/${REPO}/contents/archive`);
  if (!data || !Array.isArray(data)) {
    return res.json({ newsletters: [] });
  }

  const newsletters = data
    .filter(f => f.name.endsWith(".md"))
    .map(f => ({
      date: f.name.replace(".md", ""),
      name: f.name,
      url: f.download_url,
      html_url: f.html_url,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  res.json({ newsletters });
}
