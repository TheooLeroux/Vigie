import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { once } from "node:events";
import { runInNewContext } from "node:vm";
import { healthUpdates } from "./project-health-fixture";
import { parseSocksHealth, prepareSocksHealth, qualifySocksHealth, socksHealthScript, type SocksHealthPlan } from "../src/lib/updates/socks-health";

const target = { ...healthUpdates().runs[0].targets[0], remoteId: crypto.randomUUID(), environmentId: crypto.randomUUID() }, deployment = crypto.randomUUID(), domain = "proxy-fixture.railway.internal";
const variables = { PI_PROXY_URL: `socks5://${domain}:1055`, PI_IP: "100.65.1.2", PI_WEBHOOK_PORT: "8080" };
test("Témoin SOCKS : destination déjà configurée, réseau Tailscale et absence de credentials dans le proxy", () => {
  assert.ok(qualifySocksHealth(target, deployment, variables, domain, 1055));
  assert.equal(qualifySocksHealth(target, deployment, variables, "other.railway.internal", 1055), null);
  for (const PI_IP of ["169.254.169.254", "127.0.0.1", "8.8.8.8", "100.1.1.1"]) assert.throws(() => qualifySocksHealth(target, deployment, { ...variables, PI_IP }, domain, 1055));
  assert.throws(() => qualifySocksHealth(target, deployment, { ...variables, PI_PROXY_URL: `socks5://user:secret@${domain}:1055` }, domain, 1055));
});

test("Qualification : consommateur du même projet/environnement, configuration réduite sans secret, aucun témoin fictif", async () => {
  const consumer = { ...target, capability: { family: "node" as const, workload: "web" as const, adapter: "node-web" as const, status: "automatic" as const, label: "Node", reason: "" } };
  const image = { ...target, remoteId: crypto.randomUUID() };
  const dependencies = { targets: async () => [consumer, { ...consumer, connectionId: "other" }], request: async (_target: any, query: string) => query.includes("SocksVariables") ? { variables: { ...variables, PI_API_SECRET: "do-not-retain" } } : { serviceInstance: { latestDeployment: { id: deployment, status: "SUCCESS" }, activeDeployments: [{ id: deployment, status: "SUCCESS" }] } } };
  const plans = await prepareSocksHealth(image, "provider-project", { RAILWAY_PRIVATE_DOMAIN: domain }, 1055, dependencies);
  assert.equal(plans.length, 1); assert.doesNotMatch(JSON.stringify(plans), /do-not-retain|PI_API_SECRET/);
  await assert.rejects(prepareSocksHealth(image, "provider-project", { RAILWAY_PRIVATE_DOMAIN: domain }, 1055, { ...dependencies, targets: async () => [] }), /Aucun témoin/);
});

async function exercise(status: number, body: string, denyProxy = false) {
  const clients = new Set<net.Socket>(); let requests = 0;
  const endpoint = http.createServer((req, res) => { requests++; assert.equal(req.method, "GET"); assert.equal(req.url, "/health"); assert.equal(req.headers.authorization, undefined); res.writeHead(status, { "Content-Type": "application/json" }); res.end(body); });
  endpoint.listen(0, "127.0.0.1"); await once(endpoint, "listening");
  const port = (endpoint.address() as net.AddressInfo).port;
  const proxy = net.createServer(socket => {
    clients.add(socket); socket.on("error", () => {}); socket.once("close", () => clients.delete(socket));
    let phase = 0, input = Buffer.alloc(0);
    const receive = (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      if (phase === 0 && input.length >= 3) { assert.deepEqual([...input.subarray(0, 3)], [5, 1, 0]); input = input.subarray(3); phase = 1; socket.write(Buffer.from([5])); setImmediate(() => socket.write(Buffer.from([denyProxy ? 255 : 0]))); }
      if (phase !== 1 || input.length < 10) return;
      assert.deepEqual([...input.subarray(0, 8)], [5, 1, 0, 1, 100, 65, 1, 2]); assert.equal(input.readUInt16BE(8), port);
      phase = 2; socket.removeListener("data", receive);
      const upstream = net.connect({ host: "127.0.0.1", port }); clients.add(upstream); upstream.on("error", () => socket.destroy()); upstream.once("close", () => clients.delete(upstream));
      upstream.once("connect", () => { socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); socket.pipe(upstream).pipe(socket); });
    };
    socket.on("data", receive);
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const plan: SocksHealthPlan = { target, deploymentId: deployment, proxyHost: domain, proxyPort: 1055, peer: "100.65.1.2", port };
  const nonce = crypto.randomUUID();
  try {
    const output = await new Promise<string | null>((resolve, reject) => {
      const processMock: any = { env: { RAILWAY_DEPLOYMENT_ID: deployment, RAILWAY_SERVICE_ID: target.remoteId, RAILWAY_ENVIRONMENT_ID: target.environmentId, ...variables, PI_WEBHOOK_PORT: String(port), PI_API_SECRET: "must-never-be-read-or-transmitted" }, stdout: { write: (value: string) => resolve(value) }, exit: () => { throw new Error("refused before connection"); } };
      Object.defineProperty(processMock, "exitCode", { set: () => resolve(null) });
      try { runInNewContext(socksHealthScript(plan, nonce), { process: processMock, require: (name: string) => name === "node:net" ? { connect: (options: any) => { assert.equal(options.host, domain); assert.equal(options.port, 1055); return net.connect({ host: "127.0.0.1", port: (proxy.address() as net.AddressInfo).port }); } } : name === "node:http" ? http : name === "node:crypto" ? crypto : assert.fail("unexpected module"), Buffer, URL, setTimeout, clearTimeout }); } catch (error) { reject(error); }
    });
    if (output) { assert.doesNotMatch(output, /must-never|healthy/); assert.equal(parseSocksHealth(output, plan, nonce).status, 200); assert.throws(() => parseSocksHealth(output, plan, crypto.randomUUID())); }
    return { passed: !!output, requests };
  } finally { for (const client of clients) client.destroy(); endpoint.closeAllConnections(); await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => endpoint.close(() => resolve()))]); }
}
test("SOCKS réel : négociation fragmentée, connexion TCP et GET /health JSON, sans secret applicatif", { timeout: 15_000 }, async () => { assert.deepEqual(await exercise(200, '{"status":"healthy"}'), { passed: true, requests: 1 }); });
test("SOCKS réel : refus du proxy, HTTP 503, JSON invalide et état malsain interdisent la validation", { timeout: 25_000 }, async () => {
  assert.deepEqual(await exercise(200, '{"status":"healthy"}', true), { passed: false, requests: 0 });
  for (const [status, body] of [[503, '{"status":"healthy"}'], [200, 'not-json'], [200, '{"status":"unhealthy"}']] as const) assert.equal((await exercise(status, body)).passed, false);
});
