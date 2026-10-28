import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { officialNodeImageDigest, unchangedNodeCatalogs, type NodeCatalogEntry } from "./node-catalog-state";
import { runCommand } from "./process";
import type { SourceFile } from "./node";
import type { SecurityFinding, UpdateCheck, UpdateTarget } from "./types";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({
  schema: z.literal(1), validatedAt: z.string().datetime(), sourceHash: hex, targetsHash: hex, policyHash: hex,
  nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  catalogs: z.array(z.object({ url: z.string().max(500), accept: z.string().max(100), etag: z.string().max(210).optional(), modified: z.string().max(100).optional(), hash: hex.optional() })).max(2500),
  images: z.array(z.object({ image: z.string().max(100), digest })).min(1).max(120),
  validationImage: digest,
  deployments: z.array(z.object({ targetId: z.string().max(300), deploymentId: z.string().max(300), imageDigest: digest, source: z.enum(["container", "railpack"]), usage: z.enum(["runtime", "build"]) })).min(1).max(30),
  securityHash: hex,
  imageSecurity: z.array(z.object({ root: z.string().max(1000), hash: hex })).max(30),
  validations: z.array(z.object({ targetId: z.string().max(300), checkedAt: z.string().datetime(), scope: z.string().max(1000), status: z.enum(["passed", "warning"]), message: z.string().max(20_000) })).min(1).max(30),
  warnings: z.array(z.object({ targetId: z.string().max(300), messages: z.array(z.string().max(20_000)).max(500) })).max(30),
});
export type NodeValidationReceipt = z.infer<typeof receiptSchema>;
export type NodeCurrentKey = Pick<NodeValidationReceipt, "sourceHash" | "targetsHash" | "policyHash" | "nodeVersion">;
export function nodeSourceHash(files: SourceFile[]) { return hash([...files].sort((a, b) => a.path.localeCompare(b.path))); }
export function nodeTargetsHash(targets: UpdateTarget[]) { return hash([...targets].sort((a, b) => a.id.localeCompare(b.id))); }
export function nodeSecurityHash(findings: SecurityFinding[]) {
  return hash(findings.map(finding => ({ ...finding, aliases: [...finding.aliases].sort(), fixedVersions: [...(finding.fixedVersions || [])].sort() })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

// Version the actual solver, sandbox, profiles and scanner policy, rather than
// relying on a manually incremented cache key. A new runner image also expires it.
export async function nodePolicyHash(folder = process.cwd()) {
  async function sources(directory: string): Promise<string[]> {
    const entries = await readdir(join(folder, directory), { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? sources(directory + "/" + entry.name) : entry.isFile() ? [directory + "/" + entry.name] : []))).flat().sort();
  }
  const names = [...await sources("src/lib/updates"), "src/lib/connectors/railway-evidence.ts", "package-lock.json", "scripts/update-archive.py", "scripts/install-update-scanners.ts", "scripts/update-worker.ts", ".github/workflows/vigie-updates.yml"];
  const files = await Promise.all(names.map(async name => [name, createHash("sha256").update(await readFile(join(folder, name))).digest("hex")]));
  return hash({ files, node: process.version, platform: process.platform, arch: process.arch, os: process.env.ImageOS || "", image: process.env.ImageVersion || "" });
}

export function reusableNodeReceipt(raw: unknown, key: NodeCurrentKey, now = Date.now()) {
  const parsed = receiptSchema.safeParse(raw);
  if (!parsed.success) return null;
  const receipt = parsed.data, age = now - Date.parse(receipt.validatedAt);
  if (age < 0 || age > 24 * 60 * 60_000 || Object.entries(key).some(([name, value]) => receipt[name as keyof NodeCurrentKey] !== value)) return null;
  if (new Set(receipt.deployments.map(item => item.targetId)).size !== receipt.deployments.length || new Set(receipt.validations.map(item => item.targetId)).size !== receipt.validations.length) return null;
  if (receipt.deployments.some(item => !receipt.validations.some(validation => validation.targetId === item.targetId))) return null;
  return receipt;
}

export async function unchangedNodeInputs(receipt: NodeValidationReceipt, transport: typeof fetch = fetch, imageDigest = officialNodeImageDigest) {
  if (!await unchangedNodeCatalogs(receipt.catalogs, transport)) return false;
  return unchangedNodeImages(receipt, transport, imageDigest);
}
export async function unchangedNodeImages(receipt: NodeValidationReceipt, transport: typeof fetch = fetch, imageDigest = officialNodeImageDigest) {
  try {
    const current = await Promise.all(receipt.images.map(async image => await imageDigest(image.image, transport) === image.digest));
    return current.every(Boolean);
  } catch { return false; }
}

export async function checkCurrentNodeConfiguration(receipt: NodeValidationReceipt, actions: {
  baseline: SecurityFinding[];
  images: () => Promise<boolean>;
  finalScan: () => Promise<SecurityFinding[]>;
  sources: () => Promise<void>;
  catalogs: () => Promise<boolean>;
}) {
  if (nodeSecurityHash(actions.baseline) !== receipt.securityHash) return false;
  try {
    if (!await actions.images()) return false;
    if (nodeSecurityHash(await actions.finalScan()) !== receipt.securityHash) return false;
    await actions.sources();
    return await actions.catalogs();
  } catch { return false; }
}

export function sameNodeReceiptProof(receipt: NodeValidationReceipt, targetId: string, proof: UpdateCheck["nodeEvidence"]) {
  const trusted = receipt.deployments.find(item => item.targetId === targetId);
  return !!proof && !!trusted && proof.version === receipt.nodeVersion && proof.deploymentId === trusted.deploymentId && proof.imageDigest === trusted.imageDigest && proof.source === trusted.source && proof.usage === trusted.usage;
}

export async function nodeImageReceipt(image: string, local: string, execute = runCommand, transport: typeof fetch = fetch) {
  try {
    const [remote, raw] = await Promise.all([
      officialNodeImageDigest(image, transport),
      execute("docker", ["image", "inspect", local, "--format", "{{json .RepoDigests}}"]),
    ]);
    const repos = z.array(z.string()).parse(JSON.parse(raw));
    if (!repos.some(repo => /^(?:node|(?:docker\.io\/)?library\/node)@sha256:[a-f0-9]{64}$/.test(repo) && repo.endsWith("@" + remote))) return null;
    return { image, digest: remote };
  } catch { return null; }
}

export function nodeReceiptValidations(targets: UpdateTarget[], checks: (UpdateCheck[] | undefined)[]) {
  return targets.flatMap((target, index) => {
    const check = checks[index]?.findLast(check => check.tool === "Validation" && check.status !== "blocked");
    return check ? [{ targetId: target.id, checkedAt: check.checkedAt, scope: check.scope, status: check.status as "passed" | "warning", message: check.message }] : [];
  });
}

export function nodeReceiptDraft(key: NodeCurrentKey, catalogs: NodeCatalogEntry[], rest: Omit<NodeValidationReceipt, keyof NodeCurrentKey | "schema" | "catalogs">) {
  const parsed = receiptSchema.safeParse({ schema: 1, ...key, catalogs, ...rest });
  return parsed.success ? parsed.data : null;
}
