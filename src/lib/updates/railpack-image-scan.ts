import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "../http";
import { deploymentEvidence } from "../connectors/railway-evidence";
import { normalizeImageDigest } from "../image-reference";
import { readRailwayProbe } from "./docker-node";
import { readRailwayInstance } from "./providers";
import { caddyProbe, parseCaddyProbe } from "./railpack-caddy";
import { parseTrivy, securityCheck } from "./security";
import { runCommand } from "./process";
import type { RailpackImageIdentity } from "./railpack-image-report";
import type { UpdateTarget } from "./types";

const maxInventory = 2_000_000;
export type RailpackInventory = { sbom: string; debian: string; osRelease: string; dpkgStatus: string };

export function railpackInventoryProbe(nonce: string) {
  return caddyProbe(nonce).slice(0, -1) + `
test "$(wc -c </var/lib/dpkg/status)" -le 1000000
test "$(wc -c </etc/os-release)" -le 4096
printf "VIGIE_INVENTORY\\n"
base64 -w0 /etc/os-release
printf "\\n"
base64 -w0 /var/lib/dpkg/status
printf "\\n"
'`;
}

export function parseRailpackInventory(output: string, nonce: string, target: UpdateTarget, deploymentId: string) {
  const [proof, files, ...rest] = output.trim().split(/\r?\nVIGIE_INVENTORY\r?\n/);
  const [os, packages, ...extra] = files?.split(/\r?\n/) || [];
  if (output.length > maxInventory || rest.length || extra.length || !os || !packages ||
    ![os, packages].every(value => /^[A-Za-z0-9+/]+={0,2}$/.test(value))) throw new ApiError("Inventaire Railpack incomplet.", 422);
  const osRelease = Buffer.from(os, "base64"), dpkgStatus = Buffer.from(packages, "base64");
  if (osRelease.length > 4096 || dpkgStatus.length > 1_000_000 || !/^ID="?debian"?$/m.test(osRelease.toString()) || !/^Status: install ok installed$/m.test(dpkgStatus.toString())) {
    throw new ApiError("Inventaire Debian Railpack inexploitable.", 422);
  }
  return { ...parseCaddyProbe(proof, nonce, target, deploymentId), osRelease, dpkgStatus };
}

async function verifyActiveImage(target: UpdateTarget, identity: RailpackImageIdentity) {
  const instance = (await readRailwayInstance(target)).serviceInstance;
  const active = instance.activeDeployments || [];
  const deployment = active[0], evidence = deploymentEvidence(deployment?.meta);
  if (instance.builder !== "RAILPACK" || active.length !== 1 || deployment.id !== identity.deploymentId || deployment.status !== "SUCCESS" ||
    !evidence?.staticSite || evidence.commit !== identity.commit || evidence.repository !== target.repository || evidence.branch !== target.branch ||
    (instance.rootDirectory || "").replace(/^\/+|\/+$/g, "") !== target.root || normalizeImageDigest(evidence.imageDigest) !== identity.imageDigest ||
    !evidence.packages.some(pkg => pkg.name === "caddy" && pkg.usage === "runtime" && pkg.version === identity.caddy)) {
    throw new ApiError("Le déploiement Railpack a changé pendant le contrôle image.", 409);
  }
}

async function installedCaddy(version: string, hash: string, directory: string, root: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new ApiError("Version Caddy invalide.", 422);
  const asset = `https://github.com/caddyserver/caddy/releases/download/v${version}/caddy_${version}_linux_amd64.tar.gz`;
  const response = await fetch(asset, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new ApiError("Le binaire officiel Caddy est indisponible.", 502);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 40_000_000) throw new ApiError("L’archive Caddy dépasse la taille autorisée.", 422);
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const archive = join(directory, "caddy.tar.gz");
  await writeFile(archive, Buffer.concat(chunks));
  await runCommand("tar", ["-xzf", archive, "-C", root, "--no-same-owner", "--no-same-permissions", "caddy"], { cwd: directory, env: { NODE_ENV: "production", PATH: process.env.PATH, HOME: directory }, timeout: 20_000 });
  const path = join(root, "caddy"), info = await lstat(path);
  if (!info.isFile() || info.size > 80_000_000 || createHash("sha256").update(await readFile(path)).digest("hex") !== hash) {
    throw new ApiError("Le binaire officiel ne correspond pas au Caddy actif ; le scan image reste à vérifier.", 422);
  }
}

