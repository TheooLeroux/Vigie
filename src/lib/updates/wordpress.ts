import { createHash } from "node:crypto";
import { ApiError } from "../http";
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
export function wordpressUpdateScript(root: string, backup: string, plan: WordPressUpdatePlan) {
  if (!plan) throw new ApiError("Un plan WordPress vérifié est obligatoire avant toute mise à jour.");
  const updateCommands = [
    `test "$(wp --path="$root" core version)" = ${shellQuote(plan.wordpress.current)}`,
    ...plan.plugins.map(item => `test "$(wp --path="$root" plugin get ${shellQuote(item.slug)} --field=version)" = ${shellQuote(item.current)}`),
    ...plan.themes.map(item => `test "$(wp --path="$root" theme get ${shellQuote(item.slug)} --field=version)" = ${shellQuote(item.current)}`),
    ...(plan.wordpress.target !== plan.wordpress.current ? [`wp --path="$root" core update --version=${shellQuote(plan.wordpress.target)}`] : []),
    `wp --path="$root" core update-db`,
    ...plan.plugins.filter(item => item.target !== item.current).map(item => `wp --path="$root" plugin update ${shellQuote(item.slug)} --version=${shellQuote(item.target)}`),
  ].join("\n");
  const integrity = plan.plugins.filter(item => item.target !== item.current).map(item => `test "$(wp --path="$root" plugin verify-checksums ${shellQuote(item.slug)} --version=${shellQuote(item.current)} --strict --format=json --no-color 2>&1)" = 'Success: Verified 1 of 1 plugins.'`).join("\n");
  return `set -eu
root=${shellQuote(root)}
backup=${shellQuote(backup)}
test "$(realpath -- "$root")" = "$root"
cd "$backup"
sha256sum -c SHA256SUMS >/dev/null
test ! -f "$root/.maintenance"
${plan.wordpress.current !== plan.wordpress.target ? 'wp --path="$root" core verify-checksums --quiet' : ""}
${integrity}
wp --path="$root" maintenance-mode activate >/dev/null
trap 'wp --path="$root" maintenance-mode deactivate >/dev/null 2>&1 || true' EXIT
${updateCommands}
${plan.wordpress.integrity === "unverified" ? "# Cœur conservé : intégrité à traiter manuellement." : 'wp --path="$root" core verify-checksums >/dev/null'}
wp --path="$root" cache flush >/dev/null
if test -f "$root/.maintenance"; then wp --path="$root" maintenance-mode deactivate >/dev/null; fi
trap - EXIT
version=$(wp --path="$root" core version)
plugins=$(wp --path="$root" plugin list --update=available --format=count)
themes=$(wp --path="$root" theme list --update=available --format=count)
printf 'VIGIE_WORDPRESS=%s\\nVIGIE_PLUGINS=%s\\nVIGIE_THEMES=%s\\n' "$version" "$plugins" "$themes"
`;
}
