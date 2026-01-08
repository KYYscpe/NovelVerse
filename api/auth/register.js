import bcrypt from "bcryptjs";
import { readJson } from "../../lib/body.js";
import { sql } from "../../lib/db.js";
import { sha256Hex } from "../../lib/crypto.js";
import { createSession } from "../../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = await readJson(req);
  const email = (body?.email || "").trim().toLowerCase();
  const password = body?.password || "";
  const code = (body?.code || "").trim();

  if (!email.includes("@")) return res.status(400).json({ error: "Email invalid" });
  if (password.length < 6) return res.status(400).json({ error: "Password min 6" });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "Kode harus 6 digit" });

  const exists = await sql`select 1 from users where email=${email} limit 1`;
  if (exists.length) return res.status(409).json({ error: "Email sudah terdaftar" });

  // cek code valid (ambil yang terbaru)
  const codes = await sql`
    select id, code_hash, expires_at, attempts
    from verification_codes
    where email=${email} and purpose='register'
    order by created_at desc
    limit 1
  `;
  const row = codes[0];
  if (!row) return res.status(400).json({ error: "Minta kode dulu" });
  if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ error: "Kode kadaluarsa" });
  if ((row.attempts || 0) >= 5) return res.status(429).json({ error: "Terlalu banyak percobaan, minta kode baru" });

  const ok = sha256Hex(code) === row.code_hash;
  if (!ok) {
    await sql`update verification_codes set attempts = attempts + 1 where id=${row.id}`;
    return res.status(401).json({ error: "Kode salah" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const created = await sql`
    insert into users (email, password_hash, verified)
    values (${email}, ${passwordHash}, true)
    returning id
  `;
  const userId = created[0].id;

  // bersihkan kode
  await sql`delete from verification_codes where email=${email} and purpose='register'`;

  await createSession(res, userId);
  res.status(200).json({ ok: true });
}
