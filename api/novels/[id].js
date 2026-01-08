import { sql } from "../../lib/db.js";

export default async function handler(req, res) {
  const { id } = req.query;

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const rows = await sql`
    select
      n.id, n.title, n.synopsis, n.tags, n.cover_url, n.chapters, n.created_at, n.updated_at,
      u.email as author_email,
      (select count(*)::int from novel_likes l where l.novel_id = n.id) as likes
    from novels n
    join users u on u.id = n.user_id
    where n.id = ${id}
    limit 1
  `;
  const novel = rows[0];
  if (!novel) return res.status(404).json({ error: "Not found" });

  res.status(200).json({ novel });
}
