import { createHash } from "node:crypto";
import { ApiError } from "../http";
import { tailscaleChannel } from "./image-policy";

export type ResolvedImage = { channel: string; reference: string; digest: string; indexDigest: string };
const digestPattern = /^sha256:[a-f0-9]{64}$/;
async function bounded(response: Response) {
  if (!response.ok || !response.body) throw new ApiError(`Le registre officiel refuse la lecture de l’image (${response.status}).`, 502);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4_000_000) { await reader.cancel(); throw new ApiError("Réponse du registre trop volumineuse.", 502); } chunks.push(value); }
  return Buffer.concat(chunks);
}
export async function resolveTailscaleImage(transport: typeof fetch = fetch): Promise<ResolvedImage> {
  const authentication = await transport("https://auth.docker.io/token?service=registry.docker.io&scope=repository:tailscale/tailscale:pull", { redirect: "error", signal: AbortSignal.timeout(20_000) });
  const token = JSON.parse((await bounded(authentication)).toString("utf8")).token;
  if (typeof token !== "string" || !token || token.length > 16_000) throw new ApiError("Authentification du registre officiel invalide.", 502);
  const response = await transport("https://registry-1.docker.io/v2/tailscale/tailscale/manifests/stable", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  const bytes = await bounded(response), digest = response.headers.get("docker-content-digest");
  if (!digest || !digestPattern.test(digest) || digest !== "sha256:" + createHash("sha256").update(bytes).digest("hex")) throw new ApiError("L’empreinte de l’image officielle n’est pas vérifiable.", 502);
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(manifest.manifests) || manifest.manifests.length > 100) throw new ApiError("Index de plateformes de l’image non vérifiable.", 502);
  const platforms = manifest.manifests.filter((item: any) => item.platform?.os === "linux" && ["amd64", "arm64"].includes(item.platform.architecture));
  if (!platforms.some((item: any) => item.platform.architecture === "amd64") || platforms.some((item: any) => !digestPattern.test(item.digest))) throw new ApiError("L’image stable ne fournit pas les plateformes Linux attendues.", 502);
  const selected = platforms.find((item: any) => item.platform.architecture === "amd64").digest as string;
  return { channel: tailscaleChannel, reference: `docker.io/tailscale/tailscale@${selected}`, digest: selected, indexDigest: digest };
}
