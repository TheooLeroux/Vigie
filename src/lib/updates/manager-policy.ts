import { ApiError } from "../http";

// Peer warnings are a blocking signal for Yarn. Do not allow project-owned
// settings/plugins to suppress that signal or replace the pinned executable.
export function requireStrictYarnConfiguration(source: string) {
  if (/(?:^|[\r\n{,])\s*["']?(?:logFilters|yarnPath|yarn-path|plugins|(?:--(?:install\.)?)?(?:silent|ignore-engines|ignore-platform))["']?\s*(?::|=|\s)/im.test(source)
    || /(?:^|[\r\n{,])\s*["']?enableMessageNames["']?\s*:\s*["']?false\b/im.test(source)
    || /(?:^|[\r\n{,])\s*"[^"\r\n]*\\[^"\r\n]*"\s*:/m.test(source)
    || /^\s*\?\s|!!/m.test(source)) {
    throw new ApiError("La configuration Yarn personnalise les contrôles, les journaux ou l’exécutable. Validation dédiée nécessaire ; aucun contrôle de pairs masqué autorisé.", 422);
  }
}
