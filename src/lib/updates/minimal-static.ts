import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ApiError } from "../http";
import { deploymentEvidence } from "../connectors/railway-evidence";
import { normalizeImageDigest } from "../image-reference";
import { readRailwayProbe, readRailwayStaticImage } from "./docker-node";
import { githubRequest, githubUpdateToken, repositoryAllowed } from "./github";
import { deployRailwayArchive, railwayUpdateRequest, readRailwayInstance, waitForDeployment } from "./providers";
import { railpackCaddyVersion } from "./railpack-caddy";
import { runCommand } from "./process";
import { parseTrivy } from "./security";
import type { UpdateTarget } from "./types";

const caddyCommit = "9ea3108377d2abec102866808133c40ac9582162";
const caddyArchiveHash = "5f71a0f071a4b80e52c8ed17b95b2dccc443c5e8468d39886b08dde78a7a90af";
const dockerfile = `FROM golang:1.27.3-bookworm@sha256:025eefc1e8dbe63201734a72aaa0a55d7a077f2d8410432f8ae2f3e939f32871 AS caddy
ADD --checksum=sha256:${caddyArchiveHash} https://codeload.github.com/caddyserver/caddy/tar.gz/${caddyCommit} /caddy.tgz
RUN mkdir /src && tar -xzf /caddy.tgz -C /src --strip-components=1
WORKDIR /src
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
RUN go get golang.org/x/crypto@v0.58.1-0.20261009181718-2f1f834330b2 && go build -trimpath -buildvcs=false -ldflags="-s -w" -o /caddy ./cmd/caddy
FROM node:26.13.0-bookworm-slim@sha256:51d24d08800f352afae68628d883e63db3f2c4dd807b7ddb6f805dc6b9ef8c0e AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG VITE_API_URL
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
RUN npm test && npm run build
FROM scratch
COPY --from=caddy /caddy /caddy
COPY --from=frontend /app/dist /dist
COPY Caddyfile /Caddyfile
USER 65532:65532
ENV HOME=/tmp PORT=8080
ENTRYPOINT ["/caddy","run","--config","/Caddyfile","--adapter","caddyfile"]
`;
const bundleDockerfile = `FROM scratch
COPY caddy /caddy
COPY dist /dist
COPY Caddyfile /Caddyfile
USER 65532:65532
ENV HOME=/tmp PORT=8080
ENTRYPOINT ["/caddy","run","--config","/Caddyfile","--adapter","caddyfile"]
`;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const uuid = z.string().uuid();
const available = new Set(["caddy", "Caddyfile", "dist", "dev", "etc", "proc", "sys", "tmp", ".dockerenv", ".railway"]);

function assertMinimalListing(listing: string) {
  const entries = listing.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("sftp>")).map(line => line.replace(/^\/+|\/+$/g, ""));
  if (!["caddy", "Caddyfile", "dist"].every(name => entries.includes(name)) || entries.some(name => !available.has(name) && name !== "." && name !== "..")) {
    throw new ApiError("Le système de fichiers déployé ne correspond pas à l’image minimale attendue.", 422);
  }
}

async function scanBinary(directory: string, cache: string) {
  const report = join(directory, "trivy.json");
  await runCommand("trivy", ["rootfs", "--scanners", "vuln", "--pkg-types", "library", "--list-all-pkgs", "--cache-dir", cache, "--quiet", "--format", "json", "--output", report, directory], { timeout: 150_000 });
  if ((await lstat(report)).size > 16_000_000) throw new ApiError("Rapport de l’image minimale trop volumineux.", 422);
  const raw = await readFile(report, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.Results?.some((result: { Type?: string; Packages?: unknown[] }) => result.Type === "gobinary" && result.Packages?.length)) throw new ApiError("Inventaire Go du binaire Caddy absent du scan.", 422);
  const findings = parseTrivy(raw, false, "gobinary");
  if (findings.length) throw new ApiError(`L’image minimale contient encore ${findings.length} signalement(s) Go. Candidate refusée.`, 422);
}

