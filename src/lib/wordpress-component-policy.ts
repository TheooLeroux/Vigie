export type WordPressUpdateOrigin = "wordpress.org" | "external" | "unknown";

// A directory name alone never establishes the identity of a private package.
export function wordPressUpdateOrigin(uri: string | null | undefined, slug: string, kind: "plugin" | "theme"): WordPressUpdateOrigin {
  if (!uri?.trim()) return "unknown";
  const value = uri.trim().replace(/\/+$/, "");
  return value === `https://wordpress.org/${kind}s/${slug}` || value === `http://wordpress.org/${kind}s/${slug}` || value === `w.org/${kind}/${slug}` ? "wordpress.org" : "external";
}

export const manualPluginAction = "Récupérer le paquet et une licence valide auprès de l’éditeur, ou faire intervenir le développeur pour reporter les personnalisations sur une copie de test avant installation.";
export const manualThemeAction = "Tester le thème parent et le thème enfant sur une copie, puis mettre à jour depuis WordPress → Apparence → Thèmes ou avec le développeur du thème.";
