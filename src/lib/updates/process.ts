import { spawn } from "node:child_process";
import { ApiError } from "../http";
import { validRange } from "semver";

export type PeerConflict = { peer: string; range: string; consumer: string; version: string };
export class PeerResolutionError extends ApiError {
  constructor(readonly conflicts: PeerConflict[]) { super(`Résolution stricte npm refusée : ${conflicts.map(item => `${item.consumer}@${item.version} exige ${item.peer} ${item.range}`).join(" ; ")}.`, 502); }
}
export function npmPeerConflicts(diagnostics: string): PeerConflict[] {
  if (!/\bERESOLVE\b/.test(diagnostics)) return [];
  const pattern = /(?:^|\n)(?:npm (?:error|ERR!)\s+)?\s*peer(?:Optional)? ((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@"([0-9xXvV.*^~<>=| +\-]{1,200})" from ((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+)(?=\s|$)/gi;
  return [...new Map([...diagnostics.matchAll(pattern)].filter(match => validRange(match[2])).map(match => {
    const conflict = { peer: match[1], range: match[2], consumer: match[3], version: match[4] };
    return [JSON.stringify(conflict), conflict];
  })).values()].slice(0, 30);
}

export class DependencyValidationError extends ApiError {
  constructor(message: string, readonly packages: string[]) { super(message, 502); }
}
export class IndirectValidationError extends ApiError {
  constructor(message: string, readonly packages: string[], readonly locations: string[] = []) { super(message, 502); }
}

function affectedPackages(diagnostics: string, allowed: string[]) {
  const modules = [...diagnostics.matchAll(/(?:Module|Cannot find (?:module|package))\s+['"]+([^'"\s]+)['"]/g)].map(match => match[1]);
  const result = allowed.filter(name => modules.some(module => module === name || module.startsWith(name + "/")));
  if (/\bTS510[127]\b/.test(diagnostics) && allowed.includes("typescript")) result.push("typescript");
  return [...new Set(result)];
}

export function runCommand(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number; acceptedExitCodes?: number[]; errorMessages?: Record<string, string>; errorPatterns?: { pattern: RegExp; message: string }[]; diagnosticPackages?: string[]; diagnosticIndirectPackages?: string[]; diagnosticIndirectLocations?: Record<string, string>; peerResolution?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "", errorOutput = "", size = 0, settled = false;
    const directDiagnostics = new Set<string>(), indirectDiagnostics = new Set<string>(), allowedIndirects = new Set(options.diagnosticIndirectPackages);
    const indirectLocations = new Set<string>();
    const tails = { stdout: "", stderr: "" };
    function diagnose(chunk: string, stream: keyof typeof tails) {
      if (!options.diagnosticPackages?.length && !allowedIndirects.size) return;
      const sample = (tails[stream] + chunk).replace(/\u001b\[[0-9;]*m/g, "");
      for (const name of affectedPackages(sample, options.diagnosticPackages || [])) directDiagnostics.add(name);
      for (const line of sample.split(/\r?\n/)) {
        if (!/^\s*at\s/.test(line)) continue;
        if (options.diagnosticIndirectLocations) {
          for (const match of line.matchAll(/(?:^|[/\\])(node_modules[/\\](?:@[a-z0-9._-]+[/\\])?[a-z0-9._-]+(?:[/\\]node_modules[/\\](?:@[a-z0-9._-]+[/\\])?[a-z0-9._-]+)*)/gi)) {
            const path = match[1].replace(/\\/g, "/"), name = options.diagnosticIndirectLocations[path];
            if (name && allowedIndirects.has(name) && indirectLocations.size < 30) { indirectLocations.add(path); indirectDiagnostics.add(name); }
          }
          continue;
        }
        for (const match of line.matchAll(/(?:^|[/\\])node_modules[/\\]((?:@[a-z0-9._-]+[/\\])?[a-z0-9._-]+)(?=[/\\])/gi)) {
          const name = match[1].replace(/\\/g, "/");
          if (allowedIndirects.has(name) && indirectDiagnostics.size < 30) indirectDiagnostics.add(name);
        }
      }
      tails[stream] = sample.slice(-4096);
    }
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new ApiError("Le traitement a dépassé son délai. Consultez le suivi avant de relancer.", 504)); }, options.timeout || 120_000);
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(output);
    }
    child.stdout.on("data", chunk => {
      diagnose(chunk.toString(), "stdout");
      size += chunk.length;
      if (size > 8_000_000) { child.kill("SIGKILL"); finish(new ApiError("La sortie du traitement est trop volumineuse.")); }
      else output += chunk.toString();
    });
    child.stderr.on("data", chunk => { diagnose(chunk.toString(), "stderr"); if (errorOutput.length < 20_000) errorOutput += chunk.toString().slice(0, 20_000 - errorOutput.length); });
    child.on("error", () => finish(new ApiError(`L’outil ${command} n’est pas disponible sur l’exécuteur.`, 503)));
    child.on("close", code => {
      const reason = output.match(/^VIGIE_ERROR=([a-z_]+)$/m)?.[1];
      const known = options.errorPatterns?.find(item => item.pattern.test(output + "\n" + errorOutput));
      const message = reason && options.errorMessages?.[reason] || known?.message || `L’étape ${command} a échoué. Aucune publication supplémentaire n’a été lancée.`;
      const packages = [...new Set([...(options.diagnosticPackages ? affectedPackages(output + "\n" + errorOutput, options.diagnosticPackages) : []), ...directDiagnostics])];
      const indirects = [...indirectDiagnostics];
      const peers = options.peerResolution ? npmPeerConflicts(output + "\n" + errorOutput) : [];
      finish(code === 0 || code !== null && options.acceptedExitCodes?.includes(code) ? undefined : peers.length ? new PeerResolutionError(peers) : packages.length ? new DependencyValidationError(message, packages) : indirects.length ? new IndirectValidationError(message, indirects, [...indirectLocations]) : new ApiError(message, 502));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input || "");
  });
}
