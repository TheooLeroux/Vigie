# Maintenance Vercel : pilote Vigie

Le parcours conserve les mêmes tests, scans OSV et contrôles de publication que Railway. Une sonde authentifiée lit `process.versions.node` dans une fonction Node du déploiement Vercel actif. Les dépendances sont résolues, installées, testées et construites dans une image officielle de cette version exacte. Les références Node des sources reflètent cette version de validation ; elles ne prétendent pas imposer un correctif à Vercel. Une branche comme `24.x`, un déploiement READY ou un HTTP 200 ne suffisent pas.

## Qualification de la preuve

La requête POST vers `/api/maintenance/runtime` contient un défi aléatoire, le projet et le déploiement attendus. Requête et réponse sont signées avec des contextes distincts ; leur durée de validité est de 90 secondes. La réponse fournit seulement la version Node mesurée, les identifiants de projet/déploiement/commit, le dépôt, la branche et la région. Aucun inventaire de secrets ou d’environnement n’est retourné.

L’exécuteur vérifie aussi les métadonnées du déploiement par l’API Vercel, son état READY, son commit et la source configurée. La production active est relue après la mesure pour refuser un changement d’alias pendant le contrôle. L’adresse HTTPS doit être publique ; la connexion est fixée sur l’adresse DNS validée, avec vérification TLS du nom d’origine et sans redirection. Les corps sont bornés et les réponses ne sont pas mises en cache.

Une sonde absente ou non qualifiée bloque avant les installations et la publication. Le support de la version mesurée est vérifié dans le catalogue officiel Node. La branche doit correspondre à la dernière LTS ; un changement de majeure requiert une intervention préalable chez Vercel. Des services partageant leurs sources mais utilisant des versions Node différentes ne sont pas déclarés compatibles par une validation unique. Railway continue de viser exactement la dernière LTS publiée.

Lorsque Vercel fournit un ancien correctif de cette branche, la maintenance des dépendances peut réussir avec réserves. `managedNode` conserve la version réellement testée, la dernière LTS, le signal de correctif de sécurité et la date du relevé. Le résultat et l’interface indiquent séparément le correctif en attente chez Vercel, sans déclarer le site entièrement corrigé. Les failles des dépendances restent bloquantes ; aucune exception n’est ajoutée aux scans OSV.

Le runtime Vercel est mesuré de nouveau avant publication et après déploiement. Toute version différente de celle des tests bloque : un changement automatique de correctif pendant l’opération exige une nouvelle validation. Le catalogue et la sonde manquants ne sont jamais remplacés par une version supposée.

## Périmètre du pilote

Seul Vigie reçoit la route dans ce changement. Vigie et son exécuteur réutilisent leur clé de chiffrement existante pour dériver une clé propre au projet. Un autre projet pourrait recevoir uniquement cette clé dérivée dans `VIGIE_RUNTIME_PROBE_KEY` ; il ne doit jamais recevoir la clé de chiffrement des connecteurs Vigie. Aucun autre projet n’est équipé ou mis à jour pendant ce pilote.

La preuve porte sur la fonction Node de la sonde et la région observée. Elle ne prouve ni la version du processus de build, ni les fonctions Edge, ni chaque réplique de toutes les fonctions. Le rapport conserve cette limite. Elle n’invente aucune empreinte d’image Vercel et ne permet pas de réutiliser les reçus de validation réservés aux images Railway immuables. Une future maintenance refait le contrôle.

Le premier pilote a publié la sonde puis mis à jour les dépendances de Vigie : tests, typage, build et scans OSV réussis, commit `a72b60153f5a45a6dba7b15b9cca5dc50b6bed02`. La comparaison initiale à la dernière LTS a correctement conservé le résultat « À vérifier » : Node 24.21.0 mesuré, contre 24.22.1 testé. Les journaux Vercel confirment que la demande exacte a été ramenée à 24.x. Cette tentative n’est pas réécrite en réussite. Le parcours adapté doit refaire les validations sous 24.21.0 avant de conclure au succès des dépendances.

Références : [variables système Vercel](https://vercel.com/docs/environment-variables/system-environment-variables), [versions Node prises en charge](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).
