import { gt, valid } from "semver";
import { railwayRuntimeDeployments } from "./railway-status";
import type { SoftwareRelease } from "./railway-types";
import type { ProjectDetail, SiteInventory } from "./types";
import { activeUpdateStages, type SecurityFinding, type UpdateCheck, type UpdateState } from "./updates/types";

export type ProjectHealth = {
  security: string[];
  updates: string[];
  securityKnown: boolean;
  versionsKnown: boolean;
  incomplete: boolean;
  running: boolean;
  attention: boolean;
  securityFromScan: boolean;
};

function installedWordPressFinding(inventory: SiteInventory, finding: SecurityFinding) {
  const [kind, slug] = finding.package.split("/");
  if (kind === "wordpresses") return inventory.wordpress?.version === finding.version;
  if (kind === "plugins" || kind === "themes") return inventory[kind].some(item => item.slug === slug && item.version === finding.version);
  return false;
}

// Read existing observations only. A rejected candidate never describes the
// deployed site; accepted Node scans must match its active image identity.
export function projectHealth(detail: ProjectDetail, state?: UpdateState | null): ProjectHealth {
  const security = new Map<string, string>(), updates = new Map<string, string>();
  let securityKnown = false, versionsKnown = false, incomplete = false;
  let securityFromScan = false;
  const latest = state?.runs.find(run => run.projectId === detail.project.id);
  const addRelease = (id: string, name: string, version: string, release?: SoftwareRelease) => {
    if (!release) { incomplete = true; return; }
    if (release.securityUpdate !== null || release.supported === false) securityKnown = true;
    if (release.state === "current" || release.state === "available") versionsKnown = true;
    else incomplete = true;
    if (release.securityUpdate) security.set(id + ":security", `${name} ${version} : correctif de sécurité manquant.`);
    if (release.supported === false) security.set(id + ":support", `${name} ${version} : version en fin de support.`);
    const lts = name.includes("Node") && release.latestLts && ((valid(version) && valid(release.latestLts) && gt(release.latestLts, version)) || (/^\d+\.x$/.test(version) && Number(release.latestLts.split(".")[0]) > Number(version.split(".")[0])));
    if (release.state === "available" || release.supported === false || lts) {
      const next = lts ? release.latestLts : release.latestVersion;
      updates.set(id, `${name} : ${version}${next ? ` → ${next}` : " à actualiser"}.`);
      versionsKnown = true;
    }
  };
  for (const project of detail.railway || []) {
    if (project.connectionError || project.missingSince) incomplete = true;
    for (const service of project.services) {
      const active = railwayRuntimeDeployments(service);
      const result = latest?.results.find(result => latest.targets.some(target => target.id === result.targetId && target.connectionId === project.connectionId && target.remoteId === service.id && target.environmentId === service.environmentId));
      const proof = result?.checks?.findLast(check => check.tool === "Node" && check.phase === "after" && check.status === "passed");
      if (proof?.nodeEvidence && Date.parse(proof.checkedAt) > Date.parse(project.observedAt) && !active.some(deployment => deployment.id === proof.nodeEvidence!.deploymentId && deployment.evidence?.imageDigest === proof.nodeEvidence!.imageDigest)) {
        incomplete = true;
        continue; // The deployment changed; don't reannounce the old missing patch.
      }
      if (!active.length) incomplete = true;
      for (const deployment of active) {
        if (!deployment.evidence?.packages.length) incomplete = true;
        for (const pkg of deployment.evidence?.packages || []) addRelease(`${project.connectionId}:${service.id}:${service.environmentId}:${deployment.id}:${pkg.name}`, `${service.name} · ${pkg.name === "node" ? "Node.js" : pkg.name}`, pkg.version, pkg.release);
      }
    }
  }
  for (const project of detail.vercel || []) {
    if (project.connectionError || project.missingSince || !project.production) incomplete = true;
    const deployment = project.production;
    if (!deployment) continue;
    addRelease(`vercel:${project.id}:node`, `${project.name} · Node.js`, deployment.nodeBranch || "version inconnue", deployment.nodeRelease || undefined);
    for (const technology of deployment.analysis?.technologies || []) {
      if (technology.update === "available") {
        versionsKnown = true;
        updates.set(`vercel:${project.id}:${technology.name}`, `${technology.name} : ${technology.version}${technology.latestVersion ? ` → ${technology.latestVersion}` : " à actualiser"}.`);
      } else if (technology.update === "current") versionsKnown = true;
      else incomplete = true;
    }
  }
  for (const installation of detail.hosting || []) {
    const inventory = installation.inventory;
    if (!inventory || installation.missingSince || installation.inspectionError || inventory.error || inventory.collectionMode === "early") incomplete = true;
    if (!inventory) continue;
    const result = latest?.results.find(result => latest.targets.some(target => target.id === result.targetId && target.mode === "wordpress" && target.remoteId === installation.id && target.connectionId === installation.connectionId));
    const installed = result?.checks?.findLast(check => check.tool === "WPScan" && check.phase === "after");
    const oldInventory = result?.stage === "completed" && installed && inventory.observedAt && Date.parse(inventory.observedAt) < Date.parse(installed.checkedAt);
    if (oldInventory) incomplete = true;
    const components = oldInventory ? [] : [
      ...(inventory.wordpress ? [{ id: "wordpress", name: "WordPress", ...inventory.wordpress }] : []),
      ...inventory.plugins.map(item => ({ ...item, id: "plugin:" + item.file })),
      ...inventory.themes.map(item => ({ ...item, id: "theme:" + item.file })),
    ];
    for (const component of components) {
      if (component.updateState === "available") {
        versionsKnown = true;
        updates.set(`${installation.id}:${component.id}`, `${component.name} : ${component.version || "version inconnue"}${component.latestVersion ? ` → ${component.latestVersion}` : " à actualiser"}.`);
      } else if (component.updateState === "current") versionsKnown = true;
      else incomplete = true;
    }
    const php = inventory.php;
    if (php?.release) {
      const release = php.release;
      if (release.upstreamSupported === false || release.updateAvailable === false || (release.updateAvailable && release.securityRelease)) securityKnown = true;
      if (release.upstreamSupported === false) security.set(`${installation.id}:php-support`, `PHP ${php.version} : version en fin de support amont.`);
      if (release.updateAvailable !== null) versionsKnown = true;
      if (release.updateAvailable || release.upstreamSupported === false) updates.set(`${installation.id}:php`, `PHP : ${php.version} → ${release.latestVersion}.`);
      if (release.updateAvailable && release.securityRelease) security.set(`${installation.id}:php-security`, `PHP ${php.version} : publication de sécurité disponible.`);
    }
  }
  for (const result of latest?.results || []) {
    const target = latest!.targets.find(target => target.id === result.targetId);
    if (!target) continue;
    let checks: UpdateCheck[] = [];
    if (target.mode === "wordpress") {
      const installation = detail.hosting?.find(item => item.id === target.remoteId && item.connectionId === target.connectionId);
      const inventory = installation?.inventory;
      const scan = result.checks?.findLast(check => check.tool === "WPScan" && check.phase === "after") || result.checks?.findLast(check => check.tool === "WPScan" && check.phase === "before");
      if (scan && inventory) {
        const newerInstalledScan = scan.phase === "after" && inventory.observedAt && Date.parse(inventory.observedAt) < Date.parse(scan.checkedAt);
        checks = [{ ...scan, findings: newerInstalledScan ? scan.findings : scan.findings.filter(finding => installedWordPressFinding(inventory, finding)) }];
      }
    } else if (result.stage === "completed") {
      const proof = result.checks?.findLast(check => check.tool === "Node" && check.phase === "after" && check.status === "passed")?.nodeEvidence;
      const project = detail.railway?.find(project => project.connectionId === target.connectionId);
      const service = project?.services.find(service => service.id === target.remoteId && service.environmentId === target.environmentId);
      const bound = proof && service && railwayRuntimeDeployments(service).some(deployment => deployment.id === proof.deploymentId && deployment.evidence?.imageDigest === proof.imageDigest);
      if (bound) checks = ["OSV", "Trivy"].flatMap(tool => {
        const check = result.checks?.findLast(check => check.tool === tool && check.phase === "candidate");
        return check && check.status !== "blocked" ? [check] : [];
      });
    }
    for (const check of checks) {
      securityKnown = true;
      for (const finding of check.findings) {
        if (finding.scope !== undefined && finding.scope !== target.root) continue;
        const id = [...finding.aliases, finding.id].sort()[0];
        const severity = { critical: "critique", high: "élevée", moderate: "modérée", low: "faible", unknown: "non classée" }[finding.severity];
        security.set(`${target.id}:${finding.package}:${finding.version}:${id}`, `${result.name} · ${finding.package} ${finding.version} : ${id} (sévérité ${severity}).`);
        securityFromScan = true;
      }
    }
  }
  return { security: [...security.values()], updates: [...updates.values()], securityKnown, versionsKnown, incomplete, securityFromScan, running: !!latest && activeUpdateStages.includes(latest.stage), attention: latest?.stage === "attention" };
}
