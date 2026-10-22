import { posix } from "node:path";
import { z } from "zod";
import {
  hostingConnectionSchema,
  type HostingConnectionInput,
} from "./o2switch";
import { ApiError } from "../http";
export type CpanelFile = { file: string; type: string; size: number };
export function cpanelReadClient(
  raw: HostingConnectionInput,
  transport: typeof fetch = fetch,
) {
  const input = hostingConnectionSchema.parse(raw),
    overall = AbortSignal.timeout(180_000);
  let calls = 0;
  if (!input.secret) throw new ApiError("Jeton o2switch manquant.");
  const auth =
    input.authMode === "token"
      ? `cpanel ${input.username}:${input.secret}`
      : `Basic ${Buffer.from(input.username + ":" + input.secret).toString("base64")}`;
  const safePath = (dir: string) => {
    const normalized = posix.normalize(dir).replace(/\/$/, "");
    if (
      !normalized.startsWith(`/home/${input.username}/`) ||
      normalized.includes("\0")
    )
      throw new ApiError("Répertoire hors du compte o2switch.");
    return normalized;
  };
  async function api(
    operation: "Fileman/list_files" | "Fileman/get_file_content",
    params: Record<string, string | number>,
  ) {
    if (++calls > 1500)
      throw new ApiError(
        "Limite de lecture atteinte ; les dernières observations sont conservées.",
      );
    const url = new URL(input.endpoint + "/execute/" + operation);
    for (const [k, v] of Object.entries(params))
      url.searchParams.set(k, String(v));
    try {
      const r = await transport(url.href, {
        headers: { Authorization: auth, Accept: "application/json" },
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.any([overall, AbortSignal.timeout(15_000)]),
      });
      if (!r.ok)
        throw new ApiError(
          [401, 403].includes(r.status)
            ? "Accès cPanel refusé. Vérifiez le jeton."
            : "Lecture cPanel indisponible.",
          502,
        );
      const reader = r.body?.getReader();
      if (!reader) throw new ApiError("Réponse cPanel vide.", 502);
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new ApiError("Fichier trop volumineux pour l’inventaire.", 502);
        }
        chunks.push(value);
      }
      const raw = JSON.parse(Buffer.concat(chunks).toString("utf8")),
        result = raw.result || raw;
      if (
        result.status !== 1 ||
        (Array.isArray(result.errors) && result.errors.length)
      )
        throw new ApiError("cPanel n’a pas permis cette lecture.", 502);
      return result.data as unknown;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(
        overall.aborted
          ? "La collecte a dépassé le délai prévu."
          : "La lecture cPanel a échoué.",
        502,
      );
    }
  }
  return {
    async list(dir: string, onlyFiles?: string[]): Promise<CpanelFile[]> {
      const data = await api("Fileman/list_files", {
        dir: safePath(dir),
        include_mime: 0,
        include_hash: 0,
        include_permissions: 0,
        show_hidden: 1,
        ...(onlyFiles ? { only_these_files: onlyFiles.join(",") } : {}),
      });
      const rawEntries = Array.isArray(data)
        ? data
        : (data as { files?: unknown })?.files;
      // Some cPanel builds ignore only_these_files. Inspect just the requested
      // exact names before validating entries we will actually traverse.
      const selected =
        onlyFiles && Array.isArray(rawEntries)
          ? rawEntries.filter(
              (f) => f && typeof f === "object" && onlyFiles.includes(f.file),
            )
          : rawEntries;
      const entries = z
        .array(
          z.object({
            file: z
              .string()
              .max(255)
              .refine((f) => !/[\/\\\0]/.test(f) && f !== "." && f !== ".."),
            type: z.string().max(30),
            size: z.union([z.string(), z.number()]).optional(),
          }),
        )
        .max(5000)
        .safeParse(selected);
      if (!entries.success)
        throw new ApiError("Liste de fichiers non interprétable.", 502);
      return entries.data.map((f) => ({ ...f, size: Number(f.size) || 0 }));
    },
    async read(dir: string, file: string) {
      // Only public version files and extension/theme metadata. Never wp-config, .env or keys.
      const path = safePath(dir);
      if (
        !/^[a-zA-Z0-9_.-]{1,255}$/.test(file) ||
        file === "wp-config.php" ||
        !(
          (file === "version.php" && path.endsWith("/wp-includes")) ||
          (file === "style.css" && /\/wp-content\/themes\/[^/]+$/.test(path)) ||
          (file.endsWith(".php") &&
            /\/wp-content\/(plugins|mu-plugins)(\/[^/]+)?$/.test(path))
        )
      )
        throw new ApiError("Lecture non autorisée pour l’inventaire.");
      const data = await api("Fileman/get_file_content", {
        dir: path,
        file,
        charset: "utf-8",
      });
      const content =
        typeof data === "string"
          ? data
          : (data as { content?: unknown })?.content;
      if (typeof content !== "string")
        throw new ApiError("Fichier non lisible.", 502);
      return content;
    },
  };
}
