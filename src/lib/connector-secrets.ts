import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ApiError } from "./http";
function key() {
  const raw = process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(raw))
    throw new ApiError("Clé de chiffrement des connecteurs manquante.", 503);
  return Buffer.from(raw, "hex");
}
export function sealConnectorSecret(value: string, context: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    value: encrypted.toString("base64"),
  });
}
export function openConnectorSecret(raw: string, context: string) {
  try {
    const encoded = JSON.parse(raw),
      cipher = createDecipheriv(
        "aes-256-gcm",
        key(),
        Buffer.from(encoded.iv, "base64"),
      );
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(Buffer.from(encoded.tag, "base64"));
    return Buffer.concat([
      cipher.update(Buffer.from(encoded.value, "base64")),
      cipher.final(),
    ]).toString("utf8");
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(
      "Le secret du connecteur ne peut pas être déchiffré.",
      503,
    );
  }
}
