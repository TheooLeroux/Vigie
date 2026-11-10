import { z } from "zod";
import { ApiError } from "../http";

const testEnvironment = z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).refine(name =>
  !/^(?:PATH|HOME|CI|NODE_ENV|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV)$/.test(name) &&
  !/^(?:LD_|DOCKER_|NPM_CONFIG_)/.test(name)), z.string().max(2048).refine(value => !value.includes("\0")))
  .refine(values => Object.keys(values).length <= 32);

export function nodeTestEnvironment(manifest: { vigie?: { testEnv?: unknown } }) {
  if (manifest.vigie?.testEnv === undefined) return {};
  const parsed = testEnvironment.safeParse(manifest.vigie.testEnv);
  if (!parsed.success) throw new ApiError("Configuration de test invalide dans package.json (vigie.testEnv).", 422);
  return parsed.data;
}
