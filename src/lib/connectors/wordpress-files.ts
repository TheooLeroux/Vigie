import { posix } from "node:path";
import type { SiteInventory, WordPressComponent } from "../types";
import type { cpanelReadClient } from "./cpanel-read";
import { catalogUpdate, unknownUpdate } from "./wordpress-catalog";
export function readHeader(source: string, label: string): string | null {
  return (
    source
      .slice(0, 8192)
      .replace(/\r/g, "\n")
      .match(new RegExp("^[\\s/*#@]*" + label + ":\\s*(.+)$", "im"))?.[1]
      ?.replace(/\s*\*\/.*$/, "")
      .replace(/<[^>]*>/g, "")
      .trim()
      .slice(0, 500) || null
  );
}
export function componentFromHeader(
  source: string,
  file: string,
  kind: "plugin" | "theme",
  mustUse = false,
): WordPressComponent | null {
  const name = readHeader(
    source,
    kind === "plugin" ? "Plugin Name" : "Theme Name",
  );
  if (!name) return null;
  return {
    file,
    slug: file.includes("/") ? file.split("/")[0] : file.replace(/\.php$/, ""),
    name,
    version: readHeader(source, "Version"),
    active: mustUse ? true : null,
    mustUse,
    autoUpdate: null,
    requiresPhp: readHeader(source, "Requires PHP"),
    requiresWordPress: readHeader(source, "Requires at least"),
    template: kind === "theme" ? readHeader(source, "Template") : null,
    ...unknownUpdate(),
  };
}
export async function collectWordPressFiles(
  client: ReturnType<typeof cpanelReadClient>,
  root: string,
  catalogTransport: typeof fetch = fetch,
): Promise<SiteInventory> {
  const now = new Date().toISOString();
  const result: SiteInventory = {
    source: "cpanel-files",
    observedAt: now,
    lastAttemptAt: now,
    error: null,
    wordpress: null,
    php: null,
    site: null,
    configuration: null,
    database: null,
    plugins: [],
    themes: [],
    warnings: [
      "L’activité des extensions et thèmes ainsi que le PHP web nécessitent le connecteur WordPress.",
    ],
  };
  const source = await client.read(
    posix.join(root, "wp-includes"),
    "version.php",
  );
  const version = source.match(
    /\$wp_version\s*=\s*['"]([0-9][0-9A-Za-z.+_-]{0,40})['"]/,
  )?.[1];
  if (version)
    result.wordpress = {
      version,
      ...(await catalogUpdate("core", version, version, catalogTransport)),
    };
  else
    result.warnings.push("La version WordPress n’a pas pu être interprétée.");
  async function plugins(folder: "plugins" | "mu-plugins") {
    const dir = posix.join(root, "wp-content", folder);
    let entries;
    try {
      entries = await client.list(dir);
    } catch {
      if (folder === "plugins")
        result.warnings.push(
          "Le répertoire des extensions n’a pas pu être lu.",
        );
      return;
    }
    for (const entry of entries.slice(0, 200)) {
      if (entry.file.startsWith(".") || entry.file === "index.php") continue;
      try {
        const files =
          entry.type === "dir" && folder === "plugins"
            ? (await client.list(posix.join(dir, entry.file)))
                .filter((f) => f.type === "file" && f.file.endsWith(".php"))
                .sort(
                  (a, b) =>
                    Number(b.file === entry.file + ".php") -
                    Number(a.file === entry.file + ".php"),
                )
            : [entry];
        if (files.length > 40)
          result.warnings.push(
            `Analyse limitée à 40 fichiers pour ${entry.file}.`,
          );
        let found = false;
        for (const file of files.slice(0, 40)) {
          if (file.type !== "file" || !file.file.endsWith(".php")) continue;
          if (file.size > 1_000_000) {
            result.warnings.push(
              `En-tête non lu : ${entry.file}/${file.file} (fichier volumineux).`,
            );
            continue;
          }
          const path = entry.type === "dir" ? posix.join(dir, entry.file) : dir;
          const text = await client.read(path, file.file),
            key =
              entry.type === "dir" ? `${entry.file}/${file.file}` : file.file;
          const component = componentFromHeader(
            text,
            key,
            "plugin",
            folder === "mu-plugins",
          );
          if (!component) continue;
          found = true;
          const external = readHeader(text, "Update URI");
          if (
            !component.mustUse &&
            (!external ||
              /^https?:\/\/(?:www\.)?wordpress\.org\//i.test(external))
          )
            Object.assign(
              component,
              await catalogUpdate(
                "plugin",
                component.slug,
                component.version,
                catalogTransport,
              ),
            );
          result.plugins.push(component);
        }
        if (!found && entry.type === "dir" && folder === "plugins")
          result.warnings.push(
            `Aucun en-tête d’extension identifiable dans ${entry.file}.`,
          );
      } catch {
        result.warnings.push(
          `Extension non entièrement lisible : ${entry.file}.`,
        );
      }
    }
    if (entries.length > 200)
      result.warnings.push(
        "Inventaire des extensions partiel : plus de 200 entrées.",
      );
  }
  await plugins("plugins");
  await plugins("mu-plugins");
  const dir = posix.join(root, "wp-content/themes");
  try {
    const entries = await client.list(dir);
    for (const entry of entries
      .filter((f) => f.type === "dir" && !f.file.startsWith("."))
      .slice(0, 100)) {
      try {
        const text = await client.read(
            posix.join(dir, entry.file),
            "style.css",
          ),
          theme = componentFromHeader(text, entry.file + "/style.css", "theme");
        if (theme) {
          if (!theme.template)
            Object.assign(
              theme,
              await catalogUpdate(
                "theme",
                theme.slug,
                theme.version,
                catalogTransport,
              ),
            );
          result.themes.push(theme);
        }
      } catch {
        result.warnings.push(`Thème non lisible : ${entry.file}.`);
      }
    }
  } catch {
    result.warnings.push("Le répertoire des thèmes n’a pas pu être lu.");
  }
  return result;
}
