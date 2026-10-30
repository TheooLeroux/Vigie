# Actualisation des projets

La liste, la fiche, les vulnérabilités, l’avancement des mises à jour et l’historique utilisent un unique abonnement WebSocket Neon Realtime par onglet. Les anciens intervalles HTTP de 60 et 8 secondes sont supprimés. Les écritures des workers sont prises en compte directement en base.

La requête live renvoie uniquement des identifiants et des empreintes, calculées sur la réplique Realtime. Le client compare les empreintes et relit les projets concernés par les changements ; les modifications rapprochées sont regroupées et une modification reçue pendant une lecture déclenche une lecture suivante. Les reliaisons et suppressions invalident également l’ancien projet. Les caches de téléchargement et les verrous des workers ne déclenchent pas de relecture.

Un onglet masqué conserve les notifications et les applique à son retour. Le SDK reprend la connexion après une coupure ; les erreurs définitives sont affichées avec un bouton de reconnexion. Aucune boucle de polling des données ne sert de secours.

Le temps réel transmet les résultats enregistrés, il ne lance pas les analyses. Si les contrôles planifiés prennent du retard, les compteurs conservent le dernier résultat disponible avec sa date, son périmètre partiel éventuel et l’avertissement « À actualiser ». Ce résultat historique est distinct du compteur actuel : un ancien scan sans alerte ne valide jamais un zéro actuel, et un rapport absent ou bloqué ne fournit pas de zéro. La fiche permet de consulter les signalements du rapport conservé.

## Configuration

1. Activer Neon Realtime sur la branche de production, dans une région prise en charge.
2. Autoriser l’origine exacte de l’application et les origines locales utilisées.
3. Ajouter `NEON_REALTIME_URL` et `NEON_REALTIME_SECRET` dans les variables **serveur** de Vercel et dans `.env.local`. Ne jamais utiliser de préfixe `NEXT_PUBLIC_` pour le secret.

Le nom de la base est dérivé de `DATABASE_URL`. Aucun service Supabase, processus permanent sur Vercel ou changement de schéma n’est nécessaire.

## Authentification et consommation

`POST /api/realtime` exige initialement la session Google autorisée. Le serveur scelle une requête fixe : aucun SQL ou filtre fourni par le navigateur n’est accepté. Les secrets et le SQL ne sont pas renvoyés en clair.

Les capacités Neon expirent après 60 secondes. Leur renouvellement vérifie un mandat signé limité à cette requête et utilise uniquement la cryptographie locale : **aucune lecture de session ou de projet en base à chaque renouvellement**. Le mandat est conservé uniquement en mémoire. La requête live vérifie l’existence de la session, son propriétaire, son échéance enregistrée et l’identité Google vérifiée ; une révocation fait disparaître immédiatement le résultat et coupe l’abonnement. Le serveur vérifie aussi l’expiration du mandat et la liste des emails autorisés à chaque renouvellement. Les autres API conservent leur vérification de session habituelle.

Selon la [documentation Neon](https://neon.com/docs/realtime/overview), maintenir un abonnement n’empêche pas la mise en veille. Le démarrage de l’abonnement et les relectures après changement peuvent réveiller la base. Le service Realtime est gratuit pendant sa bêta, mais le calcul de la base et les transferts restent soumis au forfait. Les contrôles planifiés des hébergeurs restent indépendants de l’actualisation de l’écran.

## Vérification

`npm test` couvre l’autorisation, le renouvellement sans lecture de session, les invalidations ciblées et les rafales. Avec `VIGIE_UPDATES_TEST_DATABASE_URL` pointant vers un PostgreSQL local, le test d’intégration exécute la vraie requête sur les tables migrées et vérifie les écritures de workers, les contrôles Railway sans sources, les reliaisons, les suppressions et les révocations. La CI active ce test.
