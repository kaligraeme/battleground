let pending = false;

/** Asks the View tab to open the deployment log when it next mounts (after "Save & deploy"). */
export function requestLogOpen(): void {
  pending = true;
}

/** Read without clearing, so StrictMode's double render sees the same answer. */
export function logOpenRequested(): boolean {
  return pending;
}

export function clearLogOpenRequest(): void {
  pending = false;
}
