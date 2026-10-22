export type AuthIdentity = { email: string; emailVerified: boolean };

export function allowedGoogleEmails(): Set<string> {
  return new Set(
    (process.env.VIGIE_ALLOWED_GOOGLE_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowedGoogleUser(user: AuthIdentity): boolean {
  return (
    user.emailVerified === true &&
    allowedGoogleEmails().has(user.email.trim().toLowerCase())
  );
}

export function authConfiguration() {
  const missing: string[] = [];
  if (!process.env.GOOGLE_CLIENT_ID?.trim()) missing.push("GOOGLE_CLIENT_ID");
  if (!process.env.GOOGLE_CLIENT_SECRET?.trim())
    missing.push("GOOGLE_CLIENT_SECRET");
  if (
    !process.env.BETTER_AUTH_SECRET ||
    process.env.BETTER_AUTH_SECRET.length < 32
  )
    missing.push("BETTER_AUTH_SECRET");
  if (!allowedGoogleEmails().size) missing.push("VIGIE_ALLOWED_GOOGLE_EMAILS");
  const baseUrl = process.env.BETTER_AUTH_URL || "http://127.0.0.1:3001";
  try {
    const url = new URL(baseUrl);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !["http:", "https:"].includes(url.protocol)
    )
      missing.push("BETTER_AUTH_URL");
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(url.hostname)
    )
      missing.push("BETTER_AUTH_URL");
  } catch {
    missing.push("BETTER_AUTH_URL");
  }
  return {
    ready: missing.length === 0,
    missing,
    baseUrl: baseUrl.replace(/\/$/, ""),
    callbackUrl: `${baseUrl.replace(/\/$/, "")}/api/auth/callback/google`,
  };
}
