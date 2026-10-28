# Vigie

Plateau interne pour les clients, leurs sites et leurs hébergements. Le parc initial contient les 9 WordPress et les 4 applications Railway du fichier fourni ; les projets Vercel sont ajoutés depuis les connexions.

## Démarrage local

Node.js 24.14 ou plus récent dans la branche 24.

```powershell
npm ci
npm run dev -- --port 3001
```

Ouvrir http://127.0.0.1:3001. Le serveur écoute uniquement sur l’interface locale.

## Connexion Google

Le plateau et ses API exigent une session Google autorisée. Les deux adresses sont définies dans `.env.local`. L’accès n’est pas ouvert à tout le domaine.

Les nouvelles sessions et leurs cookies durent sept jours. Le seuil de renouvellement reste de trente minutes. Les sessions déjà émises conservent leur ancienne échéance jusqu'à leur renouvellement ou une nouvelle connexion ; un déploiement ne les révoque pas.

Le client OAuth **Vigie — local** est créé dans le projet Google Cloud `vigie-512409`, avec une audience interne à Reborn France. Les identifiants Google et le secret de session sont enregistrés dans le fichier privé `.env.local`. La connexion réelle avec le compte professionnel a été validée le 22 octobre 2026, avec ouverture du parc de 9 sites. L’inventaire et les exports restent refusés sans session. Si la configuration est retirée, les données restent protégées.

Les étapes et URL exactes sont dans [docs/connexion-google.md](docs/connexion-google.md).

## Plateau

- Fiches clients avec contact, email, téléphone, site et notes.
- Un client peut posséder plusieurs sites. Rattachement et changement de client depuis la fiche projet ou la fiche client.
- Liste, recherche et filtres des sites, dont un filtre par client et « À rattacher ».
- Fiches projets, environnements et services.
- Ajout en deux parcours : lier un site déjà détecté chez un hébergeur, ou créer une fiche de zéro. Le second parcours crée une fiche Vigie, sans provisionner de service distant.
- Connexions regroupées par hébergeur, avec sélection o2switch, Vercel ou Railway.
- Fiche projet en une colonne : mises à jour en un clic, suivi technique, puis hébergement, services et historique dans des sections repliables.
- Liste unique des projets et journal attribué au membre connecté.
- Activité avec recherche, filtres par projet/type/date et pagination des 100 dernières actions chargées.
- Backup affiche « Coming soon ».

L’aide, l’indicateur « Local », les paramètres, le répertoire d’accès, les ressources et les imports ne sont plus proposés dans l’interface. Les anciennes données restent conservées. Les outils d’administration et leurs API restent disponibles pour les usages documentés ci-dessous ; les exports CSV/JSON ne constituent pas une sauvegarde complète.

## Contrôle automatique des hébergements

Le [contrôle des hébergements](docs/controle-hebergements.md) vérifie périodiquement o2switch, Vercel et Railway. Après une remise en ligne, le connecteur WordPress manquant est recréé avec sa clé existante ; l’agent et le chargement réel de WordPress sont vérifiés avant de rendre la maintenance disponible. Vercel et Railway sont relus par leurs API. Le workflow demande un passage toutes les cinq minutes, avec reprise des erreurs et conservation des dernières observations.

## Connexions o2switch

Le menu **Connexions** contient les deux comptes du fichier source. Chaque compte accepte un jeton API cPanel (méthode privilégiée) ou un mot de passe cPanel. Le bouton **Synchroniser les sites** lit les domaines et leurs répertoires, reconnaît WordPress, Dolibarr, les sites HTML et les exports Next.js. Il relève les versions WordPress et Dolibarr dans leurs fichiers de version. Les comptes utilisent les deux jetons dédiés autorisés séparément par l’utilisateur ; ils expirent le 20 janvier 2027 à midi (Paris).

Une correspondance unique de domaine (y compris les URL des environnements/services) ou de répertoire documenté sur le même compte rattache l’installation à sa fiche existante. Une ambiguïté ou une fiche archivée demande un choix manuel. Les nouveaux sites sont proposés avec **Ajouter au parc** ; aucun projet n’est créé sans ce clic. Le rattachement et la création sont conservés lors des synchronisations suivantes, sans doublon. Les clients existants ne changent pas et aucun client n’est inventé. Une fiche peut recevoir plusieurs installations, par exemple production et préproduction.

