"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "./api";
import { useLive } from "./live";

/**
 * Loads data with the given fetcher, and loads it again whenever a live event arrives.
 * Pass the values the fetcher depends on (filters, page...) as `deps`.
 *
 * Only the newest request may update the screen: if a slower, older response arrives late
 * (for example after typing more in a search box), it is ignored. Old data stays visible
 * while a newer request is running (`refreshing`), so lists do not flash empty.
 */
export function useLiveData<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);       // true until the first answer
  const [refreshing, setRefreshing] = useState(false); // true while any request is running
  const { subscribe } = useLive();

  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const latestRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const requestId = ++latestRequest.current;
    const isCurrent = () => mounted.current && requestId === latestRequest.current;
    setRefreshing(true);
    try {
      const result = await fetcherRef.current();
      if (!isCurrent()) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (!isCurrent()) return;
      setError(errorText(err));
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Starting a fetch when the inputs change is the purpose of this effect (it marks the list as refreshing),
  // and `deps` is the caller's list of inputs, which the linter cannot see.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { reload(); }, [reload, ...deps]);
  useEffect(() => subscribe(reload), [subscribe, reload]);

  return { data, error, loading, refreshing, reload };
}

/** The value, but only after it has stopped changing for `delayMs`. Cleans up its timer when it unmounts. */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Page number and page size for a list. Pass a `resetKey` made from the search and filters:
 * whenever it changes, the list goes back to page 1 (the same render, so only one request is sent).
 * Changing the page size also goes back to page 1.
 */
export function usePagination(defaultPageSize = 25, resetKey = "") {
  const [state, setState] = useState({ key: resetKey, page: 1, pageSize: defaultPageSize });
  const page = state.key === resetKey ? state.page : 1;
  return {
    page,
    pageSize: state.pageSize,
    setPage: (next: number) => setState((current) => ({ ...current, key: resetKey, page: next })),
    setPageSize: (size: number) => setState({ key: resetKey, page: 1, pageSize: size }),
  };
}
