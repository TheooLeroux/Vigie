# Maintenir les contrôles des hébergements

Le workflow `vigie-wordpress-agents.yml` programme un contrôle toutes les cinq minutes, sans ouvrir Vigie. Il utilise les accès chiffrés existants et l’environnement GitHub `vigie-maintenance`. Le même workflow passe après toute publication sur `main`, après un événement GitHub `deployment_status` réussi sur cette branche et peut être lancé manuellement. La fréquence est une cadence demandée : les délais GitHub Actions, une panne réseau ou une installation longue peuvent retarder le passage. Ce dispositif ne garantit pas une disponibilité sans interruption.

## Analyses autonomes des failles et des mises à jour

Après la synchronisation de chaque hébergeur, le worker `scripts/automatic-control-worker.ts` parcourt les projets actifs de son périmètre. Il analyse chaque service au premier passage, lorsque son déploiement ou ses versions WordPress changent, puis à l’expiration d’une heure. Les déploiements des projets surveillés sont détectés par les lectures périodiques des API Vercel/Railway ; aucun webhook n’est installé dans ces projets. Ils déclenchent leur analyse au passage qui les découvre. Un déploiement intermédiaire remplacé entre deux lectures ne peut pas être garanti comme analysé.

WordPress utilise un inventaire existant renouvelé par le contrôle des agents et un nouveau relevé WPVulnerability, y compris lorsque les versions n’ont pas changé. Le cœur et les extensions ordinaires sont analysés ; les thèmes et MU-plugins restent explicitement hors du contrôle de failles actuel. Les informations de versions disponibles sont relevées par le connecteur WordPress. Les caches des catalogues WordPress.org, PHP.net, Node et npm sont limités à une heure.

Pour Node sur Vercel/Railway, la sonde lit uniquement le manifeste et le verrou du commit identifié par l’hébergeur, dans le répertoire du service, depuis un dépôt GitHub déjà autorisé. Elle ne se rabat jamais sur la tête de branche. OSV analyse les dépendances résolues, puis les versions stables disponibles des dépendances directes sont comparées au registre npm. Aucun script du projet n’est exécuté et aucun paquet du projet n’est installé. L’image système, les secrets et le code applicatif ne sont pas analysés par cette sonde. Un verrou absent, des sources non GitHub, des sources trop volumineuses, plusieurs commits simultanément actifs ou un commit déployé inconnu produisent une erreur explicite ; aucune absence de faille n’en est déduite.

Les résultats et les verrous utilisent des clés distinctes du catalogue durable `wordpress_catalog` existant : aucune migration ni nouveau secret n’est nécessaire. Un échec conserve les dernières preuves datées, retire leur validité et prévoit une nouvelle tentative au passage suivant après cinq minutes. Les rapports d’un ancien déploiement ne valident jamais le nouveau. Un verrou de dix minutes protège chaque service ; après arrêt brutal du worker, il devient récupérable. Les projets archivés et les installations ignorées ne sont pas analysés. Un échec n’empêche pas de traiter les autres projets et hébergeurs.

L’API des fiches lit les rapports enregistrés et le cache WordPress sans déclencher de scan distant. La vue d’ensemble affiche les alertes, les versions disponibles, les dates, les réserves et les erreurs de contrôle. Les alertes connues du même déploiement restent visibles pendant une panne ; une ancienne absence d’alerte ne vaut pas confirmation actuelle.

Pour activer ce comportement en production, publier ces fichiers et le workflow sur la branche principale. Les jobs Node réutilisent `VIGIE_MAINTENANCE_GITHUB_TOKENS`, le jeton séparé Janssen si présent et la variable `VIGIE_MAINTENANCE_REPOSITORIES` du parcours de maintenance. Le worker n’utilise pas le drapeau d’activation des mises à jour : la surveillance fonctionne indépendamment du droit de publier des correctifs. Les scanners ne sont téléchargés que si un contrôle Node est dû.

## o2switch et WordPress

