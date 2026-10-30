import { ApiError } from "../http";

export class GitHubAccessError extends ApiError {
  constructor(readonly githubStatus: 401 | 403 | 404, message = `GitHub refuse l’opération (${githubStatus}). Vérifiez les accès au dépôt.`) { super(message, 502); }
}

export function githubUpdateToken(repository: string) {
  const owner = repository.split("/")[0];
  const separate = process.env[`VIGIE_UPDATES_GITHUB_TOKEN_${owner.toUpperCase()}`]
    || process.env[`VIGIE_MAINTENANCE_GITHUB_TOKEN_${owner.toUpperCase()}`];
  let tokens: Record<string, string> = {};
  try { tokens = JSON.parse(process.env.VIGIE_UPDATES_GITHUB_TOKENS || process.env.VIGIE_MAINTENANCE_GITHUB_TOKENS || "{}"); }
  catch { throw new ApiError("La configuration des accès GitHub est invalide.", 503); }
  return separate || Object.entries(tokens).find(([name]) => name.toLowerCase() === owner.toLowerCase())?.[1] || "";
}
export function repositoryAllowed(repository: string) {
  return /^[\w.-]+\/[\w.-]+$/.test(repository) && (process.env.VIGIE_UPDATES_REPOSITORIES || process.env.VIGIE_MAINTENANCE_REPOSITORIES || "").split(/[\s,]+/).some(value => value.toLowerCase() === repository.toLowerCase());
}
export async function githubRequest(path: string, token: string, method = "GET", input?: unknown, transport: typeof fetch = fetch) {
  const response = await transport(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(input ? { "Content-Type": "application/json" } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    if (method === "GET" && [401, 403, 404].includes(response.status)) throw new GitHubAccessError(response.status as 401 | 403 | 404);
    throw new ApiError(`GitHub refuse l’opération (${response.status}). Vérifiez les accès au dépôt.`, 502);
  }
  return response.status === 204 ? null : response.json();
}
export function updateRunner() {
  const repository = process.env.VIGIE_UPDATES_RUNNER_REPOSITORY || process.env.VIGIE_MAINTENANCE_RUNNER_REPOSITORY || "";
  const ref = process.env.VIGIE_UPDATES_RUNNER_REF || "main";
  return /^[\w.-]+\/[\w.-]+$/.test(repository) && ref === "main" && githubUpdateToken(repository) ? { repository, ref, token: githubUpdateToken(repository) } : null;
}
export async function dispatchUpdate(id: string, transport: typeof fetch = fetch) {
  const runner = updateRunner();
  if (!runner) throw new ApiError("Le service de mise à jour doit être activé une fois par un administrateur.", 503);
  await githubRequest(`/repos/${runner.repository}/actions/workflows/vigie-updates.yml/dispatches`, runner.token, "POST", { ref: runner.ref, inputs: { run_id: id } }, transport);
}
