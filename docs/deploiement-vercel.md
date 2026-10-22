# Déploiement V1 — Vercel

Projet : `vigie`, dans l’équipe Vercel déjà utilisée pour le parc. URL de production : `https://vigie-azure.vercel.app`.

## Configuration

- Next.js, Node.js 24.x, construction avec `npm run build`.
- Fonctions à Francfort (`fra1`), près de la base Neon.
- `DATABASE_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `VIGIE_ALLOWED_GOOGLE_EMAILS` et `VIGIE_CONNECTOR_ENCRYPTION_KEY` sont définis dans l’environnement de production du projet Vercel. Les clés et secrets sont marqués sensibles.
- `BETTER_AUTH_URL=https://vigie-azure.vercel.app`. L’hôte HTTPS exact est vérifié dans le proxy et les API. Une URL de prévisualisation n’est pas implicitement autorisée.
- La liste fermée des comptes Google, les sessions serveur et les protections CSRF restent actives.
- Le fichier PHP de l’observateur est inclus explicitement dans les fonctions ; les fichiers `.data/` et `.env.local` restent privés sur le poste.
- Les API de synchronisation disposent d’une durée maximale de 300 secondes. Les verrous en mémoire des connecteurs restent propres à chaque instance Vercel : éviter de lancer simultanément la même synchronisation depuis plusieurs sessions.

## Google OAuth

Dans le client Google Cloud existant du projet `vigie-512409`, conserver les URL locales et ajouter :

- Origine JavaScript : `https://vigie-azure.vercel.app`.
- URI de retour : `https://vigie-azure.vercel.app/api/auth/callback/google`.

Conserver les secrets d’origine : les remplacer rendrait illisibles les jetons chiffrés déjà transférés dans Neon.

## Publications suivantes

Le compte Vercel ne dispose pas encore de connexion GitHub pour `TheooLeroux/Vigie`. Le premier déploiement utilise donc les fichiers du commit publié, sans envoyer de fichier privé local. Le SHA est enregistré dans les métadonnées du déploiement. Un push seul ne déclenche pas encore de déploiement.

Pour activer les déploiements automatiques, relier ce dépôt depuis les paramètres Git de Vercel après connexion du compte GitHub. Garder `main` comme branche de production. Les prévisualisations devront utiliser une base et une origine OAuth dédiées avant d’être exploitables.

Avant toute publication contenant une modification du schéma, appliquer `npm run db:migrate` sur la base cible puis déployer le commit testé. Vérifier la page de connexion, le refus des API anonymes, le retour OAuth, puis les lectures du parc et des connexions. Ne lancer une synchronisation distante que si elle est nécessaire.
