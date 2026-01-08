import { getSessionUser } from "../../lib/auth.js";

export default async function handler(req, res) {
  const user = await getSessionUser(req);
  res.status(200).json({ user });
}
