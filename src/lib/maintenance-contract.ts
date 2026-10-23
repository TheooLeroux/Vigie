import { z } from "zod";

export const repositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine(
    (value) =>
      !value
        .split("/")
        .some((part) => part === "." || part === ".." || part.endsWith(".git")),
  );
export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
export const packageNameSchema = z
  .string()
  .max(200)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/)
  .refine(
    (value) => !["__proto__", "prototype", "constructor"].includes(value),
  );
export function safeDirectory(value: string) {
  const directory = value.replace(/^\/+|\/+$/g, "");
  if (
    directory.length > 250 ||
    (directory &&
      directory
        .split("/")
        .some(
          (part) =>
            !/^[A-Za-z0-9@_.-]+$/.test(part) ||
            part === "." ||
            part === ".." ||
            [".git", "node_modules", ".github"].includes(part),
        ))
  )
    throw new Error("Répertoire applicatif non pris en charge.");
  return directory;
}
export function safeBranch(value: string) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.split("/").some((part) => part.endsWith(".lock"))
  )
    throw new Error("Branche Git non prise en charge.");
  return value;
}
export const dependencyUpdateSchema = z
  .object({ name: packageNameSchema, version: versionSchema })
  .strict();
export const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), version: versionSchema }).strict(),
  z
    .object({
      kind: z.literal("dependencies"),
      updates: z.array(dependencyUpdateSchema).min(1).max(12),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rollback"),
      pullNumber: z.number().int().positive(),
    })
    .strict(),
]);
export const workerPayloadSchema = z
  .object({
    format: z.literal("vigie.maintenance.v1"),
    id: z.uuid(),
    repository: repositorySchema,
    baseBranch: z.string().transform(safeBranch),
    baseSha: shaSchema,
    directory: z.string().transform(safeDirectory),
    nodeMode: z.enum(["major", "exact"]),
    operation: operationSchema,
  })
  .strict();
export type MaintenanceOperation = z.infer<typeof operationSchema>;
export type MaintenancePayload = z.infer<typeof workerPayloadSchema>;
export const maintenanceBranch = (id: string) =>
  `vigie/maintenance/${z.uuid().parse(id)}`;
export type MaintenanceTarget = {
  id: string;
  projectId: string;
  name: string;
  provider: "Vercel" | "Railway";
  repository: string | null;
  branch: string | null;
  commit: string | null;
  directory: string;
  node: string | null;
  observedAt: string;
  blocked: string | null;
};
export type MaintenanceJob = {
  id: string;
  projectId: string;
  targetId: string;
  revision: number;
  targetName: string;
  provider: MaintenanceTarget["provider"];
  payload: MaintenancePayload;
  status:
    | "planned"
    | "dispatching"
    | "queued"
    | "pull_request"
    | "merging"
    | "merged"
    | "closed"
    | "failed";
  createdAt: string;
  expiresAt: string;
  actor: string;
  warnings: string[];
  files: string[];
  runId?: number;
  runUrl?: string;
  pullNumber?: number;
  pullUrl?: string;
  headSha?: string;
  mergeSha?: string;
  error?: string;
  checks?: { name: string; state: string }[];
  canMerge?: boolean;
  mergeBlocker?: string;
  deployment?: "not-verified" | "observed";
  mergeRequestId?: string;
  dispatchRejected?: boolean;
};
export type MaintenanceInspection = {
  target: MaintenanceTarget;
  baseBranch: string;
  baseSha: string;
  deployedCommitMatches: boolean;
  manager: string;
  dependencies: { name: string; declared: string; scope: string }[];
  nodeVersions: string[];
  files: string[];
  warnings: string[];
  dependencyBlocker: string | null;
};
export type MaintenanceState = {
  configured: boolean;
  allowMerge: boolean;
  configurationIssues: string[];
  targets: MaintenanceTarget[];
  jobs: MaintenanceJob[];
};
