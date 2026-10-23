import { spawn } from "node:child_process";
import { ApiError } from "../http";

export class DependencyValidationError extends ApiError {
  constructor(message: string, readonly packages: string[]) { super(message, 502); }
}

function affectedPackages(diagnostics: string, allowed: string[]) {
  const modules = [...diagnostics.matchAll(/(?:Module|Cannot find (?:module|package))\s+['"]+([^'"\s]+)['"]/g)].map(match => match[1]);
  const result = allowed.filter(name => modules.some(module => module === name || module.startsWith(name + "/")));
  if (/\bTS510[127]\b/.test(diagnostics) && allowed.includes("typescript")) result.push("typescript");
  return [...new Set(result)];
}

export function runCommand(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number; errorMessages?: Record<string, string>; errorPatterns?: { pattern: RegExp; message: string }[]; diagnosticPackages?: string[] } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "", errorOutput = "", size = 0, settled = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new ApiError("Le traitement a dépassé son délai. Consultez le suivi avant de relancer.", 504)); }, options.timeout || 120_000);
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(output);
    }
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > 8_000_000) { child.kill("SIGKILL"); finish(new ApiError("La sortie du traitement est trop volumineuse.")); }
      else output += chunk.toString();
    });
    child.stderr.on("data", chunk => { if (errorOutput.length < 20_000) errorOutput += chunk.toString().slice(0, 20_000 - errorOutput.length); });
    child.on("error", () => finish(new ApiError(`L’outil ${command} n’est pas disponible sur l’exécuteur.`, 503)));
    child.on("close", code => {
      const reason = output.match(/^VIGIE_ERROR=([a-z_]+)$/m)?.[1];
      const known = options.errorPatterns?.find(item => item.pattern.test(output + "\n" + errorOutput));
      const message = reason && options.errorMessages?.[reason] || known?.message || `L’étape ${command} a échoué. Aucune publication supplémentaire n’a été lancée.`;
      const packages = options.diagnosticPackages ? affectedPackages(output + "\n" + errorOutput, options.diagnosticPackages) : [];
      finish(code === 0 ? undefined : packages.length ? new DependencyValidationError(message, packages) : new ApiError(message, 502));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input || "");
  });
}
