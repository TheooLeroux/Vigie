import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import type { lookup } from "node:dns/promises";
import { answerRuntimeChallenge, runtimeSignature, verifyRuntimeSignature } from "../src/lib/updates/vercel-runtime-protocol";
import { hkdfSync } from "node:crypto";
import { readVercelRuntime } from "../src/lib/updates/vercel-runtime";
import { verifyDeployedNode, preflightNodeRuntime } from "../src/lib/updates/node-deployment";
import { POST } from "../src/app/api/maintenance/runtime/route";
import type { UpdateTarget } from "../src/lib/updates/types";

const target: UpdateTarget = { id:"vercel:fixture",projectId:"fixture",name:"Vigie fixture",provider:"vercel",connectionId:"connection",remoteId:"prj_fixture",environmentId:null,repository:"owner/vigie",branch:"main",root:"",url:"https://vigie.example.test/",mode:"git",configured:true,unavailable:null };
const reference = {deploymentId:"dpl_fixture",commit:"a".repeat(40)};
const keys = ["VIGIE_CONNECTOR_ENCRYPTION_KEY","VIGIE_RUNTIME_PROBE_KEY","VERCEL","VERCEL_ENV","VERCEL_PROJECT_ID","VERCEL_DEPLOYMENT_ID","VERCEL_GIT_COMMIT_SHA","VERCEL_GIT_REPO_OWNER","VERCEL_GIT_REPO_SLUG","VERCEL_GIT_COMMIT_REF","VERCEL_REGION"];
const original = new Map(keys.map(key=>[key,process.env[key]]));
test.beforeEach(()=>{
 delete process.env.VIGIE_RUNTIME_PROBE_KEY;
 Object.assign(process.env,{VIGIE_CONNECTOR_ENCRYPTION_KEY:"12".repeat(32),VERCEL:"1",VERCEL_ENV:"production",VERCEL_PROJECT_ID:target.remoteId,VERCEL_DEPLOYMENT_ID:reference.deploymentId,VERCEL_GIT_COMMIT_SHA:reference.commit,VERCEL_GIT_REPO_OWNER:"owner",VERCEL_GIT_REPO_SLUG:"vigie",VERCEL_GIT_COMMIT_REF:"main",VERCEL_REGION:"fra1"});
});
test.afterEach(()=>{for(const [key,value]of original)value===undefined?delete process.env[key]:process.env[key]=value;});
const resolve = (async()=>[{address:"76.76.21.21",family:4}]) as unknown as typeof lookup;
function request() {
 const raw=JSON.stringify({projectId:target.remoteId,deploymentId:reference.deploymentId,nonce:"b".repeat(64)}), timestamp=String(Math.floor(Date.now()/1000));
 return {raw,timestamp,signature:runtimeSignature(target.remoteId,"request",raw,timestamp)};
}
function readers(mutator?:(packet:ReturnType<typeof answerRuntimeChallenge>)=>void) {
 let reads=0;
 const vercel=async(_target:UpdateTarget,path:string)=>{
  reads++;
  return path.startsWith('/v13/')?{id:reference.deploymentId,projectId:target.remoteId,target:"production",readyState:"READY",meta:{githubCommitSha:reference.commit}}:{id:target.remoteId,rootDirectory:null,link:{type:"github",org:"owner",repo:"vigie",productionBranch:"main"},targets:{production:{id:reference.deploymentId}}};
 };
 const transport:typeof fetch=async(_url,options)=>{
  assert.equal(options?.redirect,"error"); assert.equal(options?.cache,"no-store");
  const headers=new Headers(options?.headers);
  const packet=answerRuntimeChallenge(String(options?.body),headers.get("X-Vigie-Time")!,headers.get("X-Vigie-Signature")!);
  mutator?.(packet);
  return Response.json(packet);
 };
 return {vercel,transport,resolve,reads:()=>reads};
}

