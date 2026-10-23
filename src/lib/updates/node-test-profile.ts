export function nodeTestProfile(manifest: Record<string, any>, environmentSchema: string) {
  if (manifest.name !== "backend" || !manifest.dependencies?.["@supabase/supabase-js"] || !["JWT_REFRESH_SECRET", "SUPABASE_JWT_SECRET", "ADMIN_BOOTSTRAP_SECRET", "PI_API_SECRET"].every(name => environmentSchema.includes(name))) return null;
  return {
    message: "Tests NesAppli : configuration factice locale utilisée, sans secrets ni services de production.",
    environment: {
      JWT_SECRET: "vigie-test-only-jwt-secret-never-use-in-production-123456789",
      JWT_REFRESH_SECRET: "vigie-test-only-refresh-secret-never-use-in-production-123456789",
      SUPABASE_URL: "http://127.0.0.1:9",
      SUPABASE_ANON_KEY: "vigie-test-only-anonymous-key-not-a-real-credential",
      SUPABASE_SERVICE_ROLE_KEY: "vigie-test-only-service-key-not-a-real-credential",
      SUPABASE_JWT_SECRET: "vigie-test-only-supabase-secret-never-use-in-production-123456789",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "9",
      SMTP_USER: "test@example.invalid",
      SMTP_PASS: "vigie-test-only-not-a-real-password",
      SMTP_FROM: "test@example.invalid",
      ADMIN_BOOTSTRAP_SECRET: "vigie-test-only-admin-secret-never-use-in-production-123456789",
      PI_API_SECRET: "vigie-test-only-pi-secret-never-use-in-production-123456789",
    },
  };
}
