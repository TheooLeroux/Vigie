import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { dockerNodeProbe, parseDockerNodeProbe, readDockerNode } from "../src/lib/updates/docker-node";
import { verifyDeployedNode, verifyNodeServices } from "../src/lib/updates/node-deployment";
import { ApiError } from "../src/lib/http";
import type { UpdateTarget } from "../src/lib/updates/types";

const deploymentId = randomUUID(), replica = randomUUID(), second = randomUUID();
const digest = "sha256:" + "a".repeat(64), commit = "b".repeat(40);
const target: UpdateTarget = { id: "generic", projectId: "p", name: "Application Docker", provider: "railway", connectionId: "c", remoteId: randomUUID(), environmentId: randomUUID(), repository: "owner/project", branch: "release", root: "app", url: "https://example.test", mode: "git", configured: true, unavailable: null, builder: "DOCKERFILE" };
const payload = (nonce: string) => ({ nonce, deployment: deploymentId, service: target.remoteId, environment: target.environmentId, node: "24.22.1", running: ["24.22.1"] });
function harness(options: { sshFails?: boolean; createFails?: boolean; cleanupFailures?: number; replaced?: boolean; replicas?: string[]; running?: string[] } = {}) {
  const calls: string[] = [], probed: string[] = [];
  let identity = "", publicKey = "", reads = 0, deletions = 0;
  const dependencies = {
    request: async (_target: UpdateTarget, query: string, variables: any) => {
      if (query.includes("query NodeInstances")) { reads++; return { deployment: { id: deploymentId, status: "SUCCESS", instances: (options.replaced && reads > 1 ? [second] : options.replicas || [replica]).map(id => ({ id, status: "RUNNING" })) } }; }
      if (query.includes("mutation NodeProbeKey")) { publicKey = variables.input.publicKey; calls.push("register"); if (options.createFails) throw new ApiError("Réponse perdue", 502); return { sshPublicKeyCreate: { id: "own-key", publicKey } }; }
      if (query.includes("query NodeProbeKeys")) return { sshPublicKeys: { edges: [{ node: { id: "another-key", publicKey: "ssh-ed25519 unrelated" } }, { node: { id: "own-key", publicKey } }], pageInfo: { hasNextPage: false, endCursor: null } } };
      if (query.includes("mutation NodeProbeCleanup")) { assert.equal(variables.id, "own-key"); calls.push("revoke"); if (++deletions <= (options.cleanupFailures || 0)) throw new ApiError("Révocation indisponible", 502); return { sshPublicKeyDelete: true }; }
      throw Error("Unexpected API operation");
    },
    execute: async (command: string, args: string[], config: any) => {
      assert.equal(config.env.DATABASE_URL, undefined);
      assert.equal(config.env.VIGIE_CONNECTOR_ENCRYPTION_KEY, undefined);
      if (command === "ssh-keygen") { identity = args[args.indexOf("-f") + 1]; await writeFile(identity, "fixture-private", { mode: 0o600 }); await writeFile(identity + ".pub", "ssh-ed25519 Zml4dHVyZQ== vigie-node-proof\n"); return ""; }
      assert.equal(command, "ssh");
      assert.ok(args.includes("StrictHostKeyChecking=accept-new"));
      assert.ok(args.includes("BatchMode=yes"));
      assert.ok(args.includes("IdentitiesOnly=yes"));
      assert.match(args.at(-1)!, /^env -u NODE_OPTIONS -u NODE_PATH node -e /);
      probed.push(args.at(-2)!);
      if (options.sshFails) throw new ApiError("Lecture SSH indisponible", 502);
      const nonce = args.at(-1)!.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/)![0];
      return JSON.stringify({ ...payload(nonce), running: options.running || ["24.22.1"] });
    },
  };
  return { dependencies, calls, probed, identity: () => identity };
}

test("Docker déployé : lecture de toutes les répliques, seconde lecture des instances et révocation", async () => {
  const h = harness({ replicas: [replica, second] });
  const proof = await readDockerNode(target, deploymentId, digest, h.dependencies);
  assert.deepEqual(new Set(proof.instances.map(instance => instance.id)), new Set([replica, second]));
  assert.deepEqual(new Set(h.probed), new Set([replica, second].map(id => `${id}@ssh.railway.com`)));
  assert.deepEqual(h.calls, ["register", "revoke"]);
  await assert.rejects(readFile(h.identity()), { code: "ENOENT" });
});

for (const option of [{ sshFails: true }, { replaced: true }, { createFails: true }]) {
  test(`Docker déployé : refus et nettoyage après ${Object.keys(option)[0]}`, async () => {
    const h = harness(option);
    await assert.rejects(readDockerNode(target, deploymentId, digest, h.dependencies));
    assert.ok(h.calls.includes("revoke"));
    await assert.rejects(readFile(h.identity()), { code: "ENOENT" });
  });
}

