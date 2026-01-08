import bcrypt from "bcryptjs";
import { put } from "@vercel/blob";
import { neon } from "@neondatabase/serverless";
import cookie from "cookie";
import crypto from "crypto";
import nodemailer from "nodemailer";

const sql = neon(process.env.DATABASE_URL);

// ===== helpers =====
async function readJson(req, maxBytes = 3_500_000) {
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

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function random6() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}
function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
function token32() {
  return crypto.randomBytes(32).toString("hex");
}

const COOKIE_NAME = "nv_session";
function getCookieToken(req) {
  const c = req.headers.cookie;
  if (!c) return null;
  return cookie.parse(c)[COOKIE_NAME] || null;
}
function setCookie(res, token, maxAgeSeconds) {
  const secure = process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie", cookie.serialize(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: maxAgeSeconds
  }));
}
function clearCookie(res) {
  const secure = process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie", cookie.serialize(COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0
  }));
}
async function getSessionUser(req) {
  const token = getCookieToken(req);
  if (!token) return null;
  const rows = await sql`
    select u.id, u.email
    from sessions s
    join users u on u.id = s.user_id
    where s.token = ${token} and s.expires_at > now()
    limit 1
  `;
  return rows[0] || null;
}
async function createSession(res, userId) {
  const t = token32();
  const days = 14;
  await sql`
    insert into sessions (user_id, token, expires_at)
    values (${userId}, ${t}, now() + (${days} || ' days')::interval)
  `;
  setCookie(res, t, 60 * 60 * 24 * days);
}

// gmail
function mailTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("Missing GMAIL_USER or GMAIL_APP_PASSWORD");

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass }
  });
}

async function sendCodeEmail(to, code) {
  const from = process.env.MAIL_FROM || process.env.GMAIL_USER;
  const site = process.env.SITE_NAME || "NovelVerse";
  const t = mailTransport();
  await t.sendMail({
    from,
    to,
    subject: `${site} - Kode Verifikasi`,
    text: `Kode verifikasi kamu: ${code}\n\nBerlaku 10 menit.\nKalau bukan kamu yang minta, abaikan.`,
  });
}

function parseDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.+)$/.exec(dataUrl || "");
  if (!m) return null;
  return { mime: m[1], base64: m[2] };
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map(t => String(t).trim()).filter(Boolean).slice(0, 12);
}

