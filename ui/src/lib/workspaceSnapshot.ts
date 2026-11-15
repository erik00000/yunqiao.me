import type { AppState } from './api';

/** IPC returns new objects even when nothing changed. Preserve stable page inputs between polls. */
export function reconcileWorkspaceSnapshot(previous: AppState | null, next: AppState): AppState {
  if (!previous) return next;
  const result = { ...next };
  let changed = Object.keys(previous).length !== Object.keys(next).length;
  for (const key of Object.keys(next) as Array<keyof AppState>) {
    if (Object.is(previous[key], next[key]) || JSON.stringify(previous[key]) === JSON.stringify(next[key])) {
      (result as any)[key] = previous[key];
    } else changed = true;
  }
  return changed ? result : previous;
}
