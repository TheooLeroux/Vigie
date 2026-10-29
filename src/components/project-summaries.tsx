"use client";
import { createContext, useContext, useEffect, useState } from "react";
import type { ProjectSummary } from "@/lib/project-summary";
import { createRefreshQueue } from "@/lib/project-realtime";
import { useProjectRealtime } from "./project-realtime";
type Request = (path: string, method?: string, payload?: unknown, options?: { signal?: AbortSignal }) => Promise<any>;
const Context = createContext<{ summaries: Record<string, ProjectSummary>; loading: boolean }>({ summaries: {}, loading: false });
export const useProjectSummary = (id: string) => { const state = useContext(Context); return { summary: state.summaries[id], loading: state.loading }; };
export function ProjectSummaries({ ids, request, children }: { ids: string[]; request: Request; children: React.ReactNode }) {
  const [summaries, setSummaries] = useState<Record<string, ProjectSummary>>({}), [loading, setLoading] = useState(true);
  const key = [...ids].sort().join(",");
  const { subscribe } = useProjectRealtime();
  useEffect(() => {
    const controller = new AbortController(), selected = key.split(",").filter(Boolean);
    const queue = createRefreshQueue(async changed => {
      const next: Record<string, ProjectSummary> = {};
      try {
        for (let offset = 0; offset < changed.length; offset += 200) {
          if (controller.signal.aborted) return;
          Object.assign(next, await request("project-summaries", "POST", { ids: changed.slice(offset, offset + 200) }, { signal: controller.signal }));
        }
      } catch { /* Missing entries render as unavailable, never as zero findings. */ }
      finally {
        if (!controller.signal.aborted) {
          setSummaries(previous => { const merged = { ...previous }; changed.forEach(id => delete merged[id]); return { ...merged, ...next }; });
          setLoading(false);
        }
      }
    });
    const unsubscribe = subscribe(change => queue.invalidate(change.all ? selected : selected.filter(id => change.projects.includes(id))));
    setLoading(!!selected.length); queue.invalidate(selected);
    return () => { controller.abort(); queue.dispose(); unsubscribe(); };
  }, [key, request, subscribe]);
  return <Context.Provider value={{ summaries, loading }}>{children}</Context.Provider>;
}
