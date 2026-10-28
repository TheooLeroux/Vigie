import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateProgress } from "../src/components/project-updates";
import { updateStopSummary } from "../src/lib/updates/stop-summary";
import { healthCheck, healthUpdates } from "./project-health-fixture";
import { createProject } from "../src/lib/db";
import { createProjectSchema } from "../src/lib/validation";
import { saveVercelConnection, applyVercelSnapshot, linkVercelProject } from "../src/lib/vercel";
import { startProjectUpdate } from "../src/lib/updates/service";
import { executeUpdate } from "../src/lib/updates/executor";
import { readUpdateRun, updateStorage } from "../src/lib/updates/storage";
import { requireSecurityPass, securityCheck } from "../src/lib/updates/security";
import type { VercelProject } from "../src/lib/vercel-types";
import { ApiError } from "../src/lib/http";

test("Arrêt : raison, paquet et correctif non référencé visibles sans annoncer une recherche encore active", () => {
  const run = healthUpdates().runs[0]; run.stage = "failed";
  run.message = "La recherche atteint sa limite de six propositions ; aucune combinaison compatible sans alerte validée.";
  run.results[0].checks = [healthCheck({status:"blocked"})];
  const html = renderToStaticMarkup(createElement(UpdateProgress,{run}));
  assert.match(html,/Mise à jour arrêtée/);
  assert.match(html,/limite de six propositions/);
  assert.match(html,/Aucune nouvelle version n’a été publiée/);
  assert.match(html,/library 1.0.0/);
  assert.match(html,/Aucun correctif référencé dans ce rapport/);
  assert.doesNotMatch(html,/Recherche d’une autre|absence de solution démontrée/);
  assert.equal(updateStopSummary({...run,stage:"updating"}),null);
});

test("Arrêt : conserver la cause de validation et ne pas recycler une alerte d’un candidat corrigé", () => {
  const run = healthUpdates().runs[0]; run.stage="failed";run.message="La construction a échoué : une adaptation du code est nécessaire.";
  run.results[0].checks=[healthCheck({status:"blocked"}),healthCheck({status:"passed",findings:[]})];
  assert.equal(updateStopSummary(run)?.reason,run.message);
  assert.equal(updateStopSummary(run)?.findings.length,0);
  run.stage="attention";run.results[0].commit="a".repeat(40);
  const html=renderToStaticMarkup(createElement(UpdateProgress,{run}));
  assert.match(html,/état à vérifier/);
  assert.match(html,/opérations ont déjà pu être exécutées/);
  assert.doesNotMatch(html,/Aucune nouvelle version n’a été publiée/);
});

test("Exécuteur : une proposition encore vulnérable arrête définitivement la tentative, sans publication ni relance", async () => {
  process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY=randomBytes(32).toString("hex");
  process.env.VIGIE_UPDATES_ENABLED="1";
  process.env.VIGIE_UPDATES_RUNNER_REPOSITORY="qa/runner";
  process.env.VIGIE_UPDATES_GITHUB_TOKENS='{"qa":"unit-test-only"}';
  process.env.VIGIE_UPDATES_REPOSITORIES="qa/blocked";
  const project=await createProject("live",createProjectSchema.parse({name:"Blocked update",url:"https://blocked.example.test"}));
  const connection=await saveVercelConnection({name:"Fixture",teamId:`team_${randomUUID().replaceAll("-","")}`,secret:"unit-test-only"});
  const remote:VercelProject={id:`prj_${randomUUID().replaceAll("-","")}`,name:project.name,teamId:connection.teamId,teamSlug:"qa",teamName:"QA",framework:"nextjs",nodeBranch:"24.x",rootDirectory:null,repository:"qa/blocked",productionBranch:"main",domains:[],production:null,latest:null,excluded:false,clientSuggestion:null};
  await applyVercelSnapshot(connection.id,[remote]);await linkVercelProject(connection.id,remote.id,project.id);
  const run=await startProjectUpdate({projectId:project.id},async()=>{});
  let attempts=0, afterComplete=0;
  const result=await executeUpdate(run.id,async(_run,_targets,results)=>{
    attempts++;
    const check=securityCheck("OSV","candidate","racine",healthCheck().findings);
    results[0].checks=[check];
    requireSecurityPass(check);
    results[0].commit="must-never-publish";
  },async()=>{},async()=>{afterComplete++;});
  assert.equal(result,true);
  const stopped=(await readUpdateRun(run.id))!;
  assert.equal(stopped.stage,"failed");
  assert.equal(stopped.results[0].commit,undefined);
  assert.match(stopped.message,/vulnérabilité.*non résolue/);
  assert.doesNotMatch(stopped.message,/Recherche d’une autre/);
  assert.equal(updateStopSummary(stopped)?.findings[0].finding.package,"library");
  assert.equal(await executeUpdate(run.id),false,"une tentative arrêtée ne se relance pas d’elle-même");
  assert.equal(attempts,1);assert.equal(afterComplete,0);
  assert.equal((await (await updateStorage()).prepare("SELECT scope FROM update_locks WHERE run_id=?").all(run.id)).length,0);
});

test("Exécuteur : limites de recherche et incompatibilités restent une raison explicite, sans conclure à une impossibilité universelle", () => {
  const run=healthUpdates().runs[0];run.stage="failed";run.message=new ApiError("Aucun parent stable compatible trouvé dans le budget de recherche. Recherche bornée, absence de solution non démontrée au-delà du budget.",422).message;
  const summary=updateStopSummary(run)!;
  assert.match(summary.reason,/budget de recherche/);
  assert.match(summary.reason,/absence de solution non démontrée/);
});
