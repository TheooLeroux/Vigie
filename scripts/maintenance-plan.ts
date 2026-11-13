import { readFile } from "node:fs/promises";
import { fullMaintenancePlan, maintenancePlanSchema, maintenanceRequestId, maintenanceSignature } from "../src/lib/maintenance-plan";

async function requestPlan(id: string, transport: typeof fetch, method = "GET") {
  const signature = maintenanceSignature(id);
  if (!signature) return null;
  const url = new URL("https://vigie-azure.vercel.app/api/maintenance/plan");
  url.searchParams.set("id", id);
  const response = await transport(url, {
    method, headers: { Authorization: `Bearer ${signature}` }, cache: "no-store", redirect: "error",
    signal: AbortSignal.timeout(method === "GET" ? 5_000 : 55_000),
  });
  if (!response.ok) throw new Error("Cache de maintenance indisponible.");
  return method === "GET" ? response.json() : null;
}

async function workerRequestId() {
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || !process.env.GITHUB_EVENT_PATH) return null;
  try {
    const { inputs } = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
    const id: unknown = inputs?.request_id;
    if (inputs?.fallback_only === true || inputs?.fallback_only === "true" || inputs?.project_id || inputs?.installation_id ||
        (inputs?.security_only !== true && inputs?.security_only !== "true") ||
        typeof id !== "string" || !maintenanceRequestId.test(id)) return null;
    return id;
  } catch { return null; }
}

export async function readWorkerMaintenancePlan(transport: typeof fetch = fetch) {
  const id = await workerRequestId();
  if (id) {
    try {
      const plan = await requestPlan(id, transport);
      if (plan) return maintenancePlanSchema.parse(plan);
    } catch { /* A late job or unavailable cache runs the normal control. */ }
  }
  return fullMaintenancePlan;
}

export async function refreshWorkerMaintenanceCache() {
  const id = await workerRequestId();
  if (!id) return;
  try { await requestPlan(id, fetch, "POST"); }
  catch { console.warn("Vigie : mise à jour du cache de maintenance indisponible."); }
}
