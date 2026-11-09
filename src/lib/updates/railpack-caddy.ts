import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gt } from "semver";
import { z } from "zod";
import { ApiError } from "../http";
import type { RailwayDeploymentEvidence } from "../railway-types";
import { readRailwayProbe } from "./docker-node";
import { activeNodeImage, type NodeDeploymentReference } from "./node-deployment";
import { runCommand } from "./process";
import { readRailwayInstance } from "./providers";
import { stableVersion } from "./versions";
import type { UpdateCheck, UpdateTarget } from "./types";

const railpackVersion = "0.43.0";
const railpackFrontend = "ghcr.io/railwayapp/railpack-frontend@sha256:355ef61fae6f2551103cd8b10c710cb07167dd353d561f15c69b8d7ac1c676cc";
const exact = z.string().regex(/^\d+\.\d+\.\d+$/);
const config = z.strictObject({ packages: z.strictObject({ caddy: exact }) });
export type CaddyChange = { previous?: string; current: string; version: string };
export type CaddyFingerprint = { packagesHash: string; binaryHash: string };

export function railpackCaddyVersion(evidence: RailwayDeploymentEvidence | null) {
  return evidence?.staticSite && evidence.railpackVersion?.replace(/^v/, "") === railpackVersion
    ? evidence.packages.find(item => item.name === "caddy" && item.usage === "runtime")?.version
    : undefined;
}

export function caddyVersionChange(current: string, latest: string, previous?: string): CaddyChange | null {
  if (!stableVersion(current) || !stableVersion(latest) || !gt(latest, current)) return null;
  if (previous !== undefined) {
    let parsed;
    try { parsed = config.parse(JSON.parse(previous)); }
    catch { throw new ApiError("Configuration Railpack personnalisée : la mise à jour de Caddy nécessite une validation dédiée.", 422); }
    if (gt(parsed.packages.caddy, latest)) throw new ApiError("La version Caddy déjà demandée est supérieure à la candidate.", 422);
  }
  return { previous, current, version: latest };
}

export function caddyConfig(change: Pick<CaddyChange, "version">) {
  return JSON.stringify({ packages: { caddy: change.version } }, null, 2) + "\n";
}

