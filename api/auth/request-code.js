import { readJson } from "../../lib/body.js";
import { sql } from "../../lib/db.js";
import { random6DigitCode, sha256Hex } from "../../lib/crypto.js";
import { sendVerificationCode } from "../../lib/mail.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = await readJson(req);
  const email = (body?.email || "").trim().toLowerCase();
  const purpose = (body?.purpose || "register").trim();

  if (!email.includes("@")) return res.status(400).json({ error: "Email invalid" });
  if (purpose !== "register") return res.status(400).json({ error: "Invalid purpose" });

  // rate limit: 60 detik
  const recent = await sql`
    select 1 from verification_codes
    where email=${email} and purpose=${purpose} and created_at > now() - interval '60 seconds'
    limit 1
  `;
  if (recent.length) return res.status(429).json({ error: "Tunggu 60 detik sebelum minta kode lagi" });

  const code = random6DigitCode();
  const codeHash = sha256Hex(code);

  await sql`
    insert into verification_codes (email, code_hash, purpose, expires_at)
    values (${email}, ${codeHash}, ${purpose}, now() + interval '10 minutes')
  `;

  await sendVerificationCode({ to: email, code });
  res.status(200).json({ ok: true });
}
