import type { SecurityFinding } from "./types";

// Only npm's resolved package entries prove dev-only membership here. Other
// formats, local links and ambiguous entries remain unknown until qualified.
export function npmDependencyUsage(lock: string, name: string, version: string): NonNullable<SecurityFinding["usage"]> {
  try {
    const data = JSON.parse(lock);
    if (!Number.isInteger(data.lockfileVersion) || data.lockfileVersion < 2 || !data.packages || typeof data.packages !== "object") return "unknown";
    const entries = Object.entries(data.packages).flatMap(([path, raw]) => {
      const item = raw as { name?: string; version?: string; link?: boolean; dev?: boolean; devOptional?: boolean } | null;
      if (!item || item.link || item.version !== version || !(path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))) return [];
      return [item];
    });
    if (!entries.length || entries.some(item => item.devOptional)) return "unknown";
    return entries.every(item => item.dev === true) ? "build" : "runtime";
  } catch { return "unknown"; }
}
