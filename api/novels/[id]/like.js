import { sql } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";

export default async function handler(req, res) {
  const { id } = req.query;

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const exists = await sql`
    select 1 from novel_likes where novel_id=${id} and user_id=${user.id} limit 1
  `;

  if (exists.length) {
    await sql`delete from novel_likes where novel_id=${id} and user_id=${user.id}`;
  } else {
    await sql`insert into novel_likes (novel_id, user_id) values (${id}, ${user.id})`;
  }

  res.status(200).json({ ok: true });
}
