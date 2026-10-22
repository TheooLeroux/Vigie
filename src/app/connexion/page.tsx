import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { authConfiguration } from "@/lib/auth-policy";
import { GoogleSignIn } from "@/components/google-sign-in";
import { ThemeToggle } from "@/components/theme-toggle";
export const dynamic = "force-dynamic";
export const metadata = { title: "Connexion — Vigie" };
export default async function Connexion({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentSession(new Headers(await headers()))) redirect("/");
  const config = authConfiguration();
  const query = await searchParams;
  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-heading">
          <div className="login-wordmark">Vigie</div>
          <ThemeToggle />
        </div>
        <h1>Connexion</h1>
        <p className="login-intro">
          Connectez-vous avec votre compte Google professionnel pour accéder au
          parc.
        </p>
        <GoogleSignIn configured={config.ready} />
        {query.error && (
          <p className="login-error" role="alert">
            Connexion refusée ou interrompue. Utilisez l’une des deux adresses
            autorisées.
          </p>
        )}
        <p className="login-restriction">
          Accès réservé aux membres autorisés de Reborn France.
        </p>
        {!config.ready && (
          <section className="google-setup" aria-label="Configuration Google">
            <h2>Client Google à configurer</h2>
            <p>Le client OAuth Google Cloud n’a pas encore été renseigné.</p>
            <dl>
              <dt>Origine JavaScript autorisée</dt>
              <dd>
                <code>{config.baseUrl}</code>
              </dd>
              <dt>URI de redirection autorisée</dt>
              <dd>
                <code>{config.callbackUrl}</code>
              </dd>
            </dl>
            <p>
              Les identifiants OAuth doivent être ajoutés dans{" "}
              <code>.env.local</code>.
            </p>
            <a
              href="https://console.cloud.google.com/auth/clients"
              target="_blank"
              rel="noopener noreferrer"
            >
              Ouvrir Google Cloud ↗
            </a>
          </section>
        )}
      </div>
    </main>
  );
}
