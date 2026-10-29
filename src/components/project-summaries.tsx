"use client";
import { createContext, useContext, useEffect, useState } from "react";
import type { ProjectSummary } from "@/lib/project-summary";
type Request = (path: string, method?: string, payload?: unknown, options?: { signal?: AbortSignal }) => Promise<any>;
const Context = createContext<{ summaries: Record<string, ProjectSummary>; loading: boolean }>({ summaries: {}, loading: false });
export const useProjectSummary = (id: string) => { const state = useContext(Context); return { summary: state.summaries[id], loading: state.loading }; };
export function ProjectSummaries({ ids, request, children }: { ids: string[]; request: Request; children: React.ReactNode }) {
  const [summaries, setSummaries] = useState<Record<string, ProjectSummary>>({}), [loading, setLoading] = useState(true);
  const key = ids.join(",");
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>, inFlight = false;
    async function refresh() {
      if (controller.signal.aborted || inFlight) return;
      inFlight = true;
      const next: Record<string, ProjectSummary> = {};
      try {
        const selected = key.split(",").filter(Boolean);
        for (let offset = 0; offset < selected.length; offset += 200) {
          if (controller.signal.aborted) return;
          Object.assign(next, await request("project-summaries", "POST", { ids: selected.slice(offset, offset + 200) }, { signal: controller.signal }));
        }
      } catch { /* Missing entries render as unavailable, never as zero findings. */ }
      finally {
        inFlight = false;
        if (!controller.signal.aborted) { setSummaries(next); setLoading(false); timer = setTimeout(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000); }
      }
    }
    const onVisible = () => { if (document.visibilityState === "visible") { clearTimeout(timer); void refresh(); } };
    setLoading(true); void refresh(); document.addEventListener("visibilitychange", onVisible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [key, request]);
  return <Context.Provider value={{ summaries, loading }}>{children}</Context.Provider>;
}
