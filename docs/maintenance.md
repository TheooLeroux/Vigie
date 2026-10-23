# Mises à jour applicatives depuis Vigie

## Périmètre implémenté

Chaque fiche projet comporte une section **Mises à jour** et un bouton **Mettre à jour**. Ce bouton ouvre les options dans la fiche, limitées aux services et à l'historique du projet ; il ne modifie pas la production. Une cible unique est présélectionnée, plusieurs services restent au choix de l'opérateur. La vue générale **Mises à jour** conserve le suivi transversal du parc.

Ce parcours permet de choisir une application Vercel ou un service Railway rattaché à une fiche active, d'analyser sa source GitHub puis de préparer :

- Une évolution Node vers une version LTS encore supportée du catalogue officiel. Vercel conserve une branche majeure (`22.x` / `24.x`, liste fournisseur révisable dans le code) ; Railway reçoit une version exacte dans le manifeste pour provoquer une nouvelle construction reproductible. Les métadonnées Volta/devEngines et les fichiers `.nvmrc` / `.node-version` du dossier sont alignés lorsqu'ils existent.
- Des mises à jour ciblées de dépendances directes de production, développement ou optionnelles : frameworks, React, outils de build, clients de base, etc. Les versions stables publiques choisies sont exactes, le manifeste et le lockfile sont régénérés ensemble. Jusqu'à douze composants peuvent être regroupés.
- Une PR de retour code pour une mise à jour Vigie fusionnée par squash. Elle rétablit les fichiers antérieurs seulement si ces fichiers n'ont pas changé depuis la fusion. Elle ne restaure aucune base, aucun volume et aucun secret ; son approbation reste distincte.

Les dépendances transitives peuvent évoluer lors de la résolution du lockfile mais ne sont pas choisies individuellement dans l'écran. Le diff entier et les prérequis des versions cibles doivent être relus. La dernière version stable du registre n'est pas une garantie de compatibilité ou d'absence de vulnérabilités.

La préparation gère npm (`package-lock.json` v2/v3) et pnpm avec version exacte de `packageManager`. Les workspaces peuvent être traités à partir de leurs manifestes et d'une configuration pnpm limitée à des propriétés reconnues. Les lockfiles ambigus, chemins partagés Node, registres privés, dépendances Git/fichiers/alias et configurations de hooks non qualifiées sont refusés plutôt que devinés. Une version pnpm déclarée doit pouvoir s'exécuter avec le Node 24 du préparateur.

Yarn/Bun, images Docker externes, PHP, WordPress/plugins/thèmes, Dolibarr et moteurs de bases ne sont **pas mis à jour par cet exécuteur**. Ils restent soumis aux prérequis de la [matrice du parc](matrice-capacites-maintenance.md). L'existence d'un jeton hébergeur ne déverrouille pas ces écritures. Aucun changement de variable Railway, de version Node dans les paramètres Vercel ou de configuration de sécurité n'est effectué par ce parcours.

## Architecture et garanties

1. Vigie prend la source du **déploiement de production observé**, pas d'un dépôt configuré différent. Une source manquante, une image externe, une connexion en erreur, un projet disparu/archivé ou un dépôt non autorisé bloque l'analyse.
2. L'analyse lit la tête actuelle de la branche déployée et affiche son commit. Si elle a avancé depuis le relevé de production, cela apparaît dans le plan. Les minima de compatibilité des versions cibles et la portée des autres changements en attente doivent être contrôlés.
3. Le plan expire après trente minutes. Son approbation relit la branche et prend un verrou PostgreSQL **par dépôt entier**, y compris lorsque plusieurs services du parc partagent ce dépôt. Les révisions des enregistrements empêchent les réponses concurrentes d'écraser silencieusement un état plus récent.
4. Un `workflow_dispatch` démarre le préparateur dans un dépôt de confiance. Aucune boucle longue ni commande de gestionnaire de paquets ne s'exécute dans une fonction Vercel. Le code du préparateur provient uniquement de la branche par défaut du dépôt de confiance, jamais du dépôt cible.
5. Le préparateur ne récupère que les manifestes, lockfiles et fichiers de versions nécessaires, pas le code exécutable de l'application cible. Il refuse les symlinks et chemins sortant du périmètre. npm/pnpm sont lancés sans scripts, sans `.npmrc` cible, sans hooks pnpm et sans les secrets de Vigie dans leur environnement. Les sorties brutes du gestionnaire ne sont pas relayées dans les journaux.
6. Les changements sont publiés sur `vigie/maintenance/<identifiant>` et dans une PR. Aucun push sur `main`, aucune fusion et aucun redémarrage de service ne sont réalisés par le préparateur. Les workflows de push/PR et previews déjà configurés sur le dépôt cible peuvent toutefois démarrer ; ils doivent être sûrs pour leurs propres secrets et données et ne pas publier cette branche de maintenance en production.
7. Le suivi relit la PR, son SHA, les fichiers réellement modifiés et son historique. Une PR modifiée en dehors du plan bloque la publication depuis Vigie. Une absence de CI, des résultats incomplets/échoués/ignorés ou un contrôle requis absent bloquent aussi la fusion.
8. La publication exige une confirmation de revue de la PR/preview et de la stratégie de retour. C'est une attestation de l'opérateur, pas une preuve automatique de tests métier ou de sauvegarde. GitHub reçoit le SHA exact avec `bypass_rules: false` via son API de fusion asynchrone, en respectant sa file de fusion si elle existe. Un état en file n'est jamais présenté comme une fusion réussie.
9. Une fusion confirmée reste distincte d'un déploiement observé. Après synchronisation de l'hébergeur depuis **Connexions**, actualiser le suivi. Seule une égalité exacte entre le commit de fusion et celui du déploiement relevé confirme l'observation du commit ; la santé métier et le correctif Node réellement exécuté ne sont pas certifiés par cette égalité.

