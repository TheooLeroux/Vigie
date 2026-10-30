// GitHub supplies both values automatically, so existing workflows need no
// changes. A manual workflow_dispatch must keep its unconditional force.
export function forcedControlRevision(environment: Record<string, string | undefined>) {
  const revision = environment.VIGIE_CONTROL_FORCE_REVISION
    || (["push", "deployment_status"].includes(environment.GITHUB_EVENT_NAME || "") ? environment.GITHUB_SHA : undefined);
  if (revision && !/^[a-f0-9]{40}$/i.test(revision)) throw new Error("Révision du moteur invalide.");
  return revision;
}
