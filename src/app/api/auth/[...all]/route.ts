import { getAuth } from "@/lib/auth";
import { assertLocal, errorResponse } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request) {
  try {
    assertLocal(request, true);
    return (await getAuth()).handler(request);
  } catch (error) {
    return errorResponse(error);
  }
}
export const GET = handle;
export const POST = handle;
