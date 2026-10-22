import type {
  RailwayDeploymentEvidence,
  RailwayPackage,
} from "../railway-types";
// Deployment.meta is a JSON scalar: GraphQL cannot select its subfields.
// It is filtered immediately, before persistence, logging or exposing a public response.
// Never keep raw meta, serviceManifest, variables, commands or commit messages.
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function match(value: unknown, pattern: RegExp, max = 200) {
  return typeof value === "string" && value.length <= max && pattern.test(value)
    ? value
    : null;
}
export function githubRepository(value: unknown) {
  if (typeof value !== "string") return null;
  const repository = value
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  if (repository.split("/").some((part) => part === "." || part === ".."))
    return null;
  return match(repository, /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/);
}
const packages = new Set([
  "node",
  "caddy",
  "python",
  "php",
  "ruby",
  "bun",
  "deno",
  "go",
  "rust",
  "java",
  "jdk",
  "dotnet",
  "elixir",
  "erlang",
  "gleam",
  "npm",
  "pnpm",
  "yarn",
  "uv",
  "pip",
  "poetry",
  "composer",
]);
const tools = new Set([
  "npm",
  "pnpm",
  "yarn",
  "uv",
  "pip",
  "poetry",
  "composer",
]);
const compilers = new Set(["go", "rust", "gleam"]);
export function deploymentEvidence(
  raw: unknown,
): RailwayDeploymentEvidence | null {
  const meta = object(raw),
    railpack = object(meta.railpackInfo),
    metadata = object(railpack.metadata),
    resolved = object(railpack.resolvedPackages);
  const staticSite =
    metadata.nodeIsSPA === "true" || metadata.nodeIsSPA === true;
  const detected: RailwayPackage[] = [];
  for (const [name, value] of Object.entries(resolved)) {
    if (!packages.has(name)) continue;
    const version = match(
      object(value).resolvedVersion,
      /^v?\d+\.\d+(?:\.\d+){0,2}$/,
    );
    if (
      version &&
      ["node", "caddy"].includes(name) &&
      !/^v?\d+\.\d+\.\d+$/.test(version)
    )
      continue;
    if (version)
      detected.push({
        name,
        version: version.replace(/^v/, ""),
        usage: tools.has(name)
          ? "tool"
          : compilers.has(name) || (name === "node" && staticSite)
            ? "build"
            : "runtime",
      });
  }
  const result: RailwayDeploymentEvidence = {
    repository: githubRepository(meta.repo),
    branch: match(meta.branch, /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/, 250),
    commit: match(meta.commitHash, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
    rootDirectory:
      typeof meta.rootDirectory === "string" &&
      meta.rootDirectory.split("/").includes("..")
        ? null
        : match(meta.rootDirectory, /^\/?[a-zA-Z0-9_./ -]*$/, 1000),
    imageDigest: match(meta.imageDigest, /^(?:sha256:)?[a-f0-9]{64}$/i),
    railpackVersion: match(railpack.railpackVersion, /^v?\d+\.\d+\.\d+$/),
    framework: match(metadata.nodeRuntime, /^[a-z][a-z0-9-]{0,50}$/),
    staticSite,
    packages: detected,
  };
  return result.repository ||
    result.commit ||
    result.imageDigest ||
    detected.length
    ? result
    : null;
}
