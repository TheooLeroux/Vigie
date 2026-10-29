const publicRegistries = new Set(["docker.io", "ghcr.io", "quay.io", "gcr.io", "mcr.microsoft.com", "registry.k8s.io"]);

// Bind a declared public image name to the digest observed on the deployment.
// Mutable tags, private registries and absent/contradictory digests are not proof.
export function deployedImageReference(image: string, digest: string | null | undefined): string | null {
  if (!digest || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(digest) || image.length > 500 || /[\s\\?#]/.test(image)) return null;
  digest = `sha256:${digest.replace(/^sha256:/i, "").toLowerCase()}`;
  const [tagged, declaredDigest, extra] = image.split("@");
  if (extra !== undefined || declaredDigest !== undefined && declaredDigest !== digest) return null;
  const name = tagged.replace(/:[A-Za-z0-9_][A-Za-z0-9_.-]*$/, "");
  const parts = name.split("/");
  const registry = parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost" ? parts.shift()! : "docker.io";
  if (!publicRegistries.has(registry) || !parts.length || parts.some(part => !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(part))) return null;
  if (registry === "docker.io" && parts.length === 1) parts.unshift("library");
  return `${registry}/${parts.join("/")}@${digest}`;
}
