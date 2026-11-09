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
  "updates.assessment_started": "Bilan automatique demandé",
  "updates.assessed": "Résultat du bilan automatique",
  "updates.assessment_failed": "Bilan automatique en échec",
  "updates.started": "Mise à jour demandée",
  "updates.completed": "Mise à jour terminée",
  "updates.failed": "Mise à jour arrêtée",
  "updates.closed": "Mise à jour clôturée",
  "updates.source_configured": "Accès de mise à jour configuré",
};

export function activityTitle(action: string) {
  return Object.hasOwn(activityTitles, action) ? activityTitles[action] : undefined;
}
