import { randomBytes } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { getAuth } from "../src/lib/auth";

// In-memory credentials and identities for server tests only. No Google request is made.
process.env.VIGIE_DB_PATH = ":memory:";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";
process.env.BETTER_AUTH_SECRET = randomBytes(48).toString("base64url");
process.env.GOOGLE_CLIENT_ID = "unit-test.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "unit-test-no-provider-request";
process.env.VIGIE_ALLOWED_GOOGLE_EMAILS =
  "qa@reborn-france.test,second@reborn-france.test";

let fixture: Promise<{ cookie: string; token: string; userId: string }> | null =
  null;
export function authFixture() {
  if (!fixture)
    fixture = (async () => {
      const auth = await getAuth();
      const ctx = await auth.$context;
      const user = await ctx.adapter.create<{id:string}>({model:"user",data:{name:"QA",email:"qa@reborn-france.test",emailVerified:true,createdAt:new Date(),updatedAt:new Date()}});
      const session = await ctx.internalAdapter.createSession(user.id);
      const signature = await makeSignature(
        session.token,
        process.env.BETTER_AUTH_SECRET!,
      );
      return {
        cookie: `vigie.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`,
        token: session.token,
        userId: user.id,
      };
    })();
  return fixture;
}
