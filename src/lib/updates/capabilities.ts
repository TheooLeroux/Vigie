import { z } from "zod";
import { ApiError } from "../http";
import type { UpdateTarget } from "./types";

export const sourceQualificationSchema = z.object({
  schema: z.literal(1), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), commit: z.string().regex(/^[a-f0-9]{40}$/), root: z.string().max(1000),
  family: z.enum(["node", "bun", "wordpress", "dolibarr", "php", "python", "go", "rust", "ruby", "java", "static", "mixed", "unknown"]),
  manifests: z.array(z.string().max(100)).max(30), scripts: z.array(z.string().max(100)).max(200), lock: z.string().max(1000).nullable(), sharedLock: z.boolean().default(false), staticFramework: z.enum(["vite", "astro", "create-react-app"]).optional(), checkedAt: z.iso.datetime(),
});
export type SourceQualification = z.infer<typeof sourceQualificationSchema>;
export type MaintenanceCapability = {
  family: SourceQualification["family"] | "database" | "network" | "image";
  workload: "web" | "static" | "worker" | "scheduled" | "persistent" | "unknown";
  adapter: "node-web" | "node-worker" | "node-static" | "wordpress" | null;
  status: "automatic" | "qualify" | "manual";
  label: string;
  reason: string;
  staticFramework?: "vite" | "astro" | "create-react-app";
};
export class SourceQualificationError extends ApiError {
  constructor(message: string, readonly sourceQualification: SourceQualification) { super(message, 422); }
}
const markers: Record<string, SourceQualification["family"]> = { "composer.json": "php", "requirements.txt": "python", "pyproject.toml": "python", "Pipfile": "python", "go.mod": "go", "Cargo.toml": "rust", "Gemfile": "ruby", "pom.xml": "java", "build.gradle": "java" };
export function sourceFamily(names: string[], manifest?: Record<string, any>): SourceQualification["family"] {
  const files = new Set(names);
  // An asset toolchain does not turn a CMS into a Node application.
  if (files.has("wp-includes") && (files.has("wp-admin") || files.has("wp-load.php"))) return "wordpress";
  if (files.has("main.inc.php") && files.has("core") || files.has("filefunc.inc.php")) return "dolibarr";
  const families = new Set(names.flatMap(name => Object.hasOwn(markers, name) ? [markers[name]] : []));
  if (files.has("package.json")) families.add(files.has("bun.lock") || files.has("bun.lockb") || manifest?.engines?.bun || /^bun@/.test(manifest?.packageManager || "") ? "bun" : "node");
  if (families.size > 1) return "mixed";
  return [...families][0] || (files.has("index.html") ? "static" : "unknown");
}
export function qualifySources(target: Pick<UpdateTarget, "repository" | "root">, commit: string, names: string[], manifest?: Record<string, any>): SourceQualification {
  const dependencies = { ...manifest?.dependencies, ...manifest?.devDependencies };
  const staticFramework = typeof manifest?.scripts?.build === "string" ? dependencies.astro ? "astro" : dependencies.vite ? "vite" : dependencies["react-scripts"] ? "create-react-app" : undefined : undefined;
  return sourceQualificationSchema.parse({ schema: 1, repository: target.repository, root: target.root, commit, family: sourceFamily(names, manifest), manifests: names.filter(name => name === "package.json" || Object.hasOwn(markers, name) || ["wp-load.php", "filefunc.inc.php"].includes(name)), scripts: Object.keys(manifest?.scripts || {}).filter(name => name.length <= 100), lock: names.find(name => ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"].includes(name)) || null, sharedLock: !!manifest?.workspaces || names.includes("pnpm-workspace.yaml"), staticFramework, checkedAt: new Date().toISOString() });
}
export function matchingQualification(raw: unknown, repository: string | null, root: string, commit?: string | null) {
  const parsed = sourceQualificationSchema.safeParse(raw);
  return parsed.success && parsed.data.repository === repository && parsed.data.root === root && parsed.data.commit === commit ? parsed.data : null;
}
type Evidence = { framework?: string | null; runtimes?: string[]; staticSite?: boolean; image?: string | null; cron?: string | null; installation?: string; commit?: string | null; source?: unknown };
export function maintenanceCapability(target: Pick<UpdateTarget, "provider" | "repository" | "root" | "url" | "mode">, evidence: Evidence): MaintenanceCapability {
  const result = (family: MaintenanceCapability["family"], workload: MaintenanceCapability["workload"], adapter: MaintenanceCapability["adapter"], status: MaintenanceCapability["status"], label: string, reason: string): MaintenanceCapability => ({ family, workload, adapter, status, label, reason });
  if (evidence.installation) {
    if (evidence.installation === "wordpress") return result("wordpress", "web", "wordpress", "automatic", "WordPress", "Cœur et extensions admissibles ; composants conservés traités séparément.");
    const family = evidence.installation === "dolibarr" ? "dolibarr" : ["static", "next-static"].includes(evidence.installation) ? "static" : evidence.installation === "php" ? "php" : "unknown";
    return result(family, family === "static" ? "static" : "web", null, "manual", family === "dolibarr" ? "Dolibarr" : family === "static" ? "Fichiers statiques" : "Application à qualifier", "Cette application reste inventoriée ; sa maintenance demande un parcours dédié. Les autres services compatibles peuvent être traités.");
  }
  if (evidence.image) return result(/postgres|mysql|mariadb|redis/i.test(evidence.image) ? "database" : /tailscale/i.test(evidence.image) ? "network" : "image", "persistent", null, "manual", "Image ou service persistant", "Image externe : version, données et récupération à qualifier séparément du moteur Node.");
  if (evidence.cron) return result("unknown", "scheduled", null, "manual", "Tâche planifiée", "Qualifier la source, le résultat de tâche et la récupération avant d’automatiser cette tâche.");
  if (target.provider === "vercel" && evidence.runtimes?.some(runtime => !/^nodejs/.test(runtime))) return result("mixed", "unknown", null, "qualify", "Environnement d’exécution à qualifier", "Des fonctions autres que Node sont observées. Leur compatibilité ne peut pas être déduite d’une sonde Node.");
  const source = matchingQualification(evidence.source, target.repository, target.root, evidence.commit);
  if (source && source.family !== "node") return result(source.family, source.family === "static" ? "static" : "unknown", null, "manual", `Sources ${source.family}`, `Technologie ${source.family} reconnue au commit déployé ; aucun parcours automatique adapté n’est encore disponible.`);
  if (source?.sharedLock) return result("node", "unknown", null, "qualify", "Workspace Node à qualifier", "Ce service utilise un workspace ou un verrou partagé ; ses dépendances et les autres services doivent être qualifiés ensemble avant publication.");
  const knownNode = source?.family === "node" || ["nextjs", "fastify", "node", "vite", "astro", "create-react-app", "nuxtjs", "sveltekit"].includes(evidence.framework || "") || evidence.runtimes?.some(runtime => /^nodejs/.test(runtime));
  if (!knownNode) return result("unknown", "unknown", null, "qualify", "Technologie à qualifier", "Le contrôle des sources doit identifier la technologie de ce service avant sa maintenance.");
  if (source && (!source.lock || !source.scripts.some(name => name === "test" || name === "build"))) return result("node", "unknown", null, "qualify", "Node à qualifier", "Un verrou de dépendances et un script test ou build sont nécessaires pour qualifier ce service.");
  const staticSite = evidence.staticSite || target.provider === "vercel" && evidence.runtimes?.length === 0;
  if (staticSite) {
    if (target.provider === "railway") return result("node", "static", "node-static", "automatic", "Node de construction · site statique", "Build et site publié contrôlés ; aucune version Node serveur n’est revendiquée.");
    if (source?.lock && source.staticFramework && source.scripts.includes("build") && (!evidence.framework || evidence.framework === source.staticFramework)) return { ...result("node", "static", "node-static", "automatic", "Site statique Vercel", "Sources et sortie du build qualifiées avant publication ; empreintes des fichiers, domaine public et absence de fonctions contrôlés après déploiement. Configurations particulières à qualifier séparément."), staticFramework: source.staticFramework };
    return result("node", "static", null, "qualify", "Construction statique à qualifier", "Le contrôle des sources doit confirmer le verrou, le script build et un framework statique pris en charge ; l’absence de fonction observée ne suffit pas.");
  }
  if (!target.url && target.provider === "railway") return source?.scripts.includes("start") ? result("node", "worker", "node-worker", "automatic", "Traitement Node en arrière-plan", "Tests isolés et processus Node du déploiement contrôlés ; les résultats métier demandent un contrôle dédié.") : result("node", "worker", null, "qualify", "Traitement en arrière-plan à qualifier", "La source, le verrou et les scripts start et test ou build doivent être identifiés avant la maintenance sans page HTTP.");
  return result("node", "web", "node-web", "automatic", "Application Node web", "Dépendances, tests, déploiement, runtime Node et réponse HTTPS contrôlés.");
}
export function allowsAutomaticMaintenance(target: UpdateTarget) { return !target.unavailable && (!target.capability || target.capability.status === "automatic" && !!target.capability.adapter); }
export function workerTarget(target: UpdateTarget) { return target.provider === "railway" && target.capability?.adapter === "node-worker" && target.capability.status === "automatic"; }
export function executionGroup(target: UpdateTarget) { return target.mode === "git" ? `git:${target.repository!.toLowerCase()}` : `${target.provider}:${target.connectionId}:${target.remoteId}:${target.environmentId || ""}`; }
