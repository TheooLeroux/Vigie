"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createRealtimeClient, type MaterializedLiveQuerySubscription, type RealtimeClient, type SealedLiveQuery } from "@neon/realtime/client";
import { changedProjects, emptyProjectChange, hasProjectChanges, mergeProjectChanges, type ProjectChange, type ProjectRevision } from "@/lib/project-realtime";

type Listener = (change: ProjectChange) => void;
type Status = "connecting" | "live" | "stale" | "error";
const Context = createContext<{ subscribe: (listener: Listener) => () => void; status: Status; reconnect: () => void }>({ subscribe: () => () => {}, status: "connecting", reconnect: () => {} });
export const useProjectRealtime = () => useContext(Context);

export function ProjectRealtime({ children }: { children: React.ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const subscribe = useCallback((listener: Listener) => { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; }, []);
  const [status, setStatus] = useState<Status>("connecting"), [attempt, setAttempt] = useState(0);
  const reconnect = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let client: RealtimeClient | undefined, subscription: MaterializedLiveQuerySubscription<ProjectRevision> | undefined;
    let previous: readonly ProjectRevision[] | undefined, grant: string | undefined;
    let pending = emptyProjectChange(), renewing = false, failed = false, retries = 0;
    let renewTimer: ReturnType<typeof setTimeout> | undefined, flushTimer: ReturnType<typeof setTimeout> | undefined;
    const active = () => !controller.signal.aborted;
    const stop = () => { clearTimeout(renewTimer); subscription?.unsubscribe(); client?.close(); };
    const fail = () => { if (active()) { failed = true; stop(); setStatus("error"); } };
    function flush() {
      clearTimeout(flushTimer); flushTimer = undefined;
      if (!active() || !navigator.onLine || document.visibilityState !== "visible" || !hasProjectChanges(pending)) return;
      const change = pending; pending = emptyProjectChange();
      for (const listener of listeners.current) listener(change);
    }
    async function authorization() {
      const response = await fetch("/api/realtime", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(grant === undefined ? {} : { grant }),
        cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) throw Object.assign(new Error("Temps réel indisponible."), { status: response.status });
      const result = await response.json() as { url: string; grant: string; sealedQuery: SealedLiveQuery<ProjectRevision> };
      grant = result.grant;
      return result;
    }
    function schedule(expiresAt: number) {
      clearTimeout(renewTimer);
      if (active() && !failed) renewTimer = setTimeout(() => void renew(), Math.max(0, expiresAt - Date.now() - 10_000));
    }
    async function renew() {
      if (!active() || failed || renewing || !subscription) return;
      renewing = true; clearTimeout(renewTimer);
      try {
        // Neon capabilities expire after 60s. This endpoint verifies a scoped
        // signed grant and seals locally: renewal performs NO database query.
        const result = await authorization();
        if (!active()) return;
        await subscription.renew(result.sealedQuery);
        if (!active() || failed) return;
        const current = subscription.getState();
        if (current.status === "error" || current.status === "closed") { fail(); return; }
        setStatus(navigator.onLine ? current.status : "stale");
        retries = 0; schedule(result.sealedQuery.expiresAt);
      } catch (error) {
        if (!active()) return;
        if ([401, 403].includes((error as { status?: number }).status || 0) || retries >= 3) { fail(); return; }
        setStatus("stale");
        renewTimer = setTimeout(() => void renew(), [1000, 5000, 15_000][retries++]);
      } finally { renewing = false; }
    }
    async function connect() {
      setStatus("connecting");
      try {
        const result = await authorization();
        if (!active()) return;
        client = createRealtimeClient({ url: result.url });
        subscription = client.subscribe(result.sealedQuery);
        subscription.onChange(snapshot => {
          if (!active() || failed) return;
          if (snapshot.status === "error") { fail(); return; }
          if (snapshot.status === "closed") return;
          setStatus(navigator.onLine ? snapshot.status : "stale");
          if (snapshot.status !== "live" || !snapshot.data) return;
          // The auth sentinel disappears immediately on session revocation.
          if (!snapshot.data.some(row => row.key === "authorized")) { fail(); return; }
          const change = changedProjects(previous, snapshot.data);
          previous = snapshot.data;
          if (hasProjectChanges(change)) {
            pending = mergeProjectChanges(pending, change);
            if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = undefined; flush(); }, 350);
          }
        });
        schedule(result.sealedQuery.expiresAt);
      } catch { fail(); }
    }
    const resume = () => {
      if (document.visibilityState !== "visible") return;
      flush();
      if (failed) reconnect(); else void renew();
    };
    const offline = () => { if (active() && !failed) setStatus("stale"); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume); window.addEventListener("offline", offline);
    void connect();
    return () => {
      controller.abort(); stop(); clearTimeout(flushTimer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume); window.removeEventListener("offline", offline);
    };
  }, [attempt, reconnect]);
  return <Context.Provider value={{ subscribe, status, reconnect }}>{children}</Context.Provider>;
}

export function ProjectRealtimeStatus() {
  const { status, reconnect } = useProjectRealtime();
  return <div className="project-realtime-status" role="status">
    <span className={`badge ${status === "live" ? "sage" : "neutral"}`}><span className="status-dot" />{status === "live" ? "En direct" : status === "connecting" ? "Connexion au direct…" : status === "stale" ? "Direct interrompu" : "Direct indisponible"}</span>
    {(status === "stale" || status === "error") && <button className="text-button" onClick={reconnect}>Reconnecter</button>}
  </div>;
}
