import { z } from "zod";
import { postgresPool } from "../src/lib/storage";
import { downloadGitArchive, extractArchive } from "../src/lib/updates/executor";
import { testMinimalStaticRailway } from "../src/lib/updates/minimal-static";
import { updateTargets } from "../src/lib/updates/targets";

async function main() {
  const projectId = z.string().uuid().parse(process.env.VIGIE_STATIC_PROJECT);
  const commit = z.string().regex(/^[a-f0-9]{40}$/).parse(process.env.VIGIE_STATIC_COMMIT);
  const roots = z.string().regex(/^[a-z0-9][a-z0-9/_-]{0,79}$/);
  const frontend = roots.parse(process.env.VIGIE_STATIC_FRONTEND);
  const backend = roots.parse(process.env.VIGIE_STATIC_BACKEND);
  const targets = await updateTargets(projectId);
  const front = targets.filter(target => target.provider === "railway" && target.root === frontend);
  const back = targets.filter(target => target.provider === "railway" && target.root === backend);
  if (front.length !== 1 || back.length !== 1) throw Error("Le frontend et le témoin doivent désigner un service Railway unique du projet.");
  const result = await testMinimalStaticRailway(front[0], back[0], commit, async (repository, revision, archive, folder) => {
    await downloadGitArchive(repository, revision, archive);
    return extractArchive(archive, folder, true);
  });
  console.log(JSON.stringify(result));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "La validation de l’image minimale a échoué.");
  process.exitCode = 1;
}).finally(() => postgresPool().end());
