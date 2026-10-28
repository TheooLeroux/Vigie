# Maintenance o2switch et WordPress

## Composants conservés sans bloquer les autres mises à jour

Un composant privé, personnalisé, sans version exploitable, sans catalogue reconnu ou incompatible est conservé. La maintenance poursuit les mises à jour admissibles des autres composants. Le résultat conserve une liste structurée `manualUpdates` avec le composant, la version relevée, la version disponible lorsqu’elle est connue, le motif et l’intervention attendue. L’interface présente cette liste directement sous la progression, même si le compte rendu est replié. Le résumé indique « composants à traiter manuellement » ; il ne confirme pas que tout le site est à jour.

Une intervention manuelle peut demander de **vérifier** une mise à jour : l’absence de flux, de version ou de licence ne prouve pas qu’une nouvelle version existe. Une actualisation de l’inventaire qui constate une autre version retire le rappel correspondant du résumé du projet. Le compte rendu d’exécution reste un historique daté.

Le contrôle de sécurité en lecture seule fournit également cette liste avant toute exécution de maintenance. Elle apparaît directement sur la fiche, avec la date du contrôle et sans créer de faux compte rendu de mise à jour. Une extension publique vulnérable ayant une mise à jour disponible n’est pas classée manuelle uniquement parce que ce relevé ne propose aucune installation. Le connecteur MU Vigie est identifié comme géré par Vigie, sans demander une intervention utilisateur.

L’en-tête `Update URI` est classé localement. Une origine externe ne devient pas WordPress.org parce qu’une extension publique porte le même nom de dossier. Son URL, qui peut contenir un jeton de licence, n’est jamais renvoyée dans l’inventaire. Le contrôle public ne certifie pas cet homonyme privé.

Avant de proposer le remplacement d’une extension ordinaire, le plan WP-CLI compare ses fichiers aux empreintes de sa version publique avec `--strict`. Une différence, une vérification ignorée, des empreintes absentes ou un contrôle indisponible la conservent avec une intervention manuelle. Cela protège aussi une extension WordPress.org modifiée sur mesure. Les vérifications sont renouvelées au moment de l’exécution ; une modification concurrente après le plan arrête la publication devenue invalide. Ce refus de concurrence reste distinct d’un composant déjà conservé dans le plan.

Le cœur est également contrôlé avant une montée de version. Un cœur personnalisé ou non vérifiable est conservé et signalé. Les thèmes restent hors de la mise à jour automatique : les thèmes enfants et privés sont protégés ; une mise à jour du parent peut demander d’adapter le thème enfant. Les extensions MU métier ne sont ni remplacées ni certifiées automatiquement ; le connecteur Vigie dispose de sa propre maintenance contrôlée.

## Alertes de sécurité

Le cœur, les extensions ordinaires et les thèmes publics identifiables sont analysés avec WPVulnerability, y compris les composants inactifs. Une erreur du service reste une erreur, jamais une confirmation d’absence de faille. Les composants privés, les thèmes enfants, les versions non standard et les MU demandent une vérification spécifique. Ce contrôle compare des versions à des avis publics ; il ne recherche pas tous les fichiers malveillants d’un site.

Une version que Vigie **installe** doit passer le contrôle de sécurité. Les alertes portant sur la version exacte d’un composant **laissé inchangé** restent visibles avec un état « avec réserves », sans bloquer les autres mises à jour. Le périmètre conservé est lié au plan original, y compris après installation : une autre version du même composant n’obtient pas cette tolérance. Le garde final applique cette distinction uniquement aux rapports WPVulnerability de maintenance WordPress ; les autres contrôles conservent leur politique.

Le catalogue d’une extension déjà qualifiée manuelle ne participe pas à la sélection des autres mises à jour. Son contrôle de failles reste tenté en lecture seule ; une panne sur cette extension conservée ou sur un thème conservé produit une réserve explicite et ne bloque pas le cœur ni les extensions admissibles. Cette panne n’est pas répétée à chaque phase du même traitement. Une panne de contrôle sur une version que Vigie doit installer reste bloquante : aucun composant non vérifié n’est installé.

