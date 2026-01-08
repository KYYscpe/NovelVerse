import nodemailer from "nodemailer";

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is missing`);
  return v;
}

export function getTransport() {
  const user = must("GMAIL_USER");
  const pass = must("GMAIL_APP_PASSWORD");

  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass }
  });
}

export async function sendVerificationCode({ to, code }) {
  const from = must("MAIL_FROM");
  const site = process.env.SITE_NAME || "NovelVerse";

  const transport = getTransport();
  await transport.sendMail({
    from,
    to,
    subject: `${site} - Kode Verifikasi`,
    text:
`Kode verifikasi kamu: ${code}

Kode berlaku 10 menit.
Kalau kamu tidak meminta kode ini, abaikan email ini.`,
  });
}
