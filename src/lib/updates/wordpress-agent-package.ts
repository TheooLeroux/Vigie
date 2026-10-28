import { createHash } from "node:crypto";
import { ApiError } from "../http";
import { z } from "zod";

export const wordpressAgentPackageVersion = "core-plugins-free-v4";
// Exact hashes of the previously deployed, audited package. Never trust an unknown remote edit.
export const legacyAgentHashes: Record<string, string> = {
  "agent.php": "d96a2e94ac4e5a78a5027fbe6efe340c627a824b16a0d492bcca8085d58841e4",
  "plan.php": "74a585aef7a9894002e15001cb1befb13b6007047ab1957ca8c0966ef9588e3f",
  "bootstrap.php": "ebd337b186dde9df73ca775f1b2a5c9417ec361c1293808f71e37ad21ce0a84b",
  "php.d/10-phar.ini": "f2ca199ff9e14f1f8b5de387bd684c4fa34fdc6f06a52c60275ace70065d4ecc",
};
export const agentFileHash = (value: string) => createHash("sha256").update(value).digest("hex");
const configSchema = z.object({ protocol: z.literal("vigie-local-v1"), root: z.string(), secret: z.string(), phpBinary: z.string(), wpBinary: z.string(), environment: z.enum(["production", "staging"]), workerSha256: z.string().regex(/^[a-f0-9]{64}$/), planSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export function assertManagedAgentFile(name: string, current: string | null, expected: string, config: string, previous: Record<string, string> = {}, previousPhpBinary?: string) {
  if (current === null || current === expected) return;
  const allowed = (file: string) => [legacyAgentHashes[file], previous[file], file === name ? agentFileHash(expected) : undefined].filter(Boolean);
  if (name === "config.json") {
    try {
      const old = configSchema.parse(JSON.parse(current)), next = configSchema.parse(JSON.parse(config));
      const knownWorker = [legacyAgentHashes["agent.php"], previous["agent.php"], next.workerSha256].includes(old.workerSha256);
      const knownPlan = [legacyAgentHashes["plan.php"], previous["plan.php"], next.planSha256].includes(old.planSha256);
      if (old.protocol === next.protocol && old.root === next.root && old.secret === next.secret && [next.phpBinary, previousPhpBinary].includes(old.phpBinary) && old.wpBinary === next.wpBinary && old.environment === next.environment && knownWorker && knownPlan) return;
    } catch { /* Fail closed without exposing remote contents or keys. */ }
  } else if (allowed(name).includes(agentFileHash(current))) return;
  throw new ApiError("Un fichier d’agent différent existe déjà ; aucun écrasement. Seules les versions gérées et vérifiées peuvent être remplacées.");
}
