import { z } from "zod";
const text = (max = 200) => z.string().trim().max(max);
export const safeUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    if (!value) return true;
    try {
      const u = new URL(value);
      return (
        ["https:", "http:"].includes(u.protocol) && !u.username && !u.password
      );
    } catch {
      return false;
    }
  }, "Utilisez une URL http(s) complète, sans identifiant ni mot de passe.");
export const projectSchema = z.object({
  name: text().min(1, "Le nom du projet est obligatoire."),
  url: safeUrl.default(""),
  description: text(10000).default(""),
  client: text().default(""),
  clientId: z.string().min(1).nullable().default(null),
  owner: text().default(""),
  criticality: z
    .enum(["standard", "important", "critical"])
    .default("standard"),
  lifecycle: z.enum(["active", "archived"]).default("active"),
  tags: z.array(text(40)).max(20).default([]),
});
export const clientSchema = z.object({
  name: text()
    .min(1, "Le nom du client est obligatoire.")
    .transform((v) => v.normalize("NFKC").replace(/\s+/g, " ")),
  contactName: text().default(""),
  email: z.union([z.literal(""), z.email().max(320)]).default(""),
  phone: text(80).default(""),
  website: safeUrl.default(""),
  notes: text(10000).default(""),
});
export const createProjectSchema = projectSchema.extend({
  technology: text(100).default(""),
  provider: text(100).default(""),
  runtime: text(100).default(""),
  version: text(100).default(""),
  repository: safeUrl.default(""),
});
export const environmentSchema = z.object({
  name: text().min(1),
  kind: z.enum(["production", "staging", "development"]),
  url: safeUrl.default(""),
});
export const serviceSchema = z.object({
  name: text().min(1),
  environmentId: z.string().min(1),
  kind: z.enum(["web", "api", "worker", "database"]),
  technology: text(100).default(""),
  provider: text(100).default(""),
  url: safeUrl.default(""),
  repository: safeUrl.default(""),
  runtime: text(100).default(""),
  version: text(100).default(""),
});
export const accessSchema = z.object({
  label: text().min(1),
  kind: z.enum(["admin", "hosting", "git", "database", "vault", "other"]),
  url: safeUrl.default(""),
  account: text().default(""),
  vaultRef: text(1000).default(""),
  notes: text(3000).default(""),
});
export const resourceSchema = z.object({
  name: text().min(1),
  kind: z.enum(["database", "storage", "email", "other"]),
  provider: text(100).default(""),
  url: safeUrl.default(""),
  reference: text().default(""),
  notes: text(5000).default(""),
  projectIds: z.array(z.string()).max(200).default([]),
});
export const inventorySchema = z.object({
  serviceId: z.string().min(1),
  filename: text().min(1),
  content: z.string().max(5_000_000),
  commitRef: text(120).default(""),
});
export const manualInventorySchema = z.object({
  serviceId: z.string().min(1),
  components: z
    .array(
      z.object({
        name: text().min(1),
        version: text(100).min(1),
        ecosystem: text(100).min(1),
        scope: z
          .enum(["production", "development", "unknown"])
          .default("unknown"),
        direct: z.boolean().default(true),
      }),
    )
    .min(1)
    .max(500),
});
export const transferSchema = z.object({
  format: z.literal("vigie.inventory"),
  version: z.literal(1),
  projects: z.array(createProjectSchema).max(1000),
});
