import { WorkspaceApp } from "@/components/workspace-app";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
export const dynamic = "force-dynamic";
export default async function Page() {
  const session = await currentSession(new Headers(await headers()));
  if (!session) redirect("/connexion");
  return (
    <WorkspaceApp
      user={{ name: session.user.name, email: session.user.email }}
    />
  );
}
