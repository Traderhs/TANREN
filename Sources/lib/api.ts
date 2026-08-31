import { invoke } from "@tauri-apps/api/core";
import type { DeckStats, DeckSummary, EntryDraft, StudyCard, SubmitResult } from "./types";

export const api = {
  listDecks: () => invoke<DeckSummary[]>("list_decks"),
  createDeck: (name: string) =>
    invoke<DeckSummary>("create_deck", {
      name,
      sourceLanguage: "ko-KR",
      targetLanguage: "ja-JP",
    }),
  importEntries: (deckId: string, entries: EntryDraft[]) =>
    invoke<number>("import_entries", { deckId, entries }),
  startStudy: (deckId: string) => invoke<StudyCard>("start_study", { deckId }),
  submitAnswer: (
    variantId: string,
    answer: string,
    recallLatencyMs: number,
    typingDurationMs: number,
    interkeyGapsMs: number[],
    imeCompositionMs: number,
  ) => invoke<SubmitResult>("submit_answer", {
    variantId, answer, recallLatencyMs, typingDurationMs, interkeyGapsMs, imeCompositionMs,
  }),
  timeoutCurrent: (kind: "recall" | "completion", answer: string, elapsedMs: number, typingDurationMs: number) =>
    invoke<SubmitResult>("timeout_current", { kind, answer, elapsedMs, typingDurationMs }),
  submitPitch: (variantId: string, patterns: number[]) =>
    invoke<SubmitResult>("submit_pitch", { variantId, patterns }),
  continueReview: () => invoke<SubmitResult>("continue_review"),
  adjudicate: (variantId: string, answer: string, accept: boolean) =>
    invoke<SubmitResult>("adjudicate_answer", { variantId, answer, accept }),
  stats: (deckId: string) => invoke<DeckStats[]>("deck_stats", { deckId }),
  exitStudy: () => invoke<void>("exit_study"),
};
