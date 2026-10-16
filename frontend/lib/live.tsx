"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, WS_URL } from "./api";
import { useAuth } from "./auth";

type Listener = () => void;
interface LiveContextValue {
  connected: boolean;
  subscribe: (listener: Listener) => () => void;
}

const LiveContext = createContext<LiveContextValue>({ connected: false, subscribe: () => () => {} });

/**
 * One WebSocket for the whole app, opened only while signed in. A message only means "something changed",
 * so every subscriber simply re-fetches from the REST API. After a reconnect we also notify everybody,
 * which recovers anything missed while offline.
 *
 * The socket cannot use the session cookie, so each connection first asks the server for a single-use
 * ticket (30 seconds) and presents it as a WebSocket subprotocol (which keeps it out of URLs and logs).
 */
export function LiveProvider({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let attempts = 0;
    let hasBeenDisconnected = false;

    // Several events often arrive together (e.g. "started" + "machine updated"): refresh once.
    const notifyAll = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => listeners.current.forEach((listener) => listener()), 100);
    };

    const retryLater = () => {
      setConnected(false);
      hasBeenDisconnected = true;
      if (!stopped) {
        retryTimer = setTimeout(connect, Math.min(1000 * 2 ** attempts, 10000));
        attempts += 1;
      }
    };

    async function connect() {
      try {
        const { ticket } = await api<{ ticket: string }>("/api/auth/ws-ticket", { method: "POST" });
        if (stopped) return;
        socket = new WebSocket(WS_URL, ["mfg-v1", `ticket.${ticket}`]);
      } catch {
        retryLater();
        return;
      }
      socket.onopen = () => {
        attempts = 0;
        setConnected(true);
        if (hasBeenDisconnected) notifyAll(); // REST refresh to recover the latest state
      };
      socket.onmessage = notifyAll;
      socket.onclose = retryLater;
    }
    connect();

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearTimeout(debounceTimer);
      socket?.close();
      setConnected(false);
    };
  }, [status]);

  const value = useMemo(() => ({ connected, subscribe }), [connected, subscribe]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive() {
  return useContext(LiveContext);
}
