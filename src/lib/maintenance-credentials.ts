import { repositorySchema } from "./maintenance-contract";

export function maintenanceToken(repository: string) {
  repositorySchema.parse(repository);
  let tokens: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(process.env.VIGIE_MAINTENANCE_GITHUB_TOKENS || "{}");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) tokens = raw;
  } catch {
    return null;
  }
  const entries = Object.entries(tokens);
  const specific = entries.find(
    ([key]) => key.toLowerCase() === repository.toLowerCase(),
  )?.[1];
  const owner = entries.find(
    ([key]) => key.toLowerCase() === repository.split("/")[0].toLowerCase(),
  )?.[1];
  const token = specific || owner || process.env.VIGIE_MAINTENANCE_GITHUB_TOKEN;
  return typeof token === "string" && /^[!-~]{10,2000}$/.test(token)
    ? token
    : null;
}
