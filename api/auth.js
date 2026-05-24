export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { username, password } = req.body || {};
  if (username === "admin" && password === process.env.ADMIN_KEY) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Unauthorized" });
}
