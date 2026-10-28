import { parse } from "yaml";

const sections = ["dependencies", "devDependencies", "optionalDependencies"];

// A parent lock is usable only if it actually declares this deployed workspace
// and the same dependency requests. Do not silently scan an unrelated root lock.
export function workspaceLockCovers(lock: string, raw: string, root: string, manifest: Record<string, any>, parentManifest?: Record<string, any>) {
  try {
    if (lock === "pnpm-lock.yaml") {
      const data = parse(raw, { maxAliasCount: 50, uniqueKeys: true });
      const importer = data?.importers?.[root];
      if (!importer || typeof importer !== "object") return false;
      return sections.every(section => Object.entries(manifest[section] || {}).every(([name, range]) => {
        const entry = importer[section]?.[name];
        return entry !== undefined && (entry?.specifier ?? importer.specifiers?.[name]) === range;
      }));
    }
    if (["package-lock.json", "npm-shrinkwrap.json"].includes(lock)) {
      const workspace = JSON.parse(raw).packages?.[root];
      return !!workspace && sections.every(section => Object.entries(manifest[section] || {}).every(([name, range]) => workspace[section]?.[name] === range));
    }
    if (lock === "yarn.lock") {
      const patterns = Array.isArray(parentManifest?.workspaces) ? parentManifest.workspaces : parentManifest?.workspaces?.packages;
      return Array.isArray(patterns) && patterns.some(pattern => {
        if (typeof pattern !== "string" || pattern.startsWith("!")) return false;
        const expression = pattern.replace(/^\.\//, "").replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
        return new RegExp(`^${expression}$`).test(root);
      });
    }
  } catch { return false; }
  return false;
}
