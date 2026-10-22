import { AsyncLocalStorage } from "node:async_hooks";
export type AuditActor = { name: string; email: string };
const actors = new AsyncLocalStorage<AuditActor>();
export function withAuditActor<T>(actor: AuditActor, run: () => T): T {
  return actors.run(actor, run);
}
export function auditActor() {
  return actors.getStore();
}
