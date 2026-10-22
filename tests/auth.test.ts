import test from "node:test";
import assert from "node:assert/strict";
import { authFixture } from "./auth-fixture";
import { isAllowedGoogleUser, authConfiguration } from "../src/lib/auth-policy";
import { getAuth, currentSession } from "../src/lib/auth";
import { GET } from "../src/app/api/[...path]/route";
import {
  GET as authGET,
  POST as authPOST,
} from "../src/app/api/auth/[...all]/route";
import { assertLocal } from "../src/lib/http";
const base = "http://127.0.0.1:3001";

test("Google : liste fermée d’adresses vérifiées, sans autoriser tout le domaine", () => {
  assert.equal(
    isAllowedGoogleUser({
      email: "QA@REBORN-FRANCE.TEST",
      emailVerified: true,
    }),
    true,
  );
  assert.equal(
    isAllowedGoogleUser({
      email: "qa@reborn-france.test",
      emailVerified: false,
    }),
    false,
  );
  assert.equal(
    isAllowedGoogleUser({
      email: "other@reborn-france.test",
      emailVerified: true,
    }),
    false,
  );
  assert.equal(
    isAllowedGoogleUser({
      email: "qa@reborn-france.test.attacker.tld",
      emailVerified: true,
    }),
    false,
  );
});

test("Configuration absente : aucune session ni accès implicite", async () => {
  const original = process.env.GOOGLE_CLIENT_SECRET;
  try {
    delete process.env.GOOGLE_CLIENT_SECRET;
    assert.equal(authConfiguration().ready, false);
    assert.equal(await currentSession(new Headers()), null);
    assert.equal(
      (
        await GET(new Request(`${base}/api/export`), {
          params: Promise.resolve({ path: ["export"] }),
        })
      ).status,
      401,
    );
  } finally {
    process.env.GOOGLE_CLIENT_SECRET = original;
  }
});

test("Inventaire et exports refusés sans authentification ou avec un cookie falsifié", async () => {
  for (const path of ["workspace", "export"]) {
    for (const cookie of ["", "vigie.session_token=forged.signature"]) {
      const response = await GET(
        new Request(`${base}/api/${path}`, { headers: { cookie } }),
        { params: Promise.resolve({ path: [path] }) },
      );
      assert.equal(response.status, 401);
    }
  }
});

test("OAuth : le retour Google traverse la garde locale, sans désactiver CSRF ailleurs", async () => {
  assert.doesNotThrow(() =>
    assertLocal(
      new Request(`${base}/api/auth/callback/google?state=unknown`, {
        headers: { "sec-fetch-site": "cross-site" },
      }),
      true,
    ),
  );
  assert.throws(() =>
    assertLocal(
      new Request(`${base}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
      true,
    ),
  );
  const response = await authGET(
    new Request(
      `${base}/api/auth/callback/google?state=unknown&code=not-real`,
      { headers: { "sec-fetch-site": "cross-site" } },
    ),
  );
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location") || "", /connexion|error/);
});

test("Session réelle persistée : signature, autorisation courante et révocation", async () => {
  const fixture = await authFixture();
  const headers = new Headers({ cookie: fixture.cookie, origin: base });
  const session = await currentSession(headers);
  assert.equal(session?.user.email, "qa@reborn-france.test");
  const response = await GET(
    new Request(`${base}/api/workspace`, { headers }),
    { params: Promise.resolve({ path: ["workspace"] }) },
  );
  assert.equal(response.status, 200);
  const original = process.env.VIGIE_ALLOWED_GOOGLE_EMAILS;
  try {
    process.env.VIGIE_ALLOWED_GOOGLE_EMAILS = "second@reborn-france.test";
    assert.equal(await currentSession(headers), null);
  } finally {
    process.env.VIGIE_ALLOWED_GOOGLE_EMAILS = original;
  }
  const signedOut = await authPOST(
    new Request(`${base}/api/auth/sign-out`, {
      method: "POST",
      headers: {
        cookie: fixture.cookie,
        origin: base,
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  assert.equal(signedOut.status, 200);
  assert.equal(await currentSession(headers), null);
});

test("Politique de création : compte non autorisé rejeté avant persistance", async () => {
  const auth=await getAuth();
  await assert.rejects(()=>auth.options.databaseHooks!.user.create.before({name:"Forbidden",email:"other@reborn-france.test",emailVerified:true} as never),/accès à Vigie/);
});

test("Identité Google fraîche contrôlée aussi lors des connexions suivantes", async () => {
  const auth=await getAuth();
  const validate=auth.options.user!.validateUserInfo!;
  const source={action:"sign-in" as const,method:"oauth" as const,oauth:{providerId:"google"}};
  assert.equal(await validate({user:{email:"qa@reborn-france.test",emailVerified:true},source}),undefined);
  assert.equal((await validate({user:{email:"other@reborn-france.test",emailVerified:true},source}))?.error,"google_account_not_allowed");
  assert.equal((await validate({user:{email:"qa@reborn-france.test",emailVerified:false},source}))?.error,"google_account_not_allowed");
  assert.equal((await validate({user:{email:"qa@reborn-france.test",emailVerified:true},source:{...source,oauth:{providerId:"github"}}}))?.error,"google_account_not_allowed");
});