export async function validateRailpackCaddy(folder: string, root: string, names: string[], version: string, scan: (image: string) => Promise<void>, cacheKey = randomUUID()): Promise<CaddyFingerprint> {
  const temporary = await mkdtemp(join(tmpdir(), "vigie-caddy-"));
  const context = join(temporary, "source");
  const output = join(temporary, "plan"), planFile = join(output, "railpack-plan.json");
  const id = randomUUID();
  const image = `vigie-validation:${id}`, container = `vigie-caddy-${id}`;
  const env = { NODE_ENV: "production" as const, PATH: process.env.PATH, HOME: temporary, DOCKER_CONFIG: join(temporary, "docker"), ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) };
  const prefix = root ? root + "/" : "";
  try {
    await mkdir(context);
    await mkdir(output);
    await mkdir(env.DOCKER_CONFIG);
    for (const name of names.filter(name => name.startsWith(prefix))) {
      const destination = join(context, name.slice(prefix.length));
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(folder, name), destination);
    }
    await writeFile(join(context, "railpack.json"), caddyConfig({ version }));
    const uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0;
    await runCommand("docker", ["run", "--rm", "--name", container + "-plan", "--platform=linux/amd64", "--entrypoint=/railpack",
      "--user", `${uid}:${gid}`, "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=512m", "--cpus=1", "--pids-limit=128",
      "--env=HOME=/tmp", "--volume", context + ":/source:ro", "--volume", output + ":/plan", railpackFrontend,
      "prepare", "--plan-out", "/plan/railpack-plan.json", "/source"], { env, timeout: 60_000 });
    const plan = z.object({
      steps: z.array(z.object({ name: z.string(), commands: z.array(z.unknown()) })),
      deploy: z.object({ startCommand: z.literal("caddy run --config /Caddyfile --adapter caddyfile 2>&1") }),
    }).parse(JSON.parse(await readFile(planFile, "utf8")));
    if (!plan.steps.find(step => step.name === "packages:caddy")?.commands.some(command =>
      z.object({ cmd: z.literal(`mise install-into caddy@${version} /railpack/caddy`) }).safeParse(command).success
    )) throw new ApiError("Le plan Railpack n’installe pas la version Caddy demandée.", 422);
    await runCommand("docker", ["buildx", "build", "--load", "--platform=linux/amd64", "--tag", image,
      "--build-arg", `BUILDKIT_SYNTAX=${railpackFrontend}`, "--build-arg", `cache-key=${cacheKey}`, "--file", planFile, context], { env, timeout: 10 * 60_000 });
    await scan(image);
    await runCommand("docker", ["run", "--detach", "--name", container, "--network=none", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--memory=512m", "--cpus=1", "--pids-limit=128", "--env=PORT=8080", image], { env });
    await runCommand("docker", ["exec", container, "bash", "-ec", `caddy validate --config /Caddyfile --adapter caddyfile
for i in 1 2 3 4 5; do
  if (exec 3<>/dev/tcp/127.0.0.1/8080; printf 'GET / HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3; read -r -t 2 status <&3; [[ "$status" == HTTP/*" 200 "* ]]); then exit 0; fi
  sleep 1
done
exit 1`], { env, timeout: 20_000 });
    const installed = parseCaddyInventory((await runCommand("docker", ["exec", container, "bash", "-ec", caddyInventory], { env })).trim().split(/\r?\n/));
    if (installed.version !== version) throw new ApiError("La version du processus Caddy dans l’image diffère du plan.", 422);
    return installed;
  } finally {
    await runCommand("docker", ["rm", "--force", container + "-plan"], { env }).catch(() => {});
    await runCommand("docker", ["rm", "--force", container], { env }).catch(() => {});
    await runCommand("docker", ["image", "rm", "--force", image], { env }).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}

const caddyInventory = `set -o pipefail
dpkg-query -W | LC_ALL=C sort | sha256sum | cut -d " " -f 1
for exe in /proc/[0-9]*/exe; do
  path=$(readlink "$exe" 2>/dev/null) || continue
  case "$path" in
    */caddy|*/caddy" (deleted)")
      checksum=$(sha256sum "$exe" | cut -d " " -f 1)
      version=$("$exe" version)
      printf "%s %s\\n" "$checksum" "$version"
      ;;
  esac
done
:`;

function parseCaddyInventory([packagesHash, ...lines]: string[]): CaddyFingerprint & { version: string } {
  const entries = lines.map(line => /^([a-f0-9]{64}) v(\d+\.\d+\.\d+)(?:\s.*)?$/.exec(line));
  if (!/^[a-f0-9]{64}$/.test(packagesHash) || !entries.length || entries.some(entry => !entry || entry[1] !== entries[0]?.[1] || entry[2] !== entries[0]?.[2])) {
    throw new ApiError("Version ou empreinte du processus Caddy actif non confirmée.", 422);
  }
  return { packagesHash, binaryHash: entries[0]![1], version: entries[0]![2] };
}

export function caddyProbe(nonce: string) {
  if (!/^[a-f0-9-]{36}$/.test(nonce)) throw new ApiError("Identifiant de sonde Caddy invalide.");
  return `bash -ec 'printf "%s\\n" "${nonce}" "$RAILWAY_DEPLOYMENT_ID" "$RAILWAY_SERVICE_ID" "$RAILWAY_ENVIRONMENT_ID"
${caddyInventory}'`;
}

export function parseCaddyProbe(output: string, nonce: string, target: UpdateTarget, deploymentId: string) {
  const [challenge, deployment, service, environment, ...lines] = output.trim().split(/\r?\n/);
  if (output.length > 4096 || challenge !== nonce || deployment !== deploymentId || service !== target.remoteId || environment !== target.environmentId) {
    throw new ApiError("Identité du processus Caddy actif non confirmée.", 422);
  }
  return parseCaddyInventory(lines);
}

export async function verifyRailwayCaddy(target: UpdateTarget, reference: NodeDeploymentReference, nodeVersion: string, expected?: string, readers = { instance: readRailwayInstance, probe: readRailwayProbe }): Promise<UpdateCheck> {
  const active = async () => {
    const instance = (await readers.instance(target)).serviceInstance;
    if ((instance.rootDirectory || "").replace(/^\/+|\/+$/g, "") !== target.root) throw new ApiError("Le répertoire Railway a changé pendant la vérification Caddy.", 422);
    return activeNodeImage(target, reference, nodeVersion, instance.activeDeployments || []);
  };
  const before = await active();
  const manifest = railpackCaddyVersion(before);
  if (!manifest || expected && manifest !== expected) throw new ApiError("Le manifeste actif Railway n’atteste pas la version Caddy attendue.", 422);
  const instances = await readers.probe(target, reference.deploymentId, {
    command: caddyProbe, parse: (output, nonce) => parseCaddyProbe(output, nonce, target, reference.deploymentId),
  });
  const after = await active();
  const first = instances[0];
  if (after.imageDigest !== before.imageDigest || railpackCaddyVersion(after) !== manifest || !first ||
      instances.some(item => item.version !== manifest || item.packagesHash !== first.packagesHash || item.binaryHash !== first.binaryHash)) {
    throw new ApiError("Le processus Caddy actif, les instances ou l’image ne correspondent pas au manifeste Railway.", 422);
  }
  return { tool: "Caddy", phase: "after", status: "passed", scope: target.root, checkedAt: new Date().toISOString(), findings: [],
    caddyEvidence: { version: manifest, deploymentId: reference.deploymentId, imageDigest: before.imageDigest!, instances: instances.map(item => item.id),
      packagesHash: first.packagesHash, binaryHash: first.binaryHash },
    message: `Caddy ${manifest} lu sur les processus actifs de ${instances.length} instance(s) Railway. Déploiement ${reference.deploymentId}, image ${before.imageDigest} revérifiée.` };
}
