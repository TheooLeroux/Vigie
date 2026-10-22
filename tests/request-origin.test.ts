import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { assertLocal } from "../src/lib/http";
import { proxy } from "../src/proxy";

test("Vercel : domaine HTTPS exact, protections CSRF et garde des pages", () => {
  const previous = process.env.BETTER_AUTH_URL;
  const previousVercel = process.env.VERCEL;
  delete process.env.VERCEL;
  process.env.BETTER_AUTH_URL = "https://vigie.example.com";
  try {
    const origin = "https://vigie.example.com";
    assert.doesNotThrow(() => assertLocal(new Request(`${origin}/api/workspace`, {
      headers: { host: "vigie.example.com", "x-forwarded-host": "vigie.example.com" },
    })));
    const invalidHeaders: Record<string, string>[] = [
      { host: "evil.example.com" },
      { "x-forwarded-host": "evil.example.com" },
      { forwarded: "host=evil.example.com" },
      { origin: "https://evil.example.com" },
      { "sec-fetch-site": "cross-site" },
    ];
    for (const headers of invalidHeaders)
      assert.throws(() => assertLocal(new Request(`${origin}/api/workspace`, { headers })), /autorisé/);
    assert.throws(() => assertLocal(new Request("http://vigie.example.com/api/workspace")), /Hôte/);
    assert.throws(() => assertLocal(new Request("http://127.0.0.1:3001/api/workspace")), /Hôte/);
    assert.doesNotThrow(() => assertLocal(new Request(`${origin}/api/auth/callback/google`, {
      headers: { "sec-fetch-site": "cross-site", origin: "https://accounts.google.com" },
    }), true));
    const login = proxy(new NextRequest(`${origin}/connexion`));
    assert.equal(login.status, 200);
    const anonymous = proxy(new NextRequest(origin));
    assert.equal(anonymous.status, 307);
    assert.equal(anonymous.headers.get("location"), `${origin}/connexion`);
    assert.equal(proxy(new NextRequest("https://evil.example.com/connexion")).status, 403);
    process.env.VERCEL = "1";
    assert.doesNotThrow(() => assertLocal(new Request("http://localhost:3000/api/workspace", {
      headers: { host: "vigie.example.com", "x-forwarded-host": "vigie.example.com", "x-forwarded-proto": "https", forwarded: "for=proxy" },
    })));
    assert.throws(() => assertLocal(new Request("http://localhost:3000/api/workspace", {
      headers: { host: "evil.example.com", "x-forwarded-proto": "https" },
    })), /Hôte/);
  } finally {
    if (previous === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = previous;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  }
});
