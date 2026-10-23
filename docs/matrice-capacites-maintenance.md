# Matrice des capacités de maintenance du parc

État de référence : 22 octobre 2026, instantané préparé à 17:32 (Paris). Document de cadrage : il ne donne pas l'autorisation d'exécuter les opérations décrites.

Note de suivi : le premier module d'exécution Node et dépendances a été retiré pour repartir sur une intégration unifiée Vercel, Railway et o2switch. Cette matrice reste un instantané de cadrage daté, pas la description d'un moteur de mise à jour actif.

## 1. Périmètre et niveau de preuve

Le parc de production contient **42 fiches : 9 WordPress o2switch, 29 projets Vercel et 4 projets Railway regroupant 12 services**. Vigie lui-même est traité séparément : son projet Vercel est découvert, mais pas rattaché à une fiche du parc à cette date.

Sources utilisées : API authentifiées de production `/api/workspace`, `/api/connections`, `/api/vercel`, `/api/railway`, métadonnée PostgreSQL `server_version`, dépôt local et documentations officielles. Lecture des inventaires conservés, principalement collectés vers 17:16 ; aucune nouvelle collecte sur les sites, session créée, commande distante, mise à jour, sauvegarde ou restauration déclenchée pour cette matrice. La lecture PostgreSQL a mesuré `18.6 (fd34222)` pour la base de Vigie sur Neon.

Le relevé privé et daté est dans `.data/capabilities-inventory-2026-10-22.json`, ignoré par Git. Les numéros ci-dessous sont des observations, pas des cibles de mise à jour garanties.

### Légende

- **Détection acquise** : donnée observée, avec sa source et sa date ; pas une preuve de compatibilité ou de sécurité.
- **Détection partielle** : inventaire incomplet, métadonnée de build ou déclaration ; les inconnues restent explicites.
- **Mise à jour conditionnelle** : parcours techniquement envisageable après développement/intégration et satisfaction des prérequis ; pas une capacité déjà disponible dans Vigie.
- **Manuel / fournisseur** : pas d'exécuteur prévu dans la première étape ; procédure spécifique et opérateur requis.
- **Retour code** : ancien artefact/déploiement/configuration ; ne restaure pas les données.
- **Retour données** : restauration vérifiée d'un ensemble cohérent ; peut perdre des écritures postérieures et nécessite une décision distincte.

**Aujourd'hui, Vigie n'installe aucune mise à jour de WordPress, de plugin, de thème, de dépendance ou de runtime, et n'exécute aucun rollback ni sauvegarde du parc.** Son observateur WordPress peut rafraîchir les caches de vérification des mises à jour. Le dépôt et la mise à niveau contrôlés du seul observateur Vigie existent déjà ; ils ne constituent pas un moteur général de maintenance. Les jetons hébergeurs peuvent techniquement écrire, mais les connecteurs Vercel/Railway actuels ne font que lire.

## 2. Matrice principale

Toutes les possibilités futures de cette table sont **bloquées par défaut** tant que les préconditions de la section 6 ne sont pas démontrées pour la cible exacte.

