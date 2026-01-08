import cookie from "cookie";
import { sql } from "./db.js";
import { randomToken } from "./crypto.js";

const COOKIE_NAME = "nv_session";

export function getCookieToken(req) {
  const c = req.headers.cookie;
  if (!c) return null;
  const parsed = cookie.parse(c);
  return parsed[COOKIE_NAME] || null;
}

export function setSessionCookie(res, token, maxAgeSeconds) {
  const secure = process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie", cookie.serialize(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: maxAgeSeconds
  }));
}

export function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie", cookie.serialize(COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0
  }));
}

export async function getSessionUser(req) {
  const token = getCookieToken(req);
  if (!token) return null;

  const rows = await sql`
    select u.id, u.email
    from sessions s
    join users u on u.id = s.user_id
    where s.token = ${token}
      and s.expires_at > now()
    limit 1
  `;
  return rows[0] || null;
}

export async function createSession(res, userId) {
  const token = randomToken();
  const days = 14;
  const maxAgeSeconds = 60 * 60 * 24 * days;

  await sql`
    insert into sessions (user_id, token, expires_at)
    values (${userId}, ${token}, now() + (${days} || ' days')::interval)
  `;

  setSessionCookie(res, token, maxAgeSeconds);
}

export async function destroySession(req, res) {
  const token = getCookieToken(req);
  if (token) {
    await sql`delete from sessions where token = ${token}`;
  }
  clearSessionCookie(res);
}
