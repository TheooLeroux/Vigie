/** Extension boundary for future authenticated collectors. No live connector is enabled in V0.1. */
export type EvidenceLevel = "declared" | "build" | "runtime";
export type ConnectorCapability = "discover-projects" | "discover-resources" | "inventory-components" | "observe-runtime" | "deployment-metadata";
export type ConnectorContext = {
  installationId: string;
  signal: AbortSignal;
  /** Secrets are resolved server-side and must never be returned in the snapshot or logs. */
  getSecret: (reference: string) => Promise<string>;
};
export type ConnectorObservation = {
  externalId: string;
  environment: string;
  collectedAt: string;
  evidence: EvidenceLevel;
  deploymentId?: string;
  commitRef?: string;
  components: {name:string; ecosystem:string; version:string; scope:"production"|"development"|"unknown"}[];
  warnings: string[];
};
export interface ReadOnlyConnector {
  id: string;
  version: string;
  capabilities: readonly ConnectorCapability[];
  collect(context: ConnectorContext): Promise<ConnectorObservation[]>;
}
