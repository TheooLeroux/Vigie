# Connecteur Vercel — V1

Le connecteur découvre les projets d’une équipe via l’API REST officielle Vercel. Toutes ses requêtes sont des `GET` sur `https://api.vercel.com`, sans redirection. Il ne déploie pas, ne promeut pas, ne redémarre pas et ne supprime pas de ressources chez Vercel.

## Découverte puis choix des projets

Dans **Connexions → Vercel**, **Synchroniser Vercel** récupère tous les projets visibles de l’équipe. Les projets existants dans Vigie sont reconnus seulement par un accès Vercel exact ou une correspondance unique de domaine. Un nom proche ou un dépôt commun ne suffit pas à fusionner deux projets.

**La découverte ne crée aucune nouvelle fiche projet ni aucun client.** Les nouveaux éléments restent dans la liste de découverte. Cliquer sur une ligne ouvre son relevé ; **Ajouter au parc** crée la fiche, son environnement et son service initial, son accès Vercel et son association client en une seule transaction. Une seconde requête sur le même élément retrouve la même fiche. **Rattacher à une fiche** permet de choisir une fiche existante en cas d’ambiguïté.

Les noms et attributions fournis par l’utilisateur le 22 octobre 2026 sont dans `src/lib/vercel-client-mapping.ts`, pour l’équipe `team_nmJybhbrvWmdYiNrGlwGyfAQ` uniquement. Le client n’est créé ou réutilisé que lors de l’ajout ou d’un rattachement choisi. Un client déjà renseigné et les champs manuels de la fiche sont conservés. Une nouvelle synchronisation ne réapplique pas l’attribution d’origine à une fiche dont le client a été modifié.

La première résolution d’un client mémorise son identifiant dans `vercel_client_links`. Si le client est ensuite renommé dans Vigie, les prochains ajouts réutilisent cet identifiant et ne recréent pas un client sous l’ancien nom.

La liste permet de chercher un projet, client ou domaine, et de filtrer les éléments à ajouter, déjà dans le parc ou exclus. Les clients non précisés restent inconnus ; aucune attribution n’est inventée pour les autres projets de la même équipe.

## Projets « À virer »

`released-scan-demo` et `mtt-lab` sont identifiés comme **exclus du suivi**, conformément à la consigne de ne pas y toucher. La lecture globale de la liste révèle leur existence, mais le connecteur n’appelle pas leurs domaines ni leurs déploiements. Il conserve uniquement leur identité minimale pour les afficher comme exclus. Leur ajout et leur rattachement sont bloqués côté serveur, pas seulement dans l’interface. Aucune suppression n’est effectuée, chez Vercel ou dans les fiches existantes.

## Données observées

- Identifiants et noms de l’équipe et des projets.
- Domaines, vérification, redirections et environnement de rattachement.
- Framework, répertoire, branche Node et dépôt configurés pour les prochains déploiements.
- Déploiement de production **désigné par `targets.production`**, avec son état, ses dates, son URL, ses régions et, lorsque fournis, son dépôt, sa branche et son commit Git. Un dernier aperçu prêt ou un déploiement en échec ne remplace jamais la production désignée.
- Dernier déploiement, présenté séparément quand son identifiant diffère de la production.

Les liens de code utilisent le commit réellement associé au déploiement, pas la tête actuelle de la branche. Un déploiement CLI sans dépôt connu reste explicitement sans dépôt communiqué. Le relevé ne constitue pas un contrôle HTTP de disponibilité du site.

## Node et mises à jour

Vercel expose généralement une branche telle que `22.x` ou `24.x`, et prend en charge ses mises à jour mineures et correctives. Une branche ne prouve pas un numéro de correctif installé : le plateau n’en déduit jamais « à jour » ou « correctif manquant ».

La branche attachée au déploiement de production est séparée de la configuration actuelle des prochains déploiements. Son support officiel est vérifié avec le calendrier Node et le catalogue officiel déjà utilisés pour Railway, en cache six heures. Le statut de support et la dernière LTS sont accessibles sans transmettre le jeton Vercel aux catalogues externes. Un catalogue indisponible laisse le support inconnu.

## Analyse des technologies et versions

