import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { ApiError } from "../http";
import { publicAddress } from "../connectors/wordpress-observer";
import { runtimeEvidence } from "../connectors/vercel-analysis";
import { changedSources, snapshotSources, validatePreparedNodeSources, type NodeUpdateChecks, type NodeValidationRuntime } from "./node";
import { vercelUpdateRequest } from "./providers";
import type { UpdateCheck, UpdateTarget } from "./types";

export type StaticProfile = { framework: "vite" | "astro" | "create-react-app"; output: "dist" | "build"; routing: "files" | "spa" };
export type StaticArtifact = { path: string; hash: string; size: number };
export type StaticBuild = { profile: StaticProfile; nodeVersion: string; hash: string; files: StaticArtifact[]; checkedAt: string };
export function vercelStaticTarget(target: UpdateTarget) { return target.provider === "vercel" && target.capability?.adapter === "node-static"; }
const fail = (message: string): never => { throw new ApiError(message, 422); };
const normalize = (value: string | null | undefined) => (value || "").replace(/^\/+|\/+$/g, "");
const safeRelative = (path: string) => !!path && path.length <= 1000 && !/[\\\x00-\x20?#%:]/.test(path) && !path.startsWith("/") && path.split("/").every(part => !!part && part !== "." && part !== "..");

export function staticProfile(framework: string | null | undefined, manifest: Record<string, any>, paths: string[], configurations: Record<string, string> = {}): StaticProfile {
  if (!["vite", "astro", "create-react-app"].includes(framework || "")) return fail("Le framework statique doit être identifié : Vite, Astro ou Create React App.");
  if (typeof manifest.scripts?.build !== "string") return fail("Le site statique doit déclarer un script build.");
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const packageName = framework === "create-react-app" ? "react-scripts" : framework!;
  if (!dependencies[packageName]) return fail("Le framework annoncé n’est pas confirmé par les dépendances des sources.");
  if (Object.keys(dependencies).some(name => /^@astrojs\/(node|vercel|netlify|cloudflare)$/.test(name) || ["next", "@vercel/node", "@vercel/python"].includes(name))) return fail("Des dépendances de serveur ou des adaptateurs de fonctions demandent une qualification séparée.");
  if (paths.some(path => /^(?:api|functions|server|\.vercel|dist|build)\/|(?:^|\/)(?:middleware\.[cm]?[jt]s|Dockerfile(?:\.vercel)?)$/.test(path))) return fail("Une API, un serveur, une sortie déjà enregistrée ou une configuration de déploiement particulière est présent dans cette racine.");
  for (const text of Object.values(configurations)) if (/\b(?:outDir|outputDir|outputDirectory|hybrid|adapter|ssr)\b|\boutput\s*:\s*["']server["']/.test(text)) return fail("La configuration modifie la sortie ou l’exécution du build ; une qualification dédiée est nécessaire.");
  return { framework: framework as StaticProfile["framework"], output: framework === "create-react-app" ? "build" : "dist", routing: framework === "create-react-app" ? "spa" : "files" };
}
export async function qualifyStaticSources(folder: string, target: UpdateTarget, names: string[], framework: string): Promise<StaticProfile> {
  const prefix = target.root ? target.root + "/" : "";
  const local = names.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length));
  const manifest = JSON.parse(await readFile(join(folder, prefix + "package.json"), "utf8"));
  let spa = false;
  if (local.includes("vercel.json")) {
    const configuration = JSON.parse(await readFile(join(folder, prefix + "vercel.json"), "utf8"));
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) return fail("La configuration Vercel doit être un objet JSON.");
    const allowed = new Set(["$schema", "framework", "rewrites", "cleanUrls", "trailingSlash"]);
    if (Object.keys(configuration).some(key => !allowed.has(key)) || configuration.framework !== undefined && configuration.framework !== null && configuration.framework !== framework || ["cleanUrls", "trailingSlash"].some(key => configuration[key] !== undefined && typeof configuration[key] !== "boolean") || configuration.$schema !== undefined && configuration.$schema !== "https://openapi.vercel.sh/vercel.json") return fail("La configuration Vercel personnalisée demande une qualification du routage et du build.");
    if (configuration.rewrites !== undefined && (!Array.isArray(configuration.rewrites) || configuration.rewrites.length !== 1 || !configuration.rewrites[0] || configuration.rewrites[0].source !== "/(.*)" || !["/index.html", "/"].includes(configuration.rewrites[0].destination) || Object.keys(configuration.rewrites[0]).some(key => !["source", "destination"].includes(key)))) return fail("Seule une réécriture SPA locale simple est admise dans ce parcours statique.");
    if (framework === "astro" && configuration.rewrites) return fail("La réécriture SPA d’un site Astro demande une qualification dédiée.");
    spa = !!configuration.rewrites;
  }
  const configurations: Record<string, string> = {};
  let budget = 0;
  for (const name of local) {
    if (!/\.(?:[cm]?[jt]sx?|astro|vue|svelte|html|json)$/.test(name) || /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock)$/.test(name)) continue;
    const text = await readFile(join(folder, prefix + name), "utf8"); budget += Buffer.byteLength(text);
    if (budget > 12_000_000) return fail("Sources trop volumineuses pour qualifier ce build statique.");
    // Build values are deliberately not copied from the production environment.
    if (/process\.env\s*(?:\[|\.(?!NODE_ENV\b))|import\.meta\.env\s*(?:\[|\.(?!DEV\b|PROD\b|MODE\b|BASE_URL\b|SSR\b))|\bloadEnv\s*\(/.test(text)) return fail("Le build utilise des variables externes. Qualifiez ses valeurs publiques et son environnement avant la maintenance statique.");
    if (/^(?:vite|astro)\.config\.[cm]?[jt]s$/.test(name)) configurations[name] = text;
  }
  const profile = staticProfile(framework, manifest, local, configurations);
  return spa ? { ...profile, routing: "spa" } : profile;
}

export async function inspectStaticOutput(directory: string, profile: StaticProfile, nodeVersion: string): Promise<StaticBuild> {
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return fail("Le répertoire de sortie statique ne doit pas être un lien.");
  const root = await realpath(directory), files: StaticArtifact[] = [];
  let size = 0, entries = 0;
  const deadline = Date.now() + 30_000;
  async function walk(path = "") {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      if (++entries > 5000 || Date.now() > deadline) return fail("La sortie statique comporte trop de répertoires ou dépasse son délai d’inspection.");
      const name = path ? path + "/" + entry.name : entry.name;
      if (!safeRelative(name) || name.split("/").some(part => part.startsWith(".") || part.endsWith(".func") || ["node_modules", "functions", "server"].includes(part))) return fail("La sortie contient un chemin, un fichier serveur ou un fichier privé non admis.");
      const full = join(root, name), stat = await lstat(full);
      if (stat.isSymbolicLink() || !(await realpath(full)).startsWith(root + sep)) return fail("La sortie statique contient un lien ou un chemin hors du répertoire attendu.");
      if (stat.isDirectory()) { await walk(name); continue; }
      if (!/\.(?:html?|css|m?js|json|png|jpe?g|webp|avif|svg|gif|ico|woff2?|ttf|otf|eot|txt|xml|webmanifest|pdf|mp4|webm|mp3|ogg|wasm|bin)$/i.test(name)) return fail("La sortie contient un type de fichier non qualifié pour la publication statique.");
      if (!stat.isFile() || files.length >= 2000 || stat.size > 20_000_000 || (size += stat.size) > 100_000_000) return fail("La sortie statique dépasse les limites de validation.");
      const content = await readFile(full);
      if (/\.(?:html|js|css|json|txt)$/i.test(name) && /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/.test(content.toString("utf8"))) return fail("Un identifiant privé semble présent dans les fichiers destinés à être publics.");
      files.push({ path: name, hash: createHash("sha256").update(content).digest("hex"), size: content.length });
    }
  }
  await walk(); files.sort((a, b) => a.path.localeCompare(b.path));
  if (!files.some(file => file.path === "index.html")) return fail("La sortie statique doit contenir index.html.");
  const names = new Set(files.map(file => file.path));
  let references = 0;
  for (const file of files.filter(file => /\.(?:html|css)$/.test(file.path))) {
    const text = await readFile(join(root, file.path), "utf8");
    const assets: string[] = [];
    if (file.path.endsWith(".html")) {
      for (const tag of text.matchAll(/<(?:script|img|source|video|audio|link)\b[^>]*>/gi)) {
        if (/^<link\b/i.test(tag[0]) && !/\brel\s*=\s*["'][^"']*\b(?:stylesheet|icon|modulepreload|preload|manifest)\b/i.test(tag[0])) continue;
        for (const attribute of tag[0].matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) assets.push(attribute[1]);
      }
    } else {
      for (const match of text.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)|@import\s*["']([^"']+)["']/gi)) assets.push(match[1] || match[2]);
    }
    for (const asset of assets) {
      if (++references > 20_000) return fail("Trop de références de ressources à qualifier dans la sortie statique.");
      if (asset.startsWith("#") || /^(?:data:|https?:|\/\/)/i.test(asset)) continue;
      const url = new URL(asset.replace(/&amp;/g, "&"), `https://static.invalid/${file.path}`);
      if (url.origin !== "https://static.invalid") return fail("Une ressource utilise un protocole non qualifié.");
      let name: string;
      try { name = decodeURIComponent(url.pathname).slice(1); } catch { return fail("Chemin de ressource statique invalide."); }
      if (!names.has(name)) return fail(`Une ressource locale référencée est absente du build statique : ${name}.`);
    }
  }
  return { profile, nodeVersion, files, hash: createHash("sha256").update(JSON.stringify(files)).digest("hex"), checkedAt: new Date().toISOString() };
}
export async function buildStaticCandidate(folder: string, target: UpdateTarget, names: string[], profile: StaticProfile, nodeVersion: string, checks: (folder: string, roots: string[]) => NodeUpdateChecks, runtime: NodeValidationRuntime) {
  const temporary = await mkdtemp(join(tmpdir(), "vigie-static-"));
  try {
    const before = await snapshotSources(folder, names);
    for (const name of names) {
      const destination = join(temporary, name);
      if (!safeRelative(name)) return fail("Chemin source non admis pour la copie du build statique.");
      await mkdir(dirname(destination), { recursive: true }); await copyFile(join(folder, name), destination);
    }
    await validatePreparedNodeSources(temporary, [target.root], names, nodeVersion, new Set(), checks(temporary, [target.root]), runtime);
    await changedSources(temporary, before, new Set());
    for (const path of [".vercel", "api", "functions", "server"]) if (await lstat(join(temporary, target.root, path)).catch(() => null)) return fail("Le build a généré une sortie de serveur ou un déploiement particulier hors du dossier statique.");
    const build = await inspectStaticOutput(join(temporary, target.root, profile.output), profile, nodeVersion);
    await changedSources(folder, before, new Set());
    return build;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export function assertStaticDeployment(deployment: any, target: UpdateTarget, reference: { deploymentId: string; commit?: string }) {
  if (deployment.id !== reference.deploymentId || deployment.projectId !== target.remoteId || deployment.readyState !== "READY" || deployment.target !== "production" || reference.commit && deployment.meta?.githubCommitSha !== reference.commit || normalize(deployment.projectSettings?.rootDirectory) !== target.root) return fail("Le déploiement statique ne correspond pas au projet, à la racine et au commit attendus.");
  if (target.mode === "git" && (`${deployment.meta?.githubCommitOrg}/${deployment.meta?.githubCommitRepo}`.toLowerCase() !== target.repository?.toLowerCase() || deployment.meta?.githubCommitRef !== target.branch)) return fail("La source de ce déploiement statique n’est pas celle du service sélectionné.");
  if (!Array.isArray(deployment.lambdas) || deployment.lambdas.length > 100 || deployment.lambdas.some((build: any) => build.readyState !== "READY" || !Array.isArray(build.output) || build.output.some((output: any) => output.type !== "file")) || runtimeEvidence(deployment.meta?.lambdaRuntimeStats).length || deployment.crons?.length || deployment.functions && Object.keys(deployment.functions).length) return fail("La sortie hébergée contient des fonctions, tâches ou éléments dont le caractère statique n’est pas confirmé.");
  if (typeof deployment.url !== "string" || !/^[a-zA-Z0-9-]+\.vercel\.app$/.test(deployment.url)) return fail("Le domaine immuable du déploiement statique n’est pas qualifié.");
  return new URL(`https://${deployment.url}/`);
}
export async function staticPreflight(target: UpdateTarget, reference: { deploymentId: string; commit?: string }, read = vercelUpdateRequest) {
  const project = await read(target, `/v9/projects/${target.remoteId}`);
  if (project.id !== target.remoteId || project.targets?.production?.id !== reference.deploymentId || normalize(project.rootDirectory) !== target.root) return fail("Le déploiement statique actif a changé.");
  if (target.mode === "git" && (project.link?.type !== "github" || `${project.link.org}/${project.link.repo}`.toLowerCase() !== target.repository?.toLowerCase() || project.link.productionBranch && project.link.productionBranch !== target.branch)) return fail("La source de production du site statique a changé.");
  const deployment = await read(target, `/v13/deployments/${reference.deploymentId}`);
  const output = (deployment.projectSettings?.framework || target.capability?.staticFramework) === "create-react-app" ? "build" : "dist";
  if ((project.framework || null) !== (deployment.projectSettings?.framework || null) || [project.outputDirectory, deployment.projectSettings?.outputDirectory].some(directory => directory && normalize(directory) !== output) || project.buildCommand || project.installCommand || project.commandForIgnoringBuildStep) return fail("Les paramètres de build statique Vercel ont changé ou demandent une qualification dédiée.");
  assertStaticDeployment(deployment, target, reference);
  let url: URL;
  try { url = new URL(target.url || ""); } catch { return fail("Le site statique doit avoir un domaine public qualifié."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || url.pathname !== "/" || url.search || url.hash) return fail("Le contrôle statique demande la racine d’un domaine HTTPS public.");
  if (!Array.isArray(deployment.alias) || !deployment.alias.some((alias: unknown) => typeof alias === "string" && alias.toLowerCase() === url.hostname)) return fail("Le domaine public n’est pas rattaché au déploiement de production attendu.");
  return { url, framework: deployment.projectSettings?.framework as string, commit: deployment.meta?.githubCommitSha as string | undefined };
}
async function readStaticFile(url: URL, limit: number, redirects = 0): Promise<Buffer> {
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(address => !publicAddress(address.address))) return fail("Les fichiers doivent être servis par une adresse HTTPS publique.");
  const address = addresses[0];
  return new Promise((done, reject) => {
    const request = httpsRequest({ hostname: address.address, family: address.family, servername: url.hostname, port: 443, method: "GET", path: url.pathname + url.search, headers: { Host: url.hostname, "Accept-Encoding": "identity", "Cache-Control": "no-cache", "User-Agent": "Vigie-static-check/1.0" }, signal: AbortSignal.timeout(20_000) }, response => {
      if ([301, 302, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url);
        if (redirects >= 3 || next.origin !== url.origin || next.username || next.password) { reject(new ApiError("Redirection statique non qualifiée.", 422)); return; }
        void readStaticFile(next, limit, redirects + 1).then(done, reject); return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new ApiError(`Fichier statique inaccessible (HTTP ${response.statusCode}). Les protections d’accès restent actives.`, 422)); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > limit) response.destroy(new Error("size")); else chunks.push(chunk); });
      response.on("error", () => reject(new ApiError("Lecture statique interrompue ou trop volumineuse.", 422)));
      response.on("end", () => done(Buffer.concat(chunks)));
    });
    request.on("error", () => reject(new ApiError("Le fichier statique ne répond pas au contrôle HTTPS.", 502))); request.end();
  });
}
export async function verifyStaticDeployment(target: UpdateTarget, reference: { deploymentId: string; commit?: string }, build: StaticBuild, dependencies = { read: vercelUpdateRequest, file: readStaticFile }): Promise<UpdateCheck> {
  const observed = await staticPreflight(target, reference, dependencies.read);
  let cursor = 0;
  const deadline = Date.now() + 180_000;
  let failure: unknown;
  await Promise.all(Array.from({ length: 4 }, async () => {
    try {
    while (cursor < build.files.length) {
      if (failure) return;
      if (Date.now() > deadline) return fail("Le contrôle de tous les fichiers statiques a dépassé son délai ; résultat non confirmé.");
      const file = build.files[cursor++];
      const pathname = file.path === "index.html" ? "" : file.path.endsWith("/index.html") ? file.path.slice(0, -10) : file.path;
      const data = await dependencies.file(new URL(pathname, observed.url), file.size + 1);
      if (data.length !== file.size || createHash("sha256").update(data).digest("hex") !== file.hash) return fail(`Le fichier publié ${file.path} ne correspond pas à la sortie statique validée. Le résultat n’est pas confirmé.`);
    }
    } catch (error) { failure = error; }
  }));
  if (failure) throw failure;
  if (build.profile.routing === "spa") {
    const index = build.files.find(file => file.path === "index.html")!;
    const data = await dependencies.file(new URL("vigie-static-route-check/" + build.hash.slice(0, 16), observed.url), index.size + 1);
    if (data.length !== index.size || createHash("sha256").update(data).digest("hex") !== index.hash) return fail("La route profonde SPA ne restitue pas le document HTML validé.");
  }
  // Bind the public domain to the same active deployment again after all reads.
  // Vercel may protect its immutable URLs even for public production sites.
  await staticPreflight(target, reference, dependencies.read);
  return { tool: "Static", phase: "after", scope: target.root || "racine", checkedAt: new Date().toISOString(), status: "passed", findings: [], staticEvidence: { projectId: target.remoteId, deploymentId: reference.deploymentId, commit: reference.commit || observed.commit || null, artifactHash: build.hash, fileCount: build.files.length, buildNodeVersion: build.nodeVersion }, message: `${build.files.length} fichiers statiques publiés conformes aux empreintes du build validé sous Node ${build.nodeVersion}. Déploiement, domaine public${build.profile.routing === "spa" ? ", route profonde SPA" : ""} et absence de fonctions confirmés. Aucun runtime Node serveur n’est revendiqué.` };
}
