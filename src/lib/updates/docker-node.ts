import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ApiError } from "../http";
import { railwayUpdateRequest } from "./providers";
import { runCommand } from "./process";
import type { UpdateTarget } from "./types";

export type DockerNodeProof = { deploymentId: string; imageDigest: string; instances: { id: string; node: string; running: string[] }[] };
const identifier = z.string().uuid();
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const instancesQuery = `query NodeInstances($id:String!){deployment(id:$id){id status instances{id status}}}`;
const createKey = `mutation NodeProbeKey($input:SshPublicKeyCreateInput!){sshPublicKeyCreate(input:$input){id publicKey}}`;
const deleteKey = `mutation NodeProbeCleanup($id:String!){sshPublicKeyDelete(id:$id)}`;

// No application imports, application commands, or environment dump. Read the installed
// interpreter AND the executable of each already-running Node process, without invoking
// the application. Unset preload hooks before starting either probe interpreter.
// Root in a container may lack CAP_SYS_PTRACE for a different UID. Retry a denied
// /proc read under its owner; comm is not an interpreter identity (Node uses MainThread).
export function dockerNodeProbe(nonce: string) {
  if (!/^[a-f0-9-]{36}$/.test(nonce)) throw new ApiError("Identifiant de sonde Node invalide.");
  return `const fs=require('node:fs'),cp=require('node:child_process');
const env={...process.env};delete env.NODE_OPTIONS;delete env.NODE_PATH;
function inspect(pid){const fs=require('node:fs'),cp=require('node:child_process');let exe;
try{exe=fs.readlinkSync('/proc/'+pid+'/exe')}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return null;throw e}
if(!/\\/node(?:js)?(?: \\(deleted\\))?$/.test(exe))return null;
const env={...process.env};delete env.NODE_OPTIONS;delete env.NODE_PATH;
return {exe,version:cp.execFileSync('/proc/'+pid+'/exe',['--version'],{env,timeout:3000,encoding:'utf8',maxBuffer:1024}).trim().replace(/^v/,'')};}
const running=[],seen=new Set();const pids=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p));
if(pids.length>4096)throw Error('Too many processes');
for(const pid of pids){if(Number(pid)===process.pid)continue;let result;
try{result=inspect(pid)}catch(e){if(e.code!=='EACCES'||process.getuid()!==0)throw e;
let owner;try{owner=fs.statSync('/proc/'+pid)}catch(e){if(e.code==='ENOENT')continue;throw e}
if(owner.uid===0)throw e;
result=JSON.parse(cp.execFileSync(process.execPath,['-e','console.log(JSON.stringify(('+inspect.toString()+')(process.argv[1])))',pid],{env,uid:owner.uid,gid:owner.gid,timeout:5000,encoding:'utf8',maxBuffer:2048}));}
if(!result||seen.has(result.exe))continue;seen.add(result.exe);running.push(result.version);}
console.log(JSON.stringify({nonce:'${nonce}',deployment:process.env.RAILWAY_DEPLOYMENT_ID,service:process.env.RAILWAY_SERVICE_ID,environment:process.env.RAILWAY_ENVIRONMENT_ID,node:process.versions.node,running}));`;
}

export function parseDockerNodeProbe(output: string, nonce: string, target: UpdateTarget, deploymentId: string) {
  if (Buffer.byteLength(output) > 4096) throw new ApiError("Réponse de la sonde Node invalide.", 422);
  let parsed: unknown;
  try { parsed = JSON.parse(output.trim()); } catch { throw new ApiError("Aucune attestation Node reçue du conteneur actif.", 422); }
  const identity = z.object({ nonce: z.literal(nonce), deployment: z.literal(deploymentId), service: z.literal(target.remoteId), environment: z.literal(target.environmentId) });
  if (!identity.safeParse(parsed).success) throw new ApiError("L’identité renvoyée par la sonde Node ne correspond pas au service, à l’environnement ou au déploiement attendu.", 422);
  const result = identity.extend({ node: version, running: z.array(version).max(128) }).safeParse(parsed);
  if (!result.success) throw new ApiError("Les versions renvoyées par la sonde Node sont invalides.", 422);
  if (!result.data.running.length) throw new ApiError("Aucun processus Node applicatif actif n’a pu être attesté dans le conteneur.", 422);
  return { node: result.data.node, running: result.data.running };
}

