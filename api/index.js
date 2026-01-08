import bcrypt from "bcryptjs";
import { put } from "@vercel/blob";
import { neon } from "@neondatabase/serverless";
import cookie from "cookie";
import crypto from "crypto";

const sql = neon(process.env.DATABASE_URL);

// ===== utils =====
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

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
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

// ===== turnstile verify =====
async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) throw new Error("TURNSTILE_SECRET is missing");

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);

  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });

  const data = await r.json().catch(() => null);
  return !!data?.success;
}

// ===== session cookie =====
const COOKIE_NAME = "nv_session";

function getCookieToken(req) {
  const c = req.headers.cookie;
  if (!c) return null;
  return cookie.parse(c)[COOKIE_NAME] || null;
}

function setSessionCookie(res, token, maxAgeSeconds) {
  const secure = process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie", cookie.serialize(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: maxAgeSeconds
  }));
}

function clearSessionCookie(res) {
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
  const token = randomToken();
  const days = 14;
  const maxAgeSeconds = 60 * 60 * 24 * days;

  await sql`
    insert into sessions (user_id, token, expires_at)
    values (${userId}, ${token}, now() + (${days} || ' days')::interval)
  `;
  setSessionCookie(res, token, maxAgeSeconds);
}

// ===== router =====
export default async function handler(req, res) {
  try {
    if (!process.env.DATABASE_URL) return json(res, 500, { error: "DATABASE_URL missing" });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.searchParams.get("path") || "";
    const method = req.method;

    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "";

    // --- AUTH: me ---
    if (path === "auth/me" && method === "GET") {
      const user = await getSessionUser(req);
      return json(res, 200, { user });
    }

    // --- AUTH: logout ---
    if (path === "auth/logout" && method === "POST") {
      const token = getCookieToken(req);
      if (token) await sql`delete from sessions where token=${token}`;
      clearSessionCookie(res);
      return json(res, 200, { ok: true });
    }

    // --- AUTH: register (Turnstile required) ---
    if (path === "auth/register" && method === "POST") {
      const body = await readJson(req);
      const email = (body?.email || "").trim().toLowerCase();
      const password = body?.password || "";
      const captchaToken = (body?.captchaToken || "").trim();

      if (!email.includes("@")) return json(res, 400, { error: "Email invalid" });
      if (password.length < 6) return json(res, 400, { error: "Password min 6" });
      if (!captchaToken) return json(res, 400, { error: "Verifikasi manusia wajib" });

      const okHuman = await verifyTurnstile(captchaToken, ip);
      if (!okHuman) return json(res, 403, { error: "Verifikasi manusia gagal" });

      const exists = await sql`select 1 from users where email=${email} limit 1`;
      if (exists.length) return json(res, 409, { error: "Email sudah terdaftar" });

      const hash = await bcrypt.hash(password, 10);
      const created = await sql`
        insert into users (email, password_hash)
        values (${email}, ${hash})
        returning id
      `;

      await createSession(res, created[0].id);
      return json(res, 200, { ok: true });
    }

    // --- AUTH: login (tanpa captcha, biar ringan) ---
    if (path === "auth/login" && method === "POST") {
      const body = await readJson(req);
      const email = (body?.email || "").trim().toLowerCase();
      const password = body?.password || "";

      const rows = await sql`select id, password_hash from users where email=${email} limit 1`;
      const u = rows[0];
      if (!u) return json(res, 401, { error: "Email/password salah" });

      const ok = await bcrypt.compare(password, u.password_hash);
      if (!ok) return json(res, 401, { error: "Email/password salah" });

      await createSession(res, u.id);
      return json(res, 200, { ok: true });
    }

    // --- NOVELS: list ---
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

    // --- NOVELS: create (login required) ---
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

    // --- NOVELS: detail ---
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

    // --- NOVELS: like toggle ---
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

    // --- UPLOAD COVER (Blob) ---
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
