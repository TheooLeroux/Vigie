import { z } from "zod";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const scope = z.union([z.literal("all"), z.array(z.uuid())]);
export const maintenancePlanSchema = z.object({
  observations: z.object({ vercel: z.boolean(), railway: z.boolean(), o2switch: z.boolean() }),
  security: z.object({ vercel: scope, railway: scope, o2switch: scope }),
  wordpress: scope,
  agents: scope,
});
export type MaintenancePlan = z.infer<typeof maintenancePlanSchema>;
export type MaintenanceScope = z.infer<typeof scope>;
export const fullMaintenancePlan: MaintenancePlan = {
  observations: { vercel: true, railway: true, o2switch: true },
  security: { vercel: "all", railway: "all", o2switch: "all" },
  wordpress: "all", agents: "all",
};

export const maintenanceRequestId = /^maintenance-\d{10,14}-[a-f0-9]{32}$/;

export function maintenanceSignature(id: string) {
  const key = process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(key)) return null;
  const signingKey = Buffer.from(hkdfSync("sha256", Buffer.from(key, "hex"), Buffer.alloc(0), "vigie:maintenance-plan:v1", 32));
  return createHmac("sha256", signingKey).update(id).digest("hex");
}

export function authenticateMaintenancePlan(id: string, signature: string) {
  if (!maintenanceRequestId.test(id) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = maintenanceSignature(id);
  return !!expected && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
}

export function maintenanceHasWork(plan: MaintenancePlan) {
  return Object.values(plan.observations).some(Boolean) ||
    [...Object.values(plan.security), plan.wordpress, plan.agents].some(scope => scope === "all" || scope.length > 0);
}
