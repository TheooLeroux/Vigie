import type { SoftwareRelease } from "./railway-types";
export type VercelTechnology = {
  name: string;
  version: string;
  usage: "framework" | "dependency" | "build" | "tool";
  source: "build-log";
  latestVersion?: string | null;
  update?: "available" | "current" | "ahead" | "unknown";
  checkedAt?: string | null;
};
export type VercelAnalysis = {
  status: "observed" | "unavailable";
  checkedAt: string;
  truncated: boolean;
  languages: string[];
  runtimes: { name: string; functions: number }[];
  technologies: VercelTechnology[];
  refreshFailed?: boolean;
};
export type VercelDeployment = {
  id: string;
  url: string | null;
  state: string;
  target: string | null;
  createdAt: string;
  framework: string | null;
  nodeBranch: string | null;
  repository: string | null;
  branch: string | null;
  commit: string | null;
  regions: string[];
  nodeRelease?: SoftwareRelease | null;
  analysis?: VercelAnalysis;
  rootDirectory?: string | null;
};
export type VercelProject = {
  id: string;
  name: string;
  teamId: string;
  teamSlug: string;
  teamName: string;
  framework: string | null;
  nodeBranch: string | null;
  rootDirectory: string | null;
  repository: string | null;
  productionBranch: string | null;
  domains: {
    name: string;
    verified: boolean;
    redirect: string | null;
    environment: "production" | "preview" | "custom";
  }[];
  production: VercelDeployment | null;
  latest: VercelDeployment | null;
  excluded: boolean;
  clientSuggestion: string | null;
};
export type VercelProjectView = VercelProject & {
  connectionId: string;
  connectionName: string;
  configured: boolean;
  connectionError: string | null;
  observedAt: string;
  missingSince: string | null;
  projectId: string | null;
  projectName: string | null;
  clientName: string | null;
  linkMethod: "automatic" | "manual" | "created" | null;
};
export type VercelConnection = {
  id: string;
  name: string;
  teamId: string;
  configured: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
};
export type VercelState = {
  connections: VercelConnection[];
  projects: VercelProjectView[];
};
