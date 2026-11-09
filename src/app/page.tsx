import { WorkspaceApp } from "@/components/workspace-app";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { readSecurityWatchSnapshot } from "@/lib/security-watch-cache";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<{ view?: string; project?: string; client?: string }> }) {
  const session = await currentSession(new Headers(await headers()));
  if (!session) redirect("/connexion");
  const { view, project, client } = await searchParams;
  const dashboard = !project && !client && (!view || view === "security");
  return (
    <WorkspaceApp
      user={{ name: session.user.name, email: session.user.email }}
      sessionId={session.session.id}
      initialWatch={dashboard ? await readSecurityWatchSnapshot() : null}
    />
  );
}