| ID / configuration | Détection actuelle | Mise à jour envisageable, pas encore implémentée | Annulation envisageable et limites | Décision initiale |
| --- | --- | --- | --- | --- |
| W1 — Cœur WordPress | Version, flux de mise à jour et date via observateur ; mode de secours moins fiable | Version cible explicite, compatibilité PHP/extensions, mise à jour des fichiers puis éventuelle migration de base | Ancien code seulement si schéma compatible ; sinon restauration fichiers + base cohérents, après décision sur les nouvelles écritures | Conditionnel ; sauvegarde et préproduction à qualifier |
| W2 — Plugins et thèmes distribués | Versions, activité, prérequis PHP/WP lorsqu'ils sont fournis, versions proposées ; parent/enfant | Composant ciblé ou groupe de composants dépendants ; inclure les composants inactifs dans l'analyse | Ancienne archive vérifiée disponible ; restauration base si migration ou réglages incompatibles ; pas de downgrade aveugle | Conditionnel ; tests de rendu et métier obligatoires |
| W3 — Premium et flux privés | Version installée ; disponibilité parfois inconnue malgré présence d'un flux | Licence et droit de téléchargement valides, paquet de provenance vérifiée et compatibilité | Conservation autorisée de l'ancien paquet ; restauration cohérente si données modifiées | Bloqué si flux/licence/artefact non vérifiés ; « inconnu » ne prouve pas une licence expirée |
| W4 — Thèmes enfants, code sur mesure, MU-plugins | Fichiers identifiés et en-têtes parfois absents ; présence de MU-plugins connue | Dépôt source et procédure de livraison propres au composant ; ne pas remplacer par un paquet portant un nom proche | Ancien artefact propre au site, empreinte et compatibilité de données | Manuel au départ ; jamais assimilé à une mise à jour WordPress.org |
| W5 — WooCommerce et écosystème paiement/stock/livraison | WooCommerce actif sur 5 sites ; plugins associés visibles ; pas de contrôle métier complet | Groupe compatible, migration éventuelle et tâches différées, validation sur copie isolée | Restaurer une ancienne base peut effacer commandes et changements de stock ; effets chez paiement/transporteurs non annulés | Validation renforcée ; procédure de gel/réconciliation requise |
| P1 — PHP web o2switch, extensions et paramètres | PHP web exact, extensions et limites via observateur ; PHP CLI et portée de configuration inconnus | Changement de branche/configuration selon mécanisme o2switch réellement utilisé ; tester web et CLI séparément | Réappliquer ancienne configuration si encore disponible ; ne répare pas une migration applicative déjà exécutée | Manuel au départ ; cartographier les sites affectés avant intervention |
| P2 — Moteur MySQL/MariaDB mutualisé | Chaîne de version renvoyée par WordPress ; contrôle de maintenance serveur non démontré | Changement du moteur et correctifs gérés avec l'hébergeur ; distinguer migration des données applicatives | Procédure fournisseur + restauration compatible ; pas de retour par simple réinstallation WordPress | Fournisseur, pas un bouton de mise à jour Vigie |
| V1 — Dépendances/framework d'une application Vercel avec source identifiée | Dépôt/commit/branche de production ; technologies limitées aux traces de build ; aucun inventaire exhaustif des dépendances | Accès Git dédié, lecture au commit déployé, manifeste + lockfile, PR ciblée, tests et preview isolée, fusion approuvée | Déploiement précédent éligible et retour Git cohérents ; base, services externes et secrets non restaurés | Conditionnel ; accès aux dépôts et tests à qualifier |
| V2 — Node sur Vercel | Branche déclarée/configurée et celle du déploiement ; famille des fonctions ; correctif exécuté non mesuré | Changer la branche majeure supportée dans la source de configuration effective puis redéployer | Ancien déploiement éligible ; retour à l'ancienne configuration pour les prochains builds ; disponibilité de la branche à revérifier | Conditionnel ; aucun choix de correctif exact promis |
| V3 — Frontend statique Vercel | Framework ou version au build parfois connus ; absence de fonctions dans les métadonnées, pas une garantie d'absence de services externes | Dépendances de construction, nouvel artefact et contrôle des routes/assets ; Node peut être limité au build | Ancien artefact éligible ; ne restaure ni CMS/API externes ni données navigateur ; vérifier cache/service worker | Conditionnel ; ne pas parler de Node serveur sans preuve |
| V4 — Projet Vercel sans dépôt de production identifié | Déploiement, domaines et éventuelles fonctions ; source de production non identifiée pour 7 projets | Retrouver source, propriétaire et chaîne de livraison ; ne pas inventer un dépôt depuis le nom | Déploiement ancien éventuellement disponible, mais réparation durable et retour Git non établis | Mise à jour des dépendances bloquée |
| R1 — Service Node Railway / Railpack | Node résolu dans les métadonnées du build actif pour certains services, pas une mesure du processus courant | Dépôt + lockfile + configuration effective ; PR et environnement isolé ; redéploiement et tests | Déploiement précédent retenu par Railway ; image et variables restaurées selon fournisseur, pas les volumes/données | Conditionnel ; contraintes temporaires fournisseur à vérifier |
| R2 — Frontend statique Railway | Pour NES App : Node au build et Caddy à l'exécution, versions issues du build | Mettre à jour séparément dépendances frontend, Node de build et mécanisme de construction de Caddy, après vérification de son contrôle réel | Ancienne image/déploiement éligible ; vérifier compatibilité API, assets et caches | Conditionnel ; pas de mise à jour de Node « dans Caddy » |
| R3 — Source connue, versions Railway inconnues | Dépôt/commit/répertoire parfois connus ; absence de paquets résolus | Inspection Git ; mesure runtime bornée seulement après autorisation d'un nouvel accès ; identifier le langage avant de choisir un gestionnaire | Artefact antérieur éligible et données compatibles ; test de retour à définir | Blocage d'inventaire, pas une conclusion « à jour » |
| R4 — Image externe / service réseau Tailscale | Référence d'image et digest de déploiement ; version logicielle et état persistant non mesurés | Image versionnée et contrôlée ; vérifier persistance de l'identité et dépendances réseau ; accès de secours indépendant | Ancienne image disponible + état compatible ; conserver un accès hors du tunnel ; retour non garanti par le seul digest | Manuel / validation renforcée |
| D1 — Deux PostgreSQL Railway | Images déclarées avec tags 17 et 18, digests ; versions SQL réellement exécutées et volumes non inventoriés | Correctif même majeure après preuve de version et de restauration ; majeure via projet de migration explicite | Ancienne image seule insuffisante ; restauration/retour de bascule compatible avec format et nouvelles écritures | Manuel ; migrations majeures exclues de l'automatisation initiale |
| D2 — PostgreSQL Neon de Vigie | Version serveur 18.6 mesurée ; branche de production documentée ; fenêtre de restauration et sauvegardes non vérifiées ici | Maintenance du moteur selon fournisseur ; migrations applicatives versionnées et compatibles avec ancien/nouveau code | Restauration ou nouvelle branche selon possibilités du compte, rétention et test ; aucune procédure supposée disponible | Fournisseur pour moteur ; manuel pour données/schéma au départ |
| B1 — Worker, surveillance et sauvegardes | Déploiements, sources/cron partiels ; aucune preuve de succès métier ou de sauvegarde restaurable | Runtime + dépendances avec contrôle de tâche ; isolation des sorties, idempotence et prévention de double exécution | Ancienne image ne retire ni message, ni email, ni sauvegarde écrasée ; réconciliation métier nécessaire | Manuel tant que résultat et effets de bord ne sont pas qualifiés |
| C1 — Vigie et son observateur | Source locale, déploiement Git documenté ; observateurs 1.0.3 sur les 9 sites | Vigie : PR/tests puis déploiement ; observateur : mécanisme géré existant, uniquement sur fichier reconnu et cible autorisée | Vigie : retour code séparé du schéma Neon ; observateur : ancien fichier géré compatible et clé conservée, procédure de retour à ajouter | Pas de mise à jour de l'outil de maintenance pendant une intervention du parc |

