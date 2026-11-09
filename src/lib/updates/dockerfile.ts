import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ApiError } from "../http";
import { runCommand } from "./process";
import { stableVersion } from "./versions";
import { compare } from "semver";
import { SecurityPolicyError } from "./security";
import { officialNodeImageDigest } from "./node-catalog-state";
import type { SecurityFinding } from "./types";

type Replacement = { start: number; end: number; name: string; suffix: string; version: string; image: boolean };
export type DockerNodeBase = { image: string; digest: string };
type InspectDockerImage = (image: string, bases: DockerNodeBase[] | null) => Promise<void>;
function replacements(source: string) {
  if (source.length > 64_000 || /^\s*#\s*(syntax|escape)\s*=/im.test(source) || /\\\r?\n/.test(source) || /^\s*(ARG|ADD|ONBUILD)\b/im.test(source) || /--(mount|network|security)=/i.test(source)) throw new ApiError("Ce Dockerfile utilise des instructions qui nécessitent une validation dédiée.");
  const changes: Replacement[] = [], stages = new Set<string>();
  let offset = 0, bases = 0;
  for (const line of source.split(/(?<=\n)/)) {
    const from = line.match(/^\s*FROM\s+(\S+)(?:\s+AS\s+([\w-]+))?\s*$/i);
    if (from) {
      const image = from[1];
      if (!stages.has(image.toLowerCase())) {
        const node = image.match(/^node:(\d+(?:\.\d+){0,2})(-(?:slim|trixie(?:-slim)?|bookworm(?:-slim)?|bullseye(?:-slim)?|alpine(?:\d+\.\d+)?))?$/);
        if (!node) throw new ApiError("Seuls les Dockerfiles utilisant les images officielles Node avec une version explicite sont mis à jour automatiquement.");
        changes.push({ start: offset + line.indexOf(image), end: offset + line.indexOf(image) + image.length, name: "node", suffix: node[2] || "", version: node[1], image: true });
        bases++;
      }
      if (from[2]) stages.add(from[2].toLowerCase());
    } else if (/^\s*FROM\b/i.test(line)) throw new ApiError("Instruction FROM non prise en charge.");
    if (/^\s*RUN\s+npm\s+(install|i)\s/i.test(line)) {
      if (/[;&|`$<>]/.test(line) || /\s(-g|--global)\b/.test(line)) throw new ApiError("L’installation npm de ce Dockerfile doit être validée séparément.");
      const argumentsText = line.replace(/^\s*RUN\s+npm\s+(install|i)\s+/i, "").trim();
      for (const token of argumentsText.split(/\s+/).filter(token => token && !token.startsWith("-"))) {
        const pinned = token.match(/^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+)$/i);
        if (!pinned) throw new ApiError("Les paquets installés directement dans le Dockerfile doivent utiliser une version explicite.");
        changes.push({ start: offset + line.indexOf(token), end: offset + line.indexOf(token) + token.length, name: pinned[1], suffix: "", version: pinned[2], image: false });
      }
    }
    offset += line.length;
  }
  if (!bases) throw new ApiError("Aucune image Node reconnue dans le Dockerfile.");
  return changes;
}
export function dockerPackages(source: string) {
  const packages = new Map<string, string>();
  for (const item of replacements(source).filter(item => !item.image)) {
    const previous = packages.get(item.name);
    if (!previous || compare(item.version, previous) > 0) packages.set(item.name, item.version);
  }
  return Object.fromEntries(packages);
}
export function dockerRuntimeBase(source: string) {
  const bases = replacements(source).filter(item => item.image);
  const last = bases.at(-1)!;
  return `node:${last.version}${last.suffix}`;
}
export function dockerNodeBases(source: string) {
  return [...new Set(replacements(source).filter(item => item.image).map(item => source.slice(item.start, item.end)))];
}
export async function pinnedDockerNodeBases(source: string, imageDigest = officialNodeImageDigest) {
  const bases = await Promise.all(dockerNodeBases(source).map(async image => ({ image, digest: await imageDigest(image) })));
  const digests = new Map(bases.map(({ image, digest }) => [image, digest]));
  const dockerfile = replacements(source).filter(item => item.image).reverse().reduce((result, item) => {
    const image = source.slice(item.start, item.end);
    return result.slice(0, item.end) + "@" + digests.get(image) + result.slice(item.end);
  }, source);
  return { dockerfile, bases };
}
export function rewriteDockerfile(source: string, nodeVersion: string, versions: Record<string, string>, release?: "trixie" | "bookworm" | "alpine") {
  if (!stableVersion(nodeVersion)) throw new ApiError("Version Node invalide pour le Dockerfile.");
  let result = source;
  for (const item of replacements(source).reverse()) {
    const version = item.image ? nodeVersion : versions[item.name];
    if (!stableVersion(version)) throw new ApiError(`Version compatible manquante pour ${item.name} dans le Dockerfile.`);
    if (item.image && release && release !== "alpine" && item.suffix.startsWith("-alpine")) throw new ApiError("Le changement de distribution ne peut pas remplacer Alpine par Debian.");
    const suffix = item.image && release ? release === "alpine" ? "-alpine" : `-${release}${item.suffix.endsWith("-slim") ? "-slim" : ""}` : item.suffix;
    const value = item.image ? `node:${version}${suffix}` : `${item.name}@${version}`;
    result = result.slice(0, item.start) + value + result.slice(item.end);
  }
  return result;
}
export function versionOnlyDockerfile(before: string, after: string) {
  try {
    const images = (source: string) => replacements(source).filter(item => item.image);
    const portableTransition = images(before).every(item => item.suffix.endsWith("-slim")) && images(after).every(item => item.suffix.startsWith("-alpine")) && portableNodeDockerfile(before) && portableNodeDockerfile(after);
    const normalize = (source: string) => {
      let result = source;
      for (const item of replacements(source).reverse()) {
        const suffix = portableTransition && item.image ? "-portable-minimal" : item.image && !item.suffix.startsWith("-alpine") ? item.suffix.endsWith("-slim") ? "-debian-slim" : "-debian" : item.suffix;
        const value = item.image ? `node:0.0.0${suffix}` : `${item.name}@0.0.0`;
        result = result.slice(0, item.start) + value + result.slice(item.end);
      }
      return result;
    };
    return before !== after && normalize(before) === normalize(after);
  } catch { return false; }
}

function portableNodeDockerfile(source: string) {
  return source.split(/\r?\n/).every(line => {
    const value = line.trim();
    if (!value || value.startsWith("#") || /^(FROM|WORKDIR|COPY|EXPOSE)\s/i.test(value)) return true;
    if (/^ENV\s+(NODE_ENV=production|PORT=\d+)$/i.test(value) || /^USER\s+(node|1000(?::1000)?)$/i.test(value)) return true;
    if (/^RUN\s+npm\s+(install|i|ci|run\s+[a-z0-9:_-]+)(\s+[a-z0-9@/_.:=+-]+)*$/i.test(value)) return true;
    if (/^CMD\s+\[/i.test(value)) {
      try { const command = JSON.parse(value.replace(/^CMD\s+/i, "")); return Array.isArray(command) && command[0] === "node" && command.every(item => typeof item === "string"); } catch { return false; }
    }
    return false;
  });
}
export function dockerBaseAlternatives(source: string, nodeVersion: string) {
  if (replacements(source).some(item => item.image && item.suffix.startsWith("-alpine"))) return [];
  const releases: ("trixie" | "bookworm" | "alpine")[] = ["trixie", "bookworm"];
  if (replacements(source).filter(item => item.image).every(item => item.suffix.endsWith("-slim")) && portableNodeDockerfile(source)) releases.push("alpine");
  return [...new Set(releases.map(release => rewriteDockerfile(source, nodeVersion, dockerPackages(source), release)))].filter(candidate => candidate !== source);
}

const alpineRepairMarker = "# Vigie: correctifs de sécurité Alpine";
const apkName = /^[a-z0-9][a-z0-9.+_-]{0,63}$/;
const apkRelease = /^\d{1,9}(?:\.\d{1,9}){0,5}-r\d{1,9}$/;
const apkOrder = new Intl.Collator("en", { numeric: true });
export type AlpineRepair = { base: string; findings: SecurityFinding[] };

export function repairAlpineDockerfile({ base, findings }: AlpineRepair) {
  replacements(base);
  const finalFrom = [...base.matchAll(/^[ \t]*FROM[ \t]+[^\r\n]*(\r?\n|$)/gim)].at(-1);
  if (!finalFrom || !/^[ \t]*FROM[ \t]+node:\d+\.\d+\.\d+-alpine(?:\d+\.\d+)?(?:[ \t]+AS[ \t]+[\w-]+)?[ \t]*\r?\n$/i.test(finalFrom[0])) return null;
  const offset = finalFrom.index! + finalFrom[0].length;
  const newline = finalFrom[1], tail = base.slice(offset);
  const prefix = alpineRepairMarker + newline + "RUN apk add --no-cache --upgrade ";
  const versions = new Map<string, string>();
  let previous = "";
  if (base.includes(alpineRepairMarker)) {
    if (!tail.startsWith(prefix) || base.indexOf(alpineRepairMarker) !== offset) return null;
    const args = tail.slice(prefix.length).split(newline)[0];
    previous = prefix + args + newline;
    if (!tail.startsWith(previous)) return null;
    for (const arg of args.split(" ")) {
      const match = arg.match(/^'([^'>]+)>=(.+)'$/);
      if (!match || !apkName.test(match[1]) || !apkRelease.test(match[2]) || versions.has(match[1])) return null;
      versions.set(match[1], match[2]);
    }
  }
  let eligible = false;
  for (const finding of findings) {
    const fixed = finding.fixedVersions?.length === 1 ? finding.fixedVersions[0] : undefined;
    if (finding.packageManager !== "apk" || !apkName.test(finding.package) || !fixed || !apkRelease.test(fixed)) continue;
    eligible = true;
    const floor = versions.get(finding.package);
    if (!floor || apkOrder.compare(fixed, floor) > 0) versions.set(finding.package, fixed);
  }
  if (!eligible || versions.size > 32) return null;
  const args = [...versions].sort(([first], [second]) => first.localeCompare(second)).map(([name, version]) => `'${name}>=${version}'`).join(" ");
  const block = prefix + args + newline;
  return block === previous ? null : base.slice(0, offset) + block + tail.slice(previous.length);
}

export function validatedDockerfileChange(original: string, proposed: string, alpineRepair?: AlpineRepair) {
  if (!alpineRepair) return versionOnlyDockerfile(original, proposed);
  return (original === alpineRepair.base || versionOnlyDockerfile(original, alpineRepair.base))
    && repairAlpineDockerfile(alpineRepair) === proposed;
}

export async function validateDockerfile(folder: string, root: string, names: string[], nodeVersion: string, inspectImage?: InspectDockerImage, notify: (message: string) => Promise<void> = async () => {}) {
  const path = join(folder, root ? root + "/Dockerfile" : "Dockerfile"), initial = await readFile(path, "utf8");
  const candidates = [initial, ...dockerBaseAlternatives(initial, nodeVersion)];
  let failure: unknown;
  for (const [index, candidate] of candidates.entries()) {
    if (index) {
      if (!versionOnlyDockerfile(initial, candidate)) throw new ApiError("Le repli Docker ne respecte pas les changements de versions autorisés.");
      await notify(`Image refusée par Trivy ; essai de ${dockerRuntimeBase(candidate)}, même version Node et mêmes instructions. ${dockerRuntimeBase(candidate).includes("-alpine") ? "Dockerfile Node minimal et portable : la compatibilité Alpine reste à démontrer." : "Famille Debian conservée."} Nouvelle construction, nouveau scan et démarrage obligatoires.`);
      await writeFile(path, candidate);
    }
    try {
      try { await validateDockerfileCandidate(folder, root, names, nodeVersion, inspectImage); return; }
      catch (error) {
        if (!(error instanceof SecurityPolicyError) || error.check.tool !== "Trivy") throw error;
        const repair = { base: candidate, findings: error.check.blockers || error.check.findings };
        const patched = repairAlpineDockerfile(repair);
        if (!patched) throw error;
        await notify("Correctif Alpine proposé à partir du scan. Reconstruction, nouveau scan Trivy et démarrage de contrôle.");
        await writeFile(path, patched);
        await validateDockerfileCandidate(folder, root, names, nodeVersion, inspectImage);
        await notify("Correctif Alpine validé par Trivy et par le démarrage de l’image.");
        return repair;
      }
    }
    catch (error) {
      await writeFile(path, initial);
      if (!(error instanceof SecurityPolicyError) || error.check.tool !== "Trivy") throw error;
      failure = error;
    }
  }
  throw failure;
}
export async function validateDockerfileCandidate(folder: string, root: string, names: string[], nodeVersion: string, inspectImage?: InspectDockerImage) {
  const prefix = root ? root + "/" : "", source = await readFile(join(folder, prefix + "Dockerfile"), "utf8");
  replacements(source);
  const expose = [...source.matchAll(/^\s*EXPOSE\s+(\d+)(?:\/tcp)?\s*$/gim)].at(-1);
  const port = Number(expose?.[1]);
  if (!port || port > 65535) throw new ApiError("Le Dockerfile doit exposer un port HTTP unique pour vérifier le serveur.");
  const temporary = await mkdtemp(join(tmpdir(), "vigie-docker-")), context = join(temporary, "source"), image = `vigie-validation:${randomUUID()}`, container = `vigie-docker-${randomUUID()}`;
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH, HOME: temporary, DOCKER_CONFIG: join(temporary, "client"), ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) };
  try {
    await mkdir(context);
    await mkdir(env.DOCKER_CONFIG!);
    for (const name of names.filter(name => name.startsWith(prefix))) {
      const relative = name.slice(prefix.length);
      if (!relative || relative.split("/").some(part => !part || part === "." || part === ".." || part === ".git" || part === "node_modules") || /[\\\x00-\x1f]/.test(relative)) throw new ApiError("Chemin Docker non autorisé.");
      const origin = join(folder, name), destination = join(context, relative), info = await lstat(origin);
      if (!info.isFile() || info.isSymbolicLink()) throw new ApiError("Seuls les fichiers sources sont admis dans la construction Docker.");
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(origin, destination);
    }
    // BuildKit can resolve FROM without creating a local image tag to inspect.
    // Pin the build input itself for the receipt, preserving the source context.
    const pinned = inspectImage ? await pinnedDockerNodeBases(source).catch(() => null) : null;
    let dockerfile = join(context, "Dockerfile");
    if (pinned) {
      dockerfile = join(temporary, "Dockerfile");
      await writeFile(dockerfile, pinned.dockerfile);
      if (names.includes(prefix + "Dockerfile.dockerignore")) {
        await copyFile(join(context, "Dockerfile.dockerignore"), dockerfile + ".dockerignore");
      }
    }
    await runCommand("docker", ["build", "--pull", "--tag", image, "--file", dockerfile, context], { env, timeout: 15 * 60_000 });
    await inspectImage?.(image, pinned?.bases ?? null);
    const server = await readFile(join(context, "server.js"), "utf8").catch(() => "");
    const gatedDocs = server.includes("process.env.DOCS_COOKIE_SECRET") && server.includes("process.env.DOCS_GATE_URL") && server.includes("/healthz");
    const fixtureEnv = gatedDocs ? ["--env=DOCS_COOKIE_SECRET=vigie-isolated-validation-not-a-production-secret", "--env=DOCS_GATE_URL=https://vigie.invalid/api/auth/docs-gate", "--env=PUBLIC_DOCS_URL=https://vigie.invalid"] : [];
    await runCommand("docker", ["run", "--detach", "--name", container, "--read-only", "--tmpfs=/tmp:rw,nosuid,size=128m", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=512m", "--cpus=1", "--pids-limit=128", "--network=none", "--env=NODE_ENV=production", `--env=PORT=${port}`, ...fixtureEnv, image], { env });
    const actual = (await runCommand("docker", ["exec", container, "node", "--version"], { env })).trim();
    if (actual !== `v${nodeVersion}`) throw new ApiError("L’image Docker ne démarre pas avec la version Node demandée.");
    const probe = `const http=require('node:http'); const paths=${JSON.stringify(gatedDocs ? ["/healthz", "/"] : ["/"])}; const request=path=>new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:${port},path,timeout:2000},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('timeout')))}); (async()=>{for(let attempt=0;attempt<30;attempt++){try{const status=await Promise.all(paths.map(request));if(status[0]>=200&&status[0]<400&&(${gatedDocs ? "status[1]===401" : "true"}))return}catch{}await new Promise(resolve=>setTimeout(resolve,500))}process.exitCode=1})()`;
    await runCommand("docker", ["exec", container, "node", "-e", probe], { env, timeout: 30_000 });
  } finally {
    await runCommand("docker", ["rm", "--force", container], { env }).catch(() => {});
    await runCommand("docker", ["image", "rm", "--force", image], { env }).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}