La recherche du 22 octobre 2026 a inspecté 47 racines : 9 WordPress rattachés aux fiches existantes, 9 installations supplémentaires proposées à l’ajout, 1 WordPress incomplet à vérifier et 28 répertoires vides ou techniques dans une section repliée. Le parc conserve ses 13 projets. La fiche projet affiche le compte, les domaines, le répertoire et la version observée avec sa date. Les éléments ignorés peuvent être réaffichés ; les installations disparues restent signalées sans supprimer leurs fiches.

La découverte utilise uniquement les lectures HTTPS sur le port 2083 : `DomainInfo/domains_data`, `Fileman/list_files`, et `Fileman/get_file_content` limité aux versions et en-têtes des extensions/thèmes. Le test d’accès simple conserve `DomainInfo/list_domains`. Aucun fichier de configuration sensible n’est lu. Les observations sont regroupées par compte et répertoire ; changer l’adresse ou l’identifiant d’un compte isole son ancien inventaire. Les réponses sont limitées en taille et en durée, sans suivi des redirections.

Depuis l'accord de l'utilisateur le 22 octobre, le rattachement d'un WordPress installe automatiquement le connecteur d'inventaire `wp-content/mu-plugins/vigie-observer.php`, via un dépôt cPanel ciblé (création éventuelle du dossier avec API2 `Fileman/mkdir`, puis UAPI `Fileman/upload_files`). Les neuf sites existants sont concernés. Aucun fichier inconnu n'est écrasé. Une erreur conserve le rattachement et les observations précédentes, avec un message sur la fiche ; une prochaine synchronisation réessaie les installations incomplètes. Le code, la portée et la protection HMAC sont dans [docs/connecteur-wordpress.md](docs/connecteur-wordpress.md).

Les fiches affichent WordPress et PHP web, extensions/thèmes installés et actifs, versions disponibles et dates de vérification, mises à jour automatiques, version de la base, limites/extensions PHP, langue/fuseau, indexation, caches et indicateurs debug/cron. Les mises à jour payantes dépendent des flux et licences du site ; une absence de preuve reste « Non vérifiable ». Les relevés de plus de 24 heures sont signalés. Sans connecteur, les fichiers donnent un inventaire et une comparaison prudente avec WordPress.org, sans prétendre connaître l'activité ni PHP. Le dernier correctif PHP de la même branche et le support standard sont consultés sur PHP.net ; cela ne prouve pas l'absence ou la présence de correctifs rétroportés par l'hébergeur.

Les secrets sont chiffrés en AES-256-GCM avec une clé indépendante `VIGIE_CONNECTOR_ENCRYPTION_KEY` (32 octets en hexadécimal), définie dans le `.env.local` privé. Ils ne sont renvoyés ni au navigateur ni dans les exports/journaux. Conserver cette clé séparément des sauvegardes SQLite ; sans elle, il faut saisir de nouveaux jetons. Ne pas la régénérer à chaque démarrage. Le bouton de déconnexion retire le secret local, mais ne révoque pas le jeton chez o2switch.

La recherche affiche la date du relevé et les erreurs. Un échec garde le dernier relevé réussi avec sa date ; une lecture de répertoire en échec conserve la précédente version observée. L’enregistrement d’un nouveau secret lance une recherche ; les recherches suivantes sont manuelles ou effectuées par le contrôle automatique des hébergements. « Synchroniser les sites » recherche, rattache, installe les connecteurs manquants puis collecte les informations. « Actualiser » dans une fiche ne relève que ce site. Le connecteur d’inventaire reste en lecture seule ; le parcours de mise à jour utilise un accès SSH distinct, une sauvegarde préalable et WP-CLI. Aucune mise à jour périodique n’est lancée automatiquement.

