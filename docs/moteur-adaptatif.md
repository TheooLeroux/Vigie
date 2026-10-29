# Qualification et exécution par service

Le moteur sépare l’hébergeur, la famille applicative et le mode d’exécution. La présence de `package.json` ne suffit pas à qualifier une application Node : WordPress et Dolibarr sont reconnus avant leur éventuelle chaîne frontend ; les racines mêlant plusieurs familles sont laissées à qualifier. Python, PHP, Go, Rust, Ruby, Java, Bun et les fichiers statiques sont identifiés sans être déclarés automatiquement maintenables.

## Source de la qualification

Le contrôle en lecture seule lit les noms et le manifeste au commit réellement déployé. Il conserve seulement la famille, les chemins de manifestes, les noms des scripts, le verrou et l’identité dépôt/racine/commit. Aucun contenu de script ou secret n’est enregistré. Le résultat reste distinct du scan de sécurité : reconnaître PHP ne signifie pas avoir analysé ses dépendances.

La qualification ne vaut que pour ce commit, cette racine et ce dépôt. Un changement de déploiement ne réutilise pas une qualification d’une branche ou d’une autre racine. Les erreurs de qualification conservées ne deviennent pas des contrôles de sécurité réussis. Les sources téléchargées par l’exécuteur sont également identifiées avant toute installation pour refuser les racines mixtes et les applications non Node.

## Parcours disponibles

| Profil | Comportement |
| --- | --- |
| Node web Vercel/Railway | Tests et scans habituels, contrôle du déploiement, preuve Node et HTTPS. Les conditions de qualification du fournisseur restent applicables. |
| Node de build statique Railway | Attestation de construction et contrôle du site ; aucune revendication de processus Node serveur. |
| Worker Node Railway sans domaine | Sources au commit déployé, verrou et scripts `start` et `test` ou `build` requis. Même installation isolée, scans et preuve du Node exécuté dans les instances actives ; aucun HTTP fictif demandé. La présence du processus ne certifie pas les résultats métier. |
| WordPress o2switch | Cœur et extensions admissibles ; thèmes, code personnalisé et paquets protégés conservés et signalés. Un relevé avant chargement des extensions n’autorise pas une mise à jour. |
| Statique Vercel | Sources Vite, Astro ou Create React App qualifiées au commit déployé, verrou et build obligatoires. Qualification de configuration avant installation, reconstruction isolée, sortie statique contrôlée, puis comparaison SHA-256 de chaque fichier servi et contrôle du domaine public. Aucun runtime Node serveur revendiqué. Voir les limites du parcours dans `vercel-maintenance.md`. |
| Cron, images externes, bases, réseau, autres langages | Intervention séparée ou qualification dédiée, avec un motif visible. Aucun passage implicite par l’exécuteur Node. |

Un workspace ou verrou partagé reste à qualifier : son analyse de sécurité peut couvrir plusieurs applications mais ne suffit pas à valider leur mise à jour groupée. Les applications avec des racines indépendantes dans un même dépôt restent utilisables par les parcours existants.

## Exécutions partielles et sources communes

La sélection automatique prend uniquement les services admissibles ; les autres sont conservés dans `excludedTargets` avec le motif de leur exclusion. L’interface indique le type et le périmètre réel de chaque service. Un résultat terminé portant sur une sélection ne déclare pas que tout le projet est corrigé.

Un échec d’un groupe indépendant n’empêche pas de tenter les autres groupes. Un même dépôt reste un seul groupe et un seul verrou, même si plusieurs services ou branches l’utilisent ; des branches différentes ne sont pas fusionnées implicitement. Les succès restent conservés, le résultat global ne devient pas un succès en présence d’un échec, et les groupes incertains après publication gardent leur verrou. Les périmètres indépendants qui n’attendent aucune vérification sont libérés.

Avant publication Git, l’exécuteur recherche les autres consommateurs connus du dépôt sur les connexions Vercel/Railway, y compris les services non rattachés ou exclus. Une modification d’un verrou ou manifeste parent affectant un consommateur non sélectionné est refusée avant publication. Les consommateurs d’une autre branche explicitement identifiée ne sont pas affectés par le déplacement de cette référence ; une branche inconnue reste prise en compte par prudence. Ce contrôle porte sur l’inventaire connu, pas sur des hébergements qui ne sont pas connectés à Vigie.

Les tests de cette évolution utilisent des fixtures et des conteneurs jetables. Ils ne lancent aucune maintenance sur les projets du parc et ne réparent aucun WordPress.

## Exploitation et consultation

Les relevés Vercel/Railway restent soumis au seuil de fraîcheur de 15 minutes. La fiche actualise les connexions périmées à la demande et lors de sa consultation ; le lancement et la vérification avant publication les réactualisent aussi si nécessaire. Ce parcours lit uniquement les inventaires hébergeur et n’installe aucun agent WordPress. Les appels concurrents à une même connexion sont regroupés dans le processus ; les verrous du connecteur restent applicables. La planification GitHub continue d’assurer les contrôles de fond.

Une source sans dépôt, une image externe ou une technologie sans analyseur produit un rapport de couverture limitée, sans preuve de sécurité et sans échec technique. Il suit la cadence horaire des contrôles, tandis qu’un véritable échec conserve la reprise à cinq minutes. Les erreurs de droits GitHub restent explicites et ne sont pas converties en couverture validée.

La liste consulte des résumés groupés, par lots bornés à 200 projets et quatre calculs concurrents côté serveur. Les détails et rapports complets restent dans les fiches. Les requêtes côté navigateur sont annulées à la fermeture du parcours et les appels inutiles ne sont pas planifiés pour un onglet caché. Les statuts de relevé technique sont distincts des inventaires manuels.

Les filtres et pages d’activité interrogent tout l’historique conservé côté serveur ; le jour de départ utilise Europe/Paris. Les données initiales de l’espace restent limitées aux 100 dernières actions, sans charger toute la table en mémoire. Les choix de projets proviennent du parc complet. Les écrans et les onglets de fiche se retrouvent via la navigation et l’URL.

Backup centralise les emplacements de sauvegarde WordPress et les références Git/déploiement consignés dans les maintenances, y compris anciennes via pagination. Ce catalogue ne contrôle pas l’existence physique des fichiers et ne recense pas les sauvegardes externes à Vigie. Une référence de code n’est pas une sauvegarde de données. Aucune restauration automatique, création de sauvegarde ou lecture des archives distantes n’est déclenchée par sa consultation.
