import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { nodeValidationPlan, managedNodeMessage } from "../src/lib/updates/managed-node";
import { prepareNodeSources } from "../src/lib/updates/node";
import { ManagedNodeNotice } from "../src/components/project-updates";
import { healthAt, healthCheck, healthRelease, healthUpdates } from "./project-health-fixture";
import type { UpdateTarget, UpdateCheck } from "../src/lib/updates/types";

const target: UpdateTarget = {...healthUpdates().runs[0].targets[0],provider:"vercel",remoteId:"prj_fixture",root:""};
const before = (version="24.21.0"): UpdateCheck => healthCheck({tool:"Node",phase:"before",status:"passed",findings:[],nodeEvidence:{version,projectId:target.remoteId,deploymentId:"dpl_fixture",source:"vercel-function",usage:"runtime"}});
const release = async()=>({...healthRelease,state:"available" as const,securityUpdate:true});

test("Vercel géré : les validations ciblent exactement le runtime mesuré et conservent le correctif attendu",async()=>{
 const measured={...before(),checkedAt:"2026-10-28T15:00:00.000Z"};
 const plan=await nodeValidationPlan([target],[measured],"24.22.1",release);
 assert.equal(plan.version,"24.21.0");
 const managed=plan.managed.get(target.id)!;
 assert.equal(managed.updatePending,true);assert.equal(managed.securityUpdate,true);
 assert.equal(managed.checkedAt,measured.checkedAt,"la date du runtime est celle de la mesure, pas du cache du catalogue");
 assert.match(managedNodeMessage(managed),/Correctif de sécurité 24.22.1 en attente/);
 const current=await nodeValidationPlan([target],[before("24.22.1")],"24.22.1",release);
 assert.equal(current.managed.get(target.id)!.updatePending,false);
});
test("Vercel géré : aucune version n’est choisie sans preuve qualifiée, catalogue de branche connu et support confirmé",async()=>{
 await assert.rejects(nodeValidationPlan([target],[null],"24.22.1",release),/mesurée/);
 await assert.rejects(nodeValidationPlan([target],[{...before(),status:"blocked"}],"24.22.1",release),/mesurée/);
 await assert.rejects(nodeValidationPlan([target],[before("22.23.4")],"24.22.1",release),/catalogue des correctifs/);
 await assert.rejects(nodeValidationPlan([target],[before()],"24.22.1",async()=>({...await release(),supported:false})),/support/);
 await assert.rejects(nodeValidationPlan([target],[before()],"24.22.1",async()=>({...await release(),state:"unknown"})),/support/);
});
test("Les groupes Railway conservent la dernière LTS ; un groupe aux runtimes différents bloque",async()=>{
 const railway={...target,provider:"railway" as const,id:"railway"};
 assert.equal((await nodeValidationPlan([railway],[null],"24.22.1",release)).version,"24.22.1");
 await assert.rejects(nodeValidationPlan([target,railway],[before(),null],"24.22.1",release),/versions Node différentes/);
 await assert.rejects(nodeValidationPlan([target,{...target,id:"second"}],[before(),before("24.22.1")],"24.22.1",release),/versions Node différentes/);
});

test("Nouvelle majeure LTS : les dépendances restent validables sur la branche Vercel encore prise en charge", async () => {
 const plan=await nodeValidationPlan([target],[before()],"26.13.0",release);
 assert.equal(plan.version,"24.21.0");
 const managed=plan.managed.get(target.id)!;
 assert.equal(managed.branchLatest,"24.22.1"); assert.equal(managed.migrationAvailable,true); assert.equal(managed.updatePending,true);
 assert.match(managedNodeMessage(managed),/Correctif de sécurité 24.22.1/);
 assert.match(managedNodeMessage(managed),/Migration vers la LTS 26.13.0 à planifier séparément/);
 await assert.rejects(nodeValidationPlan([target],[before()],"26.13.0",async()=>({...await release(),supported:false})),/support/);
 const current=await nodeValidationPlan([target],[before("24.22.1")],"26.13.0",release);
 assert.equal(current.managed.get(target.id)!.updatePending,false);
 assert.equal(current.managed.get(target.id)!.migrationAvailable,true);
});
test("L’interface sépare explicitement les dépendances validées du correctif de sécurité Node non appliqué",()=>{
 const state=healthUpdates();
 state.runs[0].results[0].managedNode={provider:"vercel",version:"24.21.0",latestLts:"24.22.1",updatePending:true,securityUpdate:true,checkedAt:healthAt};
 const html=renderToStaticMarkup(createElement(ManagedNodeNotice,{run:state.runs[0]}));
 assert.match(html,/Correctif Node en attente chez Vercel/);assert.match(html,/24.21.0/);assert.match(html,/24.22.1/);
 assert.match(html,/dépendances ont été validées/);assert.match(html,/runtime dépend de Vercel et n’est pas confirmée/);
 state.runs[0].results[0].stage="failed";
 assert.doesNotMatch(renderToStaticMarkup(createElement(ManagedNodeNotice,{run:state.runs[0]})),/dépendances ont été validées/);
});
test("Docker Vercel : les tests tournent réellement sous 24.21.0 malgré une dernière LTS 24.22.1",{skip:process.env.VIGIE_TEST_DOCKER!=="1"},async()=>{
 const folder=await mkdtemp(join(tmpdir(),"vigie-managed-node-"));
 try{
  const plan=await nodeValidationPlan([target],[before()],"24.22.1",release);
  await writeFile(join(folder,"package.json"),JSON.stringify({name:"vigie-runtime-fixture",version:"1.0.0",private:true,engines:{node:"24.22.1"},dependencies:{"is-number":"6.0.0"},scripts:{test:"node test.cjs"}}));
  await writeFile(join(folder,"package-lock.json"),JSON.stringify({name:"vigie-runtime-fixture",version:"1.0.0",lockfileVersion:3,packages:{"":{dependencies:{"is-number":"6.0.0"}}}}));
  await writeFile(join(folder,"test.cjs"),"const assert=require('node:assert/strict');assert.equal(process.versions.node,'24.21.0');assert.equal(require('is-number')(42),true);\n");
  await prepareNodeSources(folder,[""],["package.json","package-lock.json","test.cjs"],plan.version);
  assert.equal(JSON.parse(await readFile(join(folder,"package.json"),"utf8")).engines.node,"24.21.0");
 }finally{await rm(folder,{recursive:true,force:true});}
});