Chaque passage recherche les installations sur les comptes configurés, y compris celles précédemment marquées absentes. Une remise en ligne au même emplacement conserve ainsi le rattachement et les clés. Un répertoire ou un domaine différent doit d’abord être découvert et rattaché correctement. La recherche ne crée aucune fiche de projet.

Le contrôle des agents vérifie aussi un inventaire web de moins de cinq minutes. Si le connecteur d’inventaire ne répond plus, la collecte contrôle son fichier par cPanel. Un fichier absent et son dossier MU-plugins sont recréés avec la clé existante. Une ancienne version dont l’empreinte est connue peut être remplacée. Un fichier inconnu, modifié, un lien symbolique ou un emplacement hors du compte reste refusé ; le dernier inventaire est conservé avec son erreur. Les sites sans fiche active, ignorés ou absents ne reçoivent pas de connecteur automatique.

Un agent n’est sain que si son battement signé date de moins de trois minutes et son inspection WordPress signée de moins de dix minutes. La racine, le domaine, l’environnement et le PHP web doivent correspondre ; WordPress doit autoriser les modifications et ne pas être multisite. Le lanceur renouvelle cette inspection toutes les cinq minutes, même sans changement de sa configuration. Un cron qui tourne avec un WordPress devenu inutilisable ne suffit plus à confirmer le contrôle.

La réparation remet immédiatement l’agent en attente et retire son état prêt. Elle conserve la clé, les tâches, les résultats et les sauvegardes, puis vérifie le dépôt, le cron, le battement et WordPress avant de confirmer le retour du contrôle. Les erreurs persistantes utilisent la temporisation existante de cinq à soixante minutes. Une maintenance verrouillée garde la priorité. Les modifications distantes inconnues ne sont pas écrasées.

La dernière vérification réussie est enregistrée côté serveur. Après quinze minutes sans confirmation, la fiche indique que le contrôle a expiré et bloque une nouvelle mise à jour jusqu’au retour d’une preuve fraîche. Les installations partielles et les échecs restent visibles dans les détails de l’agent et l’activité.

Les sites o2switch autres que WordPress restent suivis par la découverte cPanel. Cette version n’y installe pas d’agent de maintenance.

## Vercel et Railway

Deux tâches indépendantes vérifient les connexions et relisent les projets, services et déploiements par les API des hébergeurs. Leur contrôle ne dépend pas d’un fichier dans les sources du site : un redéploiement retrouve son état au passage suivant, sans ajout de code au projet ni modification de son déploiement.

Une panne de connexion conserve le dernier relevé daté et son erreur. Un relevé de plus de quinze minutes expire également si le contrôle périodique ne passe plus. Elle empêche de proposer la cible comme disponible pour une mise à jour. Les autres comptes et l’autre hébergeur continuent d’être vérifiés. Les conflits de synchronisation et les limites temporaires sont différés au passage suivant. Un jeton révoqué, expiré ou insuffisant doit être remplacé dans Connexions : Vigie ne peut pas recréer une autorisation chez l’hébergeur sans accès valide.

## Exécution et validation

Le contrôle nécessite la publication du code et du workflow sur la branche principale, ainsi que les secrets déjà utilisés par l’installation des agents (`VIGIE_UPDATES_DATABASE_URL`, `VIGIE_UPDATES_ENCRYPTION_KEY`). Aucun nouveau secret ni migration n’est ajouté. Les contrôles web WordPress du worker passent par `VIGIE_WORDPRESS_CONTROL_URL`, configuré sur le serveur Vigie. La collecte web peut réparer uniquement le connecteur d’inventaire autorisé ; les opérations de maintenance restent réservées à l’agent privé.

Les tests simulent notamment la suppression du dossier MU-plugins après restauration, la conservation de la clé, le refus d’un fichier modifié, l’expiration des preuves, un PHP ou domaine différent et l’isolation des pannes entre comptes. Le test Docker du lanceur vérifie le renouvellement d’une inspection devenue fausse malgré une configuration inchangée.

Le contrôle et sa réparation ne lancent aucune mise à jour du contenu, sauvegarde ou restauration du site. Les erreurs sont visibles dans Vigie et les échecs du workflow ; aucune notification externe supplémentaire n’est créée.
