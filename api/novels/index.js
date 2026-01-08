import { sql } from "../../lib/db.js";
import { readJson } from "../../lib/body.js";
import { getSessionUser } from "../../lib/auth.js";

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map(t => String(t).trim()).filter(Boolean).slice(0, 12);
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const rows = await sql`
      select
        n.id, n.title, n.synopsis, n.tags, n.cover_url, n.chapters, n.created_at, n.updated_at,
        u.email as author_email,
        (select count(*)::int from novel_likes l where l.novel_id = n.id) as likes
      from novels n
      join users u on u.id = n.user_id
      order by n.updated_at desc
    `;
    return res.status(200).json({ novels: rows });
  }

  if (req.method === "POST") {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const body = await readJson(req, 3_500_000);
    const title = (body?.title || "").trim();
    const synopsis = (body?.synopsis || "").toString().slice(0, 2000);
    const coverUrl = body?.coverUrl ? String(body.coverUrl) : null;
    const tags = normalizeTags(body?.tags);

    const chapters = Array.isArray(body?.chapters) ? body.chapters : [];
    const cleaned = chapters
      .map(c => ({
        title: (c?.title || "").toString().slice(0, 80),
        body: (c?.body || "").toString()
      }))
      .filter(c => c.body.trim().length > 0);

    if (!title) return res.status(400).json({ error: "Title required" });
    if (cleaned.length < 1) return res.status(400).json({ error: "Min 1 chapter" });

    const created = await sql`
      insert into novels (user_id, title, synopsis, tags, cover_url, chapters)
      values (${user.id}, ${title}, ${synopsis}, ${tags}, ${coverUrl}, ${JSON.stringify(cleaned)}::jsonb)
      returning id
    `;
    return res.status(200).json({ id: created[0].id });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
