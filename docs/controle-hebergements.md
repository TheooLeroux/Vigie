# Maintenir les contrôles des hébergements

Le workflow `vigie-wordpress-agents.yml` programme un contrôle toutes les cinq minutes, sans ouvrir Vigie. Il utilise les accès chiffrés existants et l’environnement GitHub `vigie-maintenance`. Le même workflow passe après publication des fichiers de contrôle sur la branche principale et peut être lancé manuellement. La fréquence est une cadence demandée : les délais GitHub Actions, une panne réseau ou une installation longue peuvent retarder le passage. Ce dispositif ne garantit pas une disponibilité sans interruption.

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
