import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { promisify } from "node:util";
import { minimalStaticWitnessId } from "../src/lib/updates/minimal-static-migration";
import { minimalStaticProfile } from "../src/lib/updates/minimal-static-profile";
import { minimalStaticBuildNode, minimalStaticCaddyCandidate, minimalStaticDockerfile, minimalStaticPins, minimalStaticProbeConfig, minimalStaticProbeProgram, minimalStaticRecipe, staticBuildVariables } from "../src/lib/updates/minimal-static";
import { nodeTargetsHash } from "../src/lib/updates/node-current";
import type { UpdateTarget } from "../src/lib/updates/types";

test("Migration statique : autorisation limitée au projet, au service et à son environnement Railway", () => {
  const target = {
    provider: "railway", mode: "git", projectId: "project", environmentId: "production", remoteId: "frontend",
    url: "https://app.up.railway.app/", root: "frontend",
  } as UpdateTarget;
  const backend = "00000000-0000-4000-8000-000000000001";
  const grant = `project:production:frontend:${backend}`;
  assert.equal(minimalStaticWitnessId(target, grant), backend);
  assert.equal(minimalStaticWitnessId({ ...target, environmentId: "staging" }, grant), undefined);
  assert.equal(minimalStaticWitnessId({ ...target, mode: "image" }, grant), undefined);
  assert.equal(minimalStaticWitnessId(target, `${grant},${grant}`), undefined);
});

test("Recette minimale : une autre version Node épinglée est admise, toute autre modification sort du parcours", () => {
  assert.equal(minimalStaticBuildNode(minimalStaticDockerfile), "26.13.0");
  const updated = minimalStaticRecipe("26.14.0", "sha256:" + "c".repeat(64));
  assert.equal(minimalStaticBuildNode(updated), "26.14.0");
  assert.equal(minimalStaticBuildNode(updated + "COPY secret /secret\n"), undefined);
});

test("Caddy minimal : archive officielle épinglée, aucun recul ni changement silencieux du binaire", () => {
  const digest = "sha256:" + "a".repeat(64);
  const candidate = minimalStaticCaddyCandidate(minimalStaticDockerfile, { version: "2.11.9", linuxAmd64Digest: digest });
  assert.ok(candidate);
  const pins = minimalStaticPins(candidate.recipe)!;
  assert.deepEqual(pins.caddy, { version: "2.11.9", digest });
  assert.equal(pins.node, "26.13.0");
  assert.equal(minimalStaticCaddyCandidate(candidate.recipe, { version: "2.11.9", linuxAmd64Digest: "sha256:" + "b".repeat(64) }), undefined);
  assert.equal(minimalStaticCaddyCandidate(candidate.recipe, { version: "2.11.8", linuxAmd64Digest: digest }), undefined);
  assert.equal(minimalStaticCaddyCandidate(candidate.recipe, { version: "2.12.0-beta.1", linuxAmd64Digest: digest }), undefined);
  assert.equal(minimalStaticCaddyCandidate(candidate.recipe, { version: "2.12.0" }), undefined);
  assert.equal(minimalStaticPins(candidate.recipe.replace("github.com/caddyserver", "example.org/caddyserver")), undefined);
  assert.deepEqual(minimalStaticPins(minimalStaticRecipe("26.14.0", pins.digest, pins.caddy))?.caddy, pins.caddy);
});

const frontend = { id: "web-target", projectId: "catalogue", environmentId: "preview", remoteId: "web" } as UpdateTarget;
const catalogueProfile = (value: object) => minimalStaticProfile(frontend, JSON.stringify({ "catalogue:preview:web": value }));

test("Validation réutilisable : seules les modifications de profil des services concernés changent la clé", () => {
  const profiles = new Map([[frontend.id, catalogueProfile({})]]);
  const original = nodeTargetsHash([frontend], profiles);
  profiles.set("other-target", catalogueProfile({ websocket: ["/other"] }));
  assert.equal(nodeTargetsHash([frontend], profiles), original);
  profiles.set(frontend.id, catalogueProfile({ websocket: ["/live-stock"] }));
  assert.notEqual(nodeTargetsHash([frontend], profiles), original);
});

test("Profil par service : isolation des environnements et valeurs de build explicitement publiques", () => {
  assert.throws(() => minimalStaticProfile(frontend, '{"catalogue:production:web":{}}'), /Profil statique/);
  for (const path of ["//another.test", "/../admin", "/%2fadmin", "/api?token=test"]) {
    assert.throws(() => catalogueProfile({ websocket: [path] }), /Profil statique/);
  }
  const profile = catalogueProfile({ publicBuild: { VITE_THEME: "night" }, upstreamVariables: ["CATALOGUE_URL"] });
  assert.deepEqual(staticBuildVariables(profile, { VITE_THEME: "night", VITE_PRIVATE_KEY: "private" }), { VITE_THEME: "night" });
  assert.throws(() => staticBuildVariables(profile, { VITE_THEME: "other" }), /valeurs publiques/);
  assert.throws(() => staticBuildVariables(profile, { VITE_THEME: "night" }, []), /valeurs publiques/);
  assert.throws(() => staticBuildVariables(catalogueProfile({}), { VITE_THEME: "night" }, ["VITE_THEME"]), /valeurs publiques/);
  const digest = "sha256:" + "b".repeat(64);
  for (const args of [["VITE_THEME"], ["VITE_API_URL", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]]) {
    const deployed = minimalStaticRecipe("24.14.0", digest, undefined, args);
    assert.deepEqual(minimalStaticPins(deployed)?.buildArguments, args);
    const update = minimalStaticCaddyCandidate(deployed, { version: "2.11.9", linuxAmd64Digest: digest });
    assert.deepEqual(minimalStaticPins(update!.recipe)?.buildArguments, args);
  }
});

test("Sondes statiques réelles : accueil seul ou routes HTTP et WebSocket propres à un autre site", { timeout: 15_000 }, async () => {
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<main>Catalogue</main>");
    } else {
      response.writeHead(request.url === "/v1/availability" ? 200 : 404, { "Content-Type": "application/json" }).end('{"ready":true}');
    }
  });
  server.on("upgrade", (request, socket) => {
    if (request.url !== "/live-stock") return socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const probe = async (value: object) => {
    const args = ["-e", minimalStaticProbeProgram, origin, origin, "test-nonce", minimalStaticProbeConfig(catalogueProfile(value))];
    const { stdout } = await promisify(execFile)(process.execPath, args, { timeout: 10_000 });
    return JSON.parse(stdout);
  };
  const api = { path: "/v1/availability", status: 200, contentType: "application/json", contains: '"ready":true' };
  try {
    assert.deepEqual(await probe({}), { nonce: "test-nonce", http: 1, websocket: 0 });
    assert.deepEqual(await probe({ http: [api], websocket: ["/live-stock"] }), { nonce: "test-nonce", http: 2, websocket: 1 });
    await assert.rejects(probe({ http: [{ ...api, contains: '"ready":false' }] }), /Contenu HTTP inattendu/);
    await assert.rejects(probe({ websocket: ["/missing"] }), /WebSocket \/missing/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