test("Docker déployé : un défaut transitoire de révocation est réessayé ; un défaut persistant bloque", async () => {
  const retry = harness({ cleanupFailures: 1 });
  await readDockerNode(target, deploymentId, digest, retry.dependencies);
  assert.equal(retry.calls.filter(call => call === "revoke").length, 2);
  const failure = harness({ cleanupFailures: 2 });
  await assert.rejects(readDockerNode(target, deploymentId, digest, failure.dependencies), /Révocation/);
  await assert.rejects(readFile(failure.identity()), { code: "ENOENT" });
});

test("Sonde Node : sortie bornée, challenge, identités et vrai processus applicatif obligatoires", () => {
  const nonce = randomUUID();
  assert.deepEqual(parseDockerNodeProbe(JSON.stringify(payload(nonce)), nonce, target, deploymentId), { node: "24.22.1", running: ["24.22.1"] });
  for (const changed of [{ nonce: randomUUID() }, { deployment: randomUUID() }, { service: randomUUID() }, { environment: randomUUID() }, { running: [] }, { node: "24.x" }, { running: ["v24.22.1"] }]) assert.throws(() => parseDockerNodeProbe(JSON.stringify({ ...payload(nonce), ...changed }), nonce, target, deploymentId));
  for (const output of ["0", "Connected\n" + JSON.stringify(payload(nonce)), "a".repeat(4097)]) assert.throws(() => parseDockerNodeProbe(output, nonce, target, deploymentId));
  assert.throws(() => dockerNodeProbe("';echo unexpected;#"));
});

function restrictedProcessProbe(options: { uid?: number; owner?: number; exe?: string; denied?: boolean; runningVersion?: string } = {}) {
  const nonce = randomUUID(), children: number[] = [];
  const denied = () => Object.assign(new Error("Permission denied"), { code: "EACCES" });
  function evaluate(script: string, uid: number, pid: number, argv: string[], env: NodeJS.ProcessEnv): string {
    let output = "";
    const fs = {
      readdirSync: () => ["1", "2", "99"],
      readlinkSync: (path: string) => {
        if (path === "/proc/1/exe") {
          if (uid !== (options.owner ?? 1000) || options.denied) throw denied();
          return options.exe || "/usr/local/bin/node";
        }
        if (path === "/proc/99/exe") return "/usr/local/bin/node";
        return "/usr/sbin/sshd";
      },
      statSync: () => ({ uid: options.owner ?? 1000, gid: 1000 }),
    };
    const cp = { execFileSync: (exe: string, args: string[], config: any) => {
      assert.equal(config.env.NODE_OPTIONS, undefined);
      assert.equal(config.env.NODE_PATH, undefined);
      if (exe === "/usr/local/bin/node") {
        assert.equal(uid, 0, "seule la sonde root peut changer d’utilisateur");
        assert.equal(config.gid, 1000);
        children.push(config.uid);
        return evaluate(args[1], config.uid, 100, [exe, args[2]], config.env);
      }
      assert.equal(exe, "/proc/1/exe", "le binaire du processus est lu, jamais le nom comm ni le Node installé");
      assert.deepEqual(Array.from(args), ["--version"]);
      assert.equal(uid, options.owner ?? 1000);
      return "v" + (options.runningVersion || "24.22.1") + "\n";
    } };
    runInNewContext(script, {
      require: (name: string) => { if (name === "node:fs") return fs; if (name === "node:child_process") return cp; throw Error("Application import forbidden"); },
      process: { pid, execPath: "/usr/local/bin/node", argv, getuid: () => uid, env, versions: { node: "24.22.1" } },
      console: { log: (value: string) => { output += value; } },
    });
    return output;
  }
  const output = evaluate(dockerNodeProbe(nonce), options.uid ?? 0, 99, [], { NODE_ENV: "production", NODE_OPTIONS: "--require=/app/preload.js", NODE_PATH: "/app", RAILWAY_DEPLOYMENT_ID: deploymentId, RAILWAY_SERVICE_ID: target.remoteId, RAILWAY_ENVIRONMENT_ID: target.environmentId! });
  return { output, nonce, children };
}

test("Sonde Node : un processus d’un autre UID est attesté sous son propriétaire sans dépendre du nom MainThread", () => {
  const { output, nonce, children } = restrictedProcessProbe({ runningVersion: "24.21.0" });
  assert.deepEqual(children, [1000]);
  assert.deepEqual(parseDockerNodeProbe(output, nonce, target, deploymentId), { node: "24.22.1", running: ["24.21.0"] });
});

test("Sonde Node : un exécutable non Node et la sonde elle-même ne prouvent pas de runtime applicatif", () => {
  const { output, nonce } = restrictedProcessProbe({ exe: "/usr/bin/caddy" });
  assert.throws(() => parseDockerNodeProbe(output, nonce, target, deploymentId), /Aucun processus Node applicatif/);
});