Ce cas est validé sur un WordPress Docker réel : le cœur et Classic Editor sont mis à jour pendant qu’Akismet personnalisé reste identique, avec une panne simulée du seul catalogue Akismet et les vrais contrôles publics pour les composants installés. Les contrôles HTTP et la restauration réussissent. Validation complémentaire : 283 tests locaux réussis, zéro échec, 41 intégrations optionnelles ignorées ; l’intégration WordPress correspondante est exécutée séparément et réussit. Journaux : `.data/analysis/wordpress-partial-maintenance-tests.log`, `wordpress-partial-maintenance-integration.log` et `wordpress-partial-maintenance-build.log`.

Le résultat « maintenance automatique terminée » peut donc coexister avec des failles restant à traiter. Une alerte critique ou de distribution malveillante conservée exige une intervention rapide : vérifier les fichiers et accès, rechercher une compromission et qualifier une correction ou un remplacement. Une simple mise à jour ne prouve pas l’assainissement du site.

## Points de qualification encore nécessaires pour le parc réel

Ces points sont des opérations à organiser ; ils ne sont pas tous automatisés par Vigie.

| Sujet | Vérification attendue |
| --- | --- |
| Extensions premium et licences | Identifier l’éditeur, le titulaire de la licence et l’accès au paquet ; tester le flux sur chaque domaine. Ne pas déduire une licence valide de l’absence de proposition de mise à jour. |
| Code personnalisé | Identifier son responsable et sa source ; reporter les modifications sur une copie. Les empreintes publiques détectent une différence, sans distinguer personnalisation légitime et altération malveillante. |
| Sauvegardes | Vérifier fichiers et base ensemble, tester la restauration, suivre l’espace disque et disposer d’une copie indépendante du compte o2switch. Une archive privée sur le même compte ne protège pas contre sa perte complète. |
| Boutiques et sites recevant des données | Tester panier, commande, paiement, formulaires et connexions ; prévoir une fenêtre pour les migrations. Une restauration SQL peut perdre les nouvelles commandes ou soumissions. Elle reste une décision explicite. |
| Préproduction | Utiliser une base distincte ; vérifier les URL, les licences et les intégrations. Neutraliser envois d’emails, paiements réels, webhooks et synchronisations pour éviter des actions métier depuis la copie. Ne pas écraser la base active par celle d’un ancien clone. |
| PHP | Vérifier le PHP web et CLI, les extensions nécessaires et les autres sites affectés par un changement de configuration. Le serveur mutualisé et le moteur SQL restent gérés avec l’hébergeur. |
| Compatibilité | Les prérequis déclarés ne prouvent pas que WooCommerce, ses passerelles, le constructeur de pages et les extensions sur mesure fonctionnent ensemble. Valider les fonctions critiques sur une copie. |
| Automatisations concurrentes | Recenser mises à jour WordPress natives, WP Tiger et autres outils pour éviter qu’ils modifient les versions pendant une intervention Vigie. Un changement détecté invalide le plan. |
| Caches et tâches | Contrôler cache de pages et d’objets, OPcache, tâches cron, files de commandes et webhooks. Une page en cache qui répond HTTP 200 ne prouve pas que WordPress fonctionne. |
| Composants hors inventaire courant | Examiner les drop-ins (`object-cache.php`, `advanced-cache.php`, `db.php`), les chargeurs MU et leurs sous-dossiers, scripts autonomes et installations autres que WordPress. La découverte cPanel ne constitue pas leur maintenance. |
| Sécurité du compte | Revoir accès cPanel, administrateurs WordPress, secrets, droits et autres sites du même compte. Aucun durcissement automatique de ces réglages n’est ajouté par ce changement. |

