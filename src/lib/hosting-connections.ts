import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { log, transaction } from "./db";
import { ApiError } from "./http";
import {
  hostingConnectionSchema,
  probeO2switch,
  type ProbeResult,
} from "./connectors/o2switch";
import type { HostingConnection } from "./types";
import { hostingStorage } from "./hosting-storage";
import { collectO2switchInstallations } from "./connectors/o2switch-discovery";
import {
  applyDiscoverySnapshot,
  hostingDiscovery,
  recordDiscoveryFailure,
} from "./hosting-discovery";

type Stored = { id: string; data: string; secret_cipher: string | null };
type Metadata = Omit<HostingConnection, "configured">;
// Server-side connector capability. Never return its result from a public API.
export async function withHostingCredentials<T>(
  id: string,
  read: (input: HostingConnection & { secret: string }) => Promise<T>,
) {
  const stored = (await row(id)),
    metadata: Metadata = JSON.parse(stored.data);
  if (!stored.secret_cipher)
    throw new ApiError("Le compte o2switch n’est pas configuré.");
  return read({
    ...publicConnection(metadata, true),
    secret: decrypt(stored.secret_cipher, metadata),
  });
}
async function store() {
  return (await hostingStorage());
}
function key() {
  const value = process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(value))
    throw new ApiError(
      "La clé privée de chiffrement des connexions n’est pas configurée sur le serveur.",
      503,
    );
  return Buffer.from(value, "hex");
}
function context(connection: Metadata) {
  return Buffer.from(
    `vigie:hosting:v1:live:${connection.id}:${connection.endpoint}:${connection.username}:${connection.authMode}`,
  );
}
function encrypt(secret: string, connection: Metadata) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(context(connection));
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    value: encrypted.toString("base64"),
  });
}
function decrypt(encrypted: string, connection: Metadata) {
  const secretKey = key();
  try {
    const data = JSON.parse(encrypted);
    if (data.v !== 1) throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      secretKey,
      Buffer.from(data.iv, "base64"),
    );
    decipher.setAAD(context(connection));
    decipher.setAuthTag(Buffer.from(data.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(data.value, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ApiError(
      "Le secret de cette connexion ne peut pas être déchiffré. Renseignez un nouveau jeton API.",
      503,
    );
  }
}
async function row(id: string): Promise<Stored> {
  const result = (await (await store())
    .prepare(
      "SELECT id,data,secret_cipher FROM hosting_connections WHERE workspace='live' AND id=?",
    )
    .get(id)) as Stored | undefined;
  if (!result) throw new ApiError("Connexion introuvable.", 404);
  return result;
}
function publicConnection(
  data: Metadata,
  configured: boolean,
): HostingConnection {
  return { ...data, configured };
}
export async function hostingConnections(): Promise<HostingConnection[]> {
  return (
    (await (await store())
      .prepare(
        "SELECT data,secret_cipher IS NOT NULL AS configured FROM hosting_connections WHERE workspace='live' ORDER BY json_extract(data,'$.name')",
      )
      .all()) as { data: string; configured: number }[]
  ).map((r) => publicConnection(JSON.parse(r.data), Boolean(r.configured)));
}
export async function saveHostingConnection(
  raw: unknown,
  id?: string,
): Promise<HostingConnection> {
  const input = hostingConnectionSchema.parse(raw);
  return (await transaction(async () => {
    const previous = id ? (await row(id)) : null;
    const current: Metadata | null = previous
      ? JSON.parse(previous.data)
      : null;
    const duplicate = (await (await store())
      .prepare(
        "SELECT id FROM hosting_connections WHERE workspace='live' AND endpoint=? AND username=? AND id<>?",
      )
      .get(input.endpoint, input.username, id || ""));
    if (duplicate)
      throw new ApiError("Ce compte o2switch est déjà enregistré.", 409);
    const changed =
      current &&
      (current.endpoint !== input.endpoint ||
        current.username !== input.username ||
        current.authMode !== input.authMode);
    if (changed && previous?.secret_cipher && !input.secret)
      throw new ApiError(
        "Renseignez le secret correspondant au nouveau serveur, compte ou mode de connexion.",
      );
    const now = new Date().toISOString();
    const reset = !current || Boolean(changed) || Boolean(input.secret);
    const connection: Metadata = {
      id: current?.id || randomUUID(),
      name: input.name,
      provider: "o2switch",
      endpoint: input.endpoint,
      username: input.username,
      authMode: input.authMode,
      status: reset
        ? input.secret
          ? "untested"
          : "unconfigured"
        : current.status,
      lastCheckedAt: reset ? null : current.lastCheckedAt,
      lastSuccessAt: changed ? null : current?.lastSuccessAt || null,
      error: reset ? null : current.error,
      domains: changed ? [] : current?.domains || [],
      createdAt: current?.createdAt || now,
      updatedAt: now,
    };
    const cipher = input.secret
      ? encrypt(input.secret, connection)
      : previous?.secret_cipher || null;
    (await (await store())
      .prepare(
        "INSERT INTO hosting_connections(id,workspace,endpoint,username,data,secret_cipher) VALUES (?,'live',?,?,?,?) ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint,username=excluded.username,data=excluded.data,secret_cipher=excluded.secret_cipher",
      )
      .run(
        connection.id,
        connection.endpoint,
        connection.username,
        JSON.stringify(connection),
        cipher,
      ));
    (await log(
      "live",
      current ? "hosting.updated" : "hosting.created",
      `Connexion « ${connection.name} » ${current ? "modifiée" : "ajoutée"}.`,
    ));
    return publicConnection(connection, Boolean(cipher));
  }));
}
const running = new Set<string>();
export async function testHostingConnection(
  id: string,
  transport: typeof fetch = fetch,
): Promise<HostingConnection> {
  const stored = (await row(id)),
    connection: Metadata = JSON.parse(stored.data);
  if (!stored.secret_cipher)
    throw new ApiError(
      "Renseignez d’abord un jeton API dans les paramètres de cette connexion.",
    );
  if (running.has(id))
    throw new ApiError(
      "Une vérification est déjà en cours pour ce compte.",
      409,
    );
  if (
    connection.lastCheckedAt &&
    Date.now() - new Date(connection.lastCheckedAt).getTime() < 10_000
  )
    throw new ApiError(
      "Attendez quelques secondes avant de relancer la vérification.",
      429,
    );
  const secret = decrypt(stored.secret_cipher, connection);
  running.add(id);
  try {
    const result = await probeO2switch({ ...connection, secret }, transport);
    return recordHostingProbe(id, result, stored);
  } finally {
    running.delete(id);
  }
}
async function recordHostingProbe(
  id: string,
  result: ProbeResult,
  expected: Stored,
  withinTransaction = false,
): Promise<HostingConnection> {
  const commit = async () => {
    const current = (await row(id));
    if (
      current.data !== expected.data ||
      current.secret_cipher !== expected.secret_cipher
    )
      throw new ApiError(
        "La configuration a changé pendant la vérification. Relancez-la.",
        409,
      );
    const connection: Metadata = JSON.parse(current.data),
      now = new Date().toISOString();
    const updated: Metadata = {
      ...connection,
      status: result.ok ? "connected" : "error",
      lastCheckedAt: now,
      lastSuccessAt: result.ok ? now : connection.lastSuccessAt,
      error: result.ok
        ? null
        : {
            code: result.code,
            message: result.message,
            ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
          },
      domains: result.ok ? result.domains : connection.domains,
      updatedAt: now,
    };
    (await (await store())
      .prepare("UPDATE hosting_connections SET data=? WHERE id=?")
      .run(JSON.stringify(updated), id));
    (await log(
      "live",
      result.ok ? "hosting.connected" : "hosting.failed",
      result.ok
        ? `Connexion « ${connection.name} » validée : ${result.domains.length} domaines lus.`
        : `Connexion « ${connection.name} » refusée ou indisponible (${result.code}).`,
    ));
    return publicConnection(updated, Boolean(current.secret_cipher));
  };
  return withinTransaction ? (await commit()) : (await transaction(commit));
}
export async function discoverHostingConnection(
  id: string,
  transport: typeof fetch = fetch,
) {
  const stored = (await row(id)),
    connection: Metadata = JSON.parse(stored.data);
  if (!stored.secret_cipher)
    throw new ApiError(
      "Renseignez le jeton de ce compte avant de rechercher ses sites.",
    );
  if (running.has(id))
    throw new ApiError(
      "Une vérification est déjà en cours pour ce compte.",
      409,
    );
  const previous = (await hostingDiscovery(id));
  if (
    previous.lastAttemptAt &&
    Date.now() - Date.parse(previous.lastAttemptAt) < 10_000
  )
    throw new ApiError(
      "Attendez quelques secondes avant de relancer la recherche.",
      429,
    );
  running.add(id);
  try {
    const result = await collectO2switchInstallations(
      { ...connection, secret: decrypt(stored.secret_cipher, connection) },
      transport,
    );
    (await transaction(async () => {
      const domains = result.installations
        .flatMap((item) => item.domains)
        .map((name) => ({
          name,
          kind:
            connection.domains.find((d) => d.name === name)?.kind ||
            ("addon" as const),
        }));
      (await recordHostingProbe(id, { ok: true, domains }, stored, true));
      (await applyDiscoverySnapshot(connection, result));
    }));
    return {
      connection: (await hostingConnections()).find((c) => c.id === id)!,
      discovery: (await hostingDiscovery(id)),
    };
  } catch (error) {
    const message =
      error instanceof ApiError
        ? error.message
        : "La recherche a échoué. Le dernier relevé a été conservé.";
    (await transaction(async () => {
      const current = (await row(id));
      if (
        current.data === stored.data &&
        current.secret_cipher === stored.secret_cipher
      )
        (await recordHostingProbe(
          id,
          { ok: false, code: "api", message },
          stored,
          true,
        ));
      (await recordDiscoveryFailure(connection, message));
    }));
    throw error instanceof ApiError ? error : new ApiError(message, 502);
  } finally {
    running.delete(id);
  }
}
export async function disconnectHostingConnection(id: string) {
  return (await transaction(async () => {
    const stored = (await row(id)),
      connection: Metadata = JSON.parse(stored.data);
    const updated: Metadata = {
      ...connection,
      status: "unconfigured",
      error: null,
      lastCheckedAt: null,
      lastSuccessAt: null,
      domains: [],
      updatedAt: new Date().toISOString(),
    };
    (await (await store())
      .prepare(
        "UPDATE hosting_connections SET data=?,secret_cipher=NULL WHERE id=?",
      )
      .run(JSON.stringify(updated), id));
    (await log(
      "live",
      "hosting.disconnected",
      `Secret de la connexion « ${connection.name} » retiré de Vigie.`,
    ));
    return publicConnection(updated, false);
  }));
}
