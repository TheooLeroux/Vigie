import { z } from "zod";
import { safeUrl } from "./validation";

export const siteListEntrySchema = z.object({
  name: z.string().trim().min(1).max(200),
  url: safeUrl.refine(Boolean, "URL du site manquante."),
  provider: z.enum(["o2switch", "Railway"]),
  technology: z.string(),
  repository: safeUrl,
  hostingUrl: safeUrl,
  directory: z.string(),
  database: z.string(),
  accountLabel: z.string(),
  notes: z.string(),
});
export type SiteListEntry = z.infer<typeof siteListEntrySchema>;

// Allowlist fields deliberately: free-form account/password lines are never copied.
export function parseSiteList(content: string): SiteListEntry[] {
  const entries: SiteListEntry[] = [];
  let section: "o2switch" | "Railway" | null = null,
    accountLabel = "",
    consoleUrl = "";
  let current: SiteListEntry | null = null;
  function flush() {
    if (current) entries.push(siteListEntrySchema.parse(current));
    current = null;
  }
  for (const raw of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    const hosting = line.match(/^o2switch\s*(\d+)\s*:/i);
    if (hosting) {
      flush();
      section = "o2switch";
      accountLabel = `o2switch ${hosting[1]}`;
      consoleUrl = "";
      continue;
    }
    if (/^Railway\s*:/i.test(line)) {
      flush();
      section = "Railway";
      accountLabel = "Railway";
      consoleUrl = "";
      continue;
    }
    if (/^Vercel\s*:/i.test(line)) {
      flush();
      section = null;
      continue;
    }
    if (!section) continue;
    if (line.startsWith("- ")) {
      flush();
      current = {
        name: line
          .slice(2)
          .replace(/\s*:\s*$/, "")
          .trim(),
        url: "",
        provider: section,
        technology: section === "o2switch" ? "WordPress" : "",
        repository: "",
        hostingUrl: consoleUrl,
        directory: "",
        database: "",
        accountLabel,
        notes: "",
      };
      continue;
    }
    if (!current) {
      if (section === "o2switch" && /^https:\/\/[^\s]+:2083\/?$/.test(line))
        consoleUrl = safeUrl.parse(line);
      continue;
    }
    const field = line.match(/^(site|git|chemin|bdd)\s*:\s*(.*)$/i);
    if (field) {
      const key = field[1].toLowerCase(),
        value = field[2].trim();
      if (key === "site") current.url = safeUrl.parse(value);
      if (key === "git") current.repository = safeUrl.parse(value);
      if (key === "chemin") {
        if (section === "Railway") current.hostingUrl = safeUrl.parse(value);
        else current.directory = value;
      }
      if (key === "bdd") {
        if (/^https?:/i.test(value)) current.database = safeUrl.parse(value);
        else if (/^[\w .-]{1,200}$/.test(value)) current.database = value;
        else
          throw new Error(
            `Référence de base non reconnue pour ${current.name}.`,
          );
      }
    }
    if (/^down\s*\?$/i.test(line))
      current.notes = "Disponibilité à vérifier (note source : « down ? »).";
  }
  flush();
  return entries;
}
