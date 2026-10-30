# Maintenance des images Railway

Le moteur distingue les dépendances issues de Git, les archives et les images externes. Le premier adaptateur d’image prend en charge le proxy SOCKS sortant de l’image officielle `tailscale/tailscale`. Les autres images, notamment PostgreSQL, MySQL et Redis, restent en intervention séparée : leur remplacement ne qualifie pas une migration de données.

## Qualification et exécution

- Une seule instance Linux amd64 active et un déploiement réussi, sans publication concurrente.
- Proxy Tailscale en mode userspace, sans volume ni répertoire d’état persistant, avec les options réseau reconnues. Commandes de démarrage personnalisées, routes annoncées, exit nodes, Serve/Funnel et configurations persistantes sont bloqués avant écriture.
- Accès OAuth de reconnexion existant, vérifié auprès de Tailscale avec les tags déjà configurés. Aucune clé ni machine créée pour ce contrôle ; aucun jeton conservé ou affiché.
- Contrôle initial du client connecté et de l’écoute SOCKS ; sélection d’un pair déjà en ligne pour le contrôle après remplacement.
- Résolution du tag officiel `stable`, vérification cryptographique de son index, puis sélection et analyse de l’empreinte Linux amd64. Le remplacement utilise cette empreinte immuable, sans dépendre d’un déplacement ultérieur du tag.
- Lecture de la version candidate dans un conteneur isolé, sans réseau, volume, privilèges ni secrets de l’application. Aucun retour à une version Tailscale antérieure.
- Empreinte des paramètres et des variables, références de récupération chiffrées, puis revérification immédiatement avant publication. Seule la source image est écrite ; les variables, volumes et règles réseau ne sont pas réécrits.
- Déploiement identifié par l’ID retourné par Railway, vérification de l’empreinte active et d’une seule instance, sonde Tailscale/écoute SOCKS, ping du pair, puis scan final frais. Une image identique est recontrôlée sans redéploiement.

Les sondes utilisent des clés SSH éphémères révoquées en fin de contrôle, y compris en cas d’échec. Le résultat et le compteur de sécurité ne sont actualisés que si le rapport final correspond au déploiement et à l’empreinte encore observés.

## Politique de sécurité des images

Ce parcours ne modifie pas la politique Node qui impose zéro vulnérabilité finale. Pour une image officielle qualifiée, seuls des signalements de sévérité **inconnue**, déjà présents pour le même composant et le même identifiant de vulnérabilité, peuvent être conservés. Leur multiplicité ne doit pas augmenter. Une nouvelle alerte, une sévérité connue ou aggravée et une alerte de chaîne d’approvisionnement bloquent le candidat.

Les signalements conservés restent dans le rapport et le compteur. Le résultat indique « terminé avec réserves », jamais « entièrement corrigé ». Une exception au garde final exige le scan après installation, la preuve d’image et le déploiement exacts.

## Récupération et limites

Un échec après remplacement déclenche le retour à l’ancienne empreinte seulement si la configuration n’a pas dérivé. Le moteur vérifie ensuite la reconnexion ; il conserve le statut « à vérifier » et les références de déploiement. Si les paramètres ont changé ou si la récupération n’est pas confirmée, il demande une intervention et conserve le verrou du service. Aucune restauration de données n’est lancée.

Le proxy sans volume peut renouveler son identité Tailscale lors de la reconnexion. Ce parcours ne convient donc pas aux usages reposant sur une identité locale persistante ou des entrées réseau. Le contrôle du pair et du proxy ne constitue pas une recette exhaustive des applications utilisant le réseau.

Références : [configuration Docker Tailscale](https://tailscale.com/docs/features/containers/docker/docker-params), [OAuth et reconnexion](https://tailscale.com/docs/features/oauth-clients), [images Railway](https://docs.railway.com/deployments/image-auto-updates).
