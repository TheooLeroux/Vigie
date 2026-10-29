import { mkdtemp, readFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "../http";
import { deployedImageReference } from "../image-reference";
import type { AutomaticControl } from "../automatic-control-state";
import { parseTrivy, securityCheck } from "./security";
import { runCommand } from "./process";

export async function scanDeployedImage(image: string, execute = runCommand): Promise<Pick<AutomaticControl, "checks" | "updates" | "warnings" | "securityCoverage">> {
  if (deployedImageReference(image, image.split("@")[1]) !== image) throw new ApiError("L’image doit être liée à une empreinte de déploiement et à un registre public pris en charge.");
  const folder = await mkdtemp(join(tmpdir(), "vigie-image-monitor-"));
  try {
    const path = join(folder, "report.json");
    // Remote inspection downloads layers only. It never starts the image or
    // mounts a Docker socket, and it receives no hosting/GitHub credentials.
    await execute("trivy", ["image", "--image-src", "remote", "--scanners", "vuln", "--format", "json", "--output", path, "--quiet", "--exit-code=0", "--cache-dir", folder, "--timeout=5m", "--max-image-size=2GB", image], {
      cwd: folder, env: { NODE_ENV: "production", PATH: process.env.PATH, HOME: folder, TMPDIR: folder, DOCKER_CONFIG: folder }, timeout: 360_000,
    });
    const info = await lstat(path);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new ApiError("Le rapport d’image dépasse le budget de lecture ou n’est pas un fichier.", 502);
    const findings = parseTrivy(await readFile(path, "utf8"), true).map(finding => ({ ...finding, usage: "runtime" as const }));
    return { checks: [securityCheck("Trivy", "before", image, findings)], updates: [], warnings: ["Paquets identifiés dans l’image déployée. Les volumes, la configuration et le code métier ne sont pas analysés."], securityCoverage: { scope: "image", limitations: [] } };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("L’image publique ou son rapport de vulnérabilités n’est pas accessible. Vérifier l’empreinte et les droits du registre.", 502);
  } finally { await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
