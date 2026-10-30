import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../http";
import { railwayUpdateRequest } from "./providers";
import { updateTargets } from "./targets";
import { readRailwayProbe } from "./docker-node";
import { tailnetIPv4 } from "./tailscale-probe";
import type { UpdateTarget } from "./types";

export type SocksHealthPlan = { target: UpdateTarget; deploymentId: string; proxyHost: string; proxyPort: number; peer: string; port: number };
export type SocksHealthProof = { serviceId: string; deploymentId: string; status: 200; checkedAt: string };
const ids = (target: UpdateTarget) => ({ s: target.remoteId, e: target.environmentId });
const deploymentQuery = `query SocksConsumer($s:String!,$e:String!){serviceInstance(serviceId:$s,environmentId:$e){latestDeployment{id status} activeDeployments{id status}}}`;
const variablesQuery = `query SocksVariables($p:String!,$s:String!,$e:String!){variables(projectId:$p,serviceId:$s,environmentId:$e)}`;
function oneDeployment(raw: unknown) {
  const parsed = z.object({ serviceInstance: z.object({ latestDeployment: z.object({ id: z.uuid(), status: z.literal("SUCCESS") }), activeDeployments: z.array(z.object({ id: z.uuid(), status: z.literal("SUCCESS") })).length(1) }) }).safeParse(raw);
  if (!parsed.success || parsed.data.serviceInstance.latestDeployment.id !== parsed.data.serviceInstance.activeDeployments[0].id) throw new ApiError("Le service consommateur du proxy doit avoir un seul déploiement stable pour vérifier son réseau.", 422);
  return parsed.data.serviceInstance.latestDeployment.id;
}
export function qualifySocksHealth(target: UpdateTarget, deploymentId: string, variables: Record<string, string>, domain: string, proxyPort: number): SocksHealthPlan | null {
  if (!variables.PI_PROXY_URL) return null;
  let proxy: URL; try { proxy = new URL(variables.PI_PROXY_URL); } catch { throw new ApiError("La configuration du consommateur SOCKS n’est pas vérifiable.", 422); }
  if (proxy.hostname !== domain) return null;
  const port = Number(variables.PI_WEBHOOK_PORT || "80");
  if (!["socks5:", "socks:"].includes(proxy.protocol) || proxy.username || proxy.password || Number(proxy.port || "1080") !== proxyPort || !tailnetIPv4(variables.PI_IP || "") || !Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError("Le témoin SOCKS exige un proxy interne et le point HTTP de santé d’un pair Tailscale déjà configuré.", 422);
  return { target, deploymentId, proxyHost: domain, proxyPort, peer: variables.PI_IP, port };
}
export async function prepareSocksHealth(image: UpdateTarget, projectId: string, variables: Record<string, string>, proxyPort: number, dependencies = { targets: updateTargets, request: railwayUpdateRequest }): Promise<SocksHealthPlan[]> {
  const domain = variables.RAILWAY_PRIVATE_DOMAIN;
  if (!domain || !/^[a-z0-9-]+\.railway\.internal$/.test(domain)) throw new ApiError("Le domaine privé Railway du proxy n’est pas confirmé.", 422);
  const consumers = (await dependencies.targets(image.projectId)).filter(target => target.provider === "railway" && target.connectionId === image.connectionId && target.environmentId === image.environmentId && target.remoteId !== image.remoteId && target.capability?.family === "node");
  const plans: SocksHealthPlan[] = [];
  for (const target of consumers) {
    const raw = await dependencies.request(target, variablesQuery, { p: projectId, ...ids(target) });
    const values = z.record(z.string(), z.string()).parse(raw.variables);
    if (!values.PI_PROXY_URL) continue;
    const deploymentId = oneDeployment(await dependencies.request(target, deploymentQuery, ids(target)));
    const plan = qualifySocksHealth(target, deploymentId, values, domain, proxyPort);
    if (plan) plans.push(plan);
  }
  if (!plans.length) throw new ApiError("Aucun témoin HTTP qualifié n’est configuré sur un consommateur de ce proxy. Aucune image remplacée.", 422);
  return plans;
}
function configuration(plan: SocksHealthPlan) { return { serviceId: plan.target.remoteId, environmentId: plan.target.environmentId, deploymentId: plan.deploymentId, proxyHost: plan.proxyHost, proxyPort: plan.proxyPort, peer: plan.peer, port: plan.port }; }
const configurationHash = (plan: SocksHealthPlan) => createHash("sha256").update(JSON.stringify(configuration(plan))).digest("hex");
export function socksHealthScript(plan: SocksHealthPlan, nonce: string) {
  if (!z.uuid().safeParse(nonce).success || !tailnetIPv4(plan.peer) || !/^[a-z0-9-]+\.railway\.internal$/.test(plan.proxyHost) || [plan.port, plan.proxyPort].some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new ApiError("Paramètres du contrôle HTTP SOCKS invalides.", 422);
  return String.raw`const cfg=${JSON.stringify(configuration(plan))},nonce=${JSON.stringify(nonce)};
const net=require('node:net'),http=require('node:http'),crypto=require('node:crypto');
let proxy;try{proxy=new URL(process.env.PI_PROXY_URL)}catch{process.exit(2)}
if(process.env.RAILWAY_DEPLOYMENT_ID!==cfg.deploymentId||process.env.RAILWAY_SERVICE_ID!==cfg.serviceId||process.env.RAILWAY_ENVIRONMENT_ID!==cfg.environmentId||proxy.hostname!==cfg.proxyHost||Number(proxy.port||1080)!==cfg.proxyPort||!['socks:','socks5:'].includes(proxy.protocol)||proxy.username||proxy.password||process.env.PI_IP!==cfg.peer||Number(process.env.PI_WEBHOOK_PORT||80)!==cfg.port)process.exit(2);
let stage=0,buffer=Buffer.alloc(0),done=false,agent;
const socket=net.connect({host:cfg.proxyHost,port:cfg.proxyPort});
const timer=setTimeout(()=>finish(false),8000);
function finish(ok){if(done)return;done=true;clearTimeout(timer);socket.destroy();agent?.destroy();if(!ok){process.exitCode=2;return}process.stdout.write(JSON.stringify({nonce,serviceId:cfg.serviceId,environmentId:cfg.environmentId,deploymentId:cfg.deploymentId,configuration:crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex'),status:200}));}
socket.on('error',()=>finish(false));socket.once('connect',()=>socket.write(Buffer.from([5,1,0])));
function receive(chunk){buffer=Buffer.concat([buffer,chunk]);if(buffer.length>65536)return finish(false);
if(stage===0&&buffer.length>=2){if(buffer[0]!==5||buffer[1]!==0)return finish(false);buffer=buffer.subarray(2);stage=1;socket.write(Buffer.from([5,1,0,1,...cfg.peer.split('.').map(Number),cfg.port>>8,cfg.port&255]));}
if(stage!==1||buffer.length<5)return;
if(buffer[0]!==5||buffer[1]!==0||buffer[2]!==0)return finish(false);
const size=buffer[3]===1?10:buffer[3]===4?22:buffer[3]===3?7+buffer[4]:0;
if(!size)return finish(false);if(buffer.length<size)return;if(buffer.length!==size)return finish(false);
stage=2;socket.pause();socket.removeListener('data',receive);agent=new http.Agent({keepAlive:false});agent.createConnection=()=>socket;
const request=http.request({hostname:cfg.peer,port:cfg.port,path:'/health',method:'GET',agent,headers:{Connection:'close',Accept:'application/json'}},response=>{let bytes=0,chunks=[];response.on('error',()=>finish(false));response.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){response.destroy();finish(false)}else chunks.push(chunk)});response.on('end',()=>{if(response.statusCode!==200)return finish(false);try{const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));finish(!!body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length>0&&!['unhealthy','error','failed'].includes(body.status))}catch{finish(false)}})});
request.on('error',()=>finish(false));request.end();socket.resume();}
socket.on('data',receive);socket.on('end',()=>{if(stage<2)finish(false)});`;
}
export function parseSocksHealth(output: string, plan: SocksHealthPlan, nonce: string): SocksHealthProof {
  if (Buffer.byteLength(output) > 2000) throw new ApiError("Attestation HTTP SOCKS invalide.", 422);
  let raw: unknown; try { raw = JSON.parse(output); } catch { throw new ApiError("Aucune réponse HTTP attestée à travers le proxy SOCKS.", 422); }
  const parsed = z.object({ nonce: z.literal(nonce), serviceId: z.literal(plan.target.remoteId), environmentId: z.literal(plan.target.environmentId), deploymentId: z.literal(plan.deploymentId), configuration: z.literal(configurationHash(plan)), status: z.literal(200) }).safeParse(raw);
  if (!parsed.success) throw new ApiError("Le contrôle HTTP SOCKS ne correspond pas au consommateur et à sa configuration.", 422);
  return { serviceId: plan.target.remoteId, deploymentId: plan.deploymentId, status: 200, checkedAt: new Date().toISOString() };
}
export async function verifySocksHealth(plans: SocksHealthPlan[], dependencies = { request: railwayUpdateRequest, probe: readRailwayProbe }): Promise<SocksHealthProof[]> {
  const proofs: SocksHealthProof[] = [];
  for (const plan of plans) {
    if (oneDeployment(await dependencies.request(plan.target, deploymentQuery, ids(plan.target))) !== plan.deploymentId) throw new ApiError("Le consommateur du proxy a changé pendant la maintenance.", 409);
    const results = await dependencies.probe(plan.target, plan.deploymentId, { command: nonce => "env -u NODE_OPTIONS -u NODE_PATH node -e '" + socksHealthScript(plan, nonce).replace(/'/g, "'\\''") + "'", parse: (output, nonce) => parseSocksHealth(output, plan, nonce) });
    if (oneDeployment(await dependencies.request(plan.target, deploymentQuery, ids(plan.target))) !== plan.deploymentId) throw new ApiError("Le consommateur du proxy a changé pendant son contrôle HTTP.", 409);
    proofs.push(...results);
  }
  return proofs;
}