export async function readDockerNode(target: UpdateTarget, deploymentId: string, imageDigest: string, dependencies = { request: railwayUpdateRequest, execute: runCommand }): Promise<DockerNodeProof> {
  identifier.parse(deploymentId);
  if (target.provider !== "railway" || !/^sha256:[a-f0-9]{64}$/.test(imageDigest)) throw new ApiError("Image déployée non identifiable pour la sonde Node.", 422);
  const instances = await readRailwayProbe(target, deploymentId, {
    command: nonce => "env -u NODE_OPTIONS -u NODE_PATH node -e '" + dockerNodeProbe(nonce).replace(/'/g, "'\\''") + "'",
    parse: (output, nonce) => parseDockerNodeProbe(output, nonce, target, deploymentId),
  }, dependencies);
  return { deploymentId, imageDigest, instances };
}

// Shared short-lived SSH lifecycle; probes provide only fixed, read-only commands.
export async function readRailwayProbe<T extends object>(target: UpdateTarget, deploymentId: string, probe: { command: (nonce: string) => string; parse: (output: string, nonce: string) => T; maxInstances?: number }, dependencies = { request: railwayUpdateRequest, execute: runCommand }): Promise<({ id: string } & T)[]> {
  identifier.parse(deploymentId);
  if (target.provider !== "railway") throw new ApiError("Sonde réservée aux conteneurs Railway.", 422);
  const maxInstances = z.number().int().min(1).max(32).parse(probe.maxInstances ?? 32);
  async function instances() {
    const raw = await dependencies.request(target, instancesQuery, { id: deploymentId });
    const data = z.object({ deployment: z.object({ id: z.literal(deploymentId), status: z.literal("SUCCESS"), instances: z.array(z.object({ id: identifier, status: z.literal("RUNNING") })).min(1).max(maxInstances) }) }).safeParse(raw);
    if (!data.success) throw new ApiError("Les instances du déploiement ne sont pas toutes actives. Attestation du conteneur non confirmée.", 422);
    const ids = data.data.deployment.instances.map(instance => instance.id).sort();
    if (new Set(ids).size !== ids.length) throw new ApiError("Instances dupliquées dans l’attestation de déploiement.", 422);
    return ids;
  }
  const before = await instances();
  const temporary = await mkdtemp(join(tmpdir(), "vigie-node-proof-"));
  const identity = join(temporary, "identity"), known = join(temporary, "known_hosts"), config = join(temporary, "config");
  // Credentials stay in the HTTPS client; SSH never receives API tokens or the
  // worker environment. The private key exists only in this private temporary folder.
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, PROGRAMDATA: process.env.PROGRAMDATA, TEMP: temporary, TMP: temporary, HOME: temporary };
  let keyId: string | undefined;
  let publicKey: string | undefined;
  let registrationAttempted = false;
  async function revoke() {
    if (!registrationAttempted) return;
    if (!keyId && publicKey) {
      let after: string | null = null;
      for (let page = 0; page < 20; page++) {
        const keys = await dependencies.request(target, `query NodeProbeKeys($after:String){sshPublicKeys(first:100,after:$after){edges{node{id publicKey}} pageInfo{hasNextPage endCursor}}}`, { after });
        const connection = z.object({ sshPublicKeys: z.object({ edges: z.array(z.object({ node: z.object({ id: z.string().min(1).max(128), publicKey: z.string() }) })), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) }) }).parse(keys).sshPublicKeys;
        const matches = connection.edges.filter(edge => edge.node.publicKey.trim() === publicKey);
        if (matches.length > 1) throw new ApiError("Clé de sonde ambiguë : révocation à vérifier.", 422);
        keyId = matches[0]?.node.id;
        if (keyId || !connection.pageInfo.hasNextPage) break;
        if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after || page === 19) throw new ApiError("Recherche de la clé temporaire incomplète : révocation à vérifier.", 422);
        after = connection.pageInfo.endCursor;
      }
    }
    if (keyId) {
      const deleted = await dependencies.request(target, deleteKey, { id: keyId });
      if (deleted.sshPublicKeyDelete !== true) throw new ApiError("Railway n’a pas confirmé la révocation de la clé temporaire.", 422);
    }
  }
  try {
    await writeFile(config, "", { mode: 0o600 });
    await dependencies.execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity, "-C", "vigie-node-proof"], { cwd: temporary, env: environment, timeout: 10_000 });
    publicKey = (await readFile(identity + ".pub", "utf8")).trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+ vigie-node-proof$/.test(publicKey)) throw new ApiError("La clé éphémère de la sonde est invalide.", 422);
    publicKey = publicKey.split(" ").slice(0, 2).join(" ");
    registrationAttempted = true;
    const created = await dependencies.request(target, createKey, { input: { name: `vigie-node-proof-${randomUUID()}`, publicKey } });
    const key = z.object({ sshPublicKeyCreate: z.object({ id: z.string().min(1).max(128), publicKey: z.literal(publicKey) }) }).safeParse(created);
    if (!key.success) throw new ApiError("Railway n’a pas confirmé la clé temporaire de vérification.", 422);
    keyId = key.data.sshPublicKeyCreate.id;
    const results: ({ id: string } & T)[] = [];
    for (const id of before) {
      const nonce = randomUUID(), command = probe.command(nonce);
      const args = ["-F", config, "-T", "-a", "-x", "-i", identity, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${known}`, "-o", `GlobalKnownHostsFile=${known}`, "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", `${id}@ssh.railway.com`, command];
      const output = await dependencies.execute("ssh", args, { cwd: temporary, env: environment, timeout: 20_000 });
      results.push({ id, ...probe.parse(output, nonce) });
    }
    if (JSON.stringify(before) !== JSON.stringify(await instances())) throw new ApiError("Les instances ont changé pendant la vérification du conteneur. Attestation refusée.", 422);
    return results;
  } finally {
    try {
      // A transient API failure must not leave an authentication key behind.
      try { await revoke(); } catch { await revoke(); }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