export async function scanRailpackImage(target: UpdateTarget, identity: RailpackImageIdentity, inventory?: RailpackInventory) {
  const folder = await mkdtemp(join(tmpdir(), "vigie-railpack-sbom-"));
  try {
    const env = { NODE_ENV: "production" as const, PATH: process.env.PATH, HOME: folder, TMPDIR: folder, DOCKER_CONFIG: folder };
    const path = join(folder, "inventory.cdx.json"), root = join(folder, "debian");
    const options = { cwd: folder, env, timeout: 120_000 };
    await mkdir(join(root, "etc"), { recursive: true });
    await mkdir(join(root, "var/lib/dpkg"), { recursive: true });
    if (!inventory) {
      await verifyActiveImage(target, identity);
      const instances = await readRailwayProbe(target, identity.deploymentId, {
        command: railpackInventoryProbe,
        parse: (output, nonce) => parseRailpackInventory(output, nonce, target, identity.deploymentId),
        maxInstances: 8,
      });
      const first = instances[0];
      if (!first || instances.some(item => item.version !== identity.caddy || item.packagesHash !== first.packagesHash ||
        item.binaryHash !== first.binaryHash || !item.osRelease.equals(first.osRelease) || !item.dpkgStatus.equals(first.dpkgStatus))) {
        throw new ApiError("Les instances Railway ne présentent pas le même inventaire Railpack.", 422);
      }
      await writeFile(join(root, "var/lib/dpkg/status"), first.dpkgStatus);
      const packagesHash = await runCommand("bash", ["-o", "pipefail", "-c", 'dpkg-query --admindir="$1" -W | LC_ALL=C sort | sha256sum | cut -d " " -f 1', "_", join(root, "var/lib/dpkg")], options);
      const debian = /^VERSION_ID="?(\d{1,2})"?$/m.exec(first.osRelease.toString())?.[1];
      if (packagesHash.trim() !== first.packagesHash || !debian) throw new ApiError("La liste de paquets ne correspond pas à l’empreinte attestée sur Railway.", 422);
      const binary = join(folder, "binary");
      await mkdir(binary);
      await installedCaddy(identity.caddy, first.binaryHash, folder, binary);
      await runCommand("trivy", ["rootfs", "--format", "cyclonedx", "--output", path, "--quiet", "--cache-dir", join(folder, "cache"), binary], options);
      if ((await lstat(path)).size > maxInventory) throw new ApiError("L’inventaire Railpack dépasse la taille autorisée.", 422);
      inventory = { sbom: await readFile(path, "utf8"), debian, osRelease: first.osRelease.toString("base64"), dpkgStatus: first.dpkgStatus.toString("base64") };
    } else {
      if (Buffer.byteLength(inventory.sbom) > maxInventory || inventory.osRelease.length > 5500 || inventory.dpkgStatus.length > 1_334_000 ||
        !/^\d{1,2}$/.test(inventory.debian)) throw new ApiError("Inventaire Railpack invalide.", 422);
      await writeFile(path, inventory.sbom);
      await writeFile(join(root, "var/lib/dpkg/status"), Buffer.from(inventory.dpkgStatus, "base64"));
    }
    await writeFile(join(root, "etc/os-release"), Buffer.from(inventory.osRelease, "base64"));
    // Trivy's CycloneDX import loses the OS package target for this rootfs.
    // Keep the attested dpkg database as the Debian input and the SBOM for Go.
    async function analyze(args: string[], input: string, type: "debian" | "gobinary") {
      const result = join(folder, type + ".json");
      await runCommand("trivy", [...args, "--scanners", "vuln", "--list-all-pkgs", "--format", "json", "--output", result, "--quiet", "--cache-dir", join(folder, "cache"), input], options);
      if ((await lstat(result)).size > 16_000_000) throw new ApiError("Le rapport Railpack dépasse la taille autorisée.", 422);
      const raw = await readFile(result, "utf8"), report = JSON.parse(raw);
      if (!report.Results?.some((item: { Type?: string; Packages?: unknown[] }) => item.Type === type && item.Packages?.length)) {
        throw new ApiError("Trivy n’a pas confirmé l’inventaire Debian ou Go de l’image Railpack.", 422);
      }
      return parseTrivy(raw, true, type === "gobinary" ? type : undefined);
    }
    const system = await analyze(["rootfs", "--pkg-types", "os", "--distro", `debian/${inventory.debian}`], root, "debian");
    const caddy = await analyze(["sbom", "--pkg-types", "library"], path, "gobinary");
    const findings = [...system, ...caddy].map(finding => ({ ...finding, scope: target.root, usage: "runtime" as const }));
    await verifyActiveImage(target, identity);
    return { inventory, check: securityCheck("Trivy", "before", `Image Railpack Caddy ${identity.caddy}`, findings) };
  } finally { await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
