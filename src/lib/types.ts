export type Workspace = "demo" | "live";
export type HostingDomain = {
  name: string;
  kind: "main" | "addon" | "alias" | "subdomain";
};
export type HostingInstallation = {
  id: string;
  connectionId: string;
  documentRoot: string;
  domains: string[];
  aliases: string[];
  kind:
    | "wordpress"
    | "wordpress-incomplete"
    | "dolibarr"
    | "next-static"
    | "static"
    | "php"
    | "technical"
    | "empty"
    | "unknown";
  version: string | null;
  observedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  missingSince: string | null;
  inspectionError: string | null;
  ignored: boolean;
  suggestedEnvironment: "production" | "staging";
};
export type HostingInstallationView = HostingInstallation & {
  inventory: SiteInventory | null;
  observerConfigured: boolean;
  project: { id: string; name: string; lifecycle: Project["lifecycle"] } | null;
  linkMethod: "automatic" | "manual" | "created" | null;
  candidates: {
    id: string;
    name: string;
    reason: string;
    lifecycle: Project["lifecycle"];
  }[];
};
export type UpdateInfo = {
  latestVersion: string | null;
  updateState: "available" | "current" | "ahead" | "unknown";
  updateCheckedAt: string | null;
  updateSource: "wordpress" | "wordpress.org" | null;
};
export type WordPressComponent = UpdateInfo & {
  file: string;
  slug: string;
  name: string;
  version: string | null;
  active: boolean | null;
  mustUse: boolean;
  autoUpdate: boolean | null;
  requiresPhp: string | null;
  requiresWordPress: string | null;
  template: string | null;
};
export type SiteInventory = {
  source: "cpanel-files" | "wordpress-observer";
  collectionMode?: "normal" | "early";
  observedAt: string | null;
  lastAttemptAt: string;
  error: string | null;
  wordpress: (UpdateInfo & { version: string }) | null;
  php: {
    version: string;
    scope: "web";
    sapi: string;
    limits: Record<string, string>;
    extensions: string[];
    release?: {
      latestVersion: string;
      updateAvailable: boolean | null;
      securityRelease: boolean;
      upstreamSupported: boolean | null;
      supportEndsAt: string | null;
      checkedAt: string;
    };
  } | null;
  site: {
    name: string;
    url: string;
    home: string;
    locale: string;
    timezone: string;
    multisite: boolean;
    searchEnginesVisible: boolean;
    https: boolean;
  } | null;
  configuration: {
    debug: boolean;
    debugDisplay: boolean;
    cronDisabled: boolean;
    fileEditDisabled: boolean;
    fileModsDisabled: boolean;
    pageCache: boolean;
    objectCache: boolean;
  } | null;
  database: { version: string } | null;
  plugins: WordPressComponent[];
  themes: WordPressComponent[];
  warnings: string[];
};
export type HostingDiscovery = {
  connectionId: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
  installations: HostingInstallationView[];
  summary: {
    linked: number;
    new: number;
    review: number;
    other: number;
    ignored: number;
    missing: number;
  };
};
export type HostingConnection = {
  id: string;
  name: string;
  provider: "o2switch";
  endpoint: string;
  username: string;
  authMode: "token" | "password";
  configured: boolean;
  status: "unconfigured" | "untested" | "connected" | "error";
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  error: { code: string; message: string; httpStatus?: number } | null;
  domains: HostingDomain[];
  createdAt: string;
  updatedAt: string;
};
export type Criticality = "standard" | "important" | "critical";
export type Client = {
  id: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  website: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
};
export type Project = {
  id: string;
  name: string;
  url: string;
  description: string;
  client: string;
  clientId: string | null;
  owner: string;
  criticality: Criticality;
  lifecycle: "active" | "archived";
  tags: string[];
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
};
export type Environment = {
  id: string;
  projectId: string;
  name: string;
  kind: "production" | "staging" | "development";
  url: string;
};
export type Service = {
  id: string;
  projectId: string;
  environmentId: string;
  name: string;
  kind: "web" | "api" | "worker" | "database";
  technology: string;
  provider: string;
  url: string;
  repository: string;
  runtime: string;
  version: string;
};
export type Access = {
  id: string;
  projectId: string;
  label: string;
  kind: "admin" | "hosting" | "git" | "database" | "vault" | "other";
  url: string;
  account: string;
  vaultRef: string;
  notes: string;
};
export type Resource = {
  id: string;
  name: string;
  kind: "database" | "storage" | "email" | "other";
  provider: string;
  url: string;
  reference: string;
  notes: string;
  projectIds: string[];
};
export type Component = {
  id: string;
  inventoryId: string;
  name: string;
  version: string;
  ecosystem: string;
  scope: "production" | "development" | "unknown";
  direct: boolean;
};
export type Inventory = {
  id: string;
  serviceId: string;
  source: "manual" | "lockfile";
  filename: string;
  commitRef: string;
  collectedAt: string;
  componentCount: number;
};
export type Activity = {
  actorName?: string;
  actorEmail?: string;
  id: string;
  projectId: string | null;
  projectName: string;
  action: string;
  detail: string;
  createdAt: string;
};
export type WorkspaceData = {
  clients: Client[];
  projects: Project[];
  services: Service[];
  environments: Environment[];
  resources: Resource[];
  accesses: Access[];
  inventories: Inventory[];
  activity: Activity[];
};
export type ProjectDetail = {
  vercel?: import('./vercel-types').VercelProjectView[];
  railway?: import('./railway-types').RailwayProjectView[];
  hosting?: (HostingInstallationView & { connectionName: string })[];
  project: Project;
  services: Service[];
  environments: Environment[];
  accesses: Access[];
  resources: Resource[];
  inventories: Inventory[];
  components: Component[];
  activity: Activity[];
};
