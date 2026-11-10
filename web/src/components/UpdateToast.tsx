import { useRegisterSW } from "virtual:pwa-register/react";
import { SHELL_COPY } from "../lib/copy/shell.js";

/**
 * `skipWaiting` is not automatic: a toast offers 'Nouvelle version
 * disponible — recharger', so an update never swaps code mid-form.
 * `useRegisterSW`'s `needRefresh` flips to `true` only once a new
 * service worker has *installed and is waiting* — `updateServiceWorker(true)`
 * (which triggers `skipWaiting` + reload) runs exclusively from this
 * button's `onClick`, never automatically.
 */
export function UpdateToast() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div role="status" data-testid="update-toast" className="k-update-toast">
      <span>{SHELL_COPY.updateAvailable}</span>
      <button
        type="button"
        data-testid="update-toast-reload-button"
        className="k-btn k-btn-secondary k-btn-sm"
        onClick={() => {
          void updateServiceWorker(true);
        }}
      >
        {SHELL_COPY.reload}
      </button>
    </div>
  );
}
