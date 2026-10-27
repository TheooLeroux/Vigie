export type UpdateTarget = {
  id: string;
  projectId: string;
  name: string;
  provider: "vercel" | "railway" | "o2switch";
  connectionId: string;
  remoteId: string;
  environmentId: string | null;
  repository: string | null;
  branch: string | null;
  root: string;
  url: string | null;
  mode: "git" | "archive" | "wordpress";
  configured: boolean;
  unavailable: string | null;
  builder?: string;
};
export type UpdateStage = "queued" | "checking" | "updating" | "publishing" | "verifying" | "completed" | "failed" | "attention";
export type SecurityFinding = {
  id: string;
  aliases: string[];
  package: string;
  version: string;
  severity: "critical" | "high" | "moderate" | "low" | "unknown";
  scope?: string;
  fixedVersions?: string[];
};
export type UpdateCheck = {
  tool: "OSV" | "Trivy" | "WPScan" | "Validation" | "Node";
  phase: "before" | "candidate" | "after";
  checkedAt: string;
  scope: string;
  status: "passed" | "warning" | "blocked";
  message: string;
  findings: SecurityFinding[];
  nodeEvidence?: { version: string; deploymentId: string; imageDigest: string; source: "container" | "railpack"; usage: "runtime" | "build"; instances?: string[] };
  blockers?: SecurityFinding[];
};
export type UpdateResult = {
  targetId: string;
  name: string;
  stage: UpdateStage;
  message: string;
  commit?: string;
  previousCommit?: string;
  deploymentId?: string;
  previousDeploymentId?: string;
  backup?: string;
  warnings: string[];
  checks?: UpdateCheck[];
};
export type UpdateRun = {
  id: string;
  projectId: string;
  stage: UpdateStage;
  createdAt: string;
  updatedAt: string;
  actor: { name: string; email: string };
  targets: UpdateTarget[];
  results: UpdateResult[];
  message: string;
  workflowRunId?: string;
};
export type UpdateState = {
  enabled: boolean;
  targets: UpdateTarget[];
  runs: UpdateRun[];
};
export type SourceSettings = {
  agentInstallation?: {
    requestId: string;
    root: string;
    connectionId: string;
    state: "queued" | "installing" | "failed" | "ready";
    attempts: number;
    requestedAt: string;
    dispatchedAt?: string;
    leaseUntil?: string;
    nextAttemptAt?: string;
    error?: string;
  };
  localAgent?: import("./wordpress-agent").LocalAgentSettings;
  archive?: string;
  filename?: string;
  deploymentId?: string | null;
  sshKey?: string;
  hostKey?: string;
};
export const activeUpdateStages: UpdateStage[] = ["queued", "checking", "updating", "publishing", "verifying"];
