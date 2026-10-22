import { z } from "zod";
import { ApiError } from "../http";
import { githubRepository } from "./railway-evidence";
import {
  vercelExcluded,
  vercelSuggestedClient,
} from "../vercel-client-mapping";
import { nodeBranchInfo } from "./software-releases";
import {
  analyzeVercelBuild,
  runtimeEvidence,
  enrichVercelTechnologies,
} from "./vercel-analysis";
import type { VercelDeployment, VercelProject } from "../vercel-types";
const teamIdSchema = z.string().regex(/^team_[a-zA-Z0-9]+$/),
  projectIdSchema = z.string().regex(/^prj_[a-zA-Z0-9]+$/),
  deploymentIdSchema = z.string().regex(/^dpl_[a-zA-Z0-9]+$/);
function object(v: unknown): Record<string, any> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : {};
}
function text(v: unknown, max = 250) {
  return typeof v === "string" && v.length <= max && !/[\u0000-\u001f]/.test(v)
    ? v
    : null;
}
function branch(v: unknown) {
  return typeof v === "string" && /^\d{1,2}\.x$/.test(v) ? v : null;
}
function domain(v: unknown) {
  return typeof v === "string" &&
    /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])$/.test(v) &&
    v.includes(".")
    ? v.toLowerCase()
    : null;
}
function date(v: unknown) {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 8.64e15)
    throw new ApiError("Date Vercel invalide.", 502);
  return new Date(v).toISOString();
}
function git(raw: Record<string, any>) {
  const meta = object(raw.meta),
    source = object(raw.gitSource);
  return {
    repository: githubRepository(
      meta.githubCommitOrg && meta.githubCommitRepo
        ? `${meta.githubCommitOrg}/${meta.githubCommitRepo}`
        : null,
    ),
    branch: text(source.ref) || text(meta.githubCommitRef),
    commit:
      typeof (source.sha || meta.githubCommitSha) === "string" &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(
        source.sha || meta.githubCommitSha,
      )
        ? source.sha || meta.githubCommitSha
        : null,
  };
}
export function vercelDeployment(raw: unknown): VercelDeployment {
  const d = object(raw),
    settings = object(d.projectSettings),
    host = domain(d.url),
    state = text(d.readyState || d.state, 40);
  if (!state) throw new ApiError("État du déploiement Vercel manquant.", 502);
  return {
    id: deploymentIdSchema.parse(d.id || d.uid),
    url: host ? `https://${host}` : null,
    state,
    target: text(d.target, 60),
    createdAt: date(d.createdAt ?? d.created),
    framework: text(settings.framework, 80),
    nodeBranch: branch(settings.nodeVersion),
    rootDirectory: text(settings.rootDirectory, 1000),
    ...git(d),
    regions: Array.isArray(d.regions)
      ? d.regions
          .filter(
            (v: unknown) =>
              typeof v === "string" && /^[a-z0-9-]{2,40}$/.test(v),
          )
          .slice(0, 100)
      : [],
  };
}
function projectBase(
  raw: unknown,
  team: { id: string; slug: string; name: string },
): VercelProject {
  const p = object(raw),
    id = projectIdSchema.parse(p.id),
    name = z
      .string()
      .min(1)
      .max(150)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .parse(p.name);
  if (p.accountId !== team.id)
    throw new ApiError("Projet Vercel hors de l’équipe sélectionnée.", 502);
  const excluded = vercelExcluded(team.id, name),
    link = object(p.link);
  return {
    id,
    name,
    teamId: team.id,
    teamSlug: team.slug,
    teamName: team.name,
    excluded,
    clientSuggestion: vercelSuggestedClient(team.id, name, []),
    framework: excluded ? null : text(p.framework, 80),
    nodeBranch: excluded ? null : branch(p.nodeVersion),
    rootDirectory: excluded ? null : text(p.rootDirectory, 1000),
    repository:
      !excluded && link.type === "github"
        ? githubRepository(`${link.org}/${link.repo}`)
        : null,
    productionBranch: excluded ? null : text(link.productionBranch),
    domains: [],
    production: null,
    latest: null,
  };
}
async function readJson(r: Response) {
  if (!r.body) throw new ApiError("Réponse Vercel vide.", 502);
  const reader = r.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > 8_000_000) {
      await reader.cancel();
      throw new ApiError("Réponse Vercel trop volumineuse.", 502);
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("Réponse Vercel illisible.", 502);
  }
}
export async function collectVercel(
  teamId: string,
  token: string,
  transport: typeof fetch = fetch,
): Promise<VercelProject[]> {
  teamIdSchema.parse(teamId);
  const abort = new AbortController(),
    signal = AbortSignal.any([AbortSignal.timeout(120_000), abort.signal]);
  async function get(path: string, query: Record<string, string> = {}) {
    // Fixed internal routes only. Never follow URLs supplied by the API or caller.
    if (
      !/^\/v(?:2\/teams\/team_[a-zA-Z0-9]+|10\/projects|9\/projects\/prj_[a-zA-Z0-9]+\/domains|13\/deployments\/dpl_[a-zA-Z0-9]+|3\/deployments\/dpl_[a-zA-Z0-9]+\/events|6\/deployments)$/.test(
        path,
      )
    )
      throw new ApiError("Lecture Vercel non autorisée.", 500);
    const url = new URL(path, "https://api.vercel.com");
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    const r = await transport(url.href, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "Vigie/1.0",
      },
    });
    if (r.status === 401 || r.status === 403)
      throw new ApiError(
        "Vercel refuse le jeton ou l’accès à cette équipe.",
        502,
      );
    if (r.status === 429)
      throw new ApiError(
        "Limite API Vercel atteinte. Réessayez dans quelques minutes.",
        429,
      );
    if (!r.ok)
      throw new ApiError(
        `Lecture Vercel impossible (HTTP ${r.status}). Le dernier relevé est conservé.`,
        502,
      );
    const data = await readJson(r);
    if (data.error)
      throw new ApiError(
        "Vercel a refusé la lecture. Le dernier relevé est conservé.",
        502,
      );
    return data;
  }
  try {
    const rawTeam = await get("/v2/teams/" + teamId),
      team = z
        .object({
          id: teamIdSchema,
          slug: z
            .string()
            .min(1)
            .max(150)
            .regex(/^[a-zA-Z0-9_-]+$/),
          name: z.string().min(1).max(250),
        })
        .parse(rawTeam);
    if (team.id !== teamId)
      throw new ApiError("Équipe Vercel inattendue.", 502);
    const rawProjects: Record<string, any>[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const raw = await get("/v10/projects", {
        teamId,
        limit: "50",
        ...(cursor ? { until: cursor } : {}),
      });
      if (
        !Array.isArray(raw.projects) ||
        raw.projects.length > 50 ||
        !raw.pagination ||
        !Object.hasOwn(raw.pagination, "next")
      )
        throw new ApiError("Liste Vercel incomplète.", 502);
      for (const p of raw.projects) {
        const base = projectBase(p, team);
        if (seen.has(base.id))
          throw new ApiError("Pagination Vercel incohérente.", 502);
        seen.add(base.id);
        rawProjects.push(p);
      }
      const next = raw.pagination.next;
      if (next === null) break;
      if (
        typeof next !== "number" ||
        !Number.isSafeInteger(next) ||
        String(next) === cursor ||
        page === 9
      )
        throw new ApiError(
          "Pagination Vercel incohérente ou limite de 500 projets atteinte.",
          502,
        );
      cursor = String(next);
    }
    const results = new Array<VercelProject>(rawProjects.length);
    let index = 0;
    async function worker() {
      while (index < rawProjects.length) {
        const slot = index++,
          raw = rawProjects[slot],
          p = projectBase(raw, team);
        results[slot] = p;
        if (p.excluded) continue;
        const domains: VercelProject["domains"] = [];
        let until: string | null = null;
        for (let page = 0; page < 10; page++) {
          const r = await get(`/v9/projects/${p.id}/domains`, {
            teamId,
            limit: "100",
            ...(until ? { until } : {}),
          });
          if (
            !Array.isArray(r.domains) ||
            !r.pagination ||
            !Object.hasOwn(r.pagination, "next")
          )
            throw new ApiError("Liste des domaines Vercel incomplète.", 502);
          for (const item of r.domains) {
            const name = domain(item.name);
            if (!name) throw new ApiError("Domaine Vercel invalide.", 502);
            domains.push({
              name,
              verified: item.verified === true,
              redirect: domain(item.redirect),
              environment: item.customEnvironmentId
                ? "custom"
                : item.gitBranch
                  ? "preview"
                  : "production",
            });
          }
          if (r.pagination.next === null) break;
          if (
            typeof r.pagination.next !== "number" ||
            String(r.pagination.next) === until ||
            page === 9
          )
            throw new ApiError(
              "Pagination des domaines Vercel incohérente.",
              502,
            );
          until = String(r.pagination.next);
        }
        p.domains = domains;
        p.clientSuggestion = vercelSuggestedClient(
          teamId,
          p.name,
          domains.map((d) => d.name),
        );
        const target = object(object(raw.targets).production),
          productionId = target.id || target.uid;
        if (productionId) {
          deploymentIdSchema.parse(productionId);
          const r = await get("/v13/deployments/" + productionId, {
            teamId,
            withGitRepoInfo: "true",
          });
          if (
            r.id !== productionId ||
            r.projectId !== p.id ||
            r.ownerId !== teamId
          )
            throw new ApiError("Déploiement Vercel hors périmètre.", 502);
          p.production = vercelDeployment(r);
          const runtimes = runtimeEvidence(object(r.meta).lambdaRuntimeStats);
          try {
            // Historical build only, never runtime request logs or a live stream.
            const events = await get(`/v3/deployments/${productionId}/events`, {
              teamId,
              direction: "forward",
              limit: "1000",
              follow: "0",
              builds: "1",
            });
            p.production.analysis = analyzeVercelBuild(events, runtimes);
          } catch {
            p.production.analysis = analyzeVercelBuild(null, runtimes);
          }
        }
        const recent = await get("/v6/deployments", {
          teamId,
          projectId: p.id,
          limit: "1",
        });
        if (!Array.isArray(recent.deployments) || recent.deployments.length > 1)
          throw new ApiError("Liste des déploiements Vercel invalide.", 502);
        if (recent.deployments.length) {
          const latest = recent.deployments[0];
          if (latest.projectId && latest.projectId !== p.id)
            throw new ApiError("Déploiement Vercel hors projet.", 502);
          const d = vercelDeployment(latest);
          p.latest = d.id === p.production?.id ? p.production : d;
        }
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    const branches = [
      ...new Set(
        results.flatMap((p) =>
          [p.nodeBranch, p.production?.nodeBranch].filter(
            (v): v is string => !!v,
          ),
        ),
      ),
    ];
    const releases = new Map<
      string,
      Awaited<ReturnType<typeof nodeBranchInfo>>
    >();
    for (const b of branches)
      releases.set(b, await nodeBranchInfo(b, transport));
    for (const p of results) {
      if (p.production?.nodeBranch)
        p.production.nodeRelease =
          releases.get(p.production.nodeBranch) || null;
    }
    await enrichVercelTechnologies(
      results.flatMap((p) =>
        p.production?.analysis ? [p.production.analysis] : [],
      ),
      transport,
    );
    return results;
  } catch (e) {
    abort.abort();
    if (e instanceof ApiError) throw e;
    throw new ApiError(
      "Le relevé Vercel est incomplet ou la connexion a échoué. Le dernier relevé est conservé.",
      502,
    );
  }
}
