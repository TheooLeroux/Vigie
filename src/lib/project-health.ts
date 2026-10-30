import { gt, valid } from "semver";
import { railwayRuntimeDeployments } from "./railway-status";
import type { SoftwareRelease } from "./railway-types";
import type { ProjectDetail, SiteInventory } from "./types";
import { activeUpdateStages, type SecurityFinding, type UpdateCheck, type UpdateState } from "./updates/types";
import { wordpressSecurityVersions } from "./updates/wordpress-security-key";
import { controlMatches, automaticControlFresh, controlSource } from "./automatic-control-state";
import { imageObservationPending } from "./updates/image-observation";
import { currentAssessmentResults } from "./updates/assessment";

export type ProjectHealth = {
  securityEvidence: { targetId: string; name: string; tool: UpdateCheck["tool"]; checkedAt: string; finding: SecurityFinding }[];
  securityOtherAlerts: string[];
  security: string[];
  updates: string[];
  manualUpdates: { label: string; reason: string }[];
  securityKnown: boolean;
  versionsKnown: boolean;
  incomplete: boolean;
  running: boolean;
  attention: boolean;
  securityFromScan: boolean;
  securityFixes: string[];
  manualSecurityFixes: string[];
  securitySearchIncomplete: boolean;
  assessedServices: number;
  unvalidatedUpdates: number;
  validatedUpdateServices: number;
};

function installedWordPressFinding(inventory: SiteInventory, finding: SecurityFinding) {
  const [kind, slug] = finding.package.split("/");
  if (kind === "wordpresses" || kind === "wordpress") return inventory.wordpress?.version === finding.version;
  if (kind === "plugins" || kind === "themes") return inventory[kind].some(item => item.slug === slug && item.version === finding.version);
  return false;
}

const isWordPressSecurityCheck = (check: UpdateCheck) => check.tool === "WPScan" || check.tool === "WPVulnerability";

