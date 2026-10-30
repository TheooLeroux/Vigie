import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../http";
import { deploymentEvidence, githubRepository } from "../connectors/railway-evidence";
import { readRailwayProbe } from "./docker-node";
import { readRailwayInstance } from "./providers";
import { scanSourceSnapshot, type SourceFile } from "./source-snapshot";
import type { UpdateTarget } from "./types";
import { npmDependencyUsage } from "./dependency-usage";

const maxFile = 2_000_000;
const filesSchema = z.array(z.object({ path: z.enum(["package.json", "package-lock.json", "npm-shrinkwrap.json"]), content: z.string().max(maxFile) }).strict()).length(2);
const limitation = "GitHub inaccessible : seules les dépendances verrouillées retrouvées dans le conteneur Railway actif sont analysées. Le verrou peut aussi référencer des dépendances de build absentes du runtime. Le système et le code applicatif ne sont pas couverts ; les mises à jour des sources nécessitent de rétablir l’accès au dépôt.";

// Fixed built-ins only: no project imports, package manager, application script,
// environment dump, recursive directory search or arbitrary source-file reads.
export function railwaySourcesCommand(nonce: string, root: string) {
  const script = `const fs=require('node:fs'),path=require('node:path');
const dirs=new Set();for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)&&Number(p)!==process.pid)){try{if(!/^node(?:js)?$/.test(path.basename(fs.realpathSync('/proc/'+pid+'/exe'))))continue;dirs.add(fs.realpathSync('/proc/'+pid+'/cwd'));}catch{}}
if(dirs.size!==1)throw Error('App working directory not unique');const dir=[...dirs][0];if(!['/app',${JSON.stringify("/app/" + root)}].includes(dir))throw Error('Unexpected app directory');
function read(name){const p=path.join(dir,name);if(fs.realpathSync(p)!==p)throw Error('Symbolic dependency file');const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const before=fs.fstatSync(fd);if(!before.isFile()||before.size>${maxFile})throw Error('Dependency file too large');const b=Buffer.alloc(${maxFile}+1);let n=0,r;while((r=fs.readSync(fd,b,n,b.length-n,null))>0){n+=r;if(n>${maxFile})throw Error('Dependency file too large');}const after=fs.fstatSync(fd);if(before.size!==n||after.size!==n||before.mtimeMs!==after.mtimeMs)throw Error('Dependency file changed');return b.subarray(0,n).toString('utf8');}finally{fs.closeSync(fd);}}
const lock=fs.existsSync(path.join(dir,'npm-shrinkwrap.json'))?'npm-shrinkwrap.json':'package-lock.json';const files=[{path:'package.json',content:read('package.json')},{path:lock,content:read(lock)}];
console.log(JSON.stringify({nonce:${JSON.stringify(nonce)},deployment:process.env.RAILWAY_DEPLOYMENT_ID,service:process.env.RAILWAY_SERVICE_ID,environment:process.env.RAILWAY_ENVIRONMENT_ID,files}));`;
  return "env -u NODE_OPTIONS -u NODE_PATH node -e '" + script.replace(/'/g, "'\\''") + "'";
}

export function parseRailwaySources(output: string, nonce: string, target: UpdateTarget, deploymentId: string): { files: SourceFile[]; hash: string } {
  if (Buffer.byteLength(output) > maxFile * 3) throw new ApiError("Réponse de sources Railway trop volumineuse.");
  let raw: unknown;
  try { raw = JSON.parse(output); } catch { throw new ApiError("Sources Railway non interprétables."); }
  const parsed = z.object({ nonce: z.literal(nonce), deployment: z.literal(deploymentId), service: z.literal(target.remoteId), environment: z.literal(target.environmentId), files: filesSchema }).safeParse(raw);
  if (!parsed.success) throw new ApiError("Les sources Railway ne correspondent pas au service, à l’environnement ou au déploiement attendu.");
  const files = parsed.data.files;
  if (files[0].path !== "package.json" || !["package-lock.json", "npm-shrinkwrap.json"].includes(files[1].path) || files.some(file => Buffer.byteLength(file.content) > maxFile)) throw new ApiError("Manifeste et verrou npm non identifiés.");
  try {
    const manifest = JSON.parse(files[0].content), lock = JSON.parse(files[1].content);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || ![2, 3].includes(lock?.lockfileVersion) || !lock.packages?.[""] || Array.isArray(lock.packages)) throw Error();
    const entries = (value: unknown) => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
    if (["dependencies", "devDependencies", "optionalDependencies"].some(section => entries(manifest[section]) !== entries(lock.packages[""][section]))) throw Error();
  } catch { throw new ApiError("Le verrou npm déployé ne correspond pas au manifeste du service."); }
  return { files, hash: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}

export async function readRailwaySources(target: UpdateTarget, deploymentId: string, commit: string, dependencies = { probe: readRailwayProbe, instance: readRailwayInstance }) {
  if (target.provider !== "railway" || target.mode !== "git" || !target.repository || !/^[\w.-]+\/[\w.-]+$/.test(target.repository) || !/^[a-f0-9]{40}$/.test(commit) || !z.uuid().safeParse(deploymentId).success || target.root && (/[\\\x00-\x1f]/.test(target.root) || target.root.split("/").some(part => !part || part === "." || part === ".."))) throw new ApiError("Source Railway non identifiable pour le contrôle de repli.");
  const normalize = (value?: string | null) => (value || "").replace(/^\/+|\/+$/g, "");
  async function current() {
    const instance = (await dependencies.instance(target)).serviceInstance;
    const active = instance?.activeDeployments;
    const evidence = active?.length === 1 ? deploymentEvidence(active[0].meta) : null;
    if (githubRepository(instance?.source?.repo) !== target.repository || normalize(instance.rootDirectory) !== target.root || active?.length !== 1 || active[0].id !== deploymentId || active[0].status !== "SUCCESS" || evidence?.commit !== commit || evidence?.repository !== target.repository || normalize(evidence?.rootDirectory) !== target.root || !evidence?.imageDigest) throw new ApiError("Le déploiement Railway actif ou sa source ne correspondent plus au contrôle.");
    return evidence.imageDigest;
  }
  const digest = await current();
  async function assertCurrent() { if (await current() !== digest) throw new ApiError("L’image Railway a changé pendant le contrôle."); }
  const instances = await dependencies.probe(target, deploymentId, { maxInstances: 4, command: nonce => railwaySourcesCommand(nonce, target.root), parse: (output, nonce) => parseRailwaySources(output, nonce, target, deploymentId) });
  if (!instances.length || instances.some(instance => instance.hash !== instances[0].hash)) throw new ApiError("Les réplicas Railway n’exposent pas les mêmes dépendances verrouillées.");
  await assertCurrent();
  return { files: instances[0].files, assertCurrent };
}

export async function scanRailwaySources(target: UpdateTarget, deploymentId: string, commit: string, dependencies = { read: readRailwaySources, scan: scanSourceSnapshot }) {
  const snapshot = await dependencies.read(target, deploymentId, commit);
  const result = await dependencies.scan(snapshot.files, { source: "railway", deploymentId, limitations: [limitation] });
  await snapshot.assertCurrent();
  if (!result.checks.length || !result.securityCoverage?.packages) throw new ApiError("Aucun inventaire de dépendances Railway analysé n’a pu être confirmé.");
  // The snapshot root is the container's working directory, not the repository
  // root. Bind its findings to the verified service root or the counter drops
  // every finding for a monorepo service such as /worker.
  const lock = snapshot.files.find(file => file.path !== "package.json")!.content;
  const checks = result.checks.map(check => ({ ...check, findings: check.findings.map(finding => ({ ...finding, scope: target.root, usage: npmDependencyUsage(lock, finding.package, finding.version) })) }));
  return { ...result, checks, coverage: "partial" as const, securityCoverage: { ...result.securityCoverage, scope: "dependencies" as const } };
}
