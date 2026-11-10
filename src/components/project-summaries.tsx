"use client";
import { createContext, useContext, useEffect, useState } from "react";
import type { ProjectSummary } from "@/lib/project-summary";
import { createRefreshQueue } from "@/lib/project-realtime";
import { useProjectRealtime } from "./project-realtime";
type Request = (path: string, method?: string, payload?: unknown, options?: { signal?: AbortSignal }) => Promise<any>;
const Context = createContext<{ summaries: Record<string, ProjectSummary>; loading: boolean }>({ summaries: {}, loading: false });
export const useProjectSummary = (id: string) => { const state = useContext(Context); return { summary: state.summaries[id], loading: state.loading }; };
export function ProjectSummaries({ ids, request, children }: { ids: string[]; request: Request; children: (summaries: Record<string, ProjectSummary>) => React.ReactNode }) {
  const [summaries, setSummaries] = useState<Record<string, ProjectSummary>>({}), [loading, setLoading] = useState(true);
  const key = [...ids].sort().join(",");
  const { subscribe } = useProjectRealtime();
  useEffect(() => {
    const controller = new AbortController(), selected = key.split(",").filter(Boolean);
    const deadlines = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    function scheduleExpiry() {
      clearTimeout(timer);
      if (deadlines.size) timer = setTimeout(expire, Math.max(0, Math.min(...deadlines.values()) - Date.now()));
    }
    function expire() {
      const now = Date.now();
      const expired = [...deadlines].filter(([, deadline]) => deadline <= now).map(([id]) => id);
      expired.forEach(id => deadlines.delete(id));
      if (expired.length) {
        setSummaries(previous => {
          const remaining = { ...previous };
          expired.forEach(id => delete remaining[id]);
          return remaining;
        });
        queue.invalidate(expired);
      }
      scheduleExpiry();
    }
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
          for (const id of changed) {
            const lifetime = next[id]?.revalidateAfterMs;
            if (lifetime === undefined) deadlines.delete(id);
            else deadlines.set(id, Date.now() + Math.max(1000, lifetime));
          }
          scheduleExpiry();
          setSummaries(previous => { const merged = { ...previous }; changed.forEach(id => delete merged[id]); return { ...merged, ...next }; });
          setLoading(false);
        }
      }
    });
    const unsubscribe = subscribe(change => queue.invalidate(change.all ? selected : selected.filter(id => change.projects.includes(id))));
    const online = () => queue.invalidate(selected);
    window.addEventListener("online", online);
    setLoading(!!selected.length); queue.invalidate(selected);
    return () => {
      controller.abort(); queue.dispose(); unsubscribe(); clearTimeout(timer);
      window.removeEventListener("online", online);
    };
  }, [key, request, subscribe]);
  return <Context.Provider value={{ summaries, loading }}>{children(summaries)}</Context.Provider>;
}
