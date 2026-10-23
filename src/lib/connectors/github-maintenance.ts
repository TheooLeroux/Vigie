import { ApiError } from "../http";
import {
  repositorySchema,
  safeBranch,
  shaSchema,
} from "../maintenance-contract";

export class GitHubMaintenanceError extends ApiError {
  constructor(
    message: string,
    status: number,
    public definitive: boolean,
    public responseStatus?: number,
  ) {
    super(message, status);
  }
}
export class GitHubMaintenanceClient {
  constructor(
    private token: string,
    private transport: typeof fetch = fetch,
  ) {}
  async request(
    path: string,
    method = "GET",
    payload?: unknown,
    optional = false,
  ): Promise<any> {
    if (
      !path.startsWith("/repos/") ||
      path.includes("..") ||
      /[\r\n\\]/.test(path)
    )
      throw new ApiError("Chemin GitHub non autorisé.");
    let response: Response;
    try {
      response = await this.transport(`https://api.github.com${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "Vigie-Maintenance",
          ...(payload === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
    } catch {
      throw new ApiError(
        "GitHub indisponible ; l’état distant doit être revérifié avant une nouvelle tentative.",
        502,
      );
    }
    if (optional && response.status === 404) return null;
    if (!response.ok)
      throw new GitHubMaintenanceError(
        response.status === 401 || response.status === 403
          ? "GitHub refuse cet accès. Vérifiez le jeton, ses dépôts et ses permissions."
          : response.status === 409 || response.status === 422
            ? "GitHub refuse ce changement : conflit, protection de branche ou état déjà modifié. Actualisez le suivi."
            : "Opération GitHub impossible. Vérifiez les accès et l’état distant.",
        response.status === 404 ? 404 : 502,
        response.status >= 400 &&
          response.status < 500 &&
          response.status !== 409,
        response.status,
      );
    if (response.status === 204) return null;
    const reader = response.body?.getReader();
    if (!reader) throw new ApiError("Réponse GitHub vide.", 502);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 12_000_000) {
        await reader.cancel();
        throw new ApiError("Réponse GitHub trop volumineuse.", 502);
      }
      chunks.push(next.value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ApiError("Réponse GitHub invalide.", 502);
    }
  }
  repo(repository: string) {
    return `/repos/${repositorySchema.parse(repository)}`;
  }
  async branch(repository: string, branch: string) {
    const result = await this.request(
      `${this.repo(repository)}/commits/${encodeURIComponent(safeBranch(branch))}`,
    );
    return shaSchema.parse(result.sha);
  }
  async tree(repository: string, commit: string): Promise<GitTreeEntry[]> {
    const commitData = await this.request(
      `${this.repo(repository)}/git/commits/${shaSchema.parse(commit)}`,
    );
    const result = await this.request(
      `${this.repo(repository)}/git/trees/${shaSchema.parse(commitData.tree?.sha)}?recursive=1`,
    );
    if (
      result.truncated ||
      !Array.isArray(result.tree) ||
      result.tree.length > 30000
    )
      throw new ApiError(
        "Arbre Git incomplet ou trop volumineux ; aucune mise à jour proposée.",
      );
    return result.tree.filter(
      (entry: GitTreeEntry) =>
        entry.type === "blob" &&
        entry.mode === "100644" &&
        typeof entry.path === "string" &&
        /^[a-f0-9]{40}$/.test(entry.sha),
    );
  }
  async blob(
    repository: string,
    entry: GitTreeEntry,
    limit = 4_000_000,
  ): Promise<string> {
    if (entry.size && entry.size > limit)
      throw new ApiError("Fichier de maintenance trop volumineux.");
    const result = await this.request(
      `${this.repo(repository)}/git/blobs/${shaSchema.parse(entry.sha)}`,
    );
    if (
      result.encoding !== "base64" ||
      typeof result.content !== "string" ||
      result.content.length > limit * 1.5
    )
      throw new ApiError("Fichier GitHub illisible ou trop volumineux.");
    const content = Buffer.from(result.content, "base64");
    if (content.length > limit)
      throw new ApiError("Fichier de maintenance trop volumineux.");
    return content.toString("utf8");
  }
}
export type GitTreeEntry = {
  path: string;
  sha: string;
  mode: string;
  type: string;
  size?: number;
};
