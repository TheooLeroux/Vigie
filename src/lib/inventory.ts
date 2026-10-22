export type ParsedComponent = { name: string; version: string; ecosystem: string; scope: "production" | "development" | "unknown"; direct: boolean };
export function parseLockfile(filename: string, content: string): ParsedComponent[] {
  if (content.length > 5_000_000) throw new Error("Le fichier dépasse 5 Mo.");
  let root: Record<string, any>;
  try { root = JSON.parse(content); } catch { throw new Error("Le fichier doit contenir un JSON valide."); }
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("Format de fichier invalide.");
  const result: ParsedComponent[] = [];
  const add = (name: unknown, version: unknown, ecosystem: string, scope: ParsedComponent["scope"], direct: boolean) => {
    if (typeof name !== "string" || typeof version !== "string" || !name || !version || name.length > 300 || version.length > 150) return;
    // Local/workspace links and version ranges do not identify an installed release.
    if (/^(file:|link:|workspace:|[~^*><=])/.test(version)) return;
    result.push({ name, version, ecosystem, scope, direct });
    if (result.length > 20000) throw new Error("Cet inventaire dépasse la limite de 20 000 composants.");
  };
  if (filename === "package-lock.json" || filename === "npm-shrinkwrap.json") {
    if (root.packages && typeof root.packages === "object") {
      const top = root.packages[""] || {};
      const direct = new Set([...Object.keys(top.dependencies || {}), ...Object.keys(top.devDependencies || {}), ...Object.keys(top.optionalDependencies || {})]);
      for (const [path, value] of Object.entries(root.packages)) {
        const pkg = value as Record<string, any>;
        if (!path || !path.includes("node_modules/") || !pkg || pkg.link) continue;
        const name = pkg.name || path.slice(path.lastIndexOf("node_modules/") + 13);
        add(name, pkg.version, "npm", pkg.dev ? "development" : "production", direct.has(name) && path === `node_modules/${name}`);
      }
    } else if (root.dependencies && typeof root.dependencies === "object") {
      const walk = (deps: Record<string, any>, depth: number) => {
        if (depth > 30) throw new Error("Imbrication du lockfile trop importante.");
        for (const [name, pkg] of Object.entries(deps)) {
          if (!pkg || typeof pkg !== "object") continue;
          add(name, pkg.version, "npm", pkg.dev ? "development" : "production", depth === 0);
          if (pkg.dependencies) walk(pkg.dependencies, depth + 1);
        }
      };
      walk(root.dependencies, 0);
    } else throw new Error("Ce fichier ne contient pas un inventaire npm reconnu.");
  } else if (filename === "composer.lock") {
    if (!Array.isArray(root.packages)) throw new Error("Ce fichier ne contient pas un inventaire Composer reconnu.");
    if (root["packages-dev"] !== undefined && !Array.isArray(root["packages-dev"])) throw new Error("Le fichier Composer contient une liste de développement invalide.");
    for (const pkg of root.packages) if (pkg && typeof pkg === "object") add(pkg.name, pkg.version, "Packagist", "production", false);
    for (const pkg of root["packages-dev"] || []) if (pkg && typeof pkg === "object") add(pkg.name, pkg.version, "Packagist", "development", false);
  } else {
    throw new Error("Formats pris en charge pour cette première version : package-lock.json, npm-shrinkwrap.json et composer.lock.");
  }
  if (!result.length) throw new Error("Aucun composant avec une version résolue n’a été trouvé.");
  return Array.from(new Map(result.map(p => [`${p.ecosystem}:${p.name}:${p.version}:${p.scope}:${p.direct}`, p])).values());
}

export function escapeCsv(value: string): string {
  const safe = /^[\s]*[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function parseCsv(content: string): Record<string, string>[] {
  if (content.length > 5_000_000) throw new Error("Le fichier dépasse 5 Mo.");
  const input = content.replace(/^\uFEFF/, "");
  const delimiter = input.split(/\r?\n/)[0]?.includes(";") ? ";" : ",";
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') { if (quoted && input[i+1] === '"') {cell += '"';i++;} else quoted = !quoted; }
    else if (c === delimiter && !quoted) { row.push(cell); cell = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && input[i+1] === "\n") i++;
      row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("Le CSV contient un champ entre guillemets non terminé.");
  row.push(cell); if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) throw new Error("Le CSV doit contenir un en-tête et au moins un projet.");
  if (rows.length > 1001) throw new Error("Import limité à 1 000 projets.");
  const headers = rows.shift()!.map(h => h.trim().toLowerCase());
  const aliases: Record<string,string> = {nom:"name",projet:"name",site:"name",responsable:"owner",technologie:"technology",hebergeur:"provider","hébergeur":"provider",criticite:"criticality","criticité":"criticality",depot:"repository","dépôt":"repository"};
  const names = headers.map(h => aliases[h] || h);
  if (!names.includes("name")) throw new Error("Une colonne name ou nom est obligatoire.");
  return rows.map((r, index) => {
    if (r.length !== headers.length) throw new Error(`Le nombre de colonnes est incorrect à la ligne ${index + 2}.`);
    return Object.fromEntries(names.map((name,i) => [name, r[i]?.trim() || ""]));
  });
}
