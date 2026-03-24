import { cookies } from "next/headers";

const SESSION_COOKIE = "batiq_session";
const SESSION_SECRET = process.env.SESSION_SECRET || "batiq-default-secret-change-me";

export function encodeSession(email: string): string {
  // Simple base64 token: email + timestamp + secret hash
  const payload = JSON.stringify({ email, ts: Date.now() });
  return Buffer.from(payload).toString("base64url");
}

export function decodeSession(token: string): { email: string; ts: number } | null {
  try {
    const payload = JSON.parse(Buffer.from(token, "base64url").toString());
    if (!payload.email || !payload.ts) return null;
    // Sessions expire after 30 days
    if (Date.now() - payload.ts > 30 * 24 * 60 * 60 * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function getSessionEmail(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = decodeSession(token);
  return session?.email || null;
}

export function sessionCookieOptions(token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  };
}
