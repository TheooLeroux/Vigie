export const activityCategories = {
  "Ajouts": ["creat", "ajout", "cré", "import"],
  "Revues": ["review", "relu", "revue"],
  "Connexions & relevés": ["connect", "synch", "relev", "collect", "rattach", "invent"],
  "Modifications": [],
};
export function activityCategory(action: string) {
  return Object.entries(activityCategories).find(([, words]) => words.some(word => action.toLowerCase().includes(word)))?.[0] || "Modifications";
}
