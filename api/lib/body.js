export async function readJson(req, maxBytes = 2_500_000) {
  const chunks = [];
  let size = 0;

  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new Error("Body too large");
    chunks.push(c);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;

  try { return JSON.parse(text); } catch { return null; }
}
