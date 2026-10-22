// Explicit allocation supplied by the team on 22 October 2026. No client inferred from a name.
export const VERCEL_SOURCE_TEAM = "team_nmJybhbrvWmdYiNrGlwGyfAQ";
export const VERCEL_CLIENT_PROJECTS: Record<string, string[]> = {
  "Reborn Studio": [
    "reborn-studio-site",
    "reborn-projets-test",
    "reborn-studio",
    "reporting-reborn",
    "real-estate-react",
  ],
  "Perso Janssen": [
    "river-club-poker",
    "quiz-pillebout",
    "vacances-budget-pwa",
  ],
  Abacus: [
    "epicv-2",
    "morne-a-leau",
    "apex-performance-8",
    "crm-diaspora",
    "partisans-crm",
    "abacus-consulting-site",
    "evaluation-joueurs",
    "epic-love-stories",
    "bisdary-poc-2",
    "epic-meeting-services",
    "sportive-ai-web",
    "bisdary-poc",
    "complem-ai",
  ],
  "Les Cabine": ["lescabines-api"],
  Eurochannel: ["eurochannel-site"],
  Vivalians: ["tokoia"],
  "JV Conseil": [
    "la-toile-de-valery-v2",
    "jim-life-style",
    "la-toile-de-valery",
  ],
  NES: ["3dquote"],
};
export function vercelExcluded(teamId: string, name: string) {
  return (
    teamId === VERCEL_SOURCE_TEAM &&
    ["released-scan-demo", "mtt-lab"].includes(name)
  );
}
export function vercelSuggestedClient(
  teamId: string,
  name: string,
  domains: string[],
) {
  if (teamId !== VERCEL_SOURCE_TEAM || vercelExcluded(teamId, name))
    return null;
  if (domains.includes("budget-quotidien-pwa.vercel.app"))
    return "Perso Janssen";
  return (
    Object.entries(VERCEL_CLIENT_PROJECTS).find(([, projects]) =>
      projects.includes(name),
    )?.[0] || null
  );
}
