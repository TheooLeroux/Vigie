import { posix } from "node:path";
import { z } from "zod";
import {
  hostingConnectionSchema,
  type HostingConnectionInput,
} from "./o2switch";
import { ApiError } from "../http";
import type { HostingInstallation } from "../types";

export type DiscoveredInstallation = Pick<
  HostingInstallation,
  | "documentRoot"
  | "domains"
  | "aliases"
  | "kind"
  | "version"
  | "inspectionError"
  | "suggestedEnvironment"
>;
export type DiscoveryResult = {
  observedAt: string;
  installations: DiscoveredInstallation[];
};
const domainName = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,63}$/);
const domainData = z
  .array(
    z.object({
      domain: domainName,
      documentroot: z.string().min(1).max(2000),
      serveralias: z.string().max(20000).optional().default(""),
    }),
  )
  .min(1)
  .max(250);
const filesSchema = z
  .array(z.object({ file: z.string().max(255), type: z.string().max(30) }))
  .max(5000);
export function isAddableInstallation(kind: HostingInstallation["kind"]) {
  return ["wordpress", "dolibarr", "next-static", "static", "php"].includes(
    kind,
  );
}
export function normalizeDocumentRoot(value: string) {
  return posix.normalize(value).replace(/\/$/, "");
}
export function canonicalHostname(value: string): string | null {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return u.hostname
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "");
  } catch {
    return null;
  }
}
export async function collectO2switchInstallations(
  raw: HostingConnectionInput & { secret: string },
  transport: typeof fetch = fetch,
): Promise<DiscoveryResult> {
  const input = hostingConnectionSchema.parse(raw);
  if (!input.secret)
    throw new ApiError(
      "Renseignez le jeton de ce compte avant de rechercher ses sites.",
    );
  const overall = AbortSignal.timeout(90_000);
  async function api(
    operation:
      | "DomainInfo/domains_data"
      | "Fileman/list_files"
      | "Fileman/get_file_content",
    params: Record<string, string | number> = {},
  ) {
    const url = new URL(input.endpoint + "/execute/" + operation);
    for (const [k, v] of Object.entries(params))
      url.searchParams.set(k, String(v));
    try {
      const response = await transport(url.href, {
        method: "GET",
        headers: {
          Authorization:
            input.authMode === "token"
              ? `cpanel ${input.username}:${input.secret}`
              : `Basic ${Buffer.from(input.username + ":" + input.secret).toString("base64")}`,
          Accept: "application/json",
        },
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.any([overall, AbortSignal.timeout(10_000)]),
      });
      if ([401, 403].includes(response.status))
        throw new ApiError(
          "cPanel refuse cet accès. Vérifiez le jeton et les droits du compte.",
          502,
        );
      if (!response.ok)
        throw new ApiError(
          "La lecture cPanel a échoué. Réessayez plus tard.",
          502,
        );
      const reader = response.body?.getReader();
      if (!reader) throw new ApiError("Réponse cPanel vide.", 502);
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 2_000_000) {
          await reader.cancel();
          throw new ApiError("Réponse cPanel trop volumineuse.", 502);
        }
        chunks.push(value);
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = parsed?.result || parsed;
      if (
        result?.status !== 1 ||
        (Array.isArray(result.errors) && result.errors.length)
      )
        throw new ApiError("cPanel n’a pas permis cette lecture.", 502);
      return result.data as unknown;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        overall.aborted
          ? "La recherche a dépassé le délai prévu. Le dernier relevé a été conservé."
          : "Impossible de lire le serveur cPanel. Vérifiez l’accès réseau et réessayez.",
        502,
      );
    }
  }
  const parsed = domainData.safeParse(
    await api("DomainInfo/domains_data", { format: "list" }),
  );
  if (!parsed.success)
    throw new ApiError(
      "La liste des domaines cPanel n’a pas pu être interprétée. Le dernier relevé est conservé.",
      502,
    );
  const grouped = new Map<string, DiscoveredInstallation>();
  for (const domain of parsed.data) {
    const root = normalizeDocumentRoot(domain.documentroot);
    let item = grouped.get(root);
    if (!item) {
      item = {
        documentRoot: root,
        domains: [],
        aliases: [],
        kind: "unknown",
        version: null,
        inspectionError: null,
        suggestedEnvironment:
          root.toLowerCase().includes("/mytiger-preprod/") ||
          domain.domain.endsWith(".wptiger.fr")
            ? "staging"
            : "production",
      };
      grouped.set(root, item);
    }
    item.domains.push(domain.domain);
    item.aliases.push(
      ...domain.serveralias
        .split(/\s+/)
        .filter((value) => domainName.safeParse(value).success)
        .map((value) => value.toLowerCase()),
    );
  }
  const installations = [...grouped.values()];
  async function readFile(
    dir: string,
    file: "version.php" | "filefunc.inc.php",
  ) {
    const data = await api("Fileman/get_file_content", {
      dir,
      file,
      charset: "utf-8",
    });
    if (typeof data === "string") return data;
    if (
      data &&
      typeof data === "object" &&
      typeof (data as { content?: unknown }).content === "string"
    )
      return (data as { content: string }).content;
    throw new ApiError("Le fichier de version n’a pas pu être lu.", 502);
  }
  let next = 0;
  async function worker() {
    while (next < installations.length) {
      const item = installations[next++];
      item.domains = [...new Set(item.domains)].sort();
      item.aliases = [...new Set(item.aliases)].sort();
      if (overall.aborted)
        throw new ApiError(
          "La recherche a dépassé le délai prévu. Le dernier relevé est conservé.",
          502,
        );
      if (
        !item.documentRoot.startsWith(`/home/${input.username}/`) ||
        item.documentRoot.includes("\0")
      ) {
        item.inspectionError =
          "Répertoire situé hors du dossier de ce compte ; lecture ignorée.";
        continue;
      }
      try {
        const listing = await api("Fileman/list_files", {
          dir: item.documentRoot,
          include_mime: 0,
          include_hash: 0,
          include_permissions: 0,
        });
        const files = filesSchema.safeParse(
          Array.isArray(listing)
            ? listing
            : (listing as { files?: unknown })?.files,
        );
        if (!files.success)
          throw new ApiError(
            "Le contenu du répertoire n’a pas pu être interprété.",
            502,
          );
        const names = new Set(files.data.map((file) => file.file));
        if (names.has("wp-admin") && names.has("wp-content")) {
          item.kind = names.has("wp-includes")
            ? "wordpress"
            : "wordpress-incomplete";
          if (item.kind === "wordpress")
            item.version =
              (
                await readFile(
                  posix.join(item.documentRoot, "wp-includes"),
                  "version.php",
                )
              ).match(
                /\$wp_version\s*=\s*['"]([0-9][0-9A-Za-z.+_-]{0,40})['"]/,
              )?.[1] || null;
        } else if (names.has("main.inc.php") && names.has("core")) {
          item.kind = "dolibarr";
          item.version =
            (await readFile(item.documentRoot, "filefunc.inc.php")).match(
              /define\s*\(\s*['"]DOL_VERSION['"]\s*,\s*['"]([0-9][0-9A-Za-z.+_-]{0,40})['"]/,
            )?.[1] || null;
        } else if (names.has("htdocs") && names.has("composer.json")) {
          try {
            item.version =
              (
                await readFile(
                  posix.join(item.documentRoot, "htdocs"),
                  "filefunc.inc.php",
                )
              ).match(
                /define\s*\(\s*['"]DOL_VERSION['"]\s*,\s*['"]([0-9][0-9A-Za-z.+_-]{0,40})['"]/,
              )?.[1] || null;
          } catch {
            /* Not every PHP project with an htdocs directory is Dolibarr. */
          }
          item.kind = item.version ? "dolibarr" : "php";
        } else if (names.has("index.html"))
          item.kind = names.has("_next") ? "next-static" : "static";
        else if (names.has("index.php") || names.has("composer.json"))
          item.kind = "php";
        else if (!names.size) item.kind = "empty";
        else if (
          [...names].every((name) =>
            [
              "cgi-bin",
              ".well-known",
              "www",
              "400.shtml",
              "401.shtml",
              "403.shtml",
              "404.shtml",
              "413.shtml",
              "500.shtml",
              "cp_errordocument.shtml",
            ].includes(name),
          )
        )
          item.kind = "technical";
      } catch (error) {
        item.inspectionError =
          error instanceof ApiError
            ? error.message
            : "Lecture du répertoire impossible.";
      }
    }
  }
  // A small bounded pool; never run hosted PHP or follow an HTTP redirect.
  await Promise.all([worker(), worker(), worker()]);
  return { observedAt: new Date().toISOString(), installations };
}
