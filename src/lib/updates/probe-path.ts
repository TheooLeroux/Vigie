import { z } from "zod";

export const probePath = z.string().max(256).regex(/^\/[A-Za-z0-9._~/-]*$/).refine(path =>
  !path.includes("//") && !path.split("/").some(segment => segment === "." || segment === ".."));
