import type { Activity } from "./types";

export const inventoryActivity = "hosting.inventory";
export const assessmentChangeActivity = "updates.assessment_changed";
export const automaticControlActivity = "hosting.automatic_control";
export const repeatableActivityFailures = ["hosting.inventory_failed", "hosting.agent_failed"] as const;
export const activityViews = ["focus", "complete"] as const;
export type ActivityView = (typeof activityViews)[number];
const parisDay = new Intl.DateTimeFormat("fr-CA", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function activityDay(value: string) {
  return parisDay.format(new Date(value));
}

export const activityCategories = {
  "Bilans automatiques": ["updates.assess"],
  "Mises à jour": ["updates."],
  "Ajouts": ["creat", "ajout", "cré", "import"],
  "Revues": ["review", "relu", "revue"],
  "Connexions & relevés": ["connect", "synch", "relev", "collect", "rattach", "invent"],
  "Modifications": [],
};
export function activityCategory(action: string) {
  return Object.entries(activityCategories).find(([, words]) => words.some(word => action.toLowerCase().includes(word)))?.[0] || "Modifications";
}

export const activityKinds = Object.keys(activityCategories) as (keyof typeof activityCategories)[];

const activityTitles: Record<string, string> = {
  [assessmentChangeActivity]: "Nouvelle proposition de mise à jour",
  "updates.assessment_failed": "Bilan automatique en échec",
  "updates.started": "Mise à jour demandée",
  "updates.completed": "Mise à jour terminée",
  "updates.failed": "Mise à jour arrêtée",
  "updates.closed": "Mise à jour clôturée",
  "updates.source_configured": "Accès de mise à jour configuré",
  "hosting.inventory_failed": "Collecte WordPress en échec",
  "hosting.agent_failed": "Agent WordPress en échec",
  "Vercel synchronisé": "Synchronisation Vercel terminée",
  "Railway synchronisé": "Synchronisation Railway terminée",
};

export function activityTitle(action: string) {
  return Object.hasOwn(activityTitles, action) ? activityTitles[action] : undefined;
}
export function activityOutcome({ action, detail }: Activity) {
  const code = action.toLowerCase();
  if (
    code.endsWith(".failed") ||
    code.endsWith("_failed") ||
    code.includes("échec") ||
    (code === automaticControlActivity && /, [1-9]\d* échec\(s\), /.test(detail))
  ) return "failure";
  if (code === assessmentChangeActivity) return "change";
}

function activityEntryKey(item: Activity, view: ActivityView) {
  if (view === "complete" && item.action === inventoryActivity && item.collectionId) {
    return `collection:${item.collectionId}`;
  }
  if (view === "focus") {
    if (item.action === automaticControlActivity) {
      return JSON.stringify([activityDay(item.createdAt), item.action, item.projectId, null]);
    }
    if (repeatableActivityFailures.some(action => action === item.action)) {
      return JSON.stringify([activityDay(item.createdAt), item.action, item.projectId, item.detail]);
    }
  }
  return `event:${item.id}`;
}

export function activityEntries(items: Activity[], view: ActivityView) {
  const entries = new Map<string, Activity[]>();
  for (const item of items) {
    const key = activityEntryKey(item, view);
    const entry = entries.get(key);
    if (entry) entry.push(item);
    else entries.set(key, [item]);
  }
  return [...entries].map(([key, events]) => ({ key, events, latest: events[0] }));
}
