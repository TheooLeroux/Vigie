import { claimHostingObservation } from "./hosting-storage";

// Both schedulers share the same lease. The primary ticks every five minutes.
// The fallback waits ten minutes since the last reservation before taking over.
const leaseMs = 4 * 60_000;
const fallbackGraceMs = 6 * 60_000;

export function claimScheduledMaintenance(source: "primary" | "fallback") {
  return claimHostingObservation("scheduled-maintenance", leaseMs, source === "fallback" ? fallbackGraceMs : 0);
}

const cycleJobs = [
  "agents", "wordpress-observations", "wordpress-security",
  "observations (o2switch)", "observations (railway)", "observations (vercel)",
  "providers (railway)", "providers (vercel)",
];

export async function recentSuccessfulPrimaryCycle(
  repository: string,
  branch: string,
  transport: typeof fetch = fetch,
) {
  return Boolean(await successfulPrimaryCycle(repository, branch, transport));
}

export async function successfulPrimaryCycle(
  repository: string,
  branch: string,
  transport: typeof fetch = fetch,
  evidence?: { revision: string; token: string },
): Promise<{ id: number; attempt: number; startedAt: number } | null> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !branch) return null;
  const windowMs = leaseMs + fallbackGraceMs - 60_000;
  const query = new URLSearchParams({
    branch, event: "workflow_dispatch", per_page: "30",
    created: `>=${new Date(Date.now() - windowMs).toISOString()}`,
  });
  const api = `https://api.github.com/repos/${repository}/actions`;
  const options: RequestInit = {
    headers: { Accept: "application/vnd.github+json", ...(evidence && { Authorization: `Bearer ${evidence.token}` }) },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  };
  try {
    const response = await transport(`${api}/workflows/vigie-wordpress-agents.yml/runs?${query}`, options);
    if (!response.ok) return null;
    const { workflow_runs: runs, total_count: total } = await response.json();
    if (!Array.isArray(runs) || total !== runs.length) return null;
    const primary = runs.filter(run =>
      run?.event === "workflow_dispatch" && run.head_branch === branch && run.display_title === "security-watch");
    if (primary.some(run => !Number.isFinite(Date.parse(run.created_at)))) return null;
    const latest = primary.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (latest?.status !== "completed" || latest.conclusion !== "success" ||
      !Number.isSafeInteger(latest.id) || !Number.isSafeInteger(latest.run_attempt)) return null;
    if (evidence && latest.head_sha !== evidence.revision) return null;
    const details = await transport(`${api}/runs/${latest.id}/attempts/${latest.run_attempt}/jobs?per_page=30`, options);
    if (!details.ok) return null;
    const { jobs } = await details.json();
    const startedAt = Date.parse(latest.created_at);
    const age = Date.now() - startedAt;
    // A project-scoped or installation-scoped dispatch can share the title.
    // Only a run that actually covered the fleet is sufficient evidence.
    return age >= 0 && age < windowMs && Array.isArray(jobs) &&
      cycleJobs.every(name => jobs.some(job => job?.name === name && job.conclusion === "success"))
      ? { id: latest.id, attempt: latest.run_attempt, startedAt } : null;
  } catch {
    return null;
  }
}
