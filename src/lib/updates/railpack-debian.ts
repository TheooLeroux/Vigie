import { ApiError } from "../http";
import { runCommand } from "./process";
import type { SecurityFinding } from "./types";

const packageName = "[a-z0-9][a-z0-9+.-]+";
const debianVersion = "(?:[0-9]+:)?[0-9][a-zA-Z0-9.+~:-]*";
const versionPattern = new RegExp(`^${debianVersion}$`);
export const debianPinPattern = new RegExp(`^${packageName}=${debianVersion}$`);

export async function newerDebianVersion(version: string, current: string, execute = runCommand) {
  if (!versionPattern.test(version) || !versionPattern.test(current) || version === current) return false;
  return (await execute("bash", ["-c", 'if dpkg --compare-versions "$1" gt "$2"; then echo newer; else test "$?" -eq 1; fi', "_", version, current], { timeout: 5_000 })).trim() === "newer";
}

export async function planDebianFixes(findings: readonly SecurityFinding[], newer = newerDebianVersion) {
  const fixes = new Map<string, { from: string; to: string }>();
  for (const finding of findings) {
    if (finding.packageManager !== "apt") continue;
    for (const to of finding.fixedVersions || []) {
      if (!debianPinPattern.test(`${finding.package}=${to}`) || !await newer(to, fixes.get(finding.package)?.to || finding.version)) continue;
      fixes.set(finding.package, { from: finding.version, to });
    }
  }
  if (fixes.size > 40) throw new ApiError("Trop de paquets Debian à mettre à jour ensemble. Le plan Railpack dépasse le périmètre autorisé.", 422);
  return [...fixes].map(([pkg, { from, to }]) => ({ package: pkg, from, to }));
}

export function verifyDebianFixes(before: readonly SecurityFinding[], after: readonly SecurityFinding[], upgrades: Awaited<ReturnType<typeof planDebianFixes>>) {
  const targeted = before.filter(finding => finding.packageManager === "apt" && finding.fixedVersions?.length &&
    upgrades.some(upgrade => upgrade.package === finding.package && upgrade.from === finding.version));
  const remaining = targeted.filter(finding => after.some(item => item.packageManager === "apt" && item.package === finding.package && item.id === finding.id));
  if (remaining.length) throw new ApiError(`Correctifs Debian non confirmés : ${remaining.map(item => `${item.package} (${item.id})`).join(", ")}.`, 422);
  return targeted.length;
}
