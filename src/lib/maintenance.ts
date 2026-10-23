import { randomUUID } from "node:crypto";
import { z } from "zod";
import { auditActor } from "./audit-context";
import { database, get, list, log, transaction } from "./db";
import { ApiError } from "./http";
import { railwayState } from "./railway";
import { vercelState } from "./vercel";
import type { Project } from "./types";
import {
  GitHubMaintenanceClient,
  GitHubMaintenanceError,
} from "./connectors/github-maintenance";
import { maintenanceToken } from "./maintenance-credentials";
import { maintenanceNodeVersions } from "./connectors/software-releases";
import {
  compareStableVersions,
  latestMaintenanceOperation,
} from "./maintenance-latest";
import {
  dependencyBlocker,
  listedDependencies,
  nodeFileChanges,
  readMaintenanceFiles,
  updateManifest,
} from "./maintenance-files";
import {
  maintenanceBranch,
  operationSchema,
  repositorySchema,
  safeBranch,
  safeDirectory,
  shaSchema,
  versionSchema,
  type MaintenanceInspection,
  type MaintenanceJob,
  type MaintenancePayload,
  type MaintenanceState,
  type MaintenanceTarget,
} from "./maintenance-contract";

const workflow = "vigie-maintenance.yml";
function configuration() {
  const repositories = (process.env.VIGIE_MAINTENANCE_REPOSITORIES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const runner = process.env.VIGIE_MAINTENANCE_RUNNER_REPOSITORY || "";
  let requiredChecks: Record<string, string[]> = {};
  try {
    requiredChecks = z
      .record(
        repositorySchema,
        z.array(z.string().min(1).max(150)).min(1).max(30),
      )
      .parse(JSON.parse(process.env.VIGIE_MAINTENANCE_REQUIRED_CHECKS || "{}"));
  } catch {
    requiredChecks = {};
  }
  const issues: string[] = [];
  if (
    !process.env.VIGIE_MAINTENANCE_GITHUB_TOKEN &&
    !process.env.VIGIE_MAINTENANCE_GITHUB_TOKENS
  )
    issues.push("Jeton GitHub de maintenance absent côté serveur.");
  if (
    !repositories.length ||
    repositories.some(
      (repository) => !repositorySchema.safeParse(repository).success,
    )
  )
    issues.push("Liste explicite des dépôts autorisés absente ou invalide.");
  if (!repositorySchema.safeParse(runner).success)
    issues.push("Dépôt de l’exécuteur GitHub Actions non configuré.");
  else if (!maintenanceToken(runner))
    issues.push("Identifiant GitHub de l’exécuteur absent ou invalide.");
  let ref = process.env.VIGIE_MAINTENANCE_RUNNER_REF || "main";
  try {
    ref = safeBranch(ref);
  } catch {
    issues.push("Branche de l’exécuteur invalide.");
  }
  return {
    repositories,
    runner,
    ref,
    issues,
    requiredChecks,
    allowMerge: process.env.VIGIE_MAINTENANCE_ALLOW_MERGE === "true",
  };
}
function clientFor(repository: string, transport: typeof fetch) {
  const config = configuration();
  if (config.issues.length) throw new ApiError(config.issues.join(" "), 503);
  if (
    !config.repositories.some(
      (allowed) =>
        allowed.toLowerCase() ===
        repositorySchema.parse(repository).toLowerCase(),
    )
  )
    throw new ApiError(
      "Ce dépôt n’est pas explicitement autorisé pour la maintenance.",
      403,
    );
  const token = maintenanceToken(repository);
  if (!token)
    throw new ApiError(
      "Identifiant GitHub absent pour le propriétaire de ce dépôt.",
      503,
    );
  return new GitHubMaintenanceClient(token, transport);
}
function runnerClient(transport: typeof fetch) {
  const config = configuration();
  const token = maintenanceToken(config.runner);
  if (!token)
    throw new ApiError("Identifiant GitHub de l’exécuteur absent.", 503);
  return new GitHubMaintenanceClient(token, transport);
}
async function storage() {
  const db = database();
  await db.initialize(`CREATE TABLE IF NOT EXISTS maintenance_jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,repository TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS maintenance_project ON maintenance_jobs(project_id);
    CREATE TABLE IF NOT EXISTS maintenance_locks(repository TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES maintenance_jobs(id) ON DELETE CASCADE);
    CREATE TRIGGER IF NOT EXISTS maintenance_scope_insert BEFORE INSERT ON maintenance_jobs WHEN NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND workspace='live') BEGIN SELECT RAISE(ABORT,'Projet hors périmètre'); END;
    CREATE TRIGGER IF NOT EXISTS maintenance_scope_update BEFORE UPDATE OF project_id ON maintenance_jobs WHEN NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND workspace='live') BEGIN SELECT RAISE(ABORT,'Projet hors périmètre'); END;`);
  return db;
}
async function storedJob(id: string): Promise<MaintenanceJob> {
  const row = (await (
    await storage()
  )
    .prepare("SELECT data FROM maintenance_jobs WHERE id=?")
    .get(z.uuid().parse(id))) as { data: string } | undefined;
  if (!row) throw new ApiError("Opération de maintenance introuvable.", 404);
  const job = JSON.parse(row.data) as MaintenanceJob;
  if (!(await get<Project>("projects", job.projectId, "live")))
    throw new ApiError("Projet introuvable.", 404);
  return job;
}
async function saveJob(job: MaintenanceJob) {
  const terminal = ["merged", "closed"].includes(job.status);
  return transaction(async () => {
    const revision = job.revision;
    const updatedJob = { ...job, revision: revision + 1 };
    const updated = await (
      await storage()
    )
      .prepare(
        "UPDATE maintenance_jobs SET status=?,data=?,revision=? WHERE id=? AND revision=? AND (status NOT IN ('merged','closed') OR status=?)",
      )
      .run(
        job.status,
        JSON.stringify(updatedJob),
        updatedJob.revision,
        job.id,
        revision,
        job.status,
      );
    if (!updated.changes) return storedJob(job.id);
    if (terminal)
      await (
        await storage()
      )
        .prepare("DELETE FROM maintenance_locks WHERE job_id=?")
        .run(job.id);
    return updatedJob;
  });
}
export async function maintenanceTargets(): Promise<MaintenanceTarget[]> {
  const [projects, vercel, railway] = await Promise.all([
    list<Project>("projects", "live"),
    vercelState(),
    railwayState(),
  ]);
  const active = new Set(
    projects
      .filter((project) => project.lifecycle === "active")
      .map((project) => project.id),
  );
  const targets: MaintenanceTarget[] = [];
  for (const project of vercel.projects.filter(
    (project) =>
      project.projectId && active.has(project.projectId) && !project.excluded,
  )) {
    const production = project.production;
    targets.push({
      id: `vercel:${project.connectionId}:${project.id}`,
      projectId: project.projectId!,
      name: project.projectName || project.name,
      provider: "Vercel",
      repository: production?.repository || null,
      branch: production?.branch || null,
      commit: production?.commit || null,
      directory: production?.rootDirectory ?? project.rootDirectory ?? "",
      node: production?.nodeBranch || null,
      observedAt: project.observedAt,
      blocked: project.missingSince
        ? "Projet absent du dernier relevé."
        : !project.configured || project.connectionError
          ? "Connexion à l’hébergeur à revérifier."
          : !production?.repository || !production.branch || !production.commit
            ? "Source GitHub de production non identifiée ; aucune source configurée ne lui est substituée."
            : null,
    });
  }
  for (const project of railway.projects.filter(
    (project) => project.projectId && active.has(project.projectId),
  )) {
    for (const service of project.services) {
      const deployment = service.activeDeployments.find(
        (deployment) => deployment.status === "SUCCESS",
      );
      const evidence = deployment?.evidence;
      targets.push({
        id: `railway:${project.connectionId}:${project.id}:${service.environmentId}:${service.id}`,
        projectId: project.projectId!,
        name: `${project.projectName || project.name} / ${service.name}`,
        provider: "Railway",
        repository: evidence?.repository || null,
        branch: evidence?.branch || null,
        commit: evidence?.commit || null,
        directory: evidence?.rootDirectory || "",
        node:
          evidence?.packages.find((item) => item.name === "node")?.version ||
          null,
        observedAt: project.observedAt,
        blocked: project.missingSince
          ? "Projet absent du dernier relevé."
          : !project.configured || project.connectionError
            ? "Connexion à l’hébergeur à revérifier."
            : service.image
              ? "Image externe : ce parcours Git ne met pas à jour les images ni les bases."
              : !evidence?.repository || !evidence.branch || !evidence.commit
                ? "Aucune source GitHub attestée sur un déploiement réussi."
                : null,
      });
    }
  }
  return targets;
}
async function targetById(id: string) {
  const target = (await maintenanceTargets()).find(
    (target) => target.id === id,
  );
  if (!target) throw new ApiError("Cible de maintenance introuvable.", 404);
  const observedAt = Date.parse(target.observedAt);
  if (
    !Number.isFinite(observedAt) ||
    Date.now() - observedAt > 24 * 3600_000 ||
    observedAt > Date.now() + 60_000
  )
    throw new ApiError(
      "Relevé de l’hébergeur trop ancien ou invalide. Synchronisez la connexion avant de préparer ou publier une mise à jour.",
      409,
    );
  if (target.blocked) throw new ApiError(target.blocked, 409);
  repositorySchema.parse(target.repository);
  safeBranch(target.branch!);
  shaSchema.parse(target.commit);
  target.directory = safeDirectory(target.directory);
  return target;
}
export async function maintenanceState(): Promise<MaintenanceState> {
  const config = configuration();
  const jobs = (await (
    await storage()
  )
    .prepare("SELECT data FROM maintenance_jobs ORDER BY id")
    .all()) as { data: string }[];
  const targets = (await maintenanceTargets()).map((target) => ({
    ...target,
    blocked:
      target.blocked ||
      (!target.repository ||
      !config.repositories.some(
        (repository) =>
          repository.toLowerCase() === target.repository!.toLowerCase(),
      )
        ? "Dépôt non autorisé pour la maintenance."
        : null),
  }));
  return {
    configured: !config.issues.length,
    allowMerge: config.allowMerge,
    configurationIssues: config.issues,
    targets,
    jobs: jobs
      .map((row) => JSON.parse(row.data) as MaintenanceJob)
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt))
      .slice(0, 100),
  };
}
export async function inspectMaintenance(
  targetId: string,
  transport: typeof fetch = fetch,
): Promise<MaintenanceInspection> {
  const target = await targetById(targetId);
  const client = clientFor(target.repository!, transport);
  const baseSha = await client.branch(target.repository!, target.branch!);
  const snapshot = await readMaintenanceFiles(
    client,
    target.repository!,
    baseSha,
    target.directory,
  );
  let allVersions: string[];
  try {
    allVersions = await maintenanceNodeVersions(transport);
  } catch {
    throw new ApiError(
      "Catalogue officiel Node indisponible ; aucune version cible n’est inventée.",
      502,
    );
  }
  const current = Math.max(
    ...[
      target.node,
      snapshot.manifest.engines?.node,
      snapshot.manifest.volta?.node,
    ].map((value) => Number(String(value || "").match(/\d+/)?.[0] || 0)),
  );
  const nodeVersions = allVersions.filter(
    (version) =>
      Number(version.split(".")[0]) >= current &&
      (target.provider !== "Vercel" ||
        [22, 24].includes(Number(version.split(".")[0]))),
  );
  const warnings = [
    "Une PR ne met pas à jour le service tant qu’elle n’est pas fusionnée et déployée. Les migrations et effets externes ne sont pas annulés par un retour code.",
  ];
  if (baseSha !== target.commit)
    warnings.push(
      "La branche source a avancé depuis le déploiement observé. La PR partira de sa tête actuelle : vérifier aussi les changements déjà en attente.",
    );
  if (target.provider === "Railway")
    warnings.push(
      "Vérifier les priorités de configuration Railpack (notamment RAILPACK_NODE_VERSION) et l’état du fournisseur. Ce parcours ne modifie aucune variable Railway.",
    );
  if (target.directory)
    warnings.push(
      "Un monorepo peut déployer plusieurs services lors de la fusion ; vérifier la portée du dépôt entier.",
    );
  return {
    target,
    baseBranch: target.branch!,
    baseSha,
    deployedCommitMatches: baseSha === target.commit,
    manager: snapshot.manager,
    dependencies: listedDependencies(snapshot.manifest),
    nodeVersions,
    files: [...snapshot.files.keys()],
    warnings,
    dependencyBlocker: dependencyBlocker(snapshot),
  };
}
async function publicPackageRelease(
  name: string,
  version: string | undefined,
  transport: typeof fetch,
) {
  let response: Response;
  try {
    response = await transport(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/${version || "latest"}`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
        headers: { Accept: "application/json" },
      },
    );
  } catch {
    throw new ApiError("Registre npm indisponible.", 502);
  }
  if (!response.ok)
    throw new ApiError(
      "Version publique du composant introuvable. Les registres privés demandent une intégration dédiée.",
    );
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError("Réponse du registre vide.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > 1_000_000) {
      await reader.cancel();
      throw new ApiError("Réponse du registre trop volumineuse.");
    }
    chunks.push(next.value);
  }
  let release;
  try {
    release = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("Réponse du registre invalide.");
  }
  if (
    release.name !== name ||
    !versionSchema.safeParse(release.version).success ||
    (version && release.version !== version) ||
    release.deprecated
  )
    throw new ApiError(
      "Version non stable, dépréciée ou incohérente : aucune mise à jour proposée.",
    );
  return {
    name,
    version: release.version as string,
    node:
      typeof release.engines?.node === "string"
        ? release.engines.node.slice(0, 200)
        : null,
  };
}
export async function packageRelease(
  raw: unknown,
  transport: typeof fetch = fetch,
) {
  const input = z
    .object({
      targetId: z.string().max(500),
      name: z.string().max(200),
      version: versionSchema.optional(),
    })
    .strict()
    .parse(raw);
  const inspection = await inspectMaintenance(input.targetId, transport);
  if (
    !inspection.dependencies.some(
      (dependency) => dependency.name === input.name,
    )
  )
    throw new ApiError("Composant absent de la cible sélectionnée.");
  return publicPackageRelease(input.name, input.version, transport);
}
export async function createMaintenancePlan(
  raw: unknown,
  transport: typeof fetch = fetch,
) {
  const input = z
    .object({
      targetId: z.string().max(500),
      operation: operationSchema,
      rollbackJobId: z.uuid().optional(),
    })
    .strict()
    .parse(raw);
  const inspection = await inspectMaintenance(input.targetId, transport);
  const { target } = inspection;
  const client = clientFor(target.repository!, transport);
  const snapshot = await readMaintenanceFiles(
    client,
    target.repository!,
    inspection.baseSha,
    target.directory,
  );
  let files: string[] = [];
  if (input.operation.kind === "node" || input.operation.kind === "all") {
    if (!inspection.nodeVersions.includes(input.operation.version))
      throw new ApiError(
        "Sélectionnez une version LTS supportée proposée par le catalogue officiel.",
      );
    files = [
      ...nodeFileChanges(
        snapshot,
        input.operation.version,
        target.provider === "Railway" ? "exact" : "major",
      ).keys(),
    ];
    if (!files.length && input.operation.kind === "node")
      throw new ApiError(
        "Les fichiers ciblés déclarent déjà cette version ; aucune modification proposée.",
      );
  }
  if (input.operation.kind === "dependencies" || input.operation.kind === "all") {
    if (inspection.dependencyBlocker)
      throw new ApiError(inspection.dependencyBlocker);
    const next = updateManifest(snapshot.manifest, input.operation);
    if (
      JSON.stringify(next) === JSON.stringify(snapshot.manifest) &&
      !files.length
    )
      throw new ApiError(
        "Ces versions sont déjà déclarées ; aucune modification proposée.",
      );
    for (const update of input.operation.updates) {
      const release = await publicPackageRelease(
        update.name,
        update.version,
        transport,
      );
      if (release.node)
        inspection.warnings.push(
          `${release.name} ${release.version} requiert Node ${release.node}. Vérifier cette contrainte avec le runtime et les autres composants avant fusion.`,
        );
    }
    files = [...new Set([...files, snapshot.manifestPath, snapshot.lockPath!])];
  } else if (input.operation.kind === "rollback") {
    const previous = input.rollbackJobId
      ? await storedJob(input.rollbackJobId)
      : null;
    if (
      !previous ||
      previous.status !== "merged" ||
      previous.payload.operation.kind === "rollback" ||
      previous.payload.repository !== target.repository ||
      previous.targetId !== target.id ||
      previous.pullNumber !== input.operation.pullNumber
    )
      throw new ApiError(
        "Le retour doit viser une mise à jour Vigie fusionnée pour cette cible.",
      );
    files = previous.files;
    inspection.warnings.push(
      "Retour du code uniquement : aucune base, commande, transaction, tâche ni secret n’est restauré. Ne pas réintroduire de version vulnérable ou de secret révoqué.",
    );
  }
  const now = new Date();
  const job: MaintenanceJob = {
    id: randomUUID(),
    revision: 0,
    projectId: target.projectId,
    targetId: target.id,
    targetName: target.name,
    provider: target.provider,
    payload: {
      format: "vigie.maintenance.v1",
      id: "",
      repository: target.repository!,
      baseBranch: target.branch!,
      baseSha: inspection.baseSha,
      directory: target.directory,
      nodeMode: target.provider === "Railway" ? "exact" : "major",
      operation: input.operation,
    },
    status: "planned",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    actor: auditActor()?.email || "Administrateur",
    warnings: inspection.warnings,
    files,
  };
  job.payload.id = job.id;
  await (
    await storage()
  )
    .prepare(
      "INSERT INTO maintenance_jobs(id,project_id,repository,status,data) VALUES(?,?,?,?,?)",
    )
    .run(
      job.id,
      job.projectId,
      target.repository!.toLowerCase(),
      job.status,
      JSON.stringify(job),
    );
  await log(
    "live",
    "maintenance.planned",
    `Plan ${input.operation.kind} préparé pour ${target.name}.`,
    target.projectId,
  );
  return job;
}
export async function updateLatestMaintenance(
  raw: unknown,
  transport: typeof fetch = fetch,
) {
  const input = z
    .object({
      targetId: z.string().max(500),
      approved: z.literal(true),
    })
    .strict()
    .parse(raw);
  const inspection = await inspectMaintenance(input.targetId, transport);
  const db = await storage();
  const lock = (await db
    .prepare("SELECT job_id FROM maintenance_locks WHERE repository=?")
    .get(inspection.target.repository!.toLowerCase())) as
    | { job_id: string }
    | undefined;
  if (lock) {
    const existing = await storedJob(lock.job_id);
    if (existing.targetId !== input.targetId)
      throw new ApiError(
        "Une mise à jour est déjà en cours sur un autre service de ce dépôt.",
        409,
      );
    return { job: existing, current: false, existing: true };
  }
  const client = clientFor(inspection.target.repository!, transport);
  const snapshot = await readMaintenanceFiles(
    client,
    inspection.target.repository!,
    inspection.baseSha,
    inspection.target.directory,
  );
  if (
    inspection.target.provider === "Railway" &&
    snapshot.tree.some((entry) => {
      const directory = entry.path.split("/").slice(0, -1).join("/");
      return (
        /(?:^|\/)Dockerfile(?:\.[A-Za-z0-9_-]+)?$/.test(entry.path) &&
        (!directory || directory === inspection.target.directory ||
          inspection.target.directory.startsWith(`${directory}/`))
      );
    })
  )
    throw new ApiError(
      "Un Dockerfile peut imposer la version Node. Cette configuration doit être qualifiée avant la mise à jour en un clic ; aucune modification n’est lancée.",
    );
  const operation = await latestMaintenanceOperation(
    inspection,
    (name) => publicPackageRelease(name, undefined, transport),
  );
  const runtime = snapshot.manifest.devEngines?.runtime;
  const runtimes = Array.isArray(runtime) ? runtime : [runtime];
  const currentVersions = [
    inspection.target.node,
    snapshot.manifest.volta?.node,
    snapshot.manifest.engines?.node,
    ...runtimes.filter((item) => item?.name === "node").map((item) => item.version),
    ...[...snapshot.files].filter(([path]) =>
      /(?:^|\/)(?:\.nvmrc|\.node-version)$/.test(path),
    ).map(([, content]) => content.trim().replace(/^v/, "")),
  ];
  for (const candidate of currentVersions) {
    if (
      typeof candidate === "string" && /^\d+\.\d+\.\d+$/.test(candidate) &&
      compareStableVersions(candidate, operation.version) > 0
    )
      throw new ApiError(
        "La version Node actuelle est plus récente que la cible LTS proposée. Aucun retour à une version antérieure n’est effectué.",
      );
  }
  const nodeChanges = nodeFileChanges(
    snapshot,
    operation.version,
    inspection.target.provider === "Railway" ? "exact" : "major",
  );
  if (!operation.updates.length && !nodeChanges.size)
    return { job: null, current: true, existing: false };
  const job = await createMaintenancePlan(
    { targetId: input.targetId, operation },
    transport,
  );
  if (job.payload.baseSha !== inspection.baseSha)
    throw new ApiError("La branche a changé pendant la recherche des versions. Relancez l’analyse.", 409);
  return {
    job: await approveMaintenance(job.id, { approved: true }, transport),
    current: false,
    existing: false,
  };
}
export async function approveMaintenance(
  id: string,
  raw: unknown,
  transport: typeof fetch = fetch,
) {
  z.object({ approved: z.literal(true) })
    .strict()
    .parse(raw);
  const job = await storedJob(id);
  if (job.status !== "planned") return job;
  if (job.expiresAt <= new Date().toISOString())
    throw new ApiError("Plan expiré. Préparez une nouvelle proposition.", 409);
  const target = await targetById(job.targetId);
  if (
    target.repository !== job.payload.repository ||
    target.branch !== job.payload.baseBranch ||
    target.directory !== job.payload.directory
  )
    throw new ApiError("La cible ou sa source a changé. Recréez le plan.", 409);
  const client = clientFor(job.payload.repository, transport);
  if (
    (await client.branch(job.payload.repository, job.payload.baseBranch)) !==
    job.payload.baseSha
  )
    throw new ApiError(
      "La branche a changé. Recréez le plan pour revoir les changements.",
      409,
    );
  const config = configuration();
  const executor = runnerClient(transport);
  const runner = await executor.request(
    `${executor.repo(config.runner)}/actions/workflows/${workflow}`,
  );
  if (
    runner.state !== "active" ||
    runner.path !== `.github/workflows/${workflow}`
  )
    throw new ApiError("Exécuteur de maintenance absent ou désactivé.", 503);
  job.status = "dispatching";
  await transaction(async () => {
    const db = await storage();
    const previousRevision = job.revision++;
    const claimed = await db
      .prepare(
        "UPDATE maintenance_jobs SET status=?,data=?,revision=? WHERE id=? AND status='planned' AND revision=?",
      )
      .run(
        job.status,
        JSON.stringify(job),
        job.revision,
        job.id,
        previousRevision,
      );
    if (!claimed.changes) throw new ApiError("Ce plan a déjà été envoyé.", 409);
    const lock = await db
      .prepare(
        "INSERT INTO maintenance_locks(repository,job_id) VALUES(?,?) ON CONFLICT(repository) DO NOTHING",
      )
      .run(job.payload.repository.toLowerCase(), job.id);
    if (!lock.changes)
      throw new ApiError(
        "Une maintenance est déjà en cours sur ce dépôt, éventuellement pour un autre service.",
        409,
      );
  });
  try {
    await executor.request(
      `${executor.repo(config.runner)}/actions/workflows/${workflow}/dispatches`,
      "POST",
      {
        ref: config.ref,
        inputs: { job: JSON.stringify(job.payload) },
        return_run_details: true,
      },
    );
    job.status = "queued";
  } catch (error) {
    if (error instanceof GitHubMaintenanceError && error.definitive) {
      job.status = "failed";
      job.dispatchRejected = true;
      job.error =
        "GitHub a refusé l’envoi. Corrigez les permissions puis fermez ce plan avant d’en créer un autre.";
    } else
      job.error =
        "Envoi incertain. Actualisez le suivi ; le verrou est conservé pour éviter une double exécution.";
  }
  const saved = await saveJob(job);
  await log(
    "live",
    "maintenance.approved",
    `Préparation approuvée et envoyée à l’exécuteur pour ${job.targetName}.`,
    job.projectId,
  );
  return saved;
}
async function workflowRun(job: MaintenanceJob, transport: typeof fetch) {
  const config = configuration();
  const client = runnerClient(transport);
  const result = job.runId
    ? {
        workflow_runs: [
          await client.request(
            `${client.repo(config.runner)}/actions/runs/${job.runId}`,
          ),
        ],
      }
    : await client.request(
        `${client.repo(config.runner)}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100`,
      );
  const runs = result.workflow_runs;
  if (!Array.isArray(runs))
    throw new ApiError("Suivi de l’exécuteur illisible.", 502);
  const run = runs.find(
    (run: any) =>
      run.display_title === `vigie-maintenance-${job.id}` &&
      Number.isSafeInteger(run.id),
  );
  if (run) {
    job.runId = run.id;
    job.runUrl = `https://github.com/${config.runner}/actions/runs/${run.id}`;
  }
  return run;
}
async function pullState(job: MaintenanceJob, client: GitHubMaintenanceClient) {
  if (job.pullNumber)
    return client.request(
      `${client.repo(job.payload.repository)}/pulls/${job.pullNumber}`,
    );
  const pulls = await client.request(
    `${client.repo(job.payload.repository)}/pulls?state=all&head=${encodeURIComponent(`${job.payload.repository.split("/")[0]}:${maintenanceBranch(job.id)}`)}&per_page=10`,
  );
  if (!Array.isArray(pulls) || pulls.length > 1)
    throw new ApiError("Pull request de maintenance ambiguë.", 409);
  return pulls.length
    ? client.request(
        `${client.repo(job.payload.repository)}/pulls/${pulls[0].number}`,
      )
    : null;
}
function validatePull(job: MaintenanceJob, pull: any) {
  if (
    pull.base?.ref !== job.payload.baseBranch ||
    pull.head?.ref !== maintenanceBranch(job.id) ||
    pull.head?.repo?.full_name?.toLowerCase() !==
      job.payload.repository.toLowerCase() ||
    !Number.isSafeInteger(pull.number) ||
    !shaSchema.safeParse(pull.head.sha).success ||
    !String(pull.body || "").includes(`Vigie maintenance job ${job.id}`)
  )
    throw new ApiError(
      "La pull request ne correspond pas au plan approuvé.",
      409,
    );
  if (job.headSha && job.headSha !== pull.head.sha)
    throw new ApiError(
      "La pull request a été modifiée après sa prise en compte. Vérifiez-la manuellement dans GitHub ; la fusion depuis Vigie est bloquée.",
      409,
    );
  job.pullNumber = pull.number;
  job.pullUrl = `https://github.com/${job.payload.repository}/pull/${pull.number}`;
  job.headSha = pull.head.sha;
}
async function validatePullFiles(
  job: MaintenanceJob,
  pull: any,
  client: GitHubMaintenanceClient,
) {
  const files = await client.request(
    `${client.repo(job.payload.repository)}/pulls/${pull.number}/files?per_page=100`,
  );
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.length !== pull.changed_files ||
    files.length !== job.files.length ||
    files.some(
      (file: any) =>
        file.status !== "modified" || !job.files.includes(file.filename),
    )
  )
    throw new ApiError(
      "Le contenu de la PR ne correspond pas à la portée du plan. Fusion depuis Vigie bloquée.",
      409,
    );
  const commit = await client.request(
    `${client.repo(job.payload.repository)}/git/commits/${pull.head.sha}`,
  );
  if (
    commit.parents?.length !== 1 ||
    commit.parents[0].sha !== job.payload.baseSha ||
    !String(commit.message || "").includes(`Vigie maintenance job ${job.id}`)
  )
    throw new ApiError("Historique de PR différent du plan approuvé.", 409);
}
export async function refreshMaintenance(
  id: string,
  transport: typeof fetch = fetch,
) {
  const job = await storedJob(id);
  if (job.status === "planned") return job;
  const client = clientFor(job.payload.repository, transport);
  const [pull, run] = await Promise.all([
    pullState(job, client),
    workflowRun(job, transport),
  ]);
  job.canMerge = false;
  if (pull) {
    validatePull(job, pull);
    await validatePullFiles(job, pull, client);
    job.error = undefined;
    if (pull.merged) {
      job.status = "merged";
      job.mergeSha = shaSchema.parse(pull.merge_commit_sha);
      job.deployment = "not-verified";
      const target = (await maintenanceTargets()).find(
        (target) => target.id === job.targetId,
      );
      if (target?.commit === job.mergeSha) job.deployment = "observed";
    } else if (pull.state === "closed") job.status = "closed";
    else {
      if (job.status === "merging") {
        if (job.mergeRequestId) {
          const result = await client.request(
            `${client.repo(job.payload.repository)}/pulls/${job.pullNumber}/merge-async/${job.mergeRequestId}`,
            "GET",
            undefined,
            true,
          );
          if (result?.status === "failed") {
            job.status = "pull_request";
            job.mergeRequestId = undefined;
            job.error =
              "GitHub a refusé la fusion asynchrone. Vérifiez les protections et les contrôles avant une nouvelle demande.";
          }
        }
        job.canMerge = false;
        job.mergeBlocker =
          "Fusion demandée ou mise en file. Actualisez le suivi GitHub ; aucune fusion n’est présumée réussie.";
        return saveJob(job);
      }
      job.status = "pull_request";
      let checks, statuses;
      try {
        [checks, statuses] = await Promise.all([
          client.request(
            `${client.repo(job.payload.repository)}/commits/${job.headSha}/check-runs?per_page=100&filter=latest`,
          ),
          client.request(
            `${client.repo(job.payload.repository)}/commits/${job.headSha}/status?per_page=100`,
          ),
        ]);
      } catch (error) {
        if (
          !(error instanceof GitHubMaintenanceError) ||
          ![401, 403].includes(error.responseStatus || 0)
        )
          throw error;
        job.checks = [];
        job.error =
          "La PR est créée, mais GitHub refuse la lecture des contrôles CI. Vérifiez les droits Checks et Commit statuses ; ce type de jeton peut nécessiter une intégration GitHub App pour les contrôles.";
        job.mergeBlocker =
          "Contrôles CI non vérifiables : aucune fusion depuis Vigie autorisée.";
        return saveJob(job);
      }
      if (
        !Array.isArray(checks.check_runs) ||
        !Array.isArray(statuses.statuses) ||
        !Number.isSafeInteger(checks.total_count) ||
        !Number.isSafeInteger(statuses.total_count)
      )
        throw new ApiError("Contrôles GitHub illisibles.", 502);
      job.checks = [
        ...checks.check_runs.map((check: any) => ({
          name: String(check.name).slice(0, 150),
          state:
            check.status === "completed"
              ? String(check.conclusion)
              : String(check.status),
        })),
        ...statuses.statuses.map((status: any) => ({
          name: String(status.context).slice(0, 150),
          state: String(status.state),
        })),
      ];
      const requiredChecks =
        Object.entries(configuration().requiredChecks).find(
          ([repository]) =>
            repository.toLowerCase() === job.payload.repository.toLowerCase(),
        )?.[1] || [];
      job.mergeBlocker = !configuration().allowMerge
        ? "Fusion depuis Vigie non activée côté serveur."
        : !run || run.status !== "completed" || run.conclusion !== "success"
          ? "L’exécuteur doit terminer avec succès."
          : checks.total_count > 100 ||
              statuses.total_count > 100 ||
              checks.total_count !== checks.check_runs.length ||
              statuses.total_count !== statuses.statuses.length
            ? "Contrôles tronqués : revue manuelle requise."
            : !job.checks.length
              ? "Aucun contrôle CI : fusion depuis Vigie bloquée."
              : !requiredChecks.length ||
                  requiredChecks.some(
                    (name) =>
                      !job.checks!.some(
                        (check) =>
                          check.name === name && check.state === "success",
                      ),
                  )
                ? "Les contrôles requis pour ce dépôt doivent être configurés côté serveur et réussir."
                : job.checks.some((check) => check.state !== "success")
                  ? "Tous les contrôles doivent réussir."
                  : pull.draft ||
                      pull.mergeable !== true ||
                      pull.mergeable_state !== "clean"
                    ? "GitHub ne confirme pas une fusion sans conflit ni restriction."
                    : undefined;
      job.canMerge = !job.mergeBlocker;
    }
  } else if (run?.status === "completed") {
    job.status = "failed";
    job.error =
      run.conclusion === "success"
        ? "L’exécuteur a terminé sans pull request identifiable. Vérifiez son résultat."
        : "La préparation a échoué ou a été arrêtée. Consultez l’exécution GitHub ; aucune fusion n’a été effectuée par Vigie.";
  }
  return saveJob(job);
}
export async function mergeMaintenance(
  id: string,
  raw: unknown,
  transport: typeof fetch = fetch,
) {
  const input = z
    .object({
      confirmed: z.literal(true),
      previewReviewed: z.literal(true),
      returnReviewed: z.literal(true),
      expectedHead: shaSchema,
    })
    .strict()
    .parse(raw);
  const job = await refreshMaintenance(id, transport);
  if (
    job.status !== "pull_request" ||
    !job.canMerge ||
    input.expectedHead !== job.headSha
  )
    throw new ApiError(
      job.mergeBlocker || "Cette version de la PR n’est pas publiable.",
      409,
    );
  const target = await targetById(job.targetId);
  if (
    target.repository !== job.payload.repository ||
    target.branch !== job.payload.baseBranch
  )
    throw new ApiError("La source du projet a changé.", 409);
  const client = clientFor(job.payload.repository, transport);
  if (
    (await client.branch(job.payload.repository, job.payload.baseBranch)) !==
    job.payload.baseSha
  )
    throw new ApiError(
      "La branche de destination a changé. Fermez ce plan et préparez une nouvelle PR.",
      409,
    );
  job.status = "merging";
  job.canMerge = false;
  const previousRevision = job.revision++;
  const claimed = await (
    await storage()
  )
    .prepare(
      "UPDATE maintenance_jobs SET status=?,data=?,revision=? WHERE id=? AND status='pull_request' AND revision=?",
    )
    .run(
      job.status,
      JSON.stringify(job),
      job.revision,
      job.id,
      previousRevision,
    );
  if (!claimed.changes)
    throw new ApiError("Une autre action est déjà en cours sur cette PR.", 409);
  try {
    const result = await client.request(
      `${client.repo(job.payload.repository)}/pulls/${job.pullNumber}/merge-async`,
      "PUT",
      {
        sha: job.headSha,
        merge_method: "squash",
        merge_action: "default",
        bypass_rules: false,
      },
    );
    if (result.status === "merged") {
      job.status = "merged";
      job.mergeSha = shaSchema.parse(result.details?.sha);
      job.deployment = "not-verified";
    } else {
      const identifier = result.details?.uuid || result.uuid;
      job.mergeRequestId = z.uuid().safeParse(identifier).success
        ? identifier
        : undefined;
      job.mergeBlocker =
        "Fusion demandée ou mise en file ; confirmation GitHub attendue.";
    }
  } catch (error) {
    if (error instanceof GitHubMaintenanceError && error.definitive) {
      job.status = "pull_request";
      job.error =
        "GitHub a refusé la demande de fusion. Actualisez les contrôles avant de réessayer.";
    } else
      job.error =
        "Résultat de fusion incertain. Le verrou est conservé ; vérifiez GitHub avant toute nouvelle action.";
  }
  const saved = await saveJob(job);
  await log(
    "live",
    "maintenance.publication",
    `Publication de la PR #${job.pullNumber} demandée pour ${job.targetName}. Fusion et déploiement à vérifier séparément.`,
    job.projectId,
  );
  return saved;
}
export async function closeMaintenance(
  id: string,
  transport: typeof fetch = fetch,
) {
  let job = await storedJob(id);
  const client = clientFor(job.payload.repository, transport);
  if (job.status !== "planned") {
    job = await refreshMaintenance(id, transport);
    if (job.status === "merged")
      throw new ApiError(
        "Une fusion ne s’annule pas en fermant le plan. Préparez un retour code.",
        409,
      );
    if (job.status === "merging")
      throw new ApiError(
        "Une fusion a été engagée. Vérifiez son état dans GitHub avant toute fermeture.",
        409,
      );
    const run = await workflowRun(job, transport);
    if ((!run || run.status !== "completed") && !job.dispatchRejected) {
      if (!run)
        throw new ApiError(
          "Exécution distante non identifiée ; verrou conservé. Revérifiez le suivi GitHub.",
          409,
        );
      const executor = runnerClient(transport);
      await executor.request(
        `${executor.repo(configuration().runner)}/actions/runs/${run.id}/cancel`,
        "POST",
      );
      job.error =
        "Arrêt demandé ; actualisez après la fin de l’exécution pour confirmer la fermeture.";
      return saveJob(job);
    }
    if (job.pullNumber && job.status === "pull_request")
      await client.request(
        `${client.repo(job.payload.repository)}/pulls/${job.pullNumber}`,
        "PATCH",
        { state: "closed" },
      );
  }
  job.status = "closed";
  job.canMerge = false;
  const saved = await saveJob(job);
  await log(
    "live",
    "maintenance.closed",
    `Préparation fermée pour ${job.targetName} ; aucune donnée restaurée.`,
    job.projectId,
  );
  return saved;
}
