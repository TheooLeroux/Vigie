# Sauvegardes Vigie · o2switch

L’onglet affiche les copies téléchargeables, par site et par date. Chaque ZIP contient `files.tar.gz` et un manifeste avec la taille et l’empreinte SHA-256 de chaque composant. Les ZIP WordPress contiennent aussi `database.sql`. Les ZIP sont des données privées, car ils peuvent contenir des réglages et données client.

## Configurer l’exécuteur

1. Configurer l’accès OpenSSH de l’exécuteur une fois par compte o2switch. Le worker prend le nom du serveur et l’utilisateur cPanel dans Vigie. Installer la clé SSH de l’exécuteur, vérifier l’empreinte du serveur dans `known_hosts` et autoriser l’IP de l’exécuteur dans cPanel. Sur l’hôte, le worker attend Bash, GNU tar et, pour WordPress, WP-CLI et le client de dump MySQL/MariaDB.
2. Lancer `npm run backups:tick -- --plan` pour vérifier les sites sélectionnés et les types à qualifier. La commande lit l’inventaire sans se connecter en SSH. `npm run backups:tick -- --preflight --site nes-proworking.fr` vérifie ensuite le périmètre à distance et donne la taille apparente des fichiers et les estimations SQL, sans créer de ZIP.
3. Configurer les variables `VIGIE_BACKUP_S3_*` sur Vigie et sur le worker. Pour le bucket R2 européen `vigie-backups`, utiliser le point de terminaison S3 européen et la région `auto`. Le projet Vercel Vigie reçoit la clé de lecture seule. Le worker reçoit la clé de lecture et écriture. Le répertoire `VIGIE_BACKUP_SCRATCH_DIRECTORY` du worker doit être privé, chiffré pour les données réelles et assez grand pour les fichiers de travail et le ZIP. `VIGIE_BACKUP_DIRECTORY` permet de tester avec un stockage local. Avec PostgreSQL, appliquer les migrations du catalogue sur la base cible via `npm run db:migrate` avant de déployer.
4. Lancer `npm run backups:tick -- --site nes-proworking.fr` pour un premier essai limité à ce domaine. Le premier appel tente le dernier créneau échu. Vérifier le ZIP affiché dans Backup en le téléchargeant depuis Vigie, puis programmer le passage automatique.

Le worker parcourt l’inventaire à chaque passage. Il prend en charge les WordPress et sites statiques de production découverts sur les comptes configurés, y compris ceux sans fiche projet. Les préproductions, sites ignorés ou disparus, installations techniques et projets archivés sont exclus. Les racines qui contiennent une autre installation de l’inventaire sont signalées. Les sites Dolibarr, les applications PHP génériques et les WordPress dont l’installation est incomplète sont signalés comme non couverts. Un nouveau site reconnu entre automatiquement dans la collecte au passage suivant.

Pour WordPress, le worker vérifie le domaine enregistré en base et exporte en une transaction les tables InnoDB du site. Pour un site statique, il vérifie la présence de l’index HTML et recherche les fichiers qui indiqueraient une application serveur. Les fichiers cachés de la racine font partie de la copie. Le SQL et les fichiers partent directement en flux SSH. Le ZIP est assemblé et vérifié sur l’exécuteur, hors de l’hébergement du site. La collecte laisse le site en ligne et limite le transfert à 20 Gio par capture.

Les fichiers et la base sont lus à des instants différents. Un site qui reçoit des fichiers pendant le passage peut donc demander une fenêtre plus calme. Les multisites, les tables non transactionnelles, les liens symboliques et les répertoires WordPress personnalisés détectés demandent une qualification séparée.

## Planification et rétention

Après validation du pilote, programmer `npm run backups:tick` avec le cron `3-58/5 * * * *` sur l’exécuteur. Le moteur calcule le créneau en `Europe/Paris` et vise le lundi à 03 h 13. Les passages suivants rattrapent le dernier créneau en cas d’arrêt. Une copie valide termine le créneau. Un échec peut être repris après 15 minutes, et la réservation d’un worker interrompu expire après quatre heures.

Le moteur conserve par installation les cinq dernières copies complètes et la dernière copie valide de chacun des douze mois civils glissants, mois courant compris. Un ZIP qui compte pour les deux règles n’existe qu’une fois. Le worker limite la collecte à un site à la fois par compte o2switch. La suppression des copies expirées suit une capture réussie. Les erreurs sont remontées au journal de l’exécuteur.

Le worker relit le ZIP dans R2 et vérifie son empreinte avant de le publier. L’application vérifie la session, puis délivre un lien valable cinq minutes. Les collectes Railway et Vercel seront qualifiées sur NES App et Vigie.
