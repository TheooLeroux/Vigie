import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { backupHostingInstallations } from "../src/lib/hosting-discovery";
import { hostingConnections } from "../src/lib/hosting-connections";
import { claimHostingObservation } from "../src/lib/hosting-storage";
import { cleanupAbandonedBackupUploads, runBackup } from "../src/lib/backups";
import { backupLeaseMs } from "../src/lib/backup-store";
import { runCommand } from "../src/lib/updates/process";
import { shellQuote } from "../src/lib/updates/wordpress";
import { allowBackupSsh } from "./backup-o2switch-firewall";

const maxCaptureBytes = 20 * 1024 ** 3;
type Operation = "preflight" | "database" | "files";
type SshAccount = { host: string; username: string };

export function wordpressCaptureScript(root: string, domain: string, operation: Operation, aliases: string[] = []) {
  const origins = [domain, ...aliases].flatMap(host => ["https://" + host, "http://" + host]);
  const allowedUrls = origins.flatMap(origin => [shellQuote(origin), shellQuote(origin + "/") + "*"]).join("|");
  return String.raw`set -euo pipefail
umask 077
fail() { printf 'VIGIE_BACKUP_ERROR=%s\n' "$1" >&2; exit 1; }
root=${shellQuote(root)}
operation=${shellQuote(operation)}
test "$(realpath -- "$root")" = "$root" || fail root
test -f "$root/wp-config.php" && test -f "$root/index.php" && test -d "$root/wp-content" || fail root
test ! -e "$root/.maintenance" || fail busy
command -v wp >/dev/null || fail wp_cli
wp_site() { wp --path="$root" --skip-plugins --skip-themes --skip-packages --quiet "$@"; }
query() { wp_site db query "$1" --batch --skip-column-names </dev/null; }

prefix=$(wp_site config get table_prefix --type=variable) || fail database
[[ "$prefix" =~ ^[a-zA-Z0-9_]+$ ]] || fail database
# Read the database directly so WordPress plugins and themes are not loaded.
site_url=$(query "SELECT option_value FROM $prefix""options WHERE option_name='home'") || fail site
case "$site_url" in
  ${allowedUrls}) ;;
  *) fail site ;;
esac

if wp_site config has WP_CONTENT_DIR --type=constant || wp_site config has UPLOADS --type=constant; then fail layout; fi
upload_path=$(query "SELECT option_value FROM $prefix""options WHERE option_name='upload_path'") || fail layout
case "$upload_path" in ""|wp-content/uploads|wp-content/uploads/) ;; *) fail layout ;; esac

if test "$operation" != database; then
  special=$(find "$root" ! -type f ! -type d -print -quit) || fail files
  test -z "$special" || fail special_files
fi

if test "$operation" != files; then
  table_rows=$(query "SELECT TABLE_NAME, COALESCE(ENGINE, 'VIEW'), COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND LEFT(BINARY TABLE_NAME, CHAR_LENGTH('$prefix'))=BINARY '$prefix' ORDER BY TABLE_NAME") || fail database
  table_list=
  table_count=0
  database_bytes=0
  while IFS=$'\t' read -r table engine bytes; do
    [[ "$table" =~ ^[a-zA-Z0-9_]+$ ]] && [[ "$bytes" =~ ^[0-9]+$ ]] || fail database
    test "$table" != "$prefix""blogs" || fail layout
    test "$engine" = InnoDB || fail engine
    if test -n "$table_list"; then table_list="$table_list,"; fi
    table_list="$table_list$table"
    table_count=$((table_count + 1))
    database_bytes=$((database_bytes + bytes))
  done <<< "$table_rows"
  for required in options posts postmeta users; do
    case ",$table_list," in *,"$prefix$required",*) ;; *) fail database ;; esac
  done
fi

case "$operation" in
  preflight)
    files_bytes=$(du -sb -- "$root" | cut -f1) || fail files
    printf '{"filesBytes":%s,"databaseBytesEstimate":%s,"tables":%s}\n' "$files_bytes" "$database_bytes" "$table_count"
    ;;
  database)
    wp_site db export - --tables="$table_list" --single-transaction --skip-lock-tables --quick --hex-blob --add-drop-table --dump-date </dev/null || fail database
    ;;
  files)
    # Full root, including hidden files. GNU tar fails if a file changes while read.
    tar --hard-dereference -czf - -C "$root" . || fail files
    ;;
esac
`;
}