test("Sonde Node : un accès toujours refusé bloque sans ignorer silencieusement le processus", () => {
  for (const options of [{ denied: true }, { uid: 2000 }, { owner: 0, denied: true }]) {
    assert.throws(() => restrictedProcessProbe(options), /Permission denied/);
  }
});

test("Sonde Node : le diagnostic distingue une mauvaise identité d’une version invalide", () => {
  const nonce = randomUUID();
  assert.throws(() => parseDockerNodeProbe(JSON.stringify({ ...payload(nonce), deployment: randomUUID() }), nonce, target, deploymentId), /identité.*déploiement attendu/);
  assert.throws(() => parseDockerNodeProbe(JSON.stringify({ ...payload(nonce), running: ["24.x"] }), nonce, target, deploymentId), /versions.*invalides/);
});

function instance(imageDigest = digest) { return { serviceInstance: { rootDirectory: "app", activeDeployments: [{ id: deploymentId, status: "SUCCESS", meta: { repo: target.repository, branch: target.branch, rootDirectory: "/app", commitHash: commit, imageDigest } }] } }; }
test("Preuve Docker : un Node installé corrigé ne suffit pas si l’application utilise encore un ancien binaire", async () => {
  const h = harness({ running: ["24.21.0", "24.22.1"] });
  const check = await verifyDeployedNode(target, { deploymentId, commit }, "24.22.1", { railway: async () => instance(), vercel: async () => { throw Error(); }, runtime: (t, id, image) => readDockerNode(t, id, image, h.dependencies) });
  assert.equal(check.status, "blocked");
  assert.match(check.message, /24.21.0/);
});

test("Preuve Docker : l’image et le commit actifs sont revérifiés après la sonde", async () => {
  for (const changed of [false, true]) {
    let reads = 0;
    const h = harness();
    const check = await verifyDeployedNode(target, { deploymentId, commit }, "24.22.1", { railway: async () => instance(changed && ++reads > 1 ? "sha256:" + "c".repeat(64) : digest), vercel: async () => { throw Error(); }, runtime: (t, id, image) => readDockerNode(t, id, image, h.dependencies) });
    assert.equal(check.status, changed ? "blocked" : "passed");
  }
  const h = harness();
  const check = await verifyDeployedNode(target, { deploymentId, commit: "d".repeat(40) }, "24.22.1", { railway: async () => instance(), vercel: async () => { throw Error(); }, runtime: (t, id, image) => readDockerNode(t, id, image, h.dependencies) });
  assert.equal(check.status, "blocked");
  assert.deepEqual(h.calls, [], "aucun accès ouvert pour une mauvaise source");
});

test("Un contrôle bloquant ne saute pas les autres services et ne devient jamais un succès global", async () => {
  const results = ["one", "two"].map(name => ({ targetId: name, name, stage: "verifying" as const, warnings: [], message: "" }));
  const visited: number[] = [];
  await assert.rejects(verifyNodeServices(results, async index => {
    visited.push(index);
    if (!index) throw new ApiError("Runtime non attesté", 422);
    Object.assign(results[index], { stage: "completed", message: "Node et HTTPS confirmés" });
  }), /Runtime non attesté/);
  assert.deepEqual(visited, [0, 1]);
  assert.equal(results[0].stage, "attention");
  assert.equal(results[1].stage, "completed");
});

test("Railway : un Dockerfile auto-détecté reste vérifié même si le builder configuré indique RAILPACK", async () => {
  const h = harness();
  const check = await verifyDeployedNode({ ...target, builder: "RAILPACK" }, { deploymentId, commit }, "24.22.1", { railway: async () => instance(), vercel: async () => { throw Error(); }, runtime: (t, id, image) => readDockerNode(t, id, image, h.dependencies) });
  assert.equal(check.status, "passed");
  assert.equal(check.nodeEvidence?.source, "container");
  assert.deepEqual(check.nodeEvidence?.instances, [replica]);
  assert.ok(h.probed.length);
});

test("Un manifeste Railpack ne conserve aucune preuve de succès si la lecture du runtime échoue", async () => {
  const data = instance();
  Object.assign(data.serviceInstance.activeDeployments[0].meta, { railpackInfo: { railpackVersion: "0.43.0", resolvedPackages: { node: { resolvedVersion: "24.22.1" } } } });
  const check = await verifyDeployedNode({ ...target, builder: "RAILPACK" }, { deploymentId, commit }, "24.22.1", { railway: async () => data, vercel: async () => { throw Error(); }, runtime: async () => { throw new ApiError("Sonde indisponible", 502); } });
  assert.equal(check.status, "blocked");
  assert.equal(check.nodeEvidence, undefined);
});
