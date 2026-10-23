import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { MaintenancePayload } from "../src/lib/maintenance-contract";
import { maintenanceToken } from "../src/lib/maintenance-credentials";
import { ApiError } from "../src/lib/http";

const command = promisify(execFile);
export async function validateUpdate(payload: MaintenancePayload, commit: string, execute: typeof command = command) {
  if (payload.operation.kind !== "all") throw new ApiError("Mise à jour groupée requise.");
  const token = maintenanceToken(payload.repository);
  if (!token) throw new ApiError("Accès au dépôt indisponible.");
  const temp = await mkdtemp(join(tmpdir(), "vigie-update-"));
  const source = join(temp, "source");
  const containers = ["install", "build", "tooling"].map((stage) => `vigie-${payload.id}-${stage}`);
  const env = { PATH: process.env.PATH || "", HOME: temp, NODE_ENV: "development" as const, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const options = { env, timeout: 240_000, maxBuffer: 1_000_000 };
  try {
    await mkdir(source);
    await mkdir(join(temp, "hooks"));
    await execute("git", ["init", source], options);
    await execute("git", ["-C", source, "-c", `core.hooksPath=${join(temp, "hooks")}`, "fetch", "--depth=1", `https://github.com/${payload.repository}.git`, commit], {
      ...options,
      env: { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` },
    });
    await execute("git", ["-C", source, "-c", `core.hooksPath=${join(temp, "hooks")}`, "checkout", "--detach", "FETCH_HEAD"], options);
    const directory = await realpath(resolve(source, payload.directory));
    if (directory !== source && !directory.startsWith(source + sep)) throw new ApiError("Répertoire hors du dépôt.");
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (typeof manifest.scripts?.build !== "string")
      throw new ApiError("Ce service nécessite un contrôle de construction avant publication ; aucun script build n’est déclaré.");
    const image = `node:${payload.operation.version}-bookworm-slim`;
    const common = ["run", "--rm", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=512", "--memory=3g", "--cpus=2", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--tmpfs", "/tmp:rw,nosuid,size=512m", "-e", "HOME=/tmp", "-e", "CI=true", "-v", `${source}:/app`, "-w", `/app${payload.directory ? `/${payload.directory}` : ""}`];
    const root = JSON.parse(await readFile(join(source, "package.json"), "utf8").catch(() => "{}"));
    const manager = manifest.packageManager || root.packageManager;
    const pnpm = typeof manager === "string" ? manager.match(/^pnpm@(\d+\.\d+\.\d+)/)?.[1] : null;
    let runner = ["npm"];
    if (pnpm) {
      const tooling = join(temp, "tooling");
      await mkdir(tooling);
      await execute("docker", ["run", "--rm", "--name", containers[2], "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "-e", "HOME=/tmp", "-v", `${tooling}:/tooling`, image, "npm", "install", "--prefix=/tooling", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", `pnpm@${pnpm}`], options);
      common.push("-v", `${tooling}:/tooling:ro`);
      runner = ["node", "/tooling/node_modules/pnpm/bin/pnpm.cjs"];
    }
    const install = pnpm
      ? ["install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--strict-peer-dependencies"]
      : ["ci", "--ignore-scripts", "--strict-peer-deps", "--no-audit", "--no-fund"];
    await execute("docker", [...common, "--name", containers[0], "--network=bridge", image, ...runner, ...install, "--registry=https://registry.npmjs.org"], options);
    await execute("docker", [...common, "--name", containers[1], "--network=none", image, ...runner, "run", "build"], options);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("Installation ou build isolé échoué : aucune publication demandée. Les scripts applicatifs n’ont reçu aucun secret de Vigie.");
  } finally {
    await execute("docker", ["rm", "--force", ...containers], { ...options, timeout: 10_000 }).catch(() => {});
    if (resolve(temp).startsWith(resolve(tmpdir()) + sep) && temp.split(sep).at(-1)?.startsWith("vigie-update-"))
      await rm(temp, { recursive: true, force: true });
  }
}