La synchronisation lit les journaux **de build** du seul déploiement désigné en production, via `GET /v3/deployments/{id}/events?builds=1&follow=0&direction=forward&limit=1000`. Elle ne lit pas les journaux des requêtes en cours. Les événements bruts ne sont ni stockés, ni affichés, ni journalisés. Le parseur extrait seulement les numéros exacts d’une liste fermée : Next.js, Vite, Nuxt, Astro, SvelteKit, React, React DOM, TypeScript, npm, pnpm et Yarn. Il ignore contraintes de versions, commandes, avertissements, préversions, chemins, messages et variables. Un composant absent des journaux reste inconnu ; aucune déduction d’inventaire exhaustif n’est faite.

Les versions observées au build sont comparées à la balise `latest` du registre public npm, uniquement pour cette liste de paquets, sans transmettre le jeton Vercel. Le cache dure six heures. L’interface distingue nouvelle majeure et version plus récente ; elle ne qualifie pas une version de sûre et n’effectue aucune mise à jour. Une panne du catalogue conserve les versions observées et laisse la comparaison inconnue.

Les statistiques `meta.lambdaRuntimeStats` sont filtrées pour relever les moteurs des fonctions et leur nombre (Node, Edge, Python, Go, Ruby, Bun). « JavaScript / TypeScript » désigne la famille compatible avec le moteur ou le framework observé ; cela ne prouve pas quel langage a été employé dans chaque fichier source. La vérification TypeScript est mentionnée seulement si observée au build. Le numéro correctif du moteur d’exécution et l’inventaire complet des dépendances restent non confirmés. Le dépôt, la branche et le commit de production sont distincts de la configuration des prochains déploiements ; un écart de dépôt ou de branche Node est signalé.

L’analyse est consultable avant l’ajout au parc et dans la fiche après rattachement. Des journaux indisponibles ne bloquent pas le relevé Vercel ; la dernière analyse est conservée uniquement si l’identifiant du déploiement est identique, avec date et avertissement. Un déploiement différent n’hérite jamais des versions du précédent. Une limite de 1 000 événements est signalée explicitement. Les projets exclus ne font l’objet d’aucune lecture de build.

Référence : [journaux de build Vercel](https://vercel.com/docs/rest-api/deployments/get-deployment-events).

Références : [API Vercel](https://vercel.com/docs/rest-api), [versions Node gérées par Vercel](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).

## Accès et conservation des données

Le jeton autorisé `vigie-local` est limité à « Janssen’s projects », avec expiration au 20 janvier 2027. Un jeton de ce type possède également des droits d’écriture chez Vercel ; la restriction aux lectures est celle du connecteur. Le secret est chiffré par AES-256-GCM, lié à l’identifiant de connexion et à l’équipe. Il n’est ni renvoyé au navigateur ni exporté ni journalisé. Le transfert depuis la création autorisée dans le navigateur est chiffré et supprimé après son enregistrement.

Toutes les routes exigent la session Google autorisée et respectent les gardes d’origine et d’accès local du plateau. Les réponses Vercel peuvent contenir des champs sensibles, notamment `env`, des détails d’authentification et des métadonnées d’auteurs. Seuls les champs explicitement nécessaires sont reconstruits avant enregistrement : les réponses brutes ne sont pas conservées ni renvoyées.

Le relevé est limité à 500 projets, 1 000 domaines par projet et 8 Mo par réponse, avec trois lectures de projets simultanées et un délai API global de 120 secondes. Une réponse tronquée, un changement de périmètre, une erreur d’API ou une pagination incohérente fait échouer le relevé entier ; le dernier succès est conservé et daté. Les lectures encore en cours sont annulées en cas d’échec. Un projet disparu est signalé comme absent et n’est pas supprimé.

Deux synchronisations d’une connexion sont espacées d’au moins 30 secondes et une seule peut s’exécuter à la fois. La synchronisation est déclenchée par l’interface ; aucun traitement périodique n’est ajouté dans cette V1. Le bouton de déconnexion supprime le secret local et conserve les observations ; la révocation distante du jeton reste une action distincte dans les paramètres Vercel.

Le script `node --env-file=.env.local --import tsx scripts/connect-vercel.ts --sync-only` relit la connexion déjà autorisée sans créer de fiches projet. Les tests utilisent uniquement une base en mémoire et des réponses simulées ; ils vérifient notamment l’absence de création à la découverte, l’ajout avec client en un clic, les exclusions et la distinction entre production et dernier déploiement.