test("Sonde Vercel : mesure le processus Node et signe uniquement son identité de déploiement",()=>{
 const input=request(),packet=answerRuntimeChallenge(input.raw,input.timestamp,input.signature);
 assert.equal(packet.payload.node,process.versions.node);
 assert.equal(packet.payload.deploymentId,reference.deploymentId);
 assert.equal(packet.payload.commit,reference.commit);
 verifyRuntimeSignature(target.remoteId,"response",JSON.stringify(packet.payload),packet.timestamp,packet.signature);
 assert.deepEqual(Object.keys(packet.payload).sort(),["projectId","deploymentId","nonce","protocol","node","commit","repository","branch","environment","region","time"].sort());
 assert.equal(JSON.stringify(packet).includes(process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY!),false);
});
test("Sonde Vercel : refuse signature forgée, message expiré et signature de réponse utilisée comme requête",()=>{
 const input=request();
 assert.throws(()=>answerRuntimeChallenge(input.raw,input.timestamp,"0".repeat(64)),/Signature/);
 assert.throws(()=>answerRuntimeChallenge(input.raw,String(Number(input.timestamp)-120),input.signature),/expirée/);
 assert.throws(()=>answerRuntimeChallenge(input.raw,input.timestamp,runtimeSignature(target.remoteId,"response",input.raw,input.timestamp)),/Signature/);
 process.env.VERCEL_DEPLOYMENT_ID="dpl_other";
 assert.throws(()=>answerRuntimeChallenge(input.raw,input.timestamp,input.signature),/déploiement servi/);
 process.env.VERCEL_ENV="preview";
 assert.throws(()=>answerRuntimeChallenge(input.raw,input.timestamp,input.signature),/production/);
});
test("Route Vercel : authentification exigée, taille bornée et réponse non mise en cache",async()=>{
 assert.equal((await POST(new Request(target.url!,{method:"POST",body:"{}"}))).status,401);
 assert.equal((await POST(new Request(target.url!,{method:"POST",body:"x".repeat(2049)}))).status,413);
 const input=request();
 const response=await POST(new Request(target.url!,{method:"POST",body:input.raw,headers:{"X-Vigie-Time":input.timestamp,"X-Vigie-Signature":input.signature}}));
 assert.equal(response.status,200);assert.match(response.headers.get("cache-control")!,/no-store/);
});
test("Vercel : preuve fraîche liée au projet, commit, source et production active avant et après lecture",async()=>{
 const deps=readers(),proof=await readVercelRuntime(target,reference,deps);
 assert.equal(proof.node,process.versions.node);assert.equal(deps.reads(),3);
 const check=await verifyDeployedNode(target,reference,process.versions.node,{railway:async()=>{throw Error("wrong provider")},vercel:deps.vercel,vercelRuntime:(t,r)=>readVercelRuntime(t,r,deps)});
 assert.equal(check.status,"passed");assert.equal(check.nodeEvidence?.source,"vercel-function");
 assert.equal(check.nodeEvidence?.imageDigest,undefined,"ne fabrique aucune empreinte d’image Vercel");
 assert.match(check.message,/Edge.*répliques.*pas attestés/);
});
test("Vercel : un correctif exécuté différent du correctif testé reste bloquant",async()=>{
 const deps=readers();
 const check=await verifyDeployedNode(target,reference,"24.0.0",{railway:async()=>{throw Error("wrong provider")},vercel:deps.vercel,vercelRuntime:(t,r)=>readVercelRuntime(t,r,deps)});
 assert.equal(check.status,"blocked");assert.match(check.message,/diffère/);
});
test("Vercel : refuse preuve ancienne, mauvaise signature et identités signées ne correspondant pas à la demande",async()=>{
 const mutations:Parameters<typeof readers>[0][]=[packet=>{packet.signature="0".repeat(64)},packet=>{packet.payload.nonce="c".repeat(64)},packet=>{packet.payload.projectId="prj_other"},packet=>{packet.payload.deploymentId="dpl_other"},packet=>{packet.payload.commit="c".repeat(40)},packet=>{packet.payload.branch="preview"},packet=>{packet.payload.repository="other/app"},packet=>{packet.payload.time-=120;packet.timestamp=String(packet.payload.time)}];
 for(const [index,mutate]of mutations.entries()){
  const deps=readers(packet=>{mutate!(packet);if(index!==0)packet.signature=runtimeSignature(target.remoteId,"response",JSON.stringify(packet.payload),packet.timestamp)});
  await assert.rejects(readVercelRuntime(target,reference,deps));
 }
});
test("Vercel : un changement d’alias pendant la mesure ne valide pas l’ancien déploiement",async()=>{
 const deps=readers(),base=deps.vercel;let calls=0;
 deps.vercel=async(t,path)=>{const data=await base(t,path);if(++calls===3)data.targets!.production.id="dpl_other";return data};
 await assert.rejects(readVercelRuntime(target,reference,deps),/pendant la mesure/);
});
test("Vercel : refuse une adresse privée avant tout envoi et une sonde absente",async()=>{
 const deps=readers();let sent=false;
 await assert.rejects(readVercelRuntime(target,reference,{...deps,resolve:(async()=>[{address:"127.0.0.1",family:4}]) as unknown as typeof lookup,transport:async()=>{sent=true;throw Error("must not send")}}),/adresse publique/);
 assert.equal(sent,false);
 await assert.rejects(readVercelRuntime(target,reference,{...deps,transport:async()=>new Response(null,{status:404})}),/Sonde Vercel indisponible/);
});
test("Vercel : une application externe peut utiliser seulement sa clé dérivée, sans clé de chiffrement Vigie",()=>{
 const input=request();
 process.env.VIGIE_RUNTIME_PROBE_KEY=Buffer.from(hkdfSync("sha256",Buffer.from(process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY!,"hex"),Buffer.alloc(0),`vigie:vercel-runtime:v1:${target.remoteId}`,32)).toString("hex");
 delete process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY;
 const packet=answerRuntimeChallenge(input.raw,input.timestamp,input.signature);
 verifyRuntimeSignature(target.remoteId,"response",JSON.stringify(packet.payload),packet.timestamp,packet.signature);
});
test("Vercel : sonde requise avant publication, une ancienne version reste admissible uniquement à ce précontrôle",async()=>{
 const deps=readers();
 const ready=await preflightNodeRuntime(target,reference.deploymentId,"99.0.0",(t,r)=>readVercelRuntime(t,r,deps));
 assert.equal(ready?.status,"passed");assert.match(ready!.message,/contrôlé après déploiement/);
 const blocked=await preflightNodeRuntime(target,reference.deploymentId,"99.0.0",async()=>{throw Error("not installed")});
 assert.equal(blocked?.status,"blocked");assert.match(blocked!.message,/Aucun changement publié/);
});
