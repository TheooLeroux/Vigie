"use client";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
export function GoogleSignIn({ configured }: { configured: boolean }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function signIn() {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: "/",
        errorCallbackURL: "/connexion?error=google",
      });
      if (result.error) {
        setError(
          "La connexion Google n’a pas pu démarrer. Vérifiez la configuration.",
        );
        setBusy(false);
      }
    } catch {
      setError("La connexion Google est momentanément indisponible.");
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="google-sign-in"
        disabled={!configured || busy}
        onClick={signIn}
      >
        {busy ? (
          <Loader2 size={19} className="spin" />
        ) : (
          <svg aria-hidden="true" viewBox="0 0 48 48" width="20" height="20">
            <path
              fill="#4285F4"
              d="M43.6 24.5c0-1.4-.1-2.8-.4-4.2H24v8h11a9.4 9.4 0 0 1-4.1 6.2v5.2h6.6c3.9-3.6 6.1-8.9 6.1-15.2z"
            />
            <path
              fill="#34A853"
              d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.6-5.2c-1.8 1.2-4.1 1.9-6.9 1.9-5.3 0-9.8-3.6-11.4-8.4H5.8v5.4A20.4 20.4 0 0 0 24 44z"
            />
            <path
              fill="#FBBC05"
              d="M12.6 27.4a12.2 12.2 0 0 1 0-7.8v-5.4H5.8a20.3 20.3 0 0 0 0 18.6z"
            />
            <path
              fill="#EA4335"
              d="M24 11.2c3 0 5.7 1 7.8 3.1l5.8-5.8A19.4 19.4 0 0 0 24 3a20.4 20.4 0 0 0-18.2 11.2l6.8 5.4C14.2 14.8 18.7 11.2 24 11.2z"
            />
          </svg>
        )}
        Se connecter avec Google
      </button>
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
