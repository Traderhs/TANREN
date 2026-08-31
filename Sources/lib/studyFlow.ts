import type { StudyCard, StudyMode, SubmitResult } from "./types";

export type StudyEnterAction = "submit" | "pitch" | "review" | "stage" | "none";
export type PitchLevel = 0 | 1;
export type PitchSelection = Array<PitchLevel | null>;

export function emptyPitchSelection(moraCount: number): PitchSelection {
  return Array.from({ length: moraCount }, () => null);
}

export function setPitchLevel(selection: PitchSelection, index: number, level: PitchLevel): PitchSelection {
  if (index < 0 || index >= selection.length) return selection;
  const next = [...selection];
  next[index] = level;
  return next;
}

export function pitchSubmission(selection: PitchSelection): number[] | null {
  return selection.every((value) => value === 0 || value === 1) ? selection as number[] : null;
}

export function cardAfterResult(current: StudyCard | null, result: SubmitResult): StudyCard | null {
  if (result.card) return result.card;
  if (result.status === "stage_clear" || result.status === "round_complete") return null;
  return current;
}

export function enterAction(result: SubmitResult | null): StudyEnterAction {
  if (!result || result.status === "pass") return "submit";
  if (result.pitch) return "pitch";
  if (result.status === "review" || result.status === "fail") return "review";
  if (result.status === "stage_clear") return "stage";
  return "none";
}

export function activeCardTimerRuns(card: StudyCard | null, result: SubmitResult | null): boolean {
  return card !== null && (result === null || result.status === "pass");
}

export function shouldAutoPlayAfterWrittenAnswer(mode: StudyMode): boolean {
  return mode === "recognition" || mode === "production";
}

export async function exitStudyForDeckNavigation(
  view: "decks" | "editor" | "study" | "stats" | "settings",
  exitStudy: () => Promise<void>,
): Promise<void> {
  if (view === "study") await exitStudy();
}
