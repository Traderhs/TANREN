import { describe, expect, it, vi } from "vitest";
import { completionDelayMs, firstMeaningfulInputAt, IME_COMPLETION_GRACE_MS, isMeaningfulInput, recallHasTimedOut } from "./studyTimers";

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
});
