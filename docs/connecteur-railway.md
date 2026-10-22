# Connecteur Railway — V1

Le connecteur utilise l’API publique GraphQL Railway, exclusivement sur `https://backboard.railway.com/graphql/v2`. Sa requête est fixe et ne comporte aucune mutation. Aucun agent n’est installé, aucun service n’est redémarré et aucun déploiement n’est déclenché.

## Utilisation

Dans **Connexions → Railway**, connecter un workspace avec son identifiant et un jeton API limité à ce workspace. Le jeton est créé dans les [paramètres des jetons Railway](https://railway.com/account/tokens) en choisissant le workspace concerné. Un jeton de workspace a également des droits d’écriture chez Railway : la limitation à la lecture est assurée par les opérations du connecteur, pas par une permission « lecture seule » du jeton.

Le jeton est chiffré par AES-256-GCM, avec la clé privée `VIGIE_CONNECTOR_ENCRYPTION_KEY` et un contexte lié à la connexion et au workspace. Il n’apparaît pas dans les réponses publiques, les exports ou l’historique. Les sessions Google et les contrôles d’origine de Vigie protègent toutes les routes du connecteur. Le jeton reste utilisable après un redémarrage de Vigie tant que la même clé de chiffrement est conservée.

**Synchroniser Railway** relit le workspace et conserve un instantané daté. Le rattachement privilégie un identifiant de projet Railway déjà enregistré dans les accès de la fiche. Sinon, un domaine identique et unique peut identifier la fiche. Les noms proches ne suffisent pas ; les projets archivés sont exclus. Les clients, environnements et services renseignés manuellement ne sont pas remplacés par le relevé. Les associations manuelles sont conservées aux synchronisations suivantes.

Un projet non reconnu reste proposé à l’ajout ou au rattachement. **Ajouter une fiche** crée uniquement une fiche Vigie ; cette action est idempotente et ne crée pas de projet chez Railway. Déconnecter retire le secret de Vigie, en conservant les relevés. Révoquer le jeton côté Railway se fait séparément dans les paramètres Railway.

## Données collectées

- Identifiants et noms du workspace, des projets, des environnements et des services ; environnements temporaires signalés.
- Domaines publics, dépôt ou image configurés, constructeur, région, nombre de réplicas, répertoire racine, chemin du contrôle de santé et planification cron.
- Déploiements actifs et dernière tentative, avec identifiant, état et dates. Une tentative échouée ne remplace pas l’état d’un déploiement précédent encore actif.
- Pour chaque déploiement : dépôt GitHub, branche, commit exact, répertoire et digest de l’image lorsque Railway les communique. Le lien de code ouvre ce commit, pas la tête actuelle de la branche.
- Versions résolues par Railpack lors de la construction de ce déploiement, framework détecté et version du constructeur. Node utilisé pour construire un frontend statique est distingué de Caddy utilisé pour le servir ; les outils tels que pnpm restent identifiés comme outils de construction.
- Comparaison de Node avec la dernière version de sa branche majeure, dernière LTS et calendrier officiel de support. Les publications de sécurité postérieures à la version observée sont signalées. Une branche en fin de support est signalée même si son dernier numéro de version est installé.
- Comparaison de Caddy avec sa dernière publication stable officielle. Les autres outils détectés affichent leur version avec un état de mise à jour inconnu tant qu’un catalogue fiable n’est pas ajouté.

Les états sont ceux de l’API Railway. Un déploiement `SUCCESS` n’est pas une preuve de disponibilité HTTP ni de bon fonctionnement métier. Une source ou une image configurée peut différer de celle du déploiement actif. Un tag Docker n’est pas une preuve de version exécutée.

Aucune requête ne demande les variables d’environnement, les journaux, les données des bases ou les secrets de registres. Pour identifier le code et la construction d’un déploiement précis, le connecteur demande désormais `Deployment.meta`. C’est un scalaire JSON : l’API ne permet pas d’en sélectionner les sous-champs. Le serveur filtre immédiatement sa réponse sur une liste fermée de champs et formats. Les métadonnées brutes, manifestes, commandes, messages de commit et autres données éventuelles ne sont ni enregistrés, ni journalisés, ni renvoyés au navigateur.

Les versions affichées proviennent de la **construction du déploiement indiqué**, pas d’une mesure du processus en cours. Un déploiement en construction ou en échec ne devient pas la version d’un conteneur déjà déployé. Lorsque Railpack ne fournit pas de version résolue (notamment pour Docker ou d’anciens builds), la version reste inconnue. Un tag tel que `node:20-slim` décrit une branche déclarée et ne prouve pas le correctif exécuté. Les dépendances applicatives ne sont pas encore collectées.

Les catalogues Node sont téléchargés depuis `nodejs.org/dist/index.json` et le calendrier officiel `nodejs/Release`. Caddy utilise la dernière publication stable de `caddyserver/caddy`. Les requêtes sont bornées, sans redirection et sans transmission du jeton Railway. Les résultats valides sont conservés six heures dans `software_release_catalog`. Les publications futures et préversions ne sont pas utilisées. Un catalogue indisponible produit un état inconnu, jamais un état « à jour » par défaut.

## Limites et erreurs

Le délai global est de 90 secondes ; chaque réponse est limitée à 8 Mo. Les projets sont paginés par 50 jusqu’à 500 projets. Au-delà de 50 environnements par projet ou de 100 services par environnement, le relevé est refusé explicitement. Une réponse GraphQL partielle, un périmètre inattendu, une erreur réseau ou un refus API ne deviennent jamais un relevé vide réussi. Les messages bruts du fournisseur ne sont pas relayés pour éviter qu’ils exposent des valeurs sensibles.

Deux synchronisations du même compte doivent être espacées de 30 secondes. Les appels concurrents sont refusés. Une nouvelle saisie de jeton permet une nouvelle tentative immédiate. Les erreurs conservent le dernier relevé réussi ; un projet disparu est signalé comme absent, pas supprimé. Un relevé de plus de 24 heures est signalé dans la fiche.

Les tests utilisent une base en mémoire et des réponses simulées. Ils contrôlent la requête de lecture, la pagination, le chiffrement, les associations, les dernières observations, les états des déploiements et l’authentification des routes. Le script d’administration `scripts/connect-railway.ts --sync-only` permet de relire le workspace déjà autorisé sans recréer de jeton.

Référence : [documentation officielle de l’API Railway](https://docs.railway.com/integrations/api).

## Compléter les conteneurs sans versions Railpack — proposition non activée

Une lecture ponctuelle dans les conteneurs permettrait de mesurer les versions manquantes. Le [client officiel Railway](https://docs.railway.com/cli/ssh) ouvre une session SSH et nécessite une clé enregistrée. Une clé dédiée au workspace donnerait techniquement un accès shell à ses services ; la limitation aux commandes ci-dessous serait celle du collecteur, pas une permission de lecture seule fournie par Railway.

Le relevé proposé se limiterait aux services déjà démarrés, avec un délai court, une commande de version par logiciel détecté, puis fermeture de la session : `node --version`, `caddy version`, `python3 --version`, `php -n --version`, `postgres --version` ou `tailscale version`. Il ne lancerait ni le code applicatif, ni une commande de mise à jour, ni une lecture des variables, ni une requête métier dans les bases. Les services de qualification, en construction ou arrêtés seraient exclus. Les sept services actuellement sans version résolue comprennent Docs NesApp, tailscale, francofil-surveillance, les deux Postgres et les deux services Mon bilan Prévention. Le service de sauvegarde Francofil en changement n’est pas concerné par cette proposition.

Aucune clé SSH n’a été créée ou enregistrée et aucune de ces commandes n’a été exécutée. Cette étape attend un accord distinct, conformément à la consigne de validation avant toute nouvelle intervention sur Railway.