export function staticCaptureScript(root: string, operation: "preflight" | "files") {
  return String.raw`set -euo pipefail
root=${shellQuote(root)}
fail() { printf 'VIGIE_BACKUP_ERROR=%s\n' "$1" >&2; exit 1; }
test "$(realpath -- "$root")" = "$root" && test -f "$root/index.html" || fail root
dynamic=$(find "$root" \( ! -type f ! -type d -o -iname '*.php*' -o -iname '*.phtml' -o -name 'composer.json' -o -name '.env' \) -print -quit) || fail files
test -z "$dynamic" || fail static_layout
${operation === "files" ? 'tar --hard-dereference -czf - -C "$root" . || fail files' : String.raw`size=$(du -sb -- "$root" | cut -f1) || fail files
printf '{"filesBytes":%s,"databaseBytesEstimate":0,"tables":0}\n' "$size"`}
`;
}

const remoteErrors: Record<string, string> = {
  root: "racine WordPress invalide",
  busy: "site déjà en maintenance",
  wp_cli: "WP-CLI indisponible",
  special_files: "liens symboliques ou fichiers spéciaux",
  site: "domaine WordPress différent du site configuré",
  layout: "installation multisite ou dossiers WordPress non standard à qualifier",
  engine: "le périmètre SQL contient des objets autres que des tables InnoDB",
  database: "contrôle ou export de la base WordPress impossible",
  files: "lecture ou archive des fichiers impossible",
  static_layout: "la racine statique contient un lien, un fichier spécial ou du code serveur",
  account: "le compte SSH ne correspond pas au compte o2switch",
};

async function transferOverSsh(account: SshAccount, script: string, output: () => Writable, maxBytes: number, timeout: number) {
  const config = process.env.VIGIE_BACKUP_SSH_CONFIG;
  const child = spawn("ssh", [
    ...(config ? ["-F", config] : []),
    "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes", "-o", "ControlPath=none", "-o", "ConnectTimeout=20",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-l", account.username, account.host, "bash", "-s",
  ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout, killSignal: "SIGKILL" });
  let diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4096); });
  child.stdin.on("error", () => {});
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error("Le transfert SSH n’a pas démarré.")));
    child.once("close", code => {
      const reason = diagnostics.match(/(?:^|\n)VIGIE_BACKUP_ERROR=([a-z_]+)/)?.[1];
      if (code === 0) resolve();
      else if (reason && remoteErrors[reason]) reject(new Error(remoteErrors[reason]));
      else if (/host key verification failed|no .* host key is known/i.test(diagnostics)) reject(new Error("Empreinte du serveur SSH non approuvée."));
      else if (/permission denied/i.test(diagnostics)) reject(new Error("Authentification SSH refusée."));
      else if (/connection timed out|operation timed out/i.test(diagnostics)) reject(new Error("Connexion SSH expirée."));
      else reject(new Error("Le transfert SSH a échoué ou dépassé son délai."));
    });
  });
  child.stdin.end(`if [ "$(id -un)" != ${shellQuote(account.username)} ]; then printf 'VIGIE_BACKUP_ERROR=account\\n' >&2; exit 1; fi\n` + script);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) done(new Error("Le transfert dépasse la taille autorisée."));
      else done(null, chunk);
    },
  });
  const transfer = pipeline(child.stdout, limit, output());
  try {
    await Promise.all([transfer, exited]);
    return bytes;
  } catch (error) {
    child.kill("SIGKILL");
    await Promise.allSettled([transfer, exited]);
    throw error;
  }
}

async function inspectSite(account: SshAccount, script: string) {
  const chunks: Buffer[] = [];
  await transferOverSsh(account, script,
    () => new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk); done(); } }),
    4096, 5 * 60_000);
  return z.object({
    filesBytes: z.number().int().positive(),
    databaseBytesEstimate: z.number().int().nonnegative(),
    tables: z.number().int().nonnegative(),
  }).strict().parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

