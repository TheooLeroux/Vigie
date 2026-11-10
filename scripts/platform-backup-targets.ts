export const nesRailway = {
  provider: "railway",
  remoteId: "b318d717-ef03-44ca-8feb-f4e9eb6d6fe2",
  projectId: "f458d781-18cd-48d3-b65b-42372755dd04",
  entry: "scripts/backup-nes-railway.ts",
} as const;

export const vigieVercel = {
  provider: "vercel",
  remoteId: "prj_r43pgnpxl2UeE9yrz8l8Y6OuEdXo",
  projectId: "8f19124d-6da3-466b-9c44-ac385bf060a7",
  entry: "scripts/backup-vigie-vercel.ts",
} as const;

export const platformBackupTargets = [nesRailway, vigieVercel];
export type PlatformBackupTarget = typeof platformBackupTargets[number];