Références : [arbre Git et commits](https://docs.github.com/en/rest/git/trees), [workflow dispatch](https://docs.github.com/en/rest/actions/workflows), [fusion asynchrone sans contournement](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously), [résolution npm](https://docs.npmjs.com/cli/v11/commands/npm-install/), [résolution pnpm](https://pnpm.io/cli/install).

## Activation, à effectuer avant usage réel

Le code seul n'active pas les droits GitHub. Aucune connexion d'écriture, PR distante ni mise à jour du parc n'est créée pendant son installation. L'intégration Vercel installée sur GitHub ne fournit pas de jeton utilisable par Vigie.

### 1. Migration et déploiement Vigie

- Exécuter `npm run db:migrate` avec la base cible pour appliquer `003-maintenance.sql`, **avant** de déployer le code. La migration ajoute les tables de plans/verrous et une contrainte de périmètre ; elle ne déclenche pas de maintenance.
- Publier le code et les workflows sur la branche par défaut d'un dépôt de confiance. Protéger cette branche, les fichiers du préparateur et les workflows : aucun code de PR non fiable ne doit s'y exécuter avec les identifiants de maintenance.
- Conserver un accès GitHub/hébergeur indépendant de Vigie. Ne pas mettre à jour Vigie lui-même pendant une intervention en cours.

### 2. Identifiants et périmètres GitHub

Prévoir un accès dédié limité aux dépôts sélectionnés, pas un jeton global administrateur. Les droits nécessaires dépendent du rôle :

| Cible                        | Droits nécessaires                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dépôts applicatifs autorisés | Métadonnées/contents lecture-écriture pour branches et commits ; pull requests lecture-écriture ; checks et commit statuses lecture pour publication |
| Dépôt du préparateur         | Actions lecture-écriture pour lancer, suivre et arrêter son workflow ; lecture des métadonnées du workflow                                           |

Ne pas donner à ces identifiants de contournement des règles de branche. Configurer sur les dépôts cibles les contrôles obligatoires, la revue et, si nécessaire, une file de fusion. Vigie n'ajoute ni ne modifie ces permissions/protections automatiquement. Les registres privés nécessiteront une intégration séparée sans réutiliser les secrets de production pendant la préparation.

Le pilote du 23 octobre a confirmé que l'interface GitHub ne propose pas la permission **Checks** pour le jeton personnel finement limité utilisé. La lecture des check-runs est refusée même avec Commit statuses en lecture. Ce jeton suffit à préparer une PR, pas à qualifier sa CI complète : prévoir un accès GitHub App approprié pour cette lecture, sans réutiliser un jeton CLI global. Vigie conserve le suivi de la PR et son verrou quand cette lecture est refusée ; les anciens résultats CI sont effacés et la fusion reste bloquée. Les résultats locaux consignés dans une revue ne remplacent pas des contrôles GitHub vérifiables.

Un jeton finement limité à un propriétaire ne doit pas être supposé valable pour tous les propriétaires du parc. La configuration accepte un jeton commun lorsqu'il est réellement autorisé, ou un dictionnaire de jetons distincts par propriétaire/dépôt. Une correspondance de dépôt prime sur celle de propriétaire, puis sur le jeton commun. Les secrets restent uniquement dans les environnements serveur/GitHub, jamais dans les inputs du workflow, le navigateur ou les plans.

### 3. Variables côté serveur Vigie

| Variable                              | Exemple non secret / rôle                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VIGIE_MAINTENANCE_GITHUB_TOKEN`      | Jeton dédié commun, si approprié au périmètre ; facultatif lorsqu'un dictionnaire suffit                                                               |
| `VIGIE_MAINTENANCE_GITHUB_TOKENS`     | JSON privé propriétaire/dépôt → jeton, pour les parcs multi-comptes ; ne pas le committer                                                              |
| `VIGIE_MAINTENANCE_REPOSITORIES`      | `TheooLeroux/Vigie,TheooLeroux/NesAppli` ; liste explicite, pas une autorisation à tous les dépôts d'un compte                                         |
| `VIGIE_MAINTENANCE_RUNNER_REPOSITORY` | Dépôt de confiance contenant le worker, par exemple `TheooLeroux/Vigie`                                                                                |
| `VIGIE_MAINTENANCE_RUNNER_REF`        | Sa branche **par défaut**, par exemple `main` ; une autre branche est refusée par le workflow                                                          |
| `VIGIE_MAINTENANCE_ALLOW_MERGE`       | `false` au départ : PR seulement ; `true` après qualification du pilote                                                                                |
| `VIGIE_MAINTENANCE_REQUIRED_CHECKS`   | JSON des noms exacts de contrôles requis par dépôt, par exemple `{"TheooLeroux/Vigie":["verify"]}` ; absence/incohérence = fusion depuis Vigie bloquée |

Renseigner les secrets en variables sensibles dans Vercel. Aucun secret de maintenance n'est demandé dans le chat ni stocké dans un fichier versionné.

### 4. Configuration du dépôt de confiance

- Workflow attendu : `.github/workflows/vigie-maintenance.yml`, actif sur la branche par défaut.
- Créer l'environnement GitHub `vigie-maintenance` et limiter ses branches de déploiement à la seule branche par défaut (`main` pour Vigie), sans règle de tag. Le job du préparateur référence cet environnement ; une branche de PR ne doit pas pouvoir obtenir ces secrets.
- GitHub **Environment Secrets** de `vigie-maintenance` : `VIGIE_MAINTENANCE_GITHUB_TOKEN` et/ou `VIGIE_MAINTENANCE_GITHUB_TOKENS`, avec les accès d'écriture aux seuls dépôts autorisés pour le préparateur. Ne pas les enregistrer comme secrets globaux du dépôt. Le secret du worker n'a pas besoin de droits Actions si le rôle de publication de PR est séparé de celui du serveur.
- GitHub Repository Variables : `VIGIE_MAINTENANCE_REPOSITORIES`, liste explicite indépendante de celle de Vigie ; la cible doit être autorisée des deux côtés.
- Le workflow de préparation n'a par défaut que `contents: read` via son `GITHUB_TOKEN`. Il ne s'appuie pas sur une élévation implicite de ce jeton pour les autres dépôts. Checkout ne conserve pas les identifiants dans Git.
- Les actions checkout et setup-node sont épinglées par commit (versions officielles v7.0.1 et v7.1.0 vérifiées lors de l'implémentation). La CI Vigie vérifie types, tests et build sur les PR/push ; les autres dépôts doivent disposer de leurs propres contrôles pertinents.

### 5. Premier pilote

Choisir un projet rattaché non critique après revue humaine, avec accès Git, preview isolée, tests métier et procédure de retour. Si l'on choisit Vigie lui-même, il doit d'abord être ajouté au parc par le parcours existant ; il n'est pas ajouté automatiquement par ce module. Tester d'abord création/fermeture de PR avec `ALLOW_MERGE=false`, puis qualifier la fusion et le déploiement. Une analyse ou un test simulé ne remplace pas ce pilote réel.

## Procédure opérateur

### Profil de production initial — 23 octobre 2026

- Le dépôt préparateur est `TheooLeroux/Vigie`, branche `main`. Son secret est isolé dans l'environnement GitHub `vigie-maintenance`, réservé à cette seule branche.
- La liste initiale autorise uniquement `TheooLeroux/NesAppli`, avec un identifiant dédié au compte TheooLeroux. Les dépôts de Janssen76140 ne sont pas activés : un accès dédié de ce propriétaire reste nécessaire.
- Le serveur Vercel utilise des variables de production uniquement ; le dictionnaire d'identifiants est sensible. Aucun jeton de session GitHub CLI n'est réutilisé comme accès applicatif permanent.
- `VIGIE_MAINTENANCE_ALLOW_MERGE=false` et la liste des contrôles requis est vide : analyse, préparation et PR seulement. La fusion reste bloquée jusqu'à qualification d'un pilote et configuration des contrôles exacts du dépôt cible.
- La migration `003-maintenance.sql` a été appliquée à Neon après création d'un instantané préalable. Aucune maintenance du parc ni PR cible n'a été lancée pendant cette activation. Le pilote réel reste à effectuer séparément.

1. Ouvrir la fiche du projet, puis **Mises à jour → Mettre à jour**, choisir son application/service et **Analyser la source GitHub**. La vue générale reste disponible pour le suivi de tous les projets.
2. Vérifier dépôt, branche, commit de production, tête de branche et répertoire. Lire les avertissements de portée et de configuration.
3. Sélectionner Node, ou ajouter les versions stables des composants liés dans un même plan. Relire les migrations et exigences des versions cibles ; les groupes framework/React doivent rester cohérents.
4. **Préparer le plan**, relire les fichiers et approuver sa création de PR. L'approbation peut lancer des workflows de push/PR du dépôt cible, dont des previews ; qualifier ces déclencheurs avant le pilote.
5. **Actualiser le suivi**, ouvrir la PR et les éventuelles erreurs du préparateur. Ses tests ne sont pas les tests de l'application : il ne les exécute pas.
6. Vérifier CI, prévisualisation, parcours métier, compatibilité des données, retour et secrets valides. Les contraintes d'un incident fournisseur peuvent imposer de reporter la maintenance ordinaire.
7. Si la publication est activée et tous les contrôles requis réussissent, confirmer **Fusionner et déclencher le déploiement**. Le déploiement n'est automatique que si cette branche est effectivement reliée à l'hébergeur ; Vigie ne crée pas cette liaison.
8. Suivre la fusion, puis le déploiement. Synchroniser l'hébergeur et actualiser le suivi ; contrôler l'application et, pour Node, la version réellement utilisée après construction.

Pour Railway, `RAILPACK_NODE_VERSION` ou d'autres priorités peuvent empêcher le changement déclaré de devenir le runtime effectif. Le module n'inspecte ni ne remplace les variables du service ; cette configuration doit être qualifiée avant publication. Pour Vercel, le fournisseur pilote les mineures/correctifs de sa branche Node : le module ne promet pas un correctif exact.

## Arrêt, incidents et retour code

- **Plan non envoyé** : fermeture locale, sans écriture distante.
- **Préparation en cours** : demande d'arrêt du run, puis nouvelle actualisation ; le verrou reste tant que la fin n'est pas confirmée. Une branche ou une PR créée juste avant l'arrêt peut subsister.
- **PR ouverte** : fermeture après fin du préparateur, sans suppression de branche. Une fermeture n'annule aucune action d'un workflow déjà démarré.
- **Fusion engagée** : le bouton de fermeture est bloqué ; vérifier d'abord l'état réel de GitHub. Les résultats des demandes asynchrones ne sont conservés que temporairement par GitHub ; en cas d'état indéterminé, utiliser l'administration indépendante.
- **Erreur de préparation** : le verrou est conservé jusqu'à fermeture explicite après vérification. Une erreur d'envoi réseau n'est jamais considérée comme une preuve d'absence d'exécution. Ne pas supprimer un verrou pour « réessayer » sans vérifier runs, branche et PR distants.
- **Fusion réalisée** : préparer une nouvelle PR de retour code, tester et confirmer séparément. Les fusions non squash ou les fichiers modifiés après la mise à jour bloquent ce retour automatique.
- **Données ou effets externes** : restauration/migration inverse/compensation à traiter séparément. Ne pas réintroduire un ancien secret révoqué ou une version vulnérable pour rétablir le service.

Les verrous sont limités au dépôt. Ils ne représentent pas un verrou sur une base ou un service externe partagé entre plusieurs dépôts : ces ressources doivent être coordonnées manuellement avant publication. Ils ne bloquent pas non plus les actions effectuées directement par un administrateur GitHub.

## Vérifications effectuées et limites

Les tests de `tests/maintenance.test.ts` utilisent une base en mémoire, des API simulées et des commandes de résolution simulées. Ils vérifient les gardes, le périmètre, les contrats, les fichiers et lockfiles, l'absence de secret dans l'environnement enfant, les verrous/révisions, les conflits et les refus de publication/retour. Ils ne lancent ni update du parc, ni commande dans Railway, ni installation WordPress, ni PR réelle. La résolution complète sur GitHub Actions et le pilote réel resteront à valider après configuration des accès et déploiement du workflow.

Une vérification locale complémentaire a également exécuté les vrais gestionnaires npm et pnpm 10.10.0 sur des manifestes temporaires isolés, avec une dépendance publique de test. Les lockfiles ont été régénérés et le script `postinstall` témoin n'a pas été exécuté. Les lectures GitHub étaient simulées et aucune écriture de production n'a eu lieu ; cela ne valide pas encore tous les monorepos ni l'intégration réelle GitHub Actions.
