import bcrypt from "bcryptjs";
import { readJson } from "../../lib/body.js";
import { sql } from "../../lib/db.js";
import { createSession } from "../../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = await readJson(req);
  const email = (body?.email || "").trim().toLowerCase();
  const password = body?.password || "";

  const rows = await sql`select id, password_hash, verified from users where email=${email} limit 1`;
  const u = rows[0];
  if (!u) return res.status(401).json({ error: "Email/password salah" });
  if (!u.verified) return res.status(403).json({ error: "Akun belum diverifikasi" });

  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.status(401).json({ error: "Email/password salah" });

  await createSession(res, u.id);
  res.status(200).json({ ok: true });
}
