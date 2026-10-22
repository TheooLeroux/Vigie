export type RailwayDeployment = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  evidence?: RailwayDeploymentEvidence | null;
};
export type SoftwareRelease = {
  state: "available" | "current" | "ahead" | "unknown";
  latestVersion: string | null;
  latestStable: string | null;
  latestLts: string | null;
  supported: boolean | null;
  supportEndsAt: string | null;
  securityUpdate: boolean | null;
  checkedAt: string | null;
  source: string | null;
};
export type RailwayPackage = {
  name: string;
  version: string;
  usage: "build" | "runtime" | "tool";
  release?: SoftwareRelease;
};
export type RailwayDeploymentEvidence = {
  repository: string | null;
  branch: string | null;
  commit: string | null;
  rootDirectory: string | null;
  imageDigest: string | null;
  railpackVersion: string | null;
  framework: string | null;
  staticSite: boolean;
  packages: RailwayPackage[];
};
export type RailwayService = {
  id: string;
  name: string;
  environmentId: string;
  environmentName: string;
  domains: string[];
  repository: string | null;
  image: string | null;
  builder: string;
  region: string | null;
  replicas: number | null;
  rootDirectory: string | null;
  healthcheckPath: string | null;
  cronSchedule: string | null;
  latestDeployment: RailwayDeployment | null;
  activeDeployments: RailwayDeployment[];
};
export type RailwayProject = {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  environments: { id: string; name: string; ephemeral: boolean }[];
  services: RailwayService[];
};
export type RailwayProjectView = RailwayProject & {
  connectionId: string;
  connectionName: string;
  observedAt: string;
  missingSince: string | null;
  connectionError: string | null;
  configured: boolean;
  projectId: string | null;
  projectName: string | null;
  linkMethod: "automatic" | "manual" | "created" | null;
};
export type RailwayConnection = {
  id: string;
  name: string;
  workspaceId: string;
  configured: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
};
export type RailwayState = {
  connections: RailwayConnection[];
  projects: RailwayProjectView[];
};
