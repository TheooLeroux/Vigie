# Maintenance Vercel : pilote Vigie

Le parcours conserve les mêmes tests, scans OSV et contrôles de publication que Railway. Une sonde authentifiée permet désormais de lire `process.versions.node` dans une fonction Node du déploiement Vercel actif. La version doit être exactement celle des validations isolées ; une branche comme `24.x`, un déploiement READY ou un HTTP 200 ne suffisent pas.

## Qualification de la preuve

La requête POST vers `/api/maintenance/runtime` contient un défi aléatoire, le projet et le déploiement attendus. Requête et réponse sont signées avec des contextes distincts ; leur durée de validité est de 90 secondes. La réponse fournit seulement la version Node mesurée, les identifiants de projet/déploiement/commit, le dépôt, la branche et la région. Aucun inventaire de secrets ou d’environnement n’est retourné.

L’exécuteur vérifie aussi les métadonnées du déploiement par l’API Vercel, son état READY, son commit et la source configurée. La production active est relue après la mesure pour refuser un changement d’alias pendant le contrôle. L’adresse HTTPS doit être publique ; la connexion est fixée sur l’adresse DNS validée, avec vérification TLS du nom d’origine et sans redirection. Les corps sont bornés et les réponses ne sont pas mises en cache.

Une sonde absente ou non qualifiée bloque avant les installations et la publication. Le précontrôle peut observer une ancienne version Node, puisqu’une mise à jour est justement demandée. Après déploiement, toute version différente de celle testée reste bloquante. Vercel choisit les correctifs de sa branche : Vigie ne prétend pas pouvoir forcer un correctif indisponible chez l’hébergeur.

## Périmètre du pilote

Seul Vigie reçoit la route dans ce changement. Vigie et son exécuteur réutilisent leur clé de chiffrement existante pour dériver une clé propre au projet. Un autre projet pourrait recevoir uniquement cette clé dérivée dans `VIGIE_RUNTIME_PROBE_KEY` ; il ne doit jamais recevoir la clé de chiffrement des connecteurs Vigie. Aucun autre projet n’est équipé ou mis à jour pendant ce pilote.

La preuve porte sur la fonction Node de la sonde et la région observée. Elle ne prouve ni la version du processus de build, ni les fonctions Edge, ni chaque réplique de toutes les fonctions. Le rapport conserve cette limite. Elle n’invente aucune empreinte d’image Vercel et ne permet pas de réutiliser les reçus de validation réservés aux images Railway immuables. Une future maintenance refait le contrôle.

Le pilote comporte d’abord la publication du code de la sonde, puis sa qualification sur le déploiement actif, avant une maintenance réelle du seul projet Vigie. Une réussite de tests locaux ne constitue pas une réussite de cette maintenance.

Références : [variables système Vercel](https://vercel.com/docs/environment-variables/system-environment-variables), [versions Node prises en charge](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).
