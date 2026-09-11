import { describe, expect, it, vi } from "vitest";
import type { StudyCard, SubmitResult } from "./types";
import { activeCardTimerRuns, cardAfterResult, emptyPitchSelection, enterAction, exitStudyForDeckNavigation, pitchSubmission, refreshReviewEntry, reviewAnswerForMode, setPitchLevel } from "./studyFlow";

const card = (id = "entry:reading"): StudyCard => ({
  entry_id: "entry", variant_id: id, stage: 1, active_duration_ms: 0, mode: "reading", question: "問",
  answer_language: "ko-KR", remaining: 1, total: 1, range_label: "0~0",
  recall_timeout_ms: 3000,
});

const result = (status: SubmitResult["status"], extra: Partial<SubmitResult> = {}): SubmitResult => ({ status, ...extra });

describe("editing the revealed entry", () => {
  const details = { entry: { id: "entry", term: "月見", meanings: ["달맞이", "달 구경"], reading: "つきみ" }, audio_path: "regenerated.wav" };

  for (const mode of ["reading", "listening", "writing"] as const) {
    it(`refreshes ${mode} in the current and other stages without changing progress or grading`, () => {
      for (const stage of [1, 2, 10]) {
        const current = { ...card(), stage, mode, audio_path: "old.wav" };
        const previous = result("review", { canonical_answer: "月  ·  달", failure_type: "UNKNOWN", card: current });
        const refreshed = refreshReviewEntry(current, previous, details)!;
        expect(refreshed.card).toEqual({ ...current, question: mode === "writing" ? "달맞이 / 달 구경" : "月見", audio_path: "regenerated.wav" });
        expect(refreshed.result.failure_type).toBe(previous.failure_type);
        expect(refreshed.result.reading).toBe("つきみ");
        expect(reviewAnswerForMode(mode, refreshed.result.canonical_answer)).toBe(mode === "reading" ? "달맞이 / 달 구경" : "月見");
        expect(activeCardTimerRuns(refreshed.card, refreshed.result)).toBe(false);
      }
    });
  }

  it("preserves a resolved review with no result card and removes invalidated audio", () => {
    const refreshed = refreshReviewEntry(card(), result("review"), { ...details, audio_path: null })!;
    expect(refreshed.result.card).toBeUndefined();
    expect(refreshed.card.audio_path).toBeNull();
  });

  it("ignores a different entry and an unresolved question", () => {
    expect(refreshReviewEntry({ ...card(), entry_id: "other" }, result("review"), details)).toBeNull();
    expect(refreshReviewEntry(card(), result("pass"), details)).toBeNull();
  });
});

describe("writing study user actions", () => {
  it("keeps the submitted card through ambiguous accept and reject actions", () => {
    const ambiguous = result("ambiguous", { card: card() });
    expect(cardAfterResult(card(), ambiguous)).toEqual(card());
    expect(enterAction(ambiguous)).toBe("none");
    expect(activeCardTimerRuns(card(), ambiguous)).toBe(false);
  });

  it("routes pitch and review Enter without submitting an answer", () => {
    expect(enterAction(result("pitch", { card: card(), pitch: {
      kind: "lexical", reading: "もん", morae: ["も", "ん"], phrase_count: 1,
      allowed_patterns: [[1, 0]], confidence: "VERIFIED", gate_enabled: true,
    } }))).toBe("pitch");
    expect(enterAction(result("review", { card: card() }))).toBe("review");
  });

  it("stage completion is terminal with no card, timer, or Enter submission", () => {
    const complete = result("stage_complete");
    expect(cardAfterResult(card(), complete)).toBeNull();
    expect(activeCardTimerRuns(null, complete)).toBe(false);
    expect(enterAction(complete)).toBe("none");
  });

  it("runs timers only for an actual active card", () => {
    expect(activeCardTimerRuns(card(), null)).toBe(true);
    expect(activeCardTimerRuns(card(), result("pass", { card: card() }))).toBe(true);
    for (const status of ["ambiguous", "pitch", "review", "cycle_complete", "stage_complete"] as const) {
      expect(activeCardTimerRuns(status === "stage_complete" ? null : card(), result(status))).toBe(false);
    }
  });

  it("shows only the answer side of the backend review payload", () => {
    const reviewPayload = "いす  ·  의자 / 좌석";
    expect(reviewAnswerForMode("reading", reviewPayload)).toBe("의자 / 좌석");
    expect(reviewAnswerForMode("writing", reviewPayload)).toBe("いす");
    expect(reviewAnswerForMode("listening", reviewPayload)).toBe("いす");
    expect(reviewAnswerForMode("reading", "의자 / 좌석")).toBe("의자 / 좌석");
  });

  it("Decks navigation exits a study session but not non-study views", async () => {
    const exit = vi.fn(async () => undefined);
    await exitStudyForDeckNavigation("study", exit);
    expect(exit).toHaveBeenCalledTimes(1);
    await exitStudyForDeckNavigation("stats", exit);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("builds a complete mora HIGH/LOW contour without numeric accent input", () => {
    let selection = emptyPitchSelection(4);
    expect(pitchSubmission(selection)).toBeNull();
    selection = setPitchLevel(selection, 0, 0);
    selection = setPitchLevel(selection, 1, 1);
    selection = setPitchLevel(selection, 2, 1);
    selection = setPitchLevel(selection, 3, 0);
    expect(pitchSubmission(selection)).toEqual([0, 1, 1, 0]);
  });

  it("a new pitch question starts with no stale contour selection", () => {
    const previous = [0, 1, 1, 0] as const;
    expect(pitchSubmission([...previous])).toEqual([0, 1, 1, 0]);
    expect(emptyPitchSelection(4)).toEqual([null, null, null, null]);
  });
});
