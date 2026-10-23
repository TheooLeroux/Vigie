import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../src/lib/updates/process";

const tools = [
  { name: "osv-scanner", url: "https://github.com/google/osv-scanner/releases/download/v2.7.0/osv-scanner_linux_amd64", sha256: "160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b", archive: false },
  { name: "trivy", url: "https://github.com/aquasecurity/trivy/releases/download/v0.76.1/trivy_0.76.1_Linux-64bit.tar.gz", sha256: "c7cbe3137fb8a48a17574bede3dd6beb16742d1e9772929940fc90082c39d9c0", archive: true },
];
async function install() {
  if (process.platform !== "linux" || process.arch !== "x64" || !process.env.RUNNER_TEMP || !process.env.GITHUB_PATH) throw Error("Installation réservée à l’exécuteur Linux x64 GitHub.");
  const directory = join(process.env.RUNNER_TEMP, "vigie-scanners");
  await mkdir(directory, { recursive: true });
  for (const tool of tools) {
    const response = await fetch(tool.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw Error(`Téléchargement de ${tool.name} refusé.`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = part.value;
      size += chunk.length;
      if (size > 200_000_000) throw Error("Binaire trop volumineux.");
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks);
    if (createHash("sha256").update(content).digest("hex") !== tool.sha256) throw Error(`Empreinte de ${tool.name} incorrecte.`);
    const destination = join(directory, tool.name + (tool.archive ? ".tar.gz" : ""));
    await writeFile(destination, content);
    if (tool.archive) await runCommand("tar", ["-xzf", destination, "-C", directory, tool.name]);
    await chmod(join(directory, tool.name), 0o755);
  }
  await appendFile(process.env.GITHUB_PATH, directory + "\n");
  console.log("OSV-Scanner 2.7.0 et Trivy 0.76.1 installés avec empreintes vérifiées.");
}
install().catch(() => { console.error("Installation des scanners interrompue. Aucune mise à jour de projet n’a démarré."); process.exitCode = 1; });
