import { useEffect, useState } from "react";

/**
 * Tracks `navigator.onLine` via the `online`/`offline` window events —
 * the offline banner and write-disabling both key off
 * this, not off any particular query's error state, so they react
 * immediately to `context.setOffline()` in tests (and to a real network
 * drop) rather than waiting for a request to time out.
 *
 * F1 (security review, T-44): the `useState` initializer
 * only ever reads `navigator.onLine` once, during this component's very
 * first render — a real connectivity flip landing in the window between
 * that render and this effect actually attaching its own `online`/`offline`
 * listeners (commit is not instantaneous) was silently missed forever:
 * nothing re-checked `navigator.onLine` once the effect finally ran, so the
 * hook kept reporting the stale value until some *later* flip happened to
 * fire a fresh event. For a write-disabling control (T-42's launch button,
 * T-44's submit button) that is exactly the race that can leave a write
 * action briefly enabled while the browser is already offline. Re-syncing
 * from `navigator.onLine` as the very first thing the effect does closes
 * that window unconditionally, regardless of whether the specific event was
 * ever actually missed — every consumer of this hook gets the fix for free.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() => navigator.onLine);

  useEffect(() => {
    setOnline(navigator.onLine);
    const handleOnline = (): void => setOnline(true);
    const handleOffline = (): void => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return online;
}
