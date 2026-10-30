import { z } from "zod";
import type { SiteInventory } from "../types";

// Keep only public code locations. PHP messages and traces can contain secrets.
export function parseWordPressLoadFailure(raw: unknown, root: string): SiteInventory["loadFailure"] {
  const result = z.object({ data: z.object({ error: z.object({ type: z.number().int(), file: z.string().max(1024), line: z.number().int().positive(), message: z.string().max(8192) }) }) }).safeParse(raw);
  if (!result.success || ![1, 4, 16, 64, 256, 4096].includes(result.data.data.error.type)) return;
  const error = result.data.data.error, prefix = root.replace(/\/$/, "") + "/";
  if (!error.file.startsWith(prefix)) return;
  const file = error.file.slice(prefix.length);
  if (!/^[a-zA-Z0-9_./-]{1,500}\.php$/.test(file) || file.split("/").some(part => !part || part === "." || part === "..")) return;
  const component = /^wp-content\/(plugins|themes)\/([a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,99})\//.exec(file);
  if (!component) return;
  const knownIssue = component[2] === "wp-rocket" && file.endsWith("/inc/ThirdParty/Plugins/CDN/Cloudflare.php") && /^Uncaught TypeError: substr\(\): Argument #1 \(\$string\) must be of type string, int given/.test(error.message);
  return { kind: component[1] === "plugins" ? "plugin" : "theme", component: component[2], file, line: error.line, ...(knownIssue ? { knownIssue: "wp-rocket-wordpress-7.1" as const } : {}) };
}

export function wordpressLoadFailureMessage(failure: NonNullable<SiteInventory["loadFailure"]>) {
  if (failure.knownIssue === "wp-rocket-wordpress-7.1") return "WP Rocket provoque une erreur PHP de compatibilité avec WordPress 7.1 dans son intégration Cloudflare. L’éditeur recommande WP Rocket 3.23.2.2 ou une version compatible plus récente.";
  return `Le chargement complet de WordPress échoue dans ${failure.kind === "plugin" ? "l’extension" : "le thème"} ${failure.component} (${failure.file.split("/").at(-1)}, ligne ${failure.line}).`;
}
