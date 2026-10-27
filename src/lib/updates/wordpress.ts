import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withHostingCredentials } from "../hosting-connections";
import { hostingInstallation } from "../hosting-discovery";
import { publicAddress } from "../connectors/wordpress-observer";
import { ApiError } from "../http";
import { readUpdateSource } from "./storage";
import { runCommand } from "./process";
import type { UpdateTarget } from "./types";
import type { WordPressUpdatePlan } from "./wordpress-security";

export function shellQuote(value: string) { return `'${value.replace(/'/g, `'"'"'`)}'`; }
export function wordpressBackupScript(root: string, username: string, runId: string, url?: string, webPhp?: string) {
  if (!/^[\w-]+$/.test(username) || !/^[a-f0-9-]{36}$/.test(runId) || !root.startsWith(`/home/${username}/`) || /[\x00-\x1f]/.test(root)) throw new ApiError("Chemin WordPress non autorisé.");
  const backup = `/home/${username}/.vigie-backups/${runId}/${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
  return `set -eu
umask 077
fail() { printf 'VIGIE_ERROR=%s\\n' "$1"; exit 1; }
root=$(realpath -- ${shellQuote(root)})
test "$root" = ${shellQuote(root)}
backup=${shellQuote(backup)}
case "$backup/" in "$root/"*) exit 1;; esac
command -v wp >/dev/null || fail cli_missing
test -f "$root/wp-config.php"
test -z "$(find "$root" -type l -print -quit)" || fail symlinks
wp --path="$root" core is-installed
${webPhp ? `test "$(wp --path="$root" eval 'echo PHP_VERSION;')" = ${shellQuote(webPhp)} || fail php_mismatch` : ""}
${url ? `test "$(wp --path="$root" eval 'echo preg_replace("/^www\\./", "", strtolower((string)parse_url(home_url(), PHP_URL_HOST)));')" = ${shellQuote(new URL(url).hostname.replace(/^www\./, ""))} || fail domain_mismatch` : ""}
test "$(wp --path="$root" eval 'echo is_multisite() ? "yes" : "no";')" = no || fail multisite
test "$(wp --path="$root" eval 'echo defined("DISALLOW_FILE_MODS") && DISALLOW_FILE_MODS ? "yes" : "no";')" = no || fail file_mods
test ! -f "$root/.maintenance" || fail maintenance
mkdir -p -- "$backup"
chmod 700 "$backup" "$(dirname "$backup")"
wp --path="$root" db check >/dev/null
wp --path="$root" db export "$backup/database.sql" --single-transaction --quick --add-drop-table >/dev/null
test -s "$backup/database.sql"
tar -czf "$backup/files.tar.gz" -C "$root" .
tar -tzf "$backup/files.tar.gz" >/dev/null
cd "$backup"
sha256sum database.sql files.tar.gz > SHA256SUMS
sha256sum -c SHA256SUMS >/dev/null
printf 'VIGIE_BACKUP=%s\\n' "$backup"
`;
}
export function wordpressUpdateScript(root: string, backup: string, plan?: WordPressUpdatePlan) {
  const updateCommands = plan ? [
    `test "$(wp --path="$root" core version)" = ${shellQuote(plan.wordpress.current)}`,
    ...plan.plugins.map(item => `test "$(wp --path="$root" plugin get ${shellQuote(item.slug)} --field=version)" = ${shellQuote(item.current)}`),
    ...plan.themes.map(item => `test "$(wp --path="$root" theme get ${shellQuote(item.slug)} --field=version)" = ${shellQuote(item.current)}`),
    ...(plan.wordpress.target !== plan.wordpress.current ? [`wp --path="$root" core update --version=${shellQuote(plan.wordpress.target)}`] : []),
    `wp --path="$root" core update-db`,
    ...plan.plugins.filter(item => item.target !== item.current).map(item => `wp --path="$root" plugin update ${shellQuote(item.slug)} --version=${shellQuote(item.target)}`),
  ].join("\n") : `wp --path="$root" core update\nwp --path="$root" core update-db\nwp --path="$root" plugin update --all`;
  return `set -eu
root=${shellQuote(root)}
backup=${shellQuote(backup)}
test "$(realpath -- "$root")" = "$root"
cd "$backup"
sha256sum -c SHA256SUMS >/dev/null
test ! -f "$root/.maintenance"
wp --path="$root" maintenance-mode activate >/dev/null
trap 'wp --path="$root" maintenance-mode deactivate >/dev/null 2>&1 || true' EXIT
${updateCommands}
wp --path="$root" core verify-checksums >/dev/null
wp --path="$root" cache flush >/dev/null
if test -f "$root/.maintenance"; then wp --path="$root" maintenance-mode deactivate >/dev/null; fi
trap - EXIT
version=$(wp --path="$root" core version)
plugins=$(wp --path="$root" plugin list --update=available --format=count)
themes=$(wp --path="$root" theme list --update=available --format=count)
printf 'VIGIE_WORDPRESS=%s\\nVIGIE_PLUGINS=%s\\nVIGIE_THEMES=%s\\n' "$version" "$plugins" "$themes"
`;
}
export async function withWordPressUpdater<T>(target: UpdateTarget, run: (execute: (script: string) => Promise<string>, username: string) => Promise<T>) {
  const source = await readUpdateSource(target.id);
  if (!source?.settings.sshKey || !source.settings.hostKey) throw new ApiError("Configurez l’accès SSH de ce WordPress.");
  const installation = await hostingInstallation(target.remoteId);
  if (installation.documentRoot !== target.root || installation.project?.id !== target.projectId || installation.missingSince || installation.kind !== "wordpress") throw new ApiError("Le rattachement WordPress a changé. Synchronisez le projet.");
  return withHostingCredentials(target.connectionId, async connection => {
    const host = new URL(connection.endpoint).hostname;
    if (!/^[a-z0-9.-]+\.o2switch\.net$/i.test(host) || !/^[\w-]+$/.test(connection.username)) throw new ApiError("Serveur SSH o2switch non reconnu.");
    const addresses = await lookup(host, { all: true });
    if (!addresses.length || addresses.some(address => !publicAddress(address.address))) throw new ApiError("Adresse SSH non publique.");
    const folder = await mkdtemp(join(tmpdir(), "vigie-ssh-"));
    try {
      const key = join(folder, "key"), hosts = join(folder, "known_hosts");
      await writeFile(key, source.settings.sshKey! + "\n", { mode: 0o600 });
      await writeFile(hosts, `${host} ${source.settings.hostKey}\n`, { mode: 0o600 });
      return await run(script => runCommand("ssh", ["-F", "/dev/null", "-T", "-i", key, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${hosts}`, "-o", `HostKeyAlias=${host}`, "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", `${connection.username}@${addresses[0].address}`, "bash", "-s"], { input: script, timeout: 12 * 60_000, errorMessages: { cli_missing: "WP-CLI n’est pas disponible sur ce compte o2switch.", php_mismatch: "WP-CLI utilise un autre PHP que le site. Alignez la version CLI avant de mettre à jour WordPress.", domain_mismatch: "Le WordPress trouvé ne correspond pas au domaine de la fiche. Vérifiez son rattachement.", symlinks: "Ce WordPress utilise des liens symboliques. Sa sauvegarde doit être adaptée avant toute mise à jour.", multisite: "Le WordPress est un multisite : une intervention dédiée est nécessaire.", file_mods: "Les mises à jour sont désactivées dans WordPress.", maintenance: "Le site est déjà en maintenance. Terminez cette intervention avant de lancer une mise à jour." } }), connection.username);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
}
