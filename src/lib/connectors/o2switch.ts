import { z } from "zod";
import type { HostingDomain } from "../types";

export const o2switchEndpoint = z
  .string()
  .trim()
  .transform((value) => value.replace(/\/$/, ""))
  .refine(
    (value) => /^https:\/\/[a-z0-9-]+\.o2switch\.net:2083$/.test(value),
    "Utilisez l’adresse HTTPS du serveur o2switch, sur le port 2083.",
  );
export const hostingConnectionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  endpoint: o2switchEndpoint,
  username: z
    .string()
    .trim()
    .regex(
      /^[a-zA-Z0-9_]{1,32}$/,
      "Indiquez l’identifiant cPanel, pas votre adresse email.",
    ),
  authMode: z.enum(["token", "password"]).default("token"),
  secret: z
    .string()
    .max(4096)
    .refine(
      (value) => !/[\r\n\0]/.test(value),
      "Le secret ne doit pas contenir de retour à la ligne.",
    )
    .optional(),
});
export type HostingConnectionInput = z.infer<typeof hostingConnectionSchema>;
export type ProbeResult =
  | { ok: true; domains: HostingDomain[] }
  | {
      ok: false;
      code:
        | "authentication"
        | "network"
        | "tls"
        | "timeout"
        | "rate_limit"
        | "api"
        | "protocol";
      message: string;
      httpStatus?: number;
    };
const domain = z
  .string()
  .trim()
  .max(253)
  .regex(
    /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/,
  );
const domainsSchema = z.object({
  main_domain: z.union([domain, z.literal(""), z.null()]).optional(),
  addon_domains: z.array(domain).max(5000).optional(),
  sub_domains: z.array(domain).max(5000).optional(),
  parked_domains: z.array(domain).max(5000).optional(),
});
const failure = (
  code: Exclude<ProbeResult, { ok: true }>["code"],
  message: string,
  httpStatus?: number,
): ProbeResult => ({
  ok: false,
  code,
  message,
  ...(httpStatus ? { httpStatus } : {}),
});

export function parseDomainResponse(raw: unknown): ProbeResult {
  if (!raw || typeof raw !== "object")
    return failure(
      "protocol",
      "La réponse reçue n’est pas une réponse API cPanel valide.",
    );
  const envelope = raw as Record<string, unknown>;
  const result = (
    envelope.result && typeof envelope.result === "object"
      ? envelope.result
      : envelope
  ) as Record<string, unknown>;
  if (
    result.status !== 1 ||
    (Array.isArray(result.errors) && result.errors.length)
  )
    return failure(
      "api",
      "cPanel n’a pas autorisé la lecture des domaines. Vérifiez le jeton et les droits du compte.",
    );
  const parsed = domainsSchema.safeParse(result.data);
  if (!parsed.success)
    return failure(
      "protocol",
      "Le format des domaines retournés par cPanel n’est pas reconnu.",
    );
  const data = parsed.data;
  const domains: HostingDomain[] = [];
  const seen = new Set<string>();
  for (const [kind, values] of [
    ["main", data.main_domain ? [data.main_domain] : []],
    ["addon", data.addon_domains || []],
    ["alias", data.parked_domains || []],
    ["subdomain", data.sub_domains || []],
  ] as const) {
    for (const name of values) {
      const normalized = name.toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        domains.push({ name: normalized, kind });
      }
    }
  }
  if (!domains.length)
    return failure(
      "api",
      "cPanel n’a retourné aucun domaine. La connexion ne peut pas être confirmée ; vérifiez les droits du compte.",
    );
  return { ok: true, domains };
}

export async function probeO2switch(
  input: HostingConnectionInput & { secret: string },
  transport: typeof fetch = fetch,
): Promise<ProbeResult> {
  const validated = hostingConnectionSchema.parse(input);
  if (!validated.secret)
    return failure(
      "authentication",
      "Renseignez un jeton API ou un mot de passe cPanel.",
    );
  try {
    // Fixed read-only UAPI function. Never accept an API path, query or redirect from the client.
    const response = await transport(
      `${validated.endpoint}/execute/DomainInfo/list_domains`,
      {
        method: "GET",
        headers: {
          Authorization:
            validated.authMode === "token"
              ? `cpanel ${validated.username}:${validated.secret}`
              : `Basic ${Buffer.from(`${validated.username}:${validated.secret}`).toString("base64")}`,
          Accept: "application/json",
        },
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if ([401, 403].includes(response.status))
      return failure(
        "authentication",
        "Accès refusé par cPanel. Vérifiez l’identifiant du compte et le jeton API (ou le mot de passe).",
        response.status,
      );
    if (response.status === 429)
      return failure(
        "rate_limit",
        "Trop de demandes reçues par cPanel. Attendez avant de retester.",
        429,
      );
    if (!response.ok)
      return failure(
        "api",
        response.status >= 300 && response.status < 400
          ? "cPanel demande une redirection. Utilisez l’adresse directe du serveur o2switch."
          : "Le serveur cPanel a refusé la lecture des domaines.",
        response.status,
      );
    const reader = response.body?.getReader();
    if (!reader)
      return failure("protocol", "Le serveur a retourné une réponse vide.");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 1_000_000) {
        await reader.cancel();
        return failure(
          "protocol",
          "La réponse cPanel dépasse la taille attendue.",
        );
      }
      chunks.push(value);
    }
    try {
      return parseDomainResponse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
    } catch {
      return failure(
        "protocol",
        "Le serveur n’a pas retourné de JSON cPanel valide.",
      );
    }
  } catch (error) {
    const value = error as { name?: string; cause?: { code?: string } };
    if (value.name === "TimeoutError" || value.name === "AbortError")
      return failure(
        "timeout",
        "Le serveur cPanel n’a pas répondu dans les 15 secondes.",
      );
    if (/CERT|TLS|SSL/.test(value.cause?.code || ""))
      return failure(
        "tls",
        "Le certificat HTTPS du serveur ne peut pas être validé.",
      );
    return failure(
      "network",
      "Connexion au serveur impossible. Vérifiez l’adresse et l’accès réseau au port 2083.",
    );
  }
}