Précisions fournisseurs : Vercel gère les mineures/correctifs Node dans la branche choisie ([versions Node](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)). L'éligibilité d'un rollback dépend notamment de l'offre et des déploiements conservés ; configuration, environnement et services externes doivent être vérifiés ([Instant Rollback](https://vercel.com/docs/instant-rollback)). Railway limite aussi le rollback à sa rétention ; il distingue retour de déploiement et restauration d'un volume ([déploiements](https://docs.railway.com/deployments/deployment-actions), [volumes](https://docs.railway.com/volumes/backups)). Ces possibilités documentées ne prouvent pas qu'un retour a été testé pour notre parc.

## 3. Application aux neuf WordPress

Les nombres de plugins incluent les MU-plugins. « MàJ annoncées » compte seulement les plugins dont le flux indique une mise à jour, pas les thèmes ni le cœur. Ce n'est ni un nombre de vulnérabilités ni une liste autorisée à installer. Les minima PHP/WordPress sont ceux des composants installés : les prérequis des versions cibles restent à vérifier.

| Projet | WP / PHP web observés | Plugins / màj annoncées | Profils | Prérequis ou blocage propre au site |
| --- | --- | --- | --- | --- |
| AntiPunaiseLit | 7.1 / 8.2.34 | 24 / 14, flux en cache | W1–W5, P1–P2 | Mode de secours `early` : échec après chargement des plugins, fraîcheur des flux non garantie ; diagnostic avant plan automatique ; paiements et MU-plugin SEO sur mesure |
| Campus des Métiers | 7.1.3 / 8.2.34 | 8 / 1 | W1–W4, P1–P2 | Astra et thème enfant Odyssee Immo Child ; contrôler formulaires et rendu, préserver le thème enfant |
| Francofil | 7.1.3 / 8.2.34 | 43 / 6 | W1–W5, P1–P2 | WooCommerce, réservation de stock et MU-plugins personnalisés ; cron désactivé, relais serveur à prouver ; coordination avec Francofil App à cartographier |
| Lovidol | 7.1.3 / 8.2.34 | 23 / 12 | W1–W5, P1–P2 | Divi + Divi-child ; catalogue, commande, paiement et expédition à tester sans sorties réelles |
| Magic Silver | 7.1.3 / 8.2.34 | 25 / 6 | W1–W5, P1–P2 | Shoptimizer et composant Blog Template sur mesure ; tests commerce et rendu |
| Proagora | 7.1.3 / 8.2.34 | 9 / 1 | W1–W4, P1–P2 | Astra Child, MU-plugin Elementor Safe Mode ; debug actif ; vérifier erreurs, formulaires et personnalisation |
| Tronconic | 7.1.3 / 8.2.34 | 22 / 2 | W1–W5, P1–P2 | Shoptimizer actif, thème Tronconic installé mais inactif ; sauvegarder les deux, qualifier leur provenance |
| NES 3D | 7.1.3 / 8.1.34 | 17 / 6 | W1–W4, P1–P2 | Thème VamTam Tecnologia et intégration associée ; licence/flux premium et compatibilité de changement PHP à contrôler |
| NES Proworking | 7.1.3 / 8.1.34 | 3 / 2 | W1–W4, P1–P2 | Thème actif `nes-proworking2` sans nom/version dans les en-têtes ; thème `nes-proworking` également non versionné : provenance et artefacts à établir |

Les neuf relevés indiquent un WordPress non multisite. Une nouvelle cible multisite demandera un parcours réseau distinct. Des flux inconnus sont présents pour des composants premium, privés ou MU ; ne pas les comparer automatiquement à un homonyme public.

Pour WordPress, le retour de référence nécessite fichiers et base cohérents, pas uniquement l'archive du plugin ([guide de mise à niveau](https://developer.wordpress.org/advanced-administration/upgrade/upgrading/)). Pour PHP, le sélecteur peut agir à l'échelle de l'hébergement et des exceptions par dossier peuvent exister : la portée réelle doit être inventoriée avant changement ([o2switch](https://faq.o2switch.fr/guides/php/changer-version-php-et-php-ini/)). Aucun rôle root sur le serveur mutualisé n'est supposé.

## 4. Application aux 29 projets Vercel

Regroupement par framework configuré ou version effectivement reconnue dans le build de production. Il ne s'agit pas d'une analyse des dépôts. Les 22 projets avec dépôt de production identifié ne sont pas pour autant accessibles à Vigie via GitHub : cette permission reste à vérifier dépôt par dépôt.

| Groupe | Projets du parc | Capacités / traitement |
| --- | --- | --- |
| Next.js — 13 | budget-quotidien-pwa ; la-toile-de-valery-v2 ; epic-love-stories ; reborn-projets-test ; morne-a-leau ; 3dquote ; reborn-studio ; eurochannel-site ; vacances-budget-pwa ; epic-meeting-services ; tokoia ; epicv-2 ; reborn-studio-site | V1 + V2 : Node, Next, React, dépendances et migrations éventuelles ; inventaire lockfile, fonctions, routes et services externes à compléter |
| Vite — 4 | reporting-reborn ; river-club-poker ; real-estate-react ; quiz-pillebout | V1/V2 et V3 selon cible ; river-club-poker comporte des fonctions Node observées : ne pas classer les quatre comme purement statiques |
| Astro — 2 | la-toile-de-valery ; jim-life-style | V1/V2 ; V3 seulement après confirmation du mode de sortie et des intégrations externes ; version Astro non extraite du build |
| Create React App — 2 | complem-ai ; sportive-ai-web | V1/V2 ; identifier `react-scripts`, React et lockfile ; sportive-ai-web comporte une fonction Node observée ; migration d'outillage éventuelle = projet séparé |
| Fastify — 1 | lescabines-api | V1/V2 : runtime et dépendances API, contrat avec clients, authentification, données, migrations et tests métier à qualifier |
| Source non identifiée — 7 | partisans-crm ; bisdary-poc ; evaluation-joueurs ; apex-performance-8 ; abacus-consulting-site ; bisdary-poc-2 ; crm-diaspora | V4 ; retrouver chaîne de livraison avant mise à jour ; apex-performance-8 comporte des fonctions Node observées |

La branche Node indiquée pour la production est `22.x` pour `tokoia` et `sportive-ai-web`, `24.x` pour les 27 autres. Ce ne sont pas des mesures du correctif Node exécuté. Une technologie avec numéro exact est extraite pour 17 projets sur 29 ; les autres ont au mieux un framework configuré ou des métadonnées de fonctions. L'absence d'un paquet dans les logs ne prouve pas son absence du projet. Il manque l'inventaire direct/transitif complet, les registres privés et les contrôles de vulnérabilités applicables.

Une PR de mise à jour n'est pas un déploiement : il faut identifier la branche auto-déployée, les contrôles bloquants et la cible de preview pour chaque dépôt. Aucun droit de fusion automatique ni accès GitHub global au parc n'a été établi ici.

## 5. Application aux douze services Railway

Les versions ci-dessous proviennent des métadonnées du build associé au déploiement indiqué comme actif. Un statut `SUCCESS` n'est pas une preuve de disponibilité métier. Le champ `staticSite: false` sans métadonnées résolues ne prouve pas un serveur dynamique. Le libellé `RAILPACK` n'annule pas la présence d'une image externe : la provenance de l'image prime pour le plan de maintenance.

| Projet / service | Preuve disponible | Profils | Blocage spécifique avant mise à jour |
| --- | --- | --- | --- |
| Heroic Appreciation / excellence-bs-worker | Node 20.20.2 runtime ; dépôt connu, `/worker` | R1, B1 | Branche Node 20 hors support ; qualifier tâches, file de travail, reprises et idempotence avant migration majeure |
| NES App / Frontend NesApp | Node 22.23.2 build, Caddy 2.11.4 runtime, Vite, `/frontend` | R2 | Tester compatibilité API et cache ; identifier comment la version Caddy est sélectionnée |
| NES App / Backend NesApp | Node 22.23.2 runtime ; `/backend` ; contrôle `/health` configuré | R1 | Dépendances et schéma de données inconnus ; contrôle `/health` nécessaire mais insuffisant |
| NES App / Docs NesApp | Dépôt et commit connus, `/docs-site` ; aucun paquet résolu | R3 | Langage, mode statique/dynamique et versions à établir ; ne pas déduire Node du seul nom |
| NES App / tailscale | Image `tailscale/tailscale` et digest ; version inconnue | R4 | État persistant, identité réseau et dépendances à qualifier ; accès de secours indépendant requis |
| Mon bilan Prevention / Postgres | Image déclarée `postgres-ssl:17`, digest ; version SQL inconnue | D1 | Identifier version réelle, volume, sauvegarde, extensions et utilisateurs applicatifs ; pas de changement de majeure par tag |
| Mon bilan Prevention / Postgres-4DcU | Image déclarée `postgres-ssl:18`, digest ; version SQL inconnue | D1 | Établir le rôle de chacune des deux bases et les applications connectées ; ne pas supposer que l'une remplace l'autre |
| Mon bilan Prevention / backend | Dépôt/commit connus, `/backend` ; versions non résolues | R3 | Identifier runtime et dépendances ; cartographier la base utilisée et les migrations |
| Mon bilan Prevention / frontend | Dépôt/commit connus, `/frontend` ; versions non résolues | R3 | Mode de sortie et dépendances inconnus ; commit différent de celui du backend, compatibilité à tester |
| Francofil App / francofil-surveillance | Dépôt/commit connus, `/tools/exploitation` ; versions non résolues | R3, B1 | Identifier tâches et effets ; ne pas provoquer de doublons de traitement/notification |
| Francofil App / francofil-backups | Cron `17,47 * * * *` ; déploiement relevé `CRASHED` ; versions/source non établies | B1 | Diagnostic et preuve d'une sauvegarde récente restaurable avant de compter sur ce service ; état issu du relevé de 17:16, pas d'un test de restauration |
| Francofil App / @francofil/web | Node 22.23.3 runtime, pnpm 11.23.0 outil ; dépôt connu | R1 | Identifier workspace/lockfile, dépendances, lien avec WordPress/stock et jobs ; déployer les composants couplés selon un plan commun |

Au total : versions de paquets résolues pour **4 services sur 12**, **8 sans version logicielle résolue** (dont sauvegardes), **1 contrôle de santé configuré sur 12** dans les métadonnées collectées. Cela ne prouve pas l'absence de supervision externe. Aucune lecture SSH, requête dans les bases Railway ou inspection de volumes n'a été exécutée.

Node 20 est hors support selon le [calendrier officiel Node](https://nodejs.org/en/about/eol). Railpack peut faire primer une variable de configuration sur les déclarations du dépôt : le plan doit résoudre les priorités réelles ([résolution Node](https://railpack.com/languages/node/)). Pour Tailscale, l'état doit être conservé pour préserver l'identité ; sa persistance dans notre service n'a pas été vérifiée ([paramètres Docker](https://tailscale.com/docs/features/containers/docker/docker-params)). Une majeure PostgreSQL exige une procédure de migration adaptée au format de données ([PostgreSQL](https://www.postgresql.org/docs/current/upgrading.html)).

### Restriction temporaire fournisseur, distincte de la matrice technique

Au **22 octobre 2026 à 15:29 UTC / 17:29 Paris**, Railway signale un incident : déploiements Pro/Enterprise ralentis, builds Hobby/Free/Trial pas encore réactivés. L'offre de notre workspace n'a pas été établie. Les écritures de maintenance Railway doivent attendre une vérification récente de l'état fournisseur et de la disponibilité réelle du déploiement et de la récupération. Ce constat ne signifie pas que toutes les applications déjà déployées sont arrêtées. [État officiel Railway](https://status.railway.com/).

**Priorité sécurité distincte :** l'[avis officiel du 21 octobre](https://blog.railway.com/p/security-disclosure-wednesday-october-21st) décrit un accès non autorisé possible à des variables d'environnement, dont certaines auraient été déchiffrées. Railway recommande par précaution à tous ses utilisateurs de renouveler/révoquer les secrets stockés dans la plateforme et d'examiner l'activité inhabituelle. L'exposition de notre compte n'a pas été établie ici. Préparer sans attendre une intervention de réponse à incident, avec accord et coordination des services dépendants ; ne pas la confondre avec une campagne ordinaire de mises à jour ni attendre que toute la matrice soit implémentée. Aucune variable, clé, donnée de journal ou permission n'a été lue ou modifiée à cette fin. Un rollback réintroduisant d'anciens identifiants potentiellement exposés serait interdit : le plan de reprise doit utiliser des secrets valides non compromis.

## 6. Conditions nécessaires pour afficher « exécutable »

Pour chaque opération, toutes les conditions applicables doivent être documentées. Une inconnue bloque l'exécution ; une intervention d'urgence éventuelle passe par une procédure manuelle explicitement approuvée, pas par le contournement silencieux des contrôles.

| Contrôle | Preuve attendue | État de notre parc à cette étape |
| --- | --- | --- |
| Cible et portée | Compte, projet, service/installation, environnement, commit/digest et ressources partagées identifiés | Identifiants largement présents ; dépendances interservices, bases et portée PHP incomplètes |
| Inventaire frais | Source/date et version attestées ; relecture juste avant exécution ; pas d'héritage de données d'un ancien déploiement | PHP web acquis ; Node Railway issu de builds ; plusieurs versions inconnues ; AntiPunaiseLit dégradé |
| Source et accès | Dépôt au commit déployé ou paquet signé/vérifié, droits limités à la cible, jeton valide | Sources Git identifiées pour une partie du parc ; accès Git/licences/droits de maintenance non qualifiés ; aucun nouvel accès créé |
| Cible compatible | Version exacte proposée, exigences des versions cibles, changelog et migrations identifiées ; ordre de transition compatible | Comparaisons disponibles partielles ; pas encore de moteur de compatibilité ni d'audit exhaustif des dépendances |
| Sauvegarde utilisable | Données + fichiers/volumes nécessaires, stockage indépendant, empreinte/date, rétention, clés protégées et essai de restauration isolé | Aucun dispositif complet vérifié pour le parc ; Backup Vigie est « Coming soon » ; ancien SQLite ne protège pas les données Neon actuelles |
| Environnement d'essai | Copie isolée, base dédiée, paiements en bac à sable, mails/webhooks/jobs neutralisés, données sensibles protégées | Préproductions exploitables non démontrées ; preview Vigie exige base et origine OAuth dédiées |
| Critères de réussite | État initial, tests techniques et parcours métier propres au site ; observation après intervention | Tests de V1 ponctuels disponibles, pas de batterie de non-régression par projet ; tous les niveaux de criticité sont actuellement « standard », ce n'est pas une analyse de risque |
| Retour prêt | Artefact antérieur réellement disponible, procédure éprouvée, compatibilité des données et accès de secours | Aucun rollback/restauration exercé pour cette matrice ; disponibilité/rétention à vérifier pour chaque fournisseur |
| Incident de sécurité | Avis fournisseur examiné ; secrets valides et non compromis ; ancien artefact corrigé ou utilisable sans réintroduire le risque | Avis Railway à traiter séparément ; exposition propre au compte non déterminée ; pas de retour automatique vers des identifiants potentiellement exposés |
| Données récentes | Fenêtre de maintenance, perte maximale acceptable (RPO), temps de reprise (RTO), gel/capture/réconciliation des écritures | Non définis ; aucune perte de commandes, stocks ou données métier implicitement acceptée |
| Exécution contrôlée | Approbation du plan exact, journal sans secrets, verrou distribué par cible et ressource partagée, reprise/idempotence, délais et état fournisseur | Exécuteur de maintenance absent ; verrous des collectes V1 en mémoire insuffisants pour des écritures multi-instances |

Un ordre « PHP puis WordPress puis plugins » ne doit pas être imposé universellement : il faut chercher un chemin où chaque état intermédiaire est compatible. Si aucune transition compatible n'existe, préparer une migration isolée puis une bascule, plutôt qu'une série de changements sur le site actif.

### Distinguer les formes d'annulation

| Situation | Ce qu'on peut annuler | Ce qu'on ne peut pas promettre |
| --- | --- | --- |
| Plan non approuvé / PR non fusionnée | Annuler le plan ou fermer la PR | Aucun effet production à annuler, mais vérifier qu'aucun workflow de preview n'a effectué d'écriture externe |
| Job démarré | Demander un arrêt au prochain point sûr, puis constater l'état atteint | Interrompre un remplacement de fichiers ou une migration au milieu ne garantit pas un retour cohérent |
| Nouveau code / image sans migration | Revenir à un artefact précédent éligible, puis aligner Git/configuration pour éviter sa réintroduction | Ne pas restaurer automatiquement les bases ; disponibilité d'un ancien artefact non garantie sans vérification |
| Migration de données | Appliquer une migration inverse testée si possible, ou restaurer/basculer sous contrôle | Les migrations ne sont pas toutes réversibles ; perte de données postérieures possible, jamais acceptée par défaut |
| Effets externes | Compensation métier spécifique, si elle existe et est approuvée | Emails, paiements, expéditions et messages consommés ne disparaissent pas avec un rollback |

## 7. Éléments découverts mais hors des 42 fiches

Ne pas les ajouter, rattacher, installer un observateur ou mettre à jour automatiquement à partir de cette matrice.

| Configuration détectée | Cibles | Détection et décision |
| --- | --- | --- |
| WordPress sans rattachement | 022e-91f45a1c2c9a.wptiger.fr ; prowo.pija4582.odns.fr | Versions lues dans les fichiers ; activité et PHP web non établis par ce mode ; propriétaire, usage et sauvegardes à qualifier avant toute extension des accès |
| WordPress incomplet | inuzin.xyz | Diagnostic manuel ; ni site sain ni candidat à une mise à jour automatique |
| Dolibarr | crmreborn.reborn-france.com (15.0.2) ; crm.nes-3d.fr (14.0.2) | Versions de fichiers seulement ; modules, personnalisations, base et sauvegardes inconnus ; migration applicative manuelle à préparer, pas une mise à jour générique PHP |
| Export Next.js | jv-conseils.fr | Fichiers exportés reconnus, pas de runtime Node déduit ; retrouver dépôt/build et ancien artefact avant remplacement |
| Sites statiques | jimlifestyle.fr ; proagoraarques.fr ; renta.reborn-france.com ; successstory.visionly.io | Fichiers statiques reconnus ; pas de version applicative fiable ; retrouver chaîne de génération et méthode de publication |
| Projets Vercel non rattachés, non exclus | bisdary-projet-56-v2 ; bisdary-projet-56 ; lescabines-employe ; vigie ; lescabines-staff | Candidats découverts seulement ; Vigie a un parcours distinct décrit plus bas ; pas d'élargissement automatique du parc |
| Projet Railway non rattaché | francofil-recovery-110 | Ne pas le considérer comme une préproduction ou une restauration opérationnelle sur la seule base du nom |
| Racines techniques/vides et projets Vercel exclus | Autres résultats de découverte | Aucune maintenance automatique ; conserver les exclusions et ne pas déduire l'absence de données d'une classification « technique » |

## 8. Vigie : contraintes particulières

Vigie est le plan de contrôle : sa panne peut empêcher la reprise d'une intervention. Maintenir un moyen d'administration hors de Vigie et conserver les procédures de restauration accessibles séparément.

- Déploiement Vercel : Next.js, Node 24.x, GitHub `TheooLeroux/Vigie`, push sur `main` auto-déployé. Les mises à jour futures passent par PR/tests et approbation ; aucune branche ni PR n'a été créée ici.
- Base Neon : migrations applicatives versionnées. Une migration avant déploiement doit rester compatible avec le code encore actif et le déploiement de retour. Sinon, maintenance planifiée et stratégie de bascule explicite.
- Les prévisualisations ne doivent pas utiliser implicitement la base de production ni une origine OAuth non autorisée. Leur fonctionnement complet reste à configurer avant de compter sur elles pour les mises à jour.
- La clé de chiffrement des connecteurs et les secrets de session nécessitent une conservation séparée des sauvegardes, sans les exposer dans les plans ni les journaux. Une rotation de secret n'est pas une simple mise à jour de dépendance et ne se défait pas en réactivant une clé compromise.
- Ne pas ajouter à l'observateur actuel une commande shell générique. Un futur exécuteur WordPress nécessitera des opérations fermées, autorisations distinctes, cibles bornées, protection contre rejeu/concurrence et procédure de récupération indépendante d'un WordPress qui ne démarre plus.
- Les changements de paquets, builds et scripts de migration sont du code potentiellement exécutable : travailleurs isolés, permissions minimales et pas de secret de production transmis à un build de PR non fiable.
- Les opérations longues devront avoir un état durable et une reprise contrôlée, indépendants de la durée d'une requête HTTP et de l'instance Vercel qui l'a reçue.

## 9. Priorités issues de cette matrice

1. **Sécurité et blocages avant maintenance ordinaire** : réponse à l'avis Railway et coordination des secrets, fonctionnement/restauration des sauvegardes Francofil, échec de chargement AntiPunaiseLit et état fournisseur Railway. Ne pas interpréter l'inventaire V1 réussi comme une certification de santé des services externes.
2. **Compléter les preuves** : source des 7 projets Vercel, versions des 8 services Railway, manifeste/lockfile des applications, provenance des thèmes personnalisés et flux premium, ressources partagées et portée PHP.
3. **Traiter la dette de support avec un plan testé** : worker Node 20 en premier candidat de migration ; branches PHP des sites NES à examiner avec l'hébergeur, sans imposer une cible arbitraire.
4. **Établir sauvegardes, essais de restauration et tests métier** ; choisir ensuite un pilote non critique, sans le déduire du champ « standard » ni du seul nom du projet.
5. **Première capacité nouvelle recommandée** : plans de maintenance et PR de dépendances sans fusion automatique, puis mises à jour WordPress ciblées et approuvées après les prérequis. Conserver migrations majeures de bases et services réseau en manuel.

Le résultat actuel est donc : **détection exploitable mais incomplète ; zéro cible certifiée pour mise à jour + annulation automatiques sans prérequis supplémentaires**. Cela ne signifie pas que le parc est impossible à maintenir, mais que la sécurité d'exécution doit être démontrée cible par cible.
