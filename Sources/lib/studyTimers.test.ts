import { describe, expect, it, vi } from "vitest";
import { COMPLETION_SUBMIT_GRACE_MS, completionDeadlineHasTimedOut, completionDeadlineMs, completionDelayMs, completionHasTimedOut, completionIdleDisplay, firstMeaningfulInputAt, IME_COMPLETION_GRACE_MS, isMeaningfulInput, recallHasTimedOut, totalCompletionHasTimedOut } from "./studyTimers";

describe("study timer semantics", () => {
  it("does not treat keydown or whitespace as meaningful recall input", () => {
    expect(isMeaningfulInput("")).toBe(false);
    expect(isMeaningfulInput(" \u3000\t")).toBe(false);
    expect(isMeaningfulInput("み")).toBe(true);
    expect(recallHasTimedOut(firstMeaningfulInputAt(null, " \t", 900))).toBe(true);
  });

  it("cancels recall timeout at the first meaningful input and preserves its timestamp", () => {
    const started = firstMeaningfulInputAt(null, "み", 1_200);
    expect(recallHasTimedOut(started)).toBe(false);
    expect(firstMeaningfulInputAt(started, "みす", 1_500)).toBe(1_200);
  });

  it("keeps completion disabled before profile warmup", () => {
    expect(completionDelayMs(null, false, "답", null, 100)).toBeNull();
  });

  it("does not schedule while composing and adds a post-composition grace period", () => {
    expect(completionDelayMs(1_000, true, "み", null, 100)).toBeNull();
    expect(completionDelayMs(1_000, false, "見据える", 100, 100)).toBe(1_000 + IME_COMPLETION_GRACE_MS);
  });

  it("fires only after the adaptive idle plus composition grace", () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const delay = completionDelayMs(1_000, false, "見据える", 100, 100)!;
    setTimeout(fired, delay);
    vi.advanceTimersByTime(delay - 1);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("keeps the visible completion countdown aligned with the IME timeout deadline", () => {
    const deadline = completionDeadlineMs(1_000, false, "見据える", 1_000, 1_000);
    expect(deadline).toBe(2_800);
    expect(Math.max(0, deadline! - 2_000)).toBe(800);
    expect(Math.max(0, deadline! - 2_800)).toBe(0);
  });

  it("keeps the IME idle bar stable while composition is active", () => {
    expect(completionIdleDisplay(1_000, true, "한", 900, 1_000, 1_500)).toEqual({
      leftMs: 1_000 + IME_COMPLETION_GRACE_MS,
      totalMs: 1_000 + IME_COMPLETION_GRACE_MS,
    });
  });

  it("gives a small hidden grace after the visible completion deadline", () => {
    const deadline = 3_000;
    expect(completionDeadlineHasTimedOut(deadline, deadline)).toBe(false);
    expect(completionDeadlineHasTimedOut(deadline, deadline + COMPLETION_SUBMIT_GRACE_MS - 1)).toBe(false);
    expect(completionDeadlineHasTimedOut(deadline, deadline + COMPLETION_SUBMIT_GRACE_MS)).toBe(true);
    expect(totalCompletionHasTimedOut(1_000, 2_000, 3_000 + COMPLETION_SUBMIT_GRACE_MS - 1)).toBe(false);
    expect(totalCompletionHasTimedOut(1_000, 2_000, 3_000 + COMPLETION_SUBMIT_GRACE_MS)).toBe(true);
  });

  it("still fires the total timeout when IME composition has no idle deadline", () => {
    const totalDeadline = 1_000 + 2_000 + COMPLETION_SUBMIT_GRACE_MS;
    expect(completionHasTimedOut(null, 1_000, 2_000, totalDeadline - 1)).toBe(false);
    expect(completionHasTimedOut(null, 1_000, 2_000, totalDeadline)).toBe(true);
  });

  it("keeps one total deadline instead of switching to an earlier idle deadline", () => {
    const idleDeadline = 2_000;
    const totalDeadline = 1_000 + 5_000 + COMPLETION_SUBMIT_GRACE_MS;
    expect(completionHasTimedOut(idleDeadline, 1_000, 5_000, idleDeadline + COMPLETION_SUBMIT_GRACE_MS)).toBe(false);
    expect(completionHasTimedOut(idleDeadline, 1_000, 5_000, totalDeadline)).toBe(true);
  });
});