## Déploiement et validation

Les sources de l’observateur passent en 1.0.5 et le paquet de l’agent en `core-plugins-free-v5`. Leur mise à niveau utilise les propriétaires et empreintes déjà enregistrés ; les fichiers distants inconnus restent protégés. Les tests d’installation de correctifs utilisent des WordPress jetables.

Les tests ciblent les homonymes privés, le maintien des alertes sur les versions conservées, le refus des versions modifiées vulnérables, l’invalidation du cache sur changement de thème ou d’origine, les actions manuelles et la préservation réelle d’une extension publique modifiée pendant la mise à jour d’une autre extension sur un WordPress Docker jetable. La mise en production reste à qualifier sur une copie représentative du parc.

Validation locale du 28 octobre 2026 : 327 tests recensés, 286 réussis, zéro échec et 41 intégrations optionnelles ignorées. Les intégrations WordPress SSH et agent privé ont aussi été exécutées séparément et réussissent. L’agent utilise l’API WPVulnerability réelle pour les composants modifiés, avec une panne simulée du catalogue d’un composant personnalisé conservé. Les empreintes du cœur personnalisé et de l’extension personnalisée restent identiques pendant la mise à jour d’une autre extension. Sauvegarde, restauration après échec et contrôle HTTP sont vérifiés sur WordPress jetable. Le typage et le build de production passent. Journaux dans `.data/analysis/` : `wordpress-partial-maintenance-integration.log`, `wordpress-readiness-full-tests.log`, `wordpress-readiness-health-tests.log` et `wordpress-readiness-build.log` ; rapport `wordpress-local-agent-pilot.json`.

Test navigateur intégré sur Tronconic le même jour : connexion Google normale à la version locale, actualisation de l’inventaire réel, vérification des 22 extensions et 4 thèmes, mise à niveau du connecteur existant en 1.0.5 et de l’agent existant en v5, battement et qualification signés, puis opération `inspect` uniquement. Le plan réel identifie zéro changement automatique applicable et dix composants manuels ; les trois alertes Kirki/WPForms restent visibles et le contrôle de maintenance retourne « avec réserves ». Aucune opération `backup`, `update` ou `restore` n’a été envoyée sur la boutique. Le contrôle signé de l’agent a été renouvelé sans réinstallation. Les résultats se trouvent dans `.data/analysis/tronconic-browser-preflight.json`.

Ce test a révélé puis corrigé une écriture `json_set` SQLite dans la persistance des empreintes du connecteur, incompatible avec PostgreSQL. L’écriture utilise désormais un document JSON sérialisé, en conservant les métadonnées, sur les deux moteurs. Une régression PostgreSQL isolée vérifie installation, mise à niveau, conservation de la clé et refus d’un fichier distant inconnu (`tests/wordpress-observer-postgres.test.ts`).

Le résumé affiche désormais la configuration actuelle, la disponibilité technique et les interventions manuelles. Un ancien échec reste un compte rendu historique replié. Les correctifs d’un composant conservé ne sont pas comptés comme mises à jour automatiques disponibles. Les quatre paramètres publics de maintenance ont été alignés localement sur Vercel ; l’exécuteur local reste déconnecté faute de jeton GitHub local. Les jetons de production sont de type sensible et ne sont pas exportés. Le bouton désactivé affiche cette cause précise ; ce test ne valide pas une installation de correctifs via ce bouton. La publication des sources reste nécessaire pour que l’exécuteur GitHub utilise cette version.

Références : [en-tête Update URI](https://make.wordpress.org/core/2021/06/29/introducing-update-uri-plugin-header-in-wordpress-5-8/), [empreintes WP-CLI](https://developer.wordpress.org/cli/commands/plugin/verify-checksums/), [API WPVulnerability](https://docs.wpvulnerability.com/), [préproduction WP Tiger et risque de remplacement des données](https://blog.o2switch.fr/preproduction-wptiger/).