// ===== main router =====
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.searchParams.get("path") || ""; // e.g. "auth/me"
    const method = req.method;

    // CORS optional (kalau kamu pakai domain lain)
    // res.setHeader("Access-Control-Allow-Origin", "*");

    // ===== AUTH: me =====
    if (path === "auth/me" && method === "GET") {
      const user = await getSessionUser(req);
      return json(res, 200, { user });
    }

    // ===== AUTH: logout =====
    if (path === "auth/logout" && method === "POST") {
      const token = getCookieToken(req);
      if (token) await sql`delete from sessions where token=${token}`;
      clearCookie(res);
      return json(res, 200, { ok: true });
    }

    // ===== AUTH: request-code =====
    if (path === "auth/request-code" && method === "POST") {
      const body = await readJson(req);
      const email = (body?.email || "").trim().toLowerCase();
      if (!email.includes("@")) return json(res, 400, { error: "Email invalid" });

      const recent = await sql`
        select 1 from verification_codes
        where email=${email} and purpose='register' and created_at > now() - interval '60 seconds'
        limit 1
      `;
      if (recent.length) return json(res, 429, { error: "Tunggu 60 detik sebelum minta kode lagi" });

      const code = random6();
      await sql`
        insert into verification_codes (email, code_hash, purpose, expires_at)
        values (${email}, ${sha256Hex(code)}, 'register', now() + interval '10 minutes')
      `;

      await sendCodeEmail(email, code);
      return json(res, 200, { ok: true });
    }

    // ===== AUTH: register (with code) =====
    if (path === "auth/register" && method === "POST") {
      const body = await readJson(req);
      const email = (body?.email || "").trim().toLowerCase();
      const password = body?.password || "";
      const code = (body?.code || "").trim();

      if (!email.includes("@")) return json(res, 400, { error: "Email invalid" });
      if (password.length < 6) return json(res, 400, { error: "Password min 6" });
      if (!/^\d{6}$/.test(code)) return json(res, 400, { error: "Kode harus 6 digit" });

      const exists = await sql`select 1 from users where email=${email} limit 1`;
      if (exists.length) return json(res, 409, { error: "Email sudah terdaftar" });

      const vc = await sql`
        select id, code_hash, expires_at, attempts
        from verification_codes
        where email=${email} and purpose='register'
        order by created_at desc
        limit 1
      `;
      const row = vc[0];
      if (!row) return json(res, 400, { error: "Minta kode dulu" });
      if (new Date(row.expires_at).getTime() < Date.now()) return json(res, 400, { error: "Kode kadaluarsa" });
      if ((row.attempts || 0) >= 5) return json(res, 429, { error: "Terlalu banyak percobaan, minta kode baru" });

      if (sha256Hex(code) !== row.code_hash) {
        await sql`update verification_codes set attempts = attempts + 1 where id=${row.id}`;
        return json(res, 401, { error: "Kode salah" });
      }

      const hash = await bcrypt.hash(password, 10);
      const created = await sql`
        insert into users (email, password_hash, verified)
        values (${email}, ${hash}, true)
        returning id
      `;
      await sql`delete from verification_codes where email=${email} and purpose='register'`;
      await createSession(res, created[0].id);
      return json(res, 200, { ok: true });
    }

    // ===== AUTH: login =====
    if (path === "auth/login" && method === "POST") {
      const body = await readJson(req);
      const email = (body?.email || "").trim().toLowerCase();
      const password = body?.password || "";

      const rows = await sql`select id, password_hash, verified from users where email=${email} limit 1`;
      const u = rows[0];
      if (!u) return json(res, 401, { error: "Email/password salah" });
      if (!u.verified) return json(res, 403, { error: "Akun belum diverifikasi" });

      const ok = await bcrypt.compare(password, u.password_hash);
      if (!ok) return json(res, 401, { error: "Email/password salah" });

      await createSession(res, u.id);
      return json(res, 200, { ok: true });
    }

    // ===== NOVELS: list =====
    if (path === "novels" && method === "GET") {
      const rows = await sql`
        select
          n.id, n.title, n.synopsis, n.tags, n.cover_url, n.chapters, n.created_at, n.updated_at,
          u.email as author_email,
          (select count(*)::int from novel_likes l where l.novel_id = n.id) as likes
        from novels n
        join users u on u.id = n.user_id
        order by n.updated_at desc
      `;
      return json(res, 200, { novels: rows });
    }

    // ===== NOVELS: create (login required) =====
    if (path === "novels" && method === "POST") {
      const user = await getSessionUser(req);
      if (!user) return json(res, 401, { error: "Unauthorized" });

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

      if (!title) return json(res, 400, { error: "Title required" });
      if (cleaned.length < 1) return json(res, 400, { error: "Min 1 chapter" });

      const created = await sql`
        insert into novels (user_id, title, synopsis, tags, cover_url, chapters)
        values (${user.id}, ${title}, ${synopsis}, ${tags}, ${coverUrl}, ${JSON.stringify(cleaned)}::jsonb)
        returning id
      `;
      return json(res, 200, { id: created[0].id });
    }

    // ===== NOVELS: detail =====
    if (path.startsWith("novels/") && method === "GET") {
      const id = path.split("/")[1];
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
      if (!novel) return json(res, 404, { error: "Not found" });
      return json(res, 200, { novel });
    }

    // ===== NOVELS: like toggle =====
    if (path.startsWith("novels/") && path.endsWith("/like") && method === "POST") {
      const user = await getSessionUser(req);
      if (!user) return json(res, 401, { error: "Unauthorized" });

      const id = path.split("/")[1];
      const exists = await sql`
        select 1 from novel_likes where novel_id=${id} and user_id=${user.id} limit 1
      `;
      if (exists.length) {
        await sql`delete from novel_likes where novel_id=${id} and user_id=${user.id}`;
      } else {
        await sql`insert into novel_likes (novel_id, user_id) values (${id}, ${user.id})`;
      }
      return json(res, 200, { ok: true });
    }

    // ===== UPLOAD COVER (Blob) =====
    if (path === "upload-cover" && method === "POST") {
      const user = await getSessionUser(req);
      if (!user) return json(res, 401, { error: "Unauthorized" });

      const body = await readJson(req, 3_000_000);
      const parsed = parseDataUrl(body?.dataUrl);
      if (!parsed) return json(res, 400, { error: "Invalid dataUrl" });

      const filename = (body?.filename || "cover.png").toString();
      const buf = Buffer.from(parsed.base64, "base64");
      if (buf.length > 2_500_000) return json(res, 413, { error: "Cover terlalu besar (maks ~2.5MB)" });

      const ext = (filename.split(".").pop() || "png").toLowerCase();
      const blob = await put(`covers/${user.id}/${Date.now()}.${ext}`, buf, {
        access: "public",
        contentType: parsed.mime
      });

      return json(res, 200, { url: blob.url });
    }

    return json(res, 404, { error: "Route not found" });
  } catch (e) {
    return json(res, 500, { error: e?.message || "Server error" });
  }
}
