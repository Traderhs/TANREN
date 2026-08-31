export const IME_COMPLETION_GRACE_MS = 800;

export function isMeaningfulInput(value: string): boolean {
  return value.trim().length > 0;
}

export function firstMeaningfulInputAt(current: number | null, value: string, now: number): number | null {
  return current ?? (isMeaningfulInput(value) ? now : null);
}

export function recallHasTimedOut(firstInputAt: number | null): boolean {
  return firstInputAt == null;
}

export function completionDelayMs(
  configuredIdleMs: number | null | undefined,
  composing: boolean,
  partialAnswer: string,
  compositionEndedAt: number | null,
  now: number,
): number | null {
  if (!configuredIdleMs || composing || !isMeaningfulInput(partialAnswer)) return null;
  const remainingGrace = compositionEndedAt == null ? 0 : Math.max(0, IME_COMPLETION_GRACE_MS - (now - compositionEndedAt));
  return configuredIdleMs + remainingGrace;
}
