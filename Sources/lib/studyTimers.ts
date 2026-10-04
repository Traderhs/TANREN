export const IME_COMPLETION_GRACE_MS = 800;
export const COMPLETION_SUBMIT_GRACE_MS = 250;

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

export function completionDeadlineMs(
  configuredIdleMs: number | null | undefined,
  composing: boolean,
  partialAnswer: string,
  compositionEndedAt: number | null,
  lastInputAt: number | null,
): number | null {
  if (lastInputAt === null) return null;
  const delay = completionDelayMs(configuredIdleMs, composing, partialAnswer, compositionEndedAt, lastInputAt);
  return delay === null ? null : lastInputAt + delay;
}

export function completionIdleDisplay(
  configuredIdleMs: number | null | undefined,
  composing: boolean,
  partialAnswer: string,
  compositionEndedAt: number | null,
  lastInputAt: number | null,
  now: number,
): { leftMs: number; totalMs: number } | null {
  if (!configuredIdleMs || !isMeaningfulInput(partialAnswer) || lastInputAt === null) return null;
  if (composing) {
    const totalMs = configuredIdleMs + IME_COMPLETION_GRACE_MS;
    return { leftMs: totalMs, totalMs };
  }
  const deadline = completionDeadlineMs(configuredIdleMs, false, partialAnswer, compositionEndedAt, lastInputAt);
  if (deadline === null) return null;
  return {
    leftMs: Math.max(0, deadline - now),
    totalMs: Math.max(1, deadline - lastInputAt),
  };
}

export function completionDeadlineHasTimedOut(deadlineMs: number | null, now: number): boolean {
  return deadlineMs !== null && now >= deadlineMs + COMPLETION_SUBMIT_GRACE_MS;
}

export function totalCompletionHasTimedOut(
  firstInputAt: number | null,
  configuredTimeoutMs: number | null | undefined,
  now: number,
): boolean {
  return firstInputAt !== null
    && configuredTimeoutMs != null
    && now - firstInputAt >= configuredTimeoutMs + COMPLETION_SUBMIT_GRACE_MS;
}

export function completionHasTimedOut(
  idleDeadlineMs: number | null,
  firstInputAt: number | null,
  configuredTimeoutMs: number | null | undefined,
  now: number,
): boolean {
  if (configuredTimeoutMs != null) {
    return totalCompletionHasTimedOut(firstInputAt, configuredTimeoutMs, now);
  }
  return completionDeadlineHasTimedOut(idleDeadlineMs, now);
}
