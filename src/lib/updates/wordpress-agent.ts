import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { z } from "zod";
import { ApiError } from "../http";
import { withHostingCredentials } from "../hosting-connections";
import { hostingInstallation } from "../hosting-discovery";
import type { HostingConnection } from "../types";
import type { UpdateTarget } from "./types";
import { readUpdateSource } from "./storage";
import { wordpressPlanPhp, wordpressPlanSchema, type WordPressUpdatePlan } from "./wordpress-security";
import { wordpressAgentPackageVersion, agentFileHash, assertManagedAgentFile } from "./wordpress-agent-package";
import { database, transaction } from "../db";
import { isPostgres } from "../storage";

export const agentProtocol = "vigie-local-v1" as const;
export type LocalAgentSettings = { protocol: typeof agentProtocol; directory: string; secret: string; phpBinary: string; wpBinary: string; environment: "production" | "staging"; ready: boolean; bundleVersion?: string; fileHashes?: Record<string, string>; previousFileHashes?: Record<string, string>; previousPhpBinary?: string };
export type AgentOperation = "inspect" | "backup" | "update" | "restore";
export function agentDirectory(root: string, username: string) {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(username) || !root.startsWith(`/home/${username}/`) || posix.normalize(root) !== root || /[\x00-\x1f]/.test(root)) throw new ApiError("Répertoire WordPress non autorisé.");
  const directory = `/home/${username}/.vigie-agent/${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
  if (directory.startsWith(root + "/") || root.startsWith(`/home/${username}/.vigie-agent/`)) throw new ApiError("L’agent doit rester hors de la racine du site.");
  return directory;
}
export function signAgentPayload(value: unknown, secret: string) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new ApiError("Clé d’agent invalide.");
  const payload = Buffer.from(JSON.stringify(value)).toString("base64");
  return { payload, signature: createHmac("sha256", Buffer.from(secret, "hex")).update(`vigie-agent-v1\n${payload}`).digest("hex") };
}
export function openAgentPayload(raw: unknown, secret: string): unknown {
  const value = z.object({ payload: z.string().max(700_000), signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw);
  const expected = createHmac("sha256", Buffer.from(secret, "hex")).update(`vigie-agent-v1\n${value.payload}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(value.signature, "hex"))) throw new ApiError("Signature de l’agent local invalide.");
  return JSON.parse(Buffer.from(value.payload, "base64").toString("utf8"));
}
const resultSchema = z.object({ id: z.string().uuid(), runId: z.string().uuid(), operation: z.enum(["inspect", "backup", "update", "restore"]), root: z.string(), stage: z.enum(["running", "completed", "failed"]), startedAt: z.number().int(), finishedAt: z.number().int().optional(), error: z.string().regex(/^[a-z_]{1,80}$/).optional(), result: z.record(z.string(), z.unknown()).optional() });
export interface AgentFiles {
  read(file: string): Promise<string | null>;
  write(file: string, content: string): Promise<void>;
}
// A caller supplies a trusted installation; neither HTTP clients nor jobs choose API paths.
export function cpanelAgentFiles(connection: HostingConnection & { secret: string }, directory: string, transport: typeof fetch = fetch) {
  const allowedDirectory = `/home/${connection.username}/.vigie-agent/`;
  if (!directory.startsWith(allowedDirectory) || !/^[a-f0-9]{16}$/.test(directory.slice(allowedDirectory.length))) throw new ApiError("Dossier d’agent invalide.");
  const authorization = connection.authMode === "token" ? `cpanel ${connection.username}:${connection.secret}` : `Basic ${Buffer.from(`${connection.username}:${connection.secret}`).toString("base64")}`;
  async function call(path: string, body?: FormData | URLSearchParams) {
    const response = await transport(connection.endpoint + path, { method: body ? "POST" : "GET", headers: { Authorization: authorization }, ...(body ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(30_000), cache: "no-store" });
    if (!response.ok) throw new ApiError("L’accès cPanel de l’agent local a échoué.", 502);
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 2_000_000) throw new ApiError("Réponse cPanel trop volumineuse.", 502);
    const data = JSON.parse(raw), envelope = data.cpanelresult || data.result || data;
    if (envelope.status === 0 || envelope.event?.result === 0 || (Array.isArray(envelope.errors) && envelope.errors.length)) throw new ApiError("cPanel a refusé l’opération de l’agent local.", 502);
    return envelope.data;
  }
  function fileParts(file: string) {
    if (!/^(?:(?:jobs|results)\/[a-f0-9-]{36}\.json|php\.d\/10-phar\.ini|bootstrap\.php|config\.json|heartbeat\.json|readiness\.json|agent\.php|plan\.php)$/.test(file)) throw new ApiError("Fichier d’agent non autorisé.");
    return { dir: posix.dirname(directory + "/" + file), name: posix.basename(file) };
  }
  const api2 = (module: "Fileman" | "Cron", func: "mkdir" | "listcron" | "add_line" | "remove_line", params: Record<string, string> = {}) => call("/json-api/cpanel", new URLSearchParams({ cpanel_jsonapi_user: connection.username, cpanel_jsonapi_apiversion: "2", cpanel_jsonapi_module: module, cpanel_jsonapi_func: func, ...params }));
  return {
    async read(file: string) {
      const { dir, name } = fileParts(file);
      const listing = await call("/execute/Fileman/list_files?" + new URLSearchParams({ dir, include_mime: "0", include_hash: "0", include_permissions: "0", show_hidden: "1" }));
      const entries = z.array(z.object({ file: z.string(), type: z.string() })).parse(Array.isArray(listing) ? listing : listing?.files);
      const entry = entries.find(item => item.file === name);
      if (!entry) return null;
      if (entry.type !== "file") throw new ApiError("Le fichier d’agent ne doit pas être un lien.");
      const data = await call("/execute/Fileman/get_file_content?" + new URLSearchParams({ dir, file: name, charset: "utf-8" }));
      const content = typeof data === "string" ? data : data?.content;
      if (typeof content !== "string") throw new ApiError("Fichier d’agent illisible.");
      return content;
    },
    async write(file: string, content: string) {
      const { dir, name } = fileParts(file);
      const form = new FormData(); form.set("dir", dir); form.set("overwrite", "1"); form.set("file-1", new Blob([content]), name);
      await call("/execute/Fileman/upload_files", form);
      // Upload errors can hide behind HTTP 200; callers verify bytes before relying on them.
    },
    async mkdir(path: string) {
      if (![posix.dirname(directory), directory, directory + "/jobs", directory + "/results", directory + "/backups", directory + "/php.d"].includes(path)) throw new ApiError("Dossier d’agent non autorisé.");
      const find = async () => {
        const listing = await call("/execute/Fileman/list_files?" + new URLSearchParams({ dir: posix.dirname(path), include_permissions: "1", show_hidden: "1" }));
        const entries = Array.isArray(listing) ? listing : listing?.files;
        if (!Array.isArray(entries)) throw new ApiError("Le dossier privé n’a pas pu être vérifié.");
        return entries.find(item => item.file === posix.basename(path));
      };
      let current = await find();
      if (!current) {
        await api2("Fileman", "mkdir", { path: posix.dirname(path), name: posix.basename(path), permissions: "0700" });
        current = await find();
      }
      if (!current || current.type !== "dir") throw new ApiError("Un lien ou fichier occupe le dossier privé de l’agent.");
      // Real cPanel UAPI returns stat mode as a decimal integer (16832 = 040700).
      const permissions = current.octal_perms ?? current.permissions;
      const privateMode = permissions !== undefined ? /^0?700$/.test(String(permissions)) : Number.isSafeInteger(current.mode) && (current.mode & 0o7777) === 0o700;
      if (!privateMode) throw new ApiError("Le dossier de l’agent doit être privé (0700).");
    },
    async addCron(command: string, previousCommand?: string) {
      return transaction(async () => {
      // cPanel deletes by line number: serialize each complete read/edit/verify sequence per account.
      if (isPostgres()) await database().prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`vigie:agent-cron:${connection.id}`);
      const rows = await api2("Cron", "listcron");
      if (!Array.isArray(rows)) throw new ApiError("Les tâches cron n’ont pas pu être vérifiées.");
      if (!rows.some(row => row.command === command)) await api2("Cron", "add_line", { command, minute: "*", hour: "*", day: "*", month: "*", weekday: "*" });
      if (previousCommand && previousCommand !== command) {
        // Never edit unrelated account jobs or infer a line number from its array index.
        const current = await api2("Cron", "listcron");
        if (!Array.isArray(current)) throw new ApiError("Les tâches cron n’ont pas pu être vérifiées.");
        const previous = current.find(row => row.command === previousCommand);
        if (previous) {
          if (!Number.isInteger(previous.count) || previous.count < 1) throw new ApiError("L’ancienne tâche de l’agent n’a pas pu être identifiée.");
          await api2("Cron", "remove_line", { line: String(previous.count) });
        }
      }
      const saved = await api2("Cron", "listcron");
      if (!Array.isArray(saved) || !saved.some(row => row.command === command) || (previousCommand && previousCommand !== command && saved.some(row => row.command === previousCommand))) throw new ApiError("La tâche cron de l’agent n’a pas été confirmée.");
      });
    },
    async assertPrivateLocation() {
      const rows = await call("/execute/DomainInfo/domains_data?format=list");
      const roots = z.array(z.object({ documentroot: z.string() })).min(1).parse(rows);
      if (roots.some(row => directory === posix.normalize(row.documentroot) || directory.startsWith(posix.normalize(row.documentroot).replace(/\/$/, "") + "/"))) throw new ApiError("Le dossier privé de l’agent est exposé par un domaine.");
    },
  };
}
export async function agentBundle(root: string, username: string, webPhp: string, environment: "production" | "staging", previous?: LocalAgentSettings) {
  const match = webPhp.match(/^(8\.[1-9])\.\d+/);
  if (!match) throw new ApiError("L’agent local nécessite PHP 8.1 ou plus récent.");
  const settings: LocalAgentSettings = previous ? { ...previous, ready: false } : { protocol: agentProtocol, directory: agentDirectory(root, username), secret: randomBytes(32).toString("hex"), phpBinary: `/opt/alt/php${match[1].replace(".", "")}/usr/bin/php`, wpBinary: "/usr/local/bin/wp", environment, ready: false };
  if (settings.directory !== agentDirectory(root, username) || settings.environment !== environment) throw new ApiError("Le rattachement de l’agent a changé.");
  const phpBinary = `/opt/alt/php${match[1].replace(".", "")}/usr/bin/php`;
  if (settings.phpBinary !== phpBinary) { settings.previousPhpBinary = settings.phpBinary; settings.phpBinary = phpBinary; }
  if (previous?.bundleVersion !== wordpressAgentPackageVersion) settings.previousFileHashes = previous?.fileHashes || previous?.previousFileHashes;
  settings.bundleVersion = wordpressAgentPackageVersion;
  const worker = await readFile(join(process.cwd(), "connectors/wordpress/local-agent.php"), "utf8");
  const bootstrap = await readFile(join(process.cwd(), "connectors/wordpress/agent-bootstrap.php"), "utf8");
  const plan = "<?php\n" + wordpressPlanPhp() + "\n";
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const config = JSON.stringify({ protocol: agentProtocol, root, secret: settings.secret, phpBinary: settings.phpBinary, wpBinary: settings.wpBinary, environment, workerSha256: hash(worker), planSha256: hash(plan) });
  const files = { "agent.php": worker, "plan.php": plan, "config.json": config, "bootstrap.php": bootstrap, "php.d/10-phar.ini": "extension=phar.so\n" };
  settings.fileHashes = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, agentFileHash(text)]));
  const cron = `${settings.phpBinary} '${settings.directory}/bootstrap.php' '${settings.directory}/config.json' >/dev/null 2>&1`;
  const previousCrons = [...new Set([settings.phpBinary, settings.previousPhpBinary].filter((value): value is string => !!value).flatMap(binary => ["agent.php", "bootstrap.php"].map(file => `${binary} '${settings.directory}/${file}' '${settings.directory}/config.json' >/dev/null 2>&1`)))].filter(value => value !== cron);
  return { settings, files, cron, previousCrons };
}
export async function provisionLocalAgent(target: UpdateTarget, settings: LocalAgentSettings, webPhp: string) {
  const installation = await hostingInstallation(target.remoteId);
  if (installation.documentRoot !== target.root || installation.project?.id !== target.projectId || installation.missingSince || installation.kind !== "wordpress") throw new ApiError("Le rattachement WordPress a changé.");
  const environment = installation.suggestedEnvironment;
  await withHostingCredentials(target.connectionId, async connection => {
    const bundle = await agentBundle(target.root, connection.username, webPhp, environment, settings);
    const files = cpanelAgentFiles(connection, settings.directory);
    await files.assertPrivateLocation();
    // Managed upgrades retain ownership, keys, jobs and backups. Unknown remote edits are refused.
    await files.mkdir(posix.dirname(settings.directory));
    await files.mkdir(settings.directory);
    await files.mkdir(settings.directory + "/php.d");
    for (const name of Object.keys(bundle.files) as (keyof typeof bundle.files)[]) {
      const current = await files.read(name);
      assertManagedAgentFile(name, current, bundle.files[name], bundle.files["config.json"], settings.previousFileHashes, settings.previousPhpBinary);
    }
    for (const dir of ["jobs", "results", "backups"]) await files.mkdir(settings.directory + "/" + dir);
    const startedAt = Date.now() / 1000;
    // Publish the new checksums last; a concurrent cron fails closed during a partial upload.
    for (const name of [...Object.keys(bundle.files).filter(name => name !== "config.json"), "config.json"] as (keyof typeof bundle.files)[]) { const source = bundle.files[name]; await files.write(name, source); if (await files.read(name) !== source) throw new ApiError("Le dépôt de l’agent n’a pas été vérifié."); }
    await files.addCron(bundle.cron);
    for (const previous of bundle.previousCrons) await files.addCron(bundle.cron, previous);
    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
      const heartbeat = await files.read("heartbeat.json");
      if (heartbeat) {
        const value = z.object({ protocol: z.literal(agentProtocol), root: z.string(), php: z.string(), time: z.number().int() }).parse(openAgentPayload(JSON.parse(heartbeat), settings.secret));
        if (value.root !== target.root || value.php !== webPhp) throw new ApiError("Le PHP ou le rattachement de l’agent ne correspond pas au site.");
        if (Math.abs(Date.now() / 1000 - value.time) > 120) { await new Promise(resolve => setTimeout(resolve, 3000)); continue; }
        const raw = await files.read("readiness.json");
        if (!raw) { await new Promise(resolve => setTimeout(resolve, 3000)); continue; }
        const inspected = z.object({ protocol: z.literal(agentProtocol), root: z.string(), php: z.string(), ready: z.boolean(), time: z.number().int(), error: z.string().regex(/^[a-z_]{1,80}$/).optional(), eligibility: z.object({ multisite: z.boolean(), fileModsDisabled: z.boolean(), home: z.string().url() }).optional() }).parse(openAgentPayload(JSON.parse(raw), settings.secret));
        if (inspected.root !== target.root || inspected.php !== webPhp) throw new ApiError("Le contrôle initial de l’agent ne correspond pas au WordPress attendu.");
        if (inspected.time < startedAt - 2 || Math.abs(Date.now() / 1000 - inspected.time) > 300) { await new Promise(resolve => setTimeout(resolve, 3000)); continue; }
        if (!inspected.ready) throw new ApiError(`L’agent est installé, mais WordPress/WP-CLI ne démarre pas correctement (${inspected.error || "wordpress_probe_failed"}).`);
        const eligibility = inspected.eligibility;
        if (!eligibility || eligibility.multisite || eligibility.fileModsDisabled || !target.url || new URL(eligibility.home).hostname.replace(/^www\./, "") !== new URL(target.url).hostname.replace(/^www\./, "")) throw new ApiError("Le contrôle initial de l’agent ne correspond pas au WordPress attendu.");
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    throw new ApiError("La tâche cron de l’agent n’a pas encore confirmé son démarrage. La configuration est conservée pour vérification.");
  });
}
export function agentRequestId(runId: string, operation: AgentOperation) {
  z.string().uuid().parse(runId);
  const bytes = createHash("sha256").update(`${runId}:${operation}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}
export async function assertAgentRunStopped(files: AgentFiles, settings: LocalAgentSettings, root: string, runId: string) {
  for (const operation of ["inspect", "backup", "update", "restore"] as const) {
    const id = agentRequestId(runId, operation);
    if (!await files.read(`jobs/${id}.json`)) continue;
    const raw = await files.read(`results/${id}.json`);
    if (!raw) throw new ApiError("Une demande de l’agent local reste en attente. Vérifiez son arrêt avant de clôturer.", 409);
    const result = resultSchema.parse(openAgentPayload(JSON.parse(raw), settings.secret));
    if (result.id !== id || result.runId !== runId || result.root !== root || result.operation !== operation || result.stage === "running") throw new ApiError("L’arrêt de l’agent local n’est pas confirmé. Le verrou est conservé.", 409);
  }
}
export async function localAgentOperation(files: AgentFiles, settings: LocalAgentSettings, root: string, runId: string, operation: AgentOperation, extra: { plan?: WordPressUpdatePlan; webPhp?: string; confirmDataLoss?: boolean } = {}, options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; requestId?: string } = {}) {
  z.enum(["inspect", "backup", "update", "restore"]).parse(operation);
  extra = z.object({ plan: wordpressPlanSchema.optional(), webPhp: z.string().regex(/^\d+\.\d+\.\d+[a-zA-Z0-9.+_-]*$/).optional(), confirmDataLoss: z.boolean().optional() }).strict().parse(extra);
  if (options.requestId && operation !== "restore") throw new ApiError("Seule une nouvelle décision de restauration peut utiliser un autre identifiant de demande.");
  const id = options.requestId ? z.string().uuid().parse(options.requestId) : agentRequestId(runId, operation);
  const job = { id, runId, root, operation, issuedAt: Math.floor(Date.now() / 1000), ...extra };
  const expected = JSON.stringify(signAgentPayload(job, settings.secret));
  const existing = await files.read(`jobs/${id}.json`);
  if (!existing) {
    await files.write(`jobs/${id}.json`, expected);
    if (await files.read(`jobs/${id}.json`) !== expected) throw new ApiError("La demande n’a pas été confirmée sur l’hébergement.");
  } else {
    const original = openAgentPayload(JSON.parse(existing), settings.secret) as typeof job;
    if (JSON.stringify({ ...original, issuedAt: 0 }) !== JSON.stringify({ ...job, issuedAt: 0 })) throw new ApiError("Une demande différente utilise déjà cet identifiant.", 409);
  }
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  while (Date.now() < deadline) {
    const raw = await files.read(`results/${id}.json`);
    if (raw) {
      const value = resultSchema.parse(openAgentPayload(JSON.parse(raw), settings.secret));
      if (value.id !== id || value.runId !== runId || value.root !== root || value.operation !== operation) throw new ApiError("La réponse de l’agent ne correspond pas à cette opération.");
      if (value.stage === "failed") throw new ApiError(operation === "inspect" ? `L’agent répond, mais le contrôle WordPress/WP-CLI échoue (${value.error || "agent_failed"}).` : `L’agent local a arrêté l’opération (${value.error || "agent_failed"}). Les sauvegardes sont conservées.`);
      if (value.stage === "completed") return value.result || {};
    }
    await sleep(options.pollMs ?? 5000);
  }
  throw new ApiError("L’agent local ne confirme pas la fin de l’opération. Ne relancez pas : vérifiez son suivi et les sauvegardes.", 504);
}
export async function withLocalWordPressAgent<T>(target: UpdateTarget, callback: (operation: (runId: string, name: AgentOperation, extra?: { plan?: WordPressUpdatePlan; webPhp?: string; confirmDataLoss?: boolean }) => Promise<Record<string, unknown>>, settings: LocalAgentSettings) => Promise<T>) {
  const source = await readUpdateSource(target.id);
  const settings = source?.settings.localAgent;
  if (!settings?.ready) throw new ApiError("L’agent local WordPress n’est pas configuré.");
  const site = await hostingInstallation(target.remoteId);
  if (site.documentRoot !== target.root || site.project?.id !== target.projectId || site.missingSince || site.kind !== "wordpress" || site.suggestedEnvironment !== settings.environment) throw new ApiError("Le rattachement WordPress a changé.");
  if (settings.environment === "production" && process.env.VIGIE_WORDPRESS_AGENT_PRODUCTION_ENABLED !== "1") throw new ApiError("Les mises à jour de production par l’agent local ne sont pas encore activées.");
  if (settings.bundleVersion !== wordpressAgentPackageVersion) throw new ApiError("L’agent doit terminer sa mise à niveau automatique avant de lancer une mise à jour WordPress.");
  return withHostingCredentials(target.connectionId, async connection => {
    if (settings.directory !== agentDirectory(target.root, connection.username)) throw new ApiError("Dossier d’agent inattendu.");
    const files = cpanelAgentFiles(connection, settings.directory);
    return callback((runId, name, extra) => localAgentOperation(files, settings, target.root, runId, name, extra), settings);
  });
}
export function agentPlan(raw: unknown): WordPressUpdatePlan { return wordpressPlanSchema.parse(raw); }
