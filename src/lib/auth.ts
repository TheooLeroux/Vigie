import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { authDatabase } from "./storage";
import { authConfiguration, isAllowedGoogleUser } from "./auth-policy";
import { ApiError } from "./http";

function createAuth() {
  const configuration = authConfiguration();
  if (!configuration.ready)
    throw new ApiError("La connexion Google n’est pas encore configurée.", 503);
  return betterAuth({
    appName: "Vigie",
    baseURL: configuration.baseUrl,
    secret: process.env.BETTER_AUTH_SECRET!,
    database: authDatabase(),
    trustedOrigins: [configuration.baseUrl],
    emailAndPassword: { enabled: false },
    user: {
      validateUserInfo: ({user,source}) => {
        if(source.method!=="oauth"||source.oauth?.providerId!=="google"||typeof user.email!=="string"||!isAllowedGoogleUser({email:user.email,emailVerified:user.emailVerified===true})) {
          return {error:"google_account_not_allowed",errorDescription:"Ce compte Google n’a pas accès à Vigie."};
        }
      },
    },
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        prompt: "select_account",
      },
    },
    account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
    telemetry: { enabled: false },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 30,
      cookieCache: { enabled: false },
    },
    advanced: {
      cookiePrefix: "vigie",
      useSecureCookies: configuration.baseUrl.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    disabledPaths: [
      "/update-user",
      "/change-email",
      "/delete-user",
      "/link-social",
      "/unlink-account",
      "/sign-up/email",
      "/sign-in/email",
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isAllowedGoogleUser(user))
              throw new APIError("FORBIDDEN", {
                message: "Ce compte Google n’a pas accès à Vigie.",
              });
            return { data: user };
          },
        },
      },
    },
    onAPIError: { errorURL: `${configuration.baseUrl}/connexion?error=google` },
  });
}

type AuthInstance = ReturnType<typeof createAuth>;
const shared = globalThis as unknown as {
  vigieAuth?: {
    signature: string;
    instance: AuthInstance;
    ready: Promise<void>;
  };
};

export async function getAuth(): Promise<AuthInstance> {
  // Refresh the instance after configuration edits during local development.
  const configuration = authConfiguration();
  if (!configuration.ready)
    throw new ApiError("La connexion Google n’est pas encore configurée.", 503);
  const signature = [
    configuration.baseUrl,
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.BETTER_AUTH_SECRET,
  ].join("|");
  if (!shared.vigieAuth || shared.vigieAuth.signature !== signature) {
    const instance = createAuth();
    const ready = getMigrations(instance.options).then((migration) =>
      migration.runMigrations(),
    );
    shared.vigieAuth = { signature, instance, ready };
  }
  await shared.vigieAuth.ready;
  return shared.vigieAuth.instance;
}

export async function currentSession(headers: Headers) {
  if (!authConfiguration().ready) return null;
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers });
  if (!session || !isAllowedGoogleUser(session.user)) return null;
  return session;
}

export async function requireSession(headers: Headers) {
  const session = await currentSession(headers);
  if (!session)
    throw new ApiError("Connectez-vous avec un compte Google autorisé.", 401);
  return session;
}
