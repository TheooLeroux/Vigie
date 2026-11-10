import { sign } from "node:crypto";
import { z } from "zod";

export async function githubBackupToken(repository: string, transport = fetch) {
  const parts = repository.split("/");
  const appId = process.env.VIGIE_BACKUP_GITHUB_APP_ID;
  const key = process.env.VIGIE_BACKUP_GITHUB_APP_KEY;
  if (parts.length !== 2 || parts.some(part => !/^[\w.-]+$/.test(part) || part === "." || part === "..")) {
    throw new Error("Dépôt GitHub de sauvegarde invalide.");
  }
  if (!appId || !/^\d+$/.test(appId) || !key) throw new Error("Application GitHub de sauvegarde non configurée.");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = encode({ alg: "RS256", typ: "JWT" }) + "." + encode({ iss: appId, iat: now - 60, exp: now + 540 });
  const jwt = payload + "." + sign("RSA-SHA256", Buffer.from(payload), key).toString("base64url");
  async function api(path: string, body?: object) {
    const response = await transport("https://api.github.com" + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: "Bearer " + jwt, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("L’application GitHub de sauvegarde ne peut pas lire ce dépôt (" + response.status + ").");
    return response.json();
  }
  const installation = z.object({ id: z.number().int().positive() }).parse(
    await api("/repos/" + parts.map(encodeURIComponent).join("/") + "/installation"),
  );
  const permissions = z.object({ contents: z.literal("read"), metadata: z.literal("read").optional() }).strict();
  const { token } = z.object({ token: z.string().min(1), permissions }).parse(
    await api("/app/installations/" + installation.id + "/access_tokens", {
      repositories: [parts[1]], permissions: { contents: "read" },
    }),
  );
  return token;
}