// Read existing observations only. A rejected candidate never describes the
// deployed site; accepted Node scans must match its active image identity.
export function projectHealth(detail: ProjectDetail, state?: UpdateState | null): ProjectHealth {
  const security = new Map<string, string>(), updates = new Map<string, string>();
  const updateOrigins = new Map<string, string>();
  const setUpdate = (key: string, label: string, targetId?: string) => { updates.set(key, label); if (targetId) updateOrigins.set(key, targetId); };
  const targetId = (provider: string, connectionId: string, remoteId: string, environmentId?: string) => state?.targets.find(target => target.provider === provider && target.connectionId === connectionId && target.remoteId === remoteId && (!environmentId || target.environmentId === environmentId))?.id;
  const securityEvidence: ProjectHealth["securityEvidence"] = [];
  const manualUpdates = new Map<string, { label: string; reason: string }>();
  const fixes = new Map<string, { label: string; versions: Set<string>; manual?: boolean; targetId: string }>();
  let securityKnown = false, versionsKnown = false, incomplete = false;
  let securityFromScan = false;
  const history = state?.runs.filter(run => run.projectId === detail.project.id) || [];
  const latest = history[0];
  const addRelease = (id: string, name: string, version: string, release?: SoftwareRelease, origin?: string) => {
    if (!release) { incomplete = true; return; }
    if (release.securityUpdate !== null || release.supported === false) securityKnown = true;
    if (release.state === "current" || release.state === "available") versionsKnown = true;
    else incomplete = true;
    if (release.securityUpdate) security.set(id + ":security", `${name} ${version} : correctif de sécurité manquant.`);
    if (release.supported === false) security.set(id + ":support", `${name} ${version} : version en fin de support.`);
    const lts = name.includes("Node") && release.latestLts && ((valid(version) && valid(release.latestLts) && gt(release.latestLts, version)) || (/^\d+\.x$/.test(version) && Number(release.latestLts.split(".")[0]) > Number(version.split(".")[0])));
    if (release.state === "available" || release.supported === false || lts) {
      const next = lts ? release.latestLts : release.latestVersion;
      setUpdate(id, `${name} : ${version}${next ? ` → ${next}` : " à actualiser"}.`, origin);
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
        for (const pkg of deployment.evidence?.packages || []) addRelease(`${project.connectionId}:${service.id}:${service.environmentId}:${deployment.id}:${pkg.name}`, `${service.name} · ${pkg.name === "node" ? "Node.js" : pkg.name}`, pkg.version, pkg.release, targetId("railway", project.connectionId, service.id, service.environmentId));
      }
    }
  }
  for (const project of detail.vercel || []) {
    if (project.connectionError || project.missingSince || !project.production) incomplete = true;
    const deployment = project.production;
    if (!deployment) continue;
    const managed = history.flatMap(run => run.results.map(result => ({ run, result }))).find(({ run, result }) => {
      const target = run.targets.find(target => target.id === result.targetId);
      const proof = result.checks?.findLast(check => check.tool === "Node" && check.phase === "after" && check.status === "passed")?.nodeEvidence;
      return result.stage === "completed" && target?.provider === "vercel" && target.remoteId === project.id && target.connectionId === project.connectionId && result.managedNode && proof?.source === "vercel-function" && proof.projectId === project.id && proof.version === result.managedNode.version && proof.deploymentId === deployment.id && !!proof.commit && proof.commit === deployment.commit;
    })?.result.managedNode;
    const nodeKey = `vercel:${project.id}:node`;
    const release = managed ? { ...deployment.nodeRelease, state: managed.updatePending ? "available" as const : "current" as const, latestVersion: managed.branchLatest || managed.latestLts, latestLts: managed.branchLatest || managed.latestLts, latestStable: deployment.nodeRelease?.latestStable || managed.latestLts, supported: true, supportEndsAt: deployment.nodeRelease?.supportEndsAt || null, securityUpdate: managed.securityUpdate, checkedAt: managed.checkedAt, source: "https://nodejs.org/dist/index.json" } : deployment.nodeRelease || undefined;
    const nodeLabel = deployment.analysis?.status === "observed" && !deployment.analysis.runtimes.length ? "Node.js de construction (configuration Vercel)" : "Node.js";
    addRelease(nodeKey, `${project.name} · ${nodeLabel}`, managed?.version || deployment.nodeBranch || "version inconnue", release, targetId("vercel", project.connectionId, project.id));
    if (managed?.updatePending && updates.has(nodeKey)) manualUpdates.set(nodeKey, { label: updates.get(nodeKey)!, reason: "Runtime géré par Vercel : correctif en attente chez l’hébergeur. Les dépendances sont validées avec la version mesurée ; le runtime reste à actualiser." });
    if (managed?.migrationAvailable) {
      const key = nodeKey + ":migration", label = `${project.name} · Migration Node ${managed.version} → LTS ${managed.latestLts}.`;
      updates.set(key, label); manualUpdates.set(key, { label, reason: "Migration de majeure à planifier séparément ; elle ne bloque pas les dépendances compatibles sur la branche prise en charge." });
    }
    for (const technology of deployment.analysis?.technologies || []) {
      if (technology.update === "available") {
        versionsKnown = true;
        setUpdate(`vercel:${project.id}:${technology.name}`, `${technology.name} : ${technology.version}${technology.latestVersion ? ` → ${technology.latestVersion}` : " à actualiser"}.`, targetId("vercel", project.connectionId, project.id));
      } else if (technology.update === "current") versionsKnown = true;
      else incomplete = true;
    }
  }
  for (const installation of detail.hosting || []) {
    const inventory = installation.inventory;
    if (!inventory || installation.missingSince || installation.inspectionError || inventory.error || inventory.collectionMode === "early") incomplete = true;
    if (!inventory) continue;
    const siteRun = state?.runs.find(run => run.projectId === detail.project.id && run.targets.some(target => target.mode === "wordpress" && target.remoteId === installation.id && target.connectionId === installation.connectionId));
    const result = siteRun?.results.find(result => siteRun.targets.some(target => target.id === result.targetId && target.mode === "wordpress" && target.remoteId === installation.id && target.connectionId === installation.connectionId));
    const installed = result?.checks?.findLast(check => isWordPressSecurityCheck(check) && check.phase === "after");
    const observation = state?.currentSecurity?.find(item => item.targetId === `wordpress:${installation.id}` && !item.error && item.versions === wordpressSecurityVersions(inventory));
    const manualItems = observation?.manualUpdates ?? result?.manualUpdates ?? [];
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
        const key = `${installation.id}:${component.id}`;
        const label = `${component.name} : ${component.version || "version inconnue"}${component.latestVersion ? ` → ${component.latestVersion}` : " à actualiser"}.`;
        setUpdate(key, label, targetId("o2switch", installation.connectionId, installation.id));
        const slug = "slug" in component && typeof component.slug === "string" ? component.slug : null;
        // Persisted execution warnings also explain retained private packages in older runs.
        const currentWarnings = state?.currentSecurity?.find(item => item.targetId === `wordpress:${installation.id}` && item.versions === wordpressSecurityVersions(inventory))?.warnings || [];
        const retained = manualItems.find(item => item.package === `${component.id.startsWith("theme:") ? "themes" : "plugins"}/${slug}` && item.version === component.version);
        const retainedPlugin = component.id.startsWith("plugin:") && slug && (retained || ("updateOrigin" in component && component.updateOrigin === "external") || [...(result?.warnings || []), ...currentWarnings].some(warning => warning.startsWith(slug + " :") && /catalogue privé, non identifié ou fermé|intervention manuelle requise/.test(warning)));
        const reason = retained ? `${retained.reason} ${retained.action}` : component.id.startsWith("theme:") ? "Vigie ne met pas les thèmes à jour actuellement. À mettre à jour depuis WordPress → Apparence → Thèmes." : retainedPlugin ? "Vigie ne peut pas télécharger cette extension privée ou non reconnue. À mettre à jour depuis WordPress ou le compte de l’éditeur." : null;
        if (reason) manualUpdates.set(key, { label, reason });
      } else if (component.updateState === "current") versionsKnown = true;
      else incomplete = true;
    }
    for (const item of oldInventory ? [] : manualItems) {
      const [kind, slug] = item.package.split("/");
      const current = kind === "wordpress" ? inventory.wordpress?.version : kind === "mu-plugins" ? inventory.plugins.find(component => component.mustUse && component.slug === slug)?.version : kind === "plugins" || kind === "themes" ? inventory[kind].find(component => component.slug === slug)?.version : undefined;
      if (current !== item.version && !(current === null && ["", "inconnue"].includes(item.version))) continue;
      const label = `${item.package} : ${item.version || "version inconnue"}${item.target ? ` → ${item.target}` : " — mise à jour à vérifier"}.`;
      const component = kind === "plugins" || kind === "themes" ? inventory[kind].find(component => component.slug === slug) : undefined;
      const existingKey = component && `${installation.id}:${kind === "plugins" ? "plugin" : "theme"}:${component.file}`;
      if (!existingKey || !manualUpdates.has(existingKey)) manualUpdates.set(`${installation.id}:manual:${item.package}`, { label, reason: `${item.reason} ${item.action}` });
    }
    const php = inventory.php;
    if (php?.release) {
      const release = php.release;
      if (release.upstreamSupported === false || release.updateAvailable === false || (release.updateAvailable && release.securityRelease)) securityKnown = true;
      if (release.upstreamSupported === false) security.set(`${installation.id}:php-support`, `PHP ${php.version} : version en fin de support amont.`);
      if (release.updateAvailable !== null) versionsKnown = true;
      if (release.updateAvailable || release.upstreamSupported === false) {
        const key = `${installation.id}:php`, label = `PHP : ${php.version} → ${release.latestVersion}.`;
        updates.set(key, label);
        manualUpdates.set(key, { label, reason: "PHP est affiché uniquement ; sa gestion reste chez l’hébergeur." });
      }
      if (release.updateAvailable && release.securityRelease) security.set(`${installation.id}:php-security`, `PHP ${php.version} : publication de sécurité disponible.`);
    }
  }
  const securityOtherAlerts = [...security.values()];
  const scanned = new Set<string>();
  const observations = (state?.currentSecurity || []).flatMap(observation => {
    const target = state?.targets.find(target => target.id === observation.targetId);
    const inventory = detail.hosting?.find(site => site.id === target?.remoteId && site.connectionId === target.connectionId)?.inventory;
    if (!target || !inventory || observation.versions !== wordpressSecurityVersions(inventory)) { incomplete = true; return []; }
    if (observation.error || observation.warnings.length) incomplete = true;
    return observation.check ? [{ target, result: { targetId: target.id, name: target.name, checks: [observation.check], stage: "completed" as const, message: "Contrôle actuel", warnings: observation.warnings } }] : [];
  });
  const automaticIds = new Set((state?.automaticControls || []).map(control => control.targetId));
  const automatic = (state?.automaticControls || []).flatMap(control => {
    const target = state?.targets.find(target => target.id === control.targetId);
    if (target && imageObservationPending(target, detail, state)) { incomplete = true; return []; }
    const matches = target && controlMatches(control, target, detail);
    if (!matches) { incomplete = true; return []; }
    const fresh = automaticControlFresh(control);
    if (!fresh) incomplete = true;
    if (control.warnings.length) incomplete = true;
    if (fresh) for (const [index, update] of control.updates.entries()) setUpdate(`automatic:${target.id}:${index}`, update, target.id);
    const checks = fresh ? control.checks : control.checks.filter(check => check.findings.length > 0);
    return [{ target, automatic: true, result: { targetId: target.id, name: target.name, checks, warnings: control.warnings, stage: "completed" as const, message: "Contrôle automatique" } }];
  });
  if (state?.automaticControls && state.targets.some(target => !automaticIds.has(target.id))) incomplete = true;
  const reports = [...automatic, ...observations.filter(item => !automaticIds.has(item.target.id)).map(item => ({ ...item, automatic: false })), ...history.flatMap(run => run.results.filter(result => !automaticIds.has(result.targetId)).map(result => ({ target: run.targets.find(target => target.id === result.targetId), result, automatic: false })))];
  for (const { target, result, automatic } of reports) {
    if (!target) continue;
    let checks: UpdateCheck[] = [];
    if (automatic) checks = result.checks || [];
    else if (target.mode === "wordpress") {
      const installation = detail.hosting?.find(item => item.id === target.remoteId && item.connectionId === target.connectionId);
      const inventory = installation?.inventory;
      const observation = state?.currentSecurity?.find(item => item.targetId === target.id && inventory && item.versions === wordpressSecurityVersions(inventory));
      if (observation?.error || observation?.warnings.length) incomplete = true;
      const scan = observation?.check || result.checks?.findLast(check => isWordPressSecurityCheck(check) && check.phase === "after") || result.checks?.findLast(check => isWordPressSecurityCheck(check) && check.phase === "before");
      if (scan && inventory) {
        const newerInstalledScan = scan.phase === "after" && inventory.observedAt && Date.parse(inventory.observedAt) < Date.parse(scan.checkedAt);
        checks = [{ ...scan, findings: newerInstalledScan ? scan.findings : scan.findings.filter(finding => installedWordPressFinding(inventory, finding)) }];
      }
    } else if (result.stage === "completed") {
      const proof = result.checks?.findLast(check => check.tool === "Node" && check.phase === "after" && check.status === "passed")?.nodeEvidence;
      const project = detail.railway?.find(project => project.connectionId === target.connectionId);
      const service = project?.services.find(service => service.id === target.remoteId && service.environmentId === target.environmentId);
      const vercel = detail.vercel?.find(project => project.id === target.remoteId && project.connectionId === target.connectionId)?.production;
      const staticProof = result.checks?.findLast(check => check.tool === "Static" && check.phase === "after" && check.status === "passed")?.staticEvidence;
      const staticBound = target.provider === "vercel" && target.capability?.adapter === "node-static" && staticProof?.projectId === target.remoteId && staticProof.deploymentId === vercel?.id && !!staticProof.commit && staticProof.commit === vercel.commit && vercel.state === "READY" && staticProof.fileCount > 0 && /^[a-f0-9]{64}$/.test(staticProof.artifactHash);
      const bound = staticBound || proof && (target.provider === "vercel" ? proof.source === "vercel-function" && proof.projectId === target.remoteId && proof.deploymentId === vercel?.id && !!proof.commit && proof.commit === vercel.commit && vercel.state === "READY" : service && railwayRuntimeDeployments(service).some(deployment => deployment.id === proof.deploymentId && deployment.evidence?.imageDigest === proof.imageDigest));
      if (bound) checks = (staticBound ? ["OSV"] : ["OSV", "Trivy"]).flatMap(tool => {
        const check = result.checks?.findLast(check => check.tool === tool && check.phase === "candidate");
        return check && check.status !== "blocked" ? [check] : [];
      });
    }
    for (const check of checks) {
      const scanKey = `${target.id}:${check.tool}`;
      if (scanned.has(scanKey)) continue;
      scanned.add(scanKey);
      securityKnown = true;
      for (const finding of check.findings) {
        if (finding.scope !== undefined && finding.scope !== target.root) continue;
        securityEvidence.push({ targetId: target.id, name: result.name, tool: check.tool, checkedAt: check.checkedAt, finding });
        const id = [...finding.aliases, finding.id].sort()[0];
        const severity = { critical: "critique", high: "élevée", moderate: "modérée", low: "faible", unknown: "non classée" }[finding.severity];
        const inventory = detail.hosting?.find(site => site.id === target.remoteId && site.connectionId === target.connectionId)?.inventory;
        const component = inventory?.plugins.find(item => finding.package === `plugins/${item.slug}`)?.name || finding.package;
        const description = finding.explanation || (finding.kind === "supply-chain" || finding.id.startsWith("WPV-SUPPLY-") ? "Signal de distribution suspect à vérifier ; aucune compromission du site confirmée." : `Vulnérabilité connue (sévérité ${severity}).`);
        security.set(`${target.id}:${finding.package}:${finding.version}:${id}`, `${target.mode === "wordpress" ? "" : result.name + " · "}${component} ${finding.version} : ${id}. ${description}`);
        securityFromScan = true;
        if (finding.fixedVersions?.length) {
          const key = `${target.id}:${finding.package}:${finding.version}`;
          const privatePlugin = target.mode === "wordpress" && result.warnings.some(warning => warning.startsWith(finding.package.replace(/^plugins\//, "") + " :") && warning.includes("catalogue privé, non identifié ou fermé"));
          const observation = state?.currentSecurity?.find(item => item.targetId === target.id && inventory && item.versions === wordpressSecurityVersions(inventory));
          const retained = [...(observation?.manualUpdates || []), ...("manualUpdates" in result ? result.manualUpdates || [] : [])];
          const manual = target.mode === "wordpress" && (privatePlugin || finding.package.startsWith("themes/") || retained.some(item => item.package === finding.package && item.version === finding.version));
          const fix = fixes.get(key) || { label: `${result.name} · ${component} ${finding.version}`, versions: new Set<string>(), manual, targetId: target.id };
          fix.manual ||= manual;
          finding.fixedVersions.forEach(version => fix.versions.add(version));
          fixes.set(key, fix);
        }
      }
    }
  }
  const assessments = currentAssessmentResults(detail, state);
  const assessedIds = new Set(assessments.map(result => result.targetId));
  for (const [key, origin] of updateOrigins) if (assessedIds.has(origin) && !manualUpdates.has(key)) updates.delete(key);
  for (const [key, fix] of fixes) if (assessedIds.has(fix.targetId) && !fix.manual) fixes.delete(key);
  const unvalidatedUpdates = [...updates].filter(([key]) => !manualUpdates.has(key)).length + [...fixes.values()].filter(fix => !fix.manual).length;
  for (const result of assessments) for (const [index, change] of result.assessment!.changes.entries()) updates.set(`assessment:${result.targetId}:${index}`, `${result.name} · ${change}`);
  if (assessments.length) versionsKnown = true;
  const securitySearchIncomplete = !!latest && ["failed", "attention"].includes(latest.stage) && latest.results.some(result => result.checks?.some(check => check.status === "blocked" && ["OSV", "Trivy", "WPScan", "WPVulnerability"].includes(check.tool)));
  const fixLabel = (fix: { label: string; versions: Set<string>; manual?: boolean }) => `${fix.label} : correctifs référencés ${[...fix.versions].join(", ")} ; ${fix.manual ? "Composant conservé. Mise à jour à effectuer depuis WordPress ou le compte de l’éditeur, avec le développeur si nécessaire, après validation de compatibilité" : "compatibilité à valider"}.`;
  return { securityEvidence, securityOtherAlerts, security: [...security.values()], updates: [...updates.values()], manualUpdates: [...manualUpdates.values()], securityKnown, versionsKnown, incomplete, securityFromScan, securityFixes: [...fixes.values()].map(fixLabel), manualSecurityFixes: [...fixes.values()].filter(fix => fix.manual).map(fixLabel), securitySearchIncomplete, assessedServices: assessments.length, unvalidatedUpdates, validatedUpdateServices: assessments.filter(result => result.assessment!.changes.length > 0).length, running: !!latest && activeUpdateStages.includes(latest.stage), attention: latest?.stage === "attention" };
}