async function hashFile(path: string, artifact = "Caddy") {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > 80_000_000) throw new ApiError(`Artefact ${artifact} invalide (${stat.size} octets).`, 422);
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function publicBuildVariables(vars: Record<string, string>) {
  const result: Record<string, string> = {};
  if (vars.VITE_API_URL) {
    if (vars.VITE_API_URL !== "/api") throw new ApiError("URL API de construction à qualifier pour l’image minimale.", 422);
    result.VITE_API_URL = vars.VITE_API_URL;
  }
  if (vars.VITE_SUPABASE_URL || vars.VITE_SUPABASE_ANON_KEY) {
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(vars.VITE_SUPABASE_URL || "")) throw new ApiError("URL publique Supabase non qualifiée.", 422);
    const key = vars.VITE_SUPABASE_ANON_KEY || "";
    let role: unknown;
    if (/^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(key)) {
      try { role = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString()).role; } catch { /* Denied below. */ }
    }
    if (role !== "anon" && !/^sb_publishable_[a-zA-Z0-9_-]{10,250}$/.test(key)) throw new ApiError("Seule une clé publique Supabase peut entrer dans le build du frontend.", 422);
    result.VITE_SUPABASE_URL = vars.VITE_SUPABASE_URL;
    result.VITE_SUPABASE_ANON_KEY = key;
  }
  return result;
}

const witnessProgram = String.raw`
const http=require("node:http"), crypto=require("node:crypto");
const [host,origin,nonce]=process.argv.slice(1);
async function probe() {
 const base="http://"+host+":8080", options={redirect:"error",signal:AbortSignal.timeout(9000)};
 const [health,home,api]=await Promise.all([fetch(base+"/health",options),fetch(base+"/",options),fetch(base+"/api/auth/me",{...options,headers:{Origin:origin}})]);
 const [html,auth]=await Promise.all([home.text(),api.json()]);
 if(health.status!==200||home.status!==200||!home.headers.get("content-type")?.includes("text/html")||!html.includes("/assets/")||api.status!==401||auth.success!==false||typeof auth.error!=="string")throw Error("HTTP");
 const key=crypto.randomBytes(16).toString("base64"), accept=crypto.createHash("sha1").update(key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
 const upgrade=await new Promise((resolve,reject)=>{
   const req=http.get(base+"/ws/terminal",{headers:{Connection:"Upgrade",Upgrade:"websocket","Sec-WebSocket-Version":"13","Sec-WebSocket-Key":key,Origin:origin},timeout:9000});
   req.on("upgrade",(res,socket)=>{socket.destroy();if(res.statusCode===101&&res.headers["sec-websocket-accept"]===accept)resolve(101);else reject(Error("Upgrade"))});
   req.on("response",res=>{res.resume();reject(Error("WebSocket "+res.statusCode))});
   req.on("timeout",()=>req.destroy(Error("WebSocket timeout")));
   req.on("error",reject);
 });
 console.log(JSON.stringify({nonce, deployment:process.env.RAILWAY_DEPLOYMENT_ID, service:process.env.RAILWAY_SERVICE_ID, environment:process.env.RAILWAY_ENVIRONMENT_ID, health:health.status, site:home.status, api:api.status, websocket:upgrade}));
}
probe().catch(e=>{console.error(e.message);process.exitCode=1});
`;

