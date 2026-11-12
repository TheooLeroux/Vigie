import { createHash } from "node:crypto";
import { ApiError } from "../http";
import { z } from "zod";

export const wordpressAgentPackageVersion = "wordpress-official-v9";
const previousV8: Record<string, string> = {
  "agent.php": "dd3a7f939fb9baee00a328b529c90e246c7d4ca3fdae28c93d47904f74e71410",
  "plan.php": "c7069f29040829b84c66fc0f844ac32dd50c654490019b992ae971b5f587ecb4",
};
const previousV7: Record<string, string> = {
  "agent.php": "5d5600f44a896784e1b433ad4ab380ce040dcd09091f3f5f6a20b39288b30f88",
  "plan.php": "2f92d58a9365aa127b64349cae5431b5a7fa4c5351ae435f2b9d6e75c09f3f5f",
};
const previousV6: Record<string, string> = {
  "agent.php": "5d5600f44a896784e1b433ad4ab380ce040dcd09091f3f5f6a20b39288b30f88",
  "plan.php": "bb87648c0396cb5c522f4ed76e8368a050a3109487f0b0a20518aa3a7b2c754d",
};
const previousV5: Record<string, string> = {
  "agent.php": "947696c3ca1d843587e177a4786de82392cc9b911577b7bfa28c538ace00fb62",
  "plan.php": "257f3a35c04d70189baaba7ec0a127addef4a13e48268f7159a7383512364ad4",
};
// Exact hashes of the previously deployed, audited package. Never trust an unknown remote edit.
export const legacyAgentHashes: Record<string, string> = {
  "agent.php": "d96a2e94ac4e5a78a5027fbe6efe340c627a824b16a0d492bcca8085d58841e4",
  "plan.php": "74a585aef7a9894002e15001cb1befb13b6007047ab1957ca8c0966ef9588e3f",
  "bootstrap.php": "ebd337b186dde9df73ca775f1b2a5c9417ec361c1293808f71e37ad21ce0a84b",
  "php.d/10-phar.ini": "f2ca199ff9e14f1f8b5de387bd684c4fa34fdc6f06a52c60275ace70065d4ecc",
};
// Exact worker and generated plan from the audited 120ae9c package.
const legacyAgentV2: Record<string, string> = {
  "agent.php": "5ec8a854463572ceb3445b0b9fe80e74d8e74347082adc6dc3714c3d22340a6b",
  "plan.php": "fdb815406033d479c048a9de6aee4d009ddde724d24808efb2e733bb43b5646c",
};
export const agentFileHash = (value: string) => createHash("sha256").update(value).digest("hex");
const configSchema = z.object({ protocol: z.literal("vigie-local-v1"), root: z.string(), secret: z.string(), phpBinary: z.string(), wpBinary: z.string(), environment: z.enum(["production", "staging"]), workerSha256: z.string().regex(/^[a-f0-9]{64}$/), planSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export function assertManagedAgentFile(name: string, current: string | null, expected: string, config: string, previous: Record<string, string> = {}, previousPhpBinary?: string) {
  if (current === null || current === expected) return;
  const allowed = (file: string) => [legacyAgentHashes[file], legacyAgentV2[file], previousV5[file], previousV6[file], previousV7[file], previousV8[file], previous[file], file === name ? agentFileHash(expected) : undefined].filter(Boolean);
  if (name === "config.json") {
    try {
      const old = configSchema.parse(JSON.parse(current)), next = configSchema.parse(JSON.parse(config));
      const knownWorker = [legacyAgentHashes["agent.php"], previous["agent.php"], next.workerSha256].includes(old.workerSha256);
      const knownPlan = [legacyAgentHashes["plan.php"], previous["plan.php"], next.planSha256].includes(old.planSha256);
      const knownV2 = old.workerSha256 === legacyAgentV2["agent.php"] && old.planSha256 === legacyAgentV2["plan.php"];
      const knownPrevious = [previousV5, previousV6, previousV7, previousV8].some(bundle => old.workerSha256 === bundle["agent.php"] && old.planSha256 === bundle["plan.php"]);
      if (old.protocol === next.protocol && old.root === next.root && old.secret === next.secret && [next.phpBinary, previousPhpBinary].includes(old.phpBinary) && old.wpBinary === next.wpBinary && old.environment === next.environment && (knownV2 || knownPrevious || knownWorker && knownPlan)) return;
    } catch { /* Fail closed without exposing remote contents or keys. */ }
  } else if (current.replace(/\r\n/g, "\n") === expected || allowed(name).includes(agentFileHash(current))) return;
  throw new ApiError("Un fichier d’agent différent existe déjà ; aucun écrasement. Seules les versions gérées et vérifiées peuvent être remplacées.");
}
