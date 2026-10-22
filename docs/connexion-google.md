# Configuration de la connexion Google

Vigie utilise Better Auth avec le fournisseur Google uniquement. L’identité doit provenir d’un compte Google vérifié et son adresse doit figurer dans la liste fermée. Les autres adresses du domaine ne sont pas autorisées implicitement.

Adresses prévues : `theo.leroux@reborn-france.com` et `contact@reborn-france.com`.

Projet Google Cloud : **Vigie** (`vigie-512409`), dans l’organisation `reborn-france.com`. Audience **Interne**. Le règlement a été accepté avec l’autorisation de l’utilisateur et le client **Vigie — local** a été créé. Ses identifiants sont enregistrés dans `.env.local` ; le secret n’est pas documenté ici.

Le parcours réel a été validé le 22 octobre 2026 avec `theo.leroux@reborn-france.com` : identité Google vérifiée, session créée et ouverture du parc de 9 sites confirmée par l’utilisateur. L’inventaire et l’export répondent HTTP 401 sans session. L’initialisation OAuth utilise l’URI de retour exacte, la portée `email profile openid`, PKCE et un état OAuth protégé.

## Créer le client OAuth

1. Se connecter à [Google Cloud Console](https://console.cloud.google.com/auth/clients) avec le compte professionnel chargé de l’application.
2. Sélectionner un projet dédié à Vigie, ou en créer un si nécessaire.
3. Configurer Google Auth Platform : nom d’application `Vigie`, adresse d’assistance et contact développeur de l’équipe. Si le projet appartient à votre organisation Google Workspace, choisir l’audience **Interne**. Sinon, utiliser l’audience **Externe** en test et ajouter les deux adresses comme utilisateurs test. La restriction à ces deux comptes reste appliquée par Vigie dans les deux cas.
4. Créer un client OAuth de type **Application Web**.
5. Ajouter l’origine JavaScript autorisée : `http://127.0.0.1:3001`.
6. Ajouter l’URI de redirection autorisée :

   ```text
   http://127.0.0.1:3001/api/auth/callback/google
   ```

7. Renseigner `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` dans `.env.local`, sans copier les valeurs dans un fichier suivi par Git.

La clé `BETTER_AUTH_SECRET` a été générée localement. La conserver privée et stable ; elle signe les cookies et chiffre les jetons OAuth conservés dans la base.

## Vérifier

Redémarrer le serveur si nécessaire : `npm run dev -- --port 3001`.

Ouvrir [la connexion](http://127.0.0.1:3001/connexion), choisir l’un des deux comptes autorisés, vérifier l’ouverture du parc réel puis la déconnexion. Un autre compte ne doit pas accéder aux fiches ni aux exports. Tant que les identifiants OAuth sont absents, le bouton reste désactivé et les données restent protégées.

## Contrôles

- Connexion Google uniquement : pas de mot de passe, de lien magique ou de compte de démonstration.
- Session persistée en base, de 12 heures, vérifiée côté serveur pour chaque accès aux données.
- Liste d’adresses relue à chaque accès : retirer une adresse bloque aussi ses sessions existantes.
- Cookies HttpOnly et SameSite=Lax ; Secure sur une origine HTTPS.
- Aucun cache de session dans un cookie client ; une révocation en base prend effet sans attendre un cache.
- Vérification OAuth/state et protections CSRF assurées par Better Auth. Seul le retour GET exact de Google est exempté du contrôle local d’origine ; il reste soumis à la validation OAuth.
- Jetons OAuth chiffrés en base ; secret séparé dans l’environnement.
- L’auteur des nouvelles opérations est enregistré dans le journal.

Cette configuration reste limitée au poste local. Une URL d’équipe sur un domaine HTTPS demandera de mettre à jour l’origine, l’URI de retour et l’hébergement.

Documentation : [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Better Auth Google](https://better-auth.com/docs/authentication/google), [Next.js](https://better-auth.com/docs/integrations/next).