async function main(args: string[]) {
  const { values } = parseArgs({ args, options: {
    preflight: { type: "boolean" }, plan: { type: "boolean" }, site: { type: "string" },
  } });
  const { preflight, plan } = values;
  if (preflight && plan) throw new Error("Choisissez --preflight ou --plan.");
  const requestedDomain = values.site === undefined ? null : z.hostname().parse(values.site).toLowerCase();
  const [installations, connections] = await Promise.all([backupHostingInstallations(), hostingConnections()]);
  const accounts = new Map(connections.filter(account => account.configured).map(account => [account.id, account]));
  const targets = installations.filter(site => accounts.has(site.connectionId) && !site.missingSince &&
    !site.ignored && site.projectActive && site.suggestedEnvironment === "production" &&
    !["empty", "technical"].includes(site.kind) &&
    (!requestedDomain || [...site.domains, ...site.aliases].some(name => name.toLowerCase() === requestedDomain)));
  if (requestedDomain && targets.length !== 1) throw new Error("Le domaine demandé doit correspondre à un seul site éligible de l’inventaire.");
  if (!preflight && !plan && !requestedDomain) {
    try {
      await cleanupAbandonedBackupUploads();
    } catch (error) {
      console.error("Nettoyage des sauvegardes interrompues en échec.", error instanceof Error ? error.message : "");
      process.exitCode = 1;
    }
  }
  const firewallLeases = new Map<string, Promise<() => Promise<void>>>();
  try {
    for (const site of targets) {
      const account = accounts.get(site.connectionId)!;
      const domain = site.domains.find(name => z.hostname().safeParse(name).success)?.toLowerCase();
      const label = domain || site.id;
      let release: (() => Promise<unknown>) | null = null;
      try {
        const root = site.documentRoot;
        const host = new URL(account.endpoint).hostname;
        const base = "/home/" + account.username + "/";
        if (!domain || !/^[a-z0-9.-]+\.o2switch\.net$/i.test(host) || !/^[\w-]+$/.test(account.username) ||
            !root.startsWith(base) || root.length <= base.length || /[\x00-\x1f]/.test(root)) {
          throw new Error("Domaine, compte ou racine o2switch non reconnu.");
        }
        if (installations.some(other => other.connectionId === site.connectionId && !other.missingSince &&
            other.documentRoot.startsWith(root + "/"))) {
          throw new Error("La racine contient une autre installation de l’inventaire.");
        }
        const wordpress = site.kind === "wordpress";
        if (!wordpress && site.kind !== "static" && site.kind !== "next-static") {
          const message = "Collecte des fichiers et de la base à qualifier pour ce type de site (" + site.kind + ").";
          if (requestedDomain) throw new Error(message);
          console.warn("Sauvegarde non couverte pour " + label + ". " + message);
          continue;
        }
        if (plan) {
          console.log(JSON.stringify({ site: domain, type: site.kind, projectLinked: Boolean(site.projectId) }));
          continue;
        }
        if (process.env.VIGIE_BACKUP_MANAGE_FIREWALL === "1") {
          const lease = firewallLeases.get(account.id) ?? allowBackupSsh(account.id, host, account.username);
          firewallLeases.set(account.id, lease);
          await lease;
        }
        const ssh = { host, username: account.username };
        const aliases = [...new Set([...site.domains, ...site.aliases].map(name => name.toLowerCase()))]
          .filter(name => name !== domain && z.hostname().safeParse(name).success);
        if (preflight) {
          const report = await inspectSite(ssh, wordpress
            ? wordpressCaptureScript(root, domain, "preflight", aliases)
            : staticCaptureScript(root, "preflight"));
          console.log(JSON.stringify({ site: domain, ...report }));
          continue;
        }
        release = await claimHostingObservation("backup:o2switch:" + account.id, backupLeaseMs);
        if (!release) continue;
        const saved = await runBackup({ installationId: site.id, projectId: site.projectId, domain }, async (folder, zip) => {
          const files = join(folder, "files.tar.gz");
          const database = wordpress ? join(folder, "database.sql") : "-";
          const download = (script: string, path: string, limit: number) => transferOverSsh(ssh, script,
            () => createWriteStream(path, { mode: 0o600, flags: "wx" }), limit, 40 * 60_000);
          const sqlBytes = wordpress ? await download(wordpressCaptureScript(root, domain, "database", aliases), database, maxCaptureBytes) : 0;
          await download(wordpress ? wordpressCaptureScript(root, domain, "files", aliases) : staticCaptureScript(root, "files"),
            files, maxCaptureBytes - sqlBytes);
          await runCommand(process.env.VIGIE_BACKUP_PYTHON || (process.platform === "win32" ? "python" : "python3"),
            ["scripts/pack-site-backup.py", files, database, zip, site.projectId || "-", domain], { timeout: 30 * 60_000 });
        });
        if (saved) console.log("ZIP vérifié pour " + domain + ".");
      } catch (error) {
        console.error("Sauvegarde " + label + " en échec.", error instanceof Error ? error.message : "");
        process.exitCode = 1;
      } finally {
        await release?.();
      }
    }
  } finally {
    for (const lease of firewallLeases.values()) {
      const release = await lease.catch(() => null);
      if (!release) continue;
      try {
        await release();
      } catch {
        console.error("Nettoyage du pare-feu o2switch en échec.");
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error("Impossible de lancer le worker de sauvegarde.", error instanceof Error ? error.message : "");
    process.exitCode = 1;
  });
}