export async function testMinimalStaticRailway(target: UpdateTarget, witness: UpdateTarget, commit: string, getSources: (repository: string, commit: string, archive: string, folder: string) => Promise<string[]>, log = console.log) {
  sha.parse(commit);
  if (target.provider !== "railway" || target.mode !== "git" || !target.repository || !repositoryAllowed(target.repository) || !target.branch || !target.url ||
    !target.root || target.projectId !== witness.projectId || target.connectionId !== witness.connectionId || target.environmentId !== witness.environmentId ||
    witness.provider !== "railway" || witness.id === target.id || target.repository !== witness.repository) throw new ApiError("Frontend et témoin Railway non qualifiés.", 422);
  const origin = new URL(target.url).origin;
  if (!/^https:\/\/[a-z0-9.-]+$/.test(origin)) throw new ApiError("Origine WebSocket non qualifiée.", 422);
  const [original, witnessService] = await Promise.all([readRailwayInstance(target), readRailwayInstance(witness)]);
  const current = original.serviceInstance.activeDeployments, backend = witnessService.serviceInstance.activeDeployments;
  const live = deploymentEvidence(current?.[0]?.meta);
  if (original.service.projectId !== witnessService.service.projectId || current?.length !== 1 || current[0].status !== "SUCCESS" ||
    !railpackCaddyVersion(live) || live?.commit !== commit || live.branch !== target.branch || live.repository !== target.repository ||
    backend?.length !== 1 || backend[0].status !== "SUCCESS") throw new ApiError("Le déploiement Railpack ou le témoin Railway a changé.", 409);
  const projectId = uuid.parse(original.service.projectId);
  const environmentId = uuid.parse(target.environmentId);
  const token = githubUpdateToken(target.repository);
  const head = await githubRequest(`/repos/${target.repository}/git/ref/heads/${encodeURIComponent(target.branch)}`, token);
  if (head.object.sha !== commit) throw new ApiError("Le commit du frontend n’est plus la tête de la branche.", 409);
  const { variables } = await railwayUpdateRequest(target, "query PreviewVariables($projectId:String!,$serviceId:String!,$environmentId:String!){variables(projectId:$projectId,serviceId:$serviceId,environmentId:$environmentId)}", { projectId, serviceId: target.remoteId, environmentId });
  const buildVars = publicBuildVariables(variables);
  const upstream = variables.BACKEND_INTERNAL_URL;
  if (upstream && !/^http:\/\/[a-z0-9-]+\.railway\.internal:\d{2,5}\/?$/.test(upstream)) throw new ApiError("Adresse interne du backend à qualifier.", 422);
  const dir = await mkdtemp(join(tmpdir(), "vigie-minimal-"));
  const image = `vigie-validation:${randomUUID()}`;
  const name = `vigie-minimal-${randomUUID().slice(0, 12)}`;
  let container = "", preview: UpdateTarget | undefined;
  try {
    const sources = join(dir, "sources"), context = join(dir, "build"), bundle = join(dir, "deploy");
    const names = await getSources(target.repository, commit, join(dir, "source.zip"), sources);
    const prefix = target.root + "/";
    if (!["package.json", "package-lock.json", "Caddyfile"].every(file => names.includes(prefix + file)) || names.includes(prefix + "Dockerfile")) throw new ApiError("Sources statiques non qualifiées pour la migration minimale.", 422);
    const manifest = JSON.parse(await readFile(join(sources, target.root, "package.json"), "utf8"));
    if (manifest.engines?.node !== "26.13.0" || !manifest.devDependencies?.vite || !manifest.scripts?.test || !manifest.scripts?.build || manifest.workspaces) throw new ApiError("Le profil de construction du frontend ne correspond pas au parcours validé.", 422);
    for (const file of names.filter(file => file.startsWith(prefix))) {
      const output = join(context, file.slice(prefix.length));
      await mkdir(dirname(output), { recursive: true });
      await cp(join(sources, file), output);
    }
    await writeFile(join(context, "Dockerfile"), dockerfile);
    const env = { NODE_ENV: "production" as const, PATH: process.env.PATH, HOME: dir, DOCKER_CONFIG: join(dir, ".docker"), ...buildVars };
    await mkdir(env.DOCKER_CONFIG);
    log("Construction isolée de la candidate et exécution des tests frontend.");
    await runCommand("docker", ["build", "--platform=linux/amd64", "--tag", image, ...Object.keys(buildVars).flatMap(key => ["--build-arg", key]), context], { env, timeout: 900_000 });
    container = (await runCommand("docker", ["create", image], { env })).trim();
    if (!/^[a-f0-9]{64}$/.test(container)) throw new ApiError("Conteneur candidat non identifiable.", 422);
    await mkdir(bundle);
    for (const file of ["caddy", "dist", "Caddyfile"]) await runCommand("docker", ["cp", `${container}:/${file}`, join(bundle, file)], { env });
    const binaryHash = await hashFile(join(bundle, "caddy"));
    await hashFile(join(bundle, "dist", "index.html"), "index.html");
    const candidate = join(dir, "candidate");
    await mkdir(candidate);
    await cp(join(bundle, "caddy"), join(candidate, "caddy"));
    const cache = join(dir, "trivy-cache");
    await scanBinary(candidate, cache);
    await writeFile(join(bundle, "Dockerfile"), bundleDockerfile);
    const create = await railwayUpdateRequest(target, "mutation StaticPreview($input:ServiceCreateInput!){serviceCreate(input:$input){id name projectId}}", { input: { projectId, environmentId, name, variables: { PORT: "8080", ...(upstream ? { BACKEND_INTERNAL_URL: upstream } : {}) } } });
    const created = z.object({ id: uuid, name: z.literal(name), projectId: z.literal(projectId) }).parse(create.serviceCreate);
    preview = { ...target, remoteId: created.id, id: created.id, name, mode: "archive", root: "", repository: null, branch: null };
    log(`Service de test Railway créé (${name}).`);
    // Railway detects the Dockerfile at the root of an uploaded bundle.
    const deploymentId = await deployRailwayArchive(preview, bundle, randomUUID());
    log(`Image minimale envoyée à Railway (${deploymentId}).`);
    await waitForDeployment(preview, { deploymentId, runId: deploymentId }, async () => {});
    const active = async () => {
      const instance = (await readRailwayInstance(preview!)).serviceInstance;
      const deployments = instance.activeDeployments;
      const digest = normalizeImageDigest(deploymentEvidence(deployments?.[0]?.meta)?.imageDigest);
      if (deployments?.length !== 1 || deployments[0].id !== deploymentId || deployments[0].status !== "SUCCESS" || !digest) throw new ApiError("Image active du service de test non confirmée.", 422);
      return digest;
    };
    const digest = await active();
    const deployed = join(dir, "deployed");
    await mkdir(deployed);
    const instances = await readRailwayStaticImage(preview, deploymentId, async (binary, listing) => {
      assertMinimalListing(listing);
      if (await hashFile(binary) !== binaryHash) throw new ApiError("Le binaire déployé diffère de la candidate analysée.", 422);
      await cp(binary, join(deployed, "caddy"));
      await scanBinary(deployed, cache);
    });
    const backendId = uuid.parse(backend[0].id);
    const routes = await readRailwayProbe(witness, backendId, {
      command: nonce => "env -u NODE_OPTIONS -u NODE_PATH node -e '" + witnessProgram.replace(/'/g, "'\\''") + `' '${name}.railway.internal' '${origin}' '${nonce}'`,
      parse: (output, nonce) => z.object({ nonce: z.literal(nonce), deployment: z.literal(backendId), service: z.literal(witness.remoteId), environment: z.literal(environmentId), health: z.literal(200), site: z.literal(200), api: z.literal(401), websocket: z.literal(101) }).parse(JSON.parse(output)),
    });
    if (await active() !== digest) throw new ApiError("L’image active a changé pendant les contrôles.", 409);
    return { commit, caddyCommit, deploymentId, digest, scannedInstances: instances.length, witnesses: routes.length, imageFindings: 0, health: 200, site: 200, api: 401, websocket: 101 };
  } finally {
    try {
      if (preview) {
        const removed = await railwayUpdateRequest(preview, "mutation StaticPreviewCleanup($id:String!){serviceDelete(id:$id)}", { id: preview.remoteId });
        if (removed.serviceDelete !== true) throw new ApiError(`Suppression du service de test à vérifier (${name}).`, 502);
        log(`Service de test Railway supprimé (${name}).`);
      }
    } finally {
      if (container) await runCommand("docker", ["rm", "--force", container]).catch(() => {});
      await runCommand("docker", ["image", "rm", "--force", image]).catch(() => {});
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}
