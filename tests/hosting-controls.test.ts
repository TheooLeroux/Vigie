import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { reconcileHostingConnections, hostingControlIssue } from "../src/lib/hosting-controls";
import { ApiError } from "../src/lib/http";

test("Contrôles hébergeurs : isoler les pannes et ignorer les comptes déconnectés", async () => {
  for (const provider of ["o2switch", "vercel", "railway"] as const) {
    const visited: string[] = [];
    const result = await reconcileHostingConnections(provider, {
      connections: async () => ["failed", "disconnected", "busy", "limited", "healthy"].map(id => ({ id, configured: id !== "disconnected" })),
      synchronize: async id => {
        visited.push(id);
        if (id === "failed") throw new Error("unavailable");
        if (id === "busy") throw new ApiError("busy", 409);
        if (id === "limited") throw new ApiError("recent", 429);
      },
    });
    assert.deepEqual(visited, ["failed", "busy", "limited", "healthy"]);
    assert.deepEqual(result, { checked: 1, failed: 1, deferred: 2 });
  }
});

test("Contrôles hébergeurs : une ancienne observation ne constitue plus un accès vérifié", () => {
  const now = Date.now();
  const observation = (age: number) => ({ observedAt: new Date(now - age).toISOString(), connectionError: null });
  assert.equal(hostingControlIssue("Vercel", observation(60_000), now), null);
  assert.match(hostingControlIssue("Railway", observation(16 * 60_000), now) || "", /expiré/);
  assert.match(hostingControlIssue("Vercel", { ...observation(0), connectionError: "fixture-only" }, now) || "", /indisponible/);
  assert.match(hostingControlIssue("Vercel", { observedAt: "invalid", connectionError: null }, now) || "", /expiré/);
});
