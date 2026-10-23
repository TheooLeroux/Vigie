import { authFixture } from "./auth-fixture";
import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../src/app/api/[...path]/route";

test("Ancien module de mise à jour : routes retirées, session toujours obligatoire", async () => {
  const origin = "http://127.0.0.1:3001";
  const anonymous = await GET(new Request(`${origin}/api/maintenance`), {
    params: Promise.resolve({ path: ["maintenance"] }),
  });
  assert.equal(anonymous.status, 401);
  const { cookie } = await authFixture();
  for (const [method, path] of [
    ["GET", "maintenance"],
    ["POST", "maintenance/execute"],
    ["POST", "maintenance/plans"],
    ["POST", "maintenance/latest"],
    ["POST", "maintenance/obsolete/approve"],
    ["POST", "maintenance/obsolete/merge"],
    ["POST", "maintenance/obsolete/refresh"],
    ["POST", "maintenance/obsolete/close"],
  ]) {
    const response = await (method === "GET" ? GET : POST)(
      new Request(`${origin}/api/${path}`, {
        method,
        headers: { cookie, origin, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      }),
      { params: Promise.resolve({ path: path.split("/") }) },
    );
    assert.equal(response.status, 404, `${method} ${path}`);
  }
});
