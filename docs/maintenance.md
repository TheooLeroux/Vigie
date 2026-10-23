# Mises à jour depuis Vigie

## Parcours utilisateur

La fiche projet affiche ses services et un bouton **Mettre à jour** par service.
Le clic choisit la dernière Node LTS supportée et les dernières dépendances
stables publiques, puis lance la mise à jour. Aucun plan, sélection de versions,
approbation ou fusion de PR n'est demandé à l'utilisateur.

L'état passe de **Mise à jour en cours** à **Déploiement en cours**, puis
**Mise à jour déployée** uniquement lorsque le commit est observé dans le
déploiement actif de l'hébergeur. Ce dernier état n'est pas une certification
des parcours métier. Un lien de diagnostic est disponible en cas de besoin.

## Exécution

1. Vérification des accès dédiés, de la source de production et du dépôt autorisé.
2. Fermeture de l'ancienne préparation PR si elle est terminée et non fusionnée.
   Une exécution encore active est arrêtée avant de libérer son verrou. Les
   données historiques sont conservées, mais l'ancien parcours n'est plus exposé.
3. Résolution npm/pnpm sans scripts applicatifs dans le workflow de confiance.
4. Création d'un commit candidat sur une branche technique, sans PR.
5. Lecture de ce commit dans un dossier temporaire. Installation des dépendances
   sans scripts, puis exécution de `build` dans un conteneur Docker distinct,
   sans réseau pour le build, sans secrets de Vigie, sans socket Docker, avec
   mémoire et processus limités. Un script `build` est obligatoire.
6. Après succès, publication du commit sur la branche source avec `force: false`.
   La tête de branche doit être restée identique depuis le début. Les protections
   GitHub ne sont jamais contournées. Une branche protégée peut refuser cette
   publication : il faut alors qualifier une intégration adaptée, pas forcer.
7. Le lien Git de Vercel/Railway déclenche la reconstruction réelle avec sa propre
   configuration. Le suivi resynchronise le fournisseur pour observer le commit.

Le résultat ne dépend pas des permissions GitHub Checks/Commit statuses ni du
drapeau de fusion de l'ancien module. Le workflow doit être publié sur la branche
par défaut du dépôt de confiance avant de publier l'interface qui l'appelle.
La tâche continue dans GitHub Actions lorsque l'utilisateur ferme Vigie ; la
relecture du suivi reprend à son retour.

## Configuration et limites

Les accès existants sont réutilisés : `VIGIE_MAINTENANCE_GITHUB_TOKENS` (ou jeton
dédié unique), `VIGIE_MAINTENANCE_REPOSITORIES`,
`VIGIE_MAINTENANCE_RUNNER_REPOSITORY`, `VIGIE_MAINTENANCE_RUNNER_REF`, et les secrets
de l'environnement GitHub `vigie-maintenance`. Aucun jeton n'est envoyé au client.
Un jeton supplémentaire peut être stocké séparément sous
`VIGIE_MAINTENANCE_GITHUB_TOKEN_<PROPRIETAIRE>` (majuscules, tirets remplacés par
des underscores), par exemple `VIGIE_MAINTENANCE_GITHUB_TOKEN_JANSSEN76140`.
Il est transmis explicitement au préparateur dans le workflow. Cela permet de
conserver le dictionnaire sensible existant sans devoir le relire ou l'écraser.
Une entrée de dictionnaire spécifique à un dépôt reste prioritaire, puis viennent
le jeton séparé du propriétaire, l'entrée propriétaire du dictionnaire et le
jeton unique historique.
Les tables existantes et l'historique sont conservés, sans nouvelle migration.

Ce parcours concerne les projets Node GitHub npm/pnpm compatibles Vercel/Railpack.
Les Dockerfiles Railway restent refusés tant que le changement de leur runtime
n'est pas qualifié. Aucune variable Railway n'est changée ; un override Node peut
prendre priorité sur le manifeste. WordPress, PHP, images externes et bases de
données ne sont pas exécutables par ce module. L'interface n'affiche pas de faux
succès pour ces cas. Un build sans secrets ni réseau peut échouer pour un projet
qui exige des téléchargements, des scripts d'installation ou un environnement
spécifique ; aucune publication n'est alors demandée.

Il n'y a pas de restauration automatique des données ni de retour arrière
automatique après un déploiement défectueux. Le commit source antérieur est
conservé. Les anciennes fonctions PR restent internes pour lire/fermer les
opérations historiques, pas comme parcours utilisateur ni routes de création.