La procédure de création du jeton est documentée par [o2switch](https://faq.o2switch.fr/cpanel/securite/token-api-cpanel/) ; le jeton possède les droits du compte cPanel. Vigie l'utilise pour les lectures et le dépôt contrôlé de son propre connecteur.

Les sites du fichier ne précisent pas leurs propriétaires clients : ils restent à rattacher à leurs clients. Le champ client des imports CSV/JSON crée ou réutilise une fiche par nom. Les renommages conservent les associations. Les versions détectées restent des observations datées des fichiers, distinctes des versions saisies dans les services ; les liens Railway, Git et bases fournis sont des références, sans collecte distante.

Le script d’administration `npx tsx --env-file=.env.local scripts/discover-o2switch.ts` lance la même recherche et le même rapprochement que l’interface sur les comptes configurés. Il ne crée pas les projets proposés. Une sauvegarde SQLite cohérente a été créée dans `.data/backups/` avant le premier rattachement réel.

`npx tsx --env-file=.env.local scripts/collect-o2switch.ts` collecte les inventaires et répare automatiquement le connecteur d’inventaire des WordPress rattachés actifs si nécessaire, sans installer l’agent de maintenance. Son option d'administration `--install-observers-confirmed` installe/vérifie les connecteurs sur les WordPress rattachés ; elle n'est à utiliser qu'avec une autorisation explicite. Une sauvegarde cohérente a été créée avant le premier dépôt. Les scripts n'affichent aucune clé.

## Relire le fichier source

L’import spécialisé ne conserve que les champs documentés WordPress/o2switch et Railway. Il ignore les lignes libres d’identifiants et la section Vercel. Il retrouve les sites existants par URL et évite les doublons de ressources et d’accès.

```powershell
npx tsx scripts/import-site-list.ts C:\Users\theol\Desktop\site.txt
# Après vérification de l’aperçu :
npx tsx scripts/import-site-list.ts C:\Users\theol\Desktop\site.txt --apply
```

Ce script est une opération locale d’administration. Avant de l’appliquer, conserver une sauvegarde cohérente SQLite. Une sauvegarde privée a été créée dans `.data/backups/` avant l’import du 22 octobre.

## Mises à jour en un clic

La [matrice des capacités de maintenance](docs/matrice-capacites-maintenance.md) distingue, pour les configurations du parc, la détection actuelle, les mises à jour envisageables, les conditions de retour arrière et les blocages par projet. C'est un état de référence daté, pas un moteur de mise à jour activé ni une autorisation d'intervenir. Les sauvegardes et restaurations du parc restent à qualifier avant toute automatisation des écritures.

Le nouveau parcours est intégré à chaque fiche projet : **Tout mettre à jour**, progression et résultat, sans écran PR ni choix de versions obligatoire. Il vise Node LTS et les dépendances stables des applications Vercel/Railway, ainsi que WordPress, ses extensions et ses thèmes sur o2switch. Les mises à jour majeures sont incluses lorsque la validation réussit. Voir [le périmètre, l’activation et les limites](docs/mises-a-jour.md).

La migration `004-updates.sql` ajoute le suivi durable, les verrous d’exécution et les sources chiffrées. Le module est désactivé par défaut : appliquer la migration, configurer l’exécuteur et réaliser un pilote avant l’activation. L’ancienne migration `003-maintenance.sql` et ses traces sont conservées sans réutiliser les anciens jobs ni leurs verrous. Les jetons dédiés existants peuvent être réutilisés par compatibilité, sans rotation ni élargissement automatique de leurs droits.

## Vérifications

Vercel est disponible dans **Connexions**, avec découverte de tous les projets, filtre par client et ajout au parc sur choix explicite. L’ajout crée la fiche et son association client en un clic ; la découverte seule ne crée rien. Les deux projets « À virer » restent exclus et ne sont pas modifiés. Voir [le fonctionnement et les limites du connecteur Vercel](docs/connecteur-vercel.md).

Railway est disponible dans **Connexions**, avec découverte du workspace, rattachement aux fiches et relevés des services et déploiements. Le dépôt, la branche et le commit déployés sont identifiés lorsque disponibles. Les versions résolues par Railpack distinguent la construction de l’exécution ; Node et Caddy sont comparés aux publications officielles, avec fin de support Node signalée. Docker et les constructions sans métadonnées restent explicitement inconnus. Le connecteur travaille en lecture seule et conserve le dernier relevé lors d’une panne. Voir [les données collectées et les limites](docs/connecteur-railway.md). Les dépendances applicatives ne sont pas encore collectées.

```powershell
npm run typecheck
npm test
npm run build
```

Les tests utilisent des bases en mémoire et des réponses cPanel simulées dans les tests uniquement. Ils ne contactent ni Google ni les hébergements et ne modifient pas le parc réel. Ils vérifient l’authentification, les imports, les clients, les modifications partielles, le chiffrement des secrets, les réponses et refus API, l’absence de suivi des redirections, les limites de taille et les vérifications concurrentes.

Le test d'intégration du connecteur exécute le vrai fichier PHP contre des API WordPress isolées, sur un serveur éphémère local. Il vérifie les signatures et les requêtes ordinaires, les réponses complètes et le mode précoce. Définir `VIGIE_TEST_PHP_BIN` si PHP n'est pas dans `.data/tools/php81/php.exe` ; sans exécutable, seul ce test PHP est ignoré. `node scripts/prepare-php-test.mjs` télécharge une archive officielle PHP 8.1 et contrôle son SHA-256 ; l'extraire ensuite dans `.data/tools/php81/`. Aucune installation système n'est effectuée.

## Stockage

Le déploiement HTTPS est décrit dans [la procédure Vercel](docs/deploiement-vercel.md).

Les données, sessions Google, inventaires et secrets chiffrés sont désormais dans PostgreSQL sur Neon. `DATABASE_URL` contient l’URL poolée avec TLS, uniquement côté serveur. Elle est obligatoire en production. Le projet Neon `vigie` est hébergé à Francfort ; la configuration locale privée utilise sa base `vigie`, branche `production`. `.data/` et les fichiers `.env*` privés sont exclus de Git. L’accès aux données est centralisé dans `src/lib/db.ts` et `src/lib/storage.ts`, l’authentification dans `src/lib/auth.ts` et la liste d’accès dans `src/lib/auth-policy.ts`.

Avant de démarrer une nouvelle installation PostgreSQL, renseigner `DATABASE_URL` et exécuter `npm run db:migrate`. Les migrations SQL versionnées sont atomiques et sérialisées par un verrou PostgreSQL. Les changements futurs du schéma Better Auth doivent également faire l’objet d’une migration avant déploiement.

Pour transférer une ancienne installation : arrêter Vigie, conserver les valeurs d’origine de `BETTER_AUTH_SECRET` et `VIGIE_CONNECTOR_ENCRYPTION_KEY`, renseigner `DATABASE_URL`, puis exécuter `npm run db:import-sqlite -- --apply`. Le script crée une sauvegarde SQLite cohérente, vérifie son intégrité, refuse toute cible déjà remplie, copie les 27 tables dans une transaction et compare chaque ligne avant validation. Les dates des sessions sont converties en horodatages PostgreSQL. Une erreur annule tout le transfert de données. Ne pas relancer l’import après la bascule : il ne fusionne pas deux bases.

Le transfert initial du 22 octobre 2026 a conservé les 50 fiches projets (tous espaces confondus), les 16 clients, les connexions, les observateurs et les sessions. La sauvegarde antérieure à la bascule reste dans `.data/backups/avant-neon-1792680319314.sqlite`. Le fichier SQLite d’origine reste intact mais n’est plus alimenté dès que `DATABASE_URL` est défini.

Pour vérifier Neon sans modifier durablement le parc : définir `VIGIE_POSTGRES_TEST=1` puis lancer `npx tsx --env-file=.env.local --test tests/postgres.test.ts`. Ce test lit les données et les secrets en mémoire, vérifie Better Auth, les contraintes de périmètre, les transactions concurrentes et les annulations. Les autres tests restent isolés dans SQLite en mémoire. SQLite reste disponible pour le développement sans `DATABASE_URL` et pour ces tests.

Avant mise en ligne, configurer les mêmes secrets et `DATABASE_URL` dans l’hébergeur, exécuter les migrations, puis adapter `BETTER_AUTH_URL` et l’URI de retour du client OAuth Google au domaine final. Conserver les clés séparément des sauvegardes : une restauration des seules données ne permet pas de déchiffrer les secrets. Utiliser les sauvegardes PostgreSQL ou les fonctions de restauration Neon pour les données postérieures à la bascule. Les notes ne doivent contenir aucun secret.
