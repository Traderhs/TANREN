import { invoke } from "@tauri-apps/api/core";
import type { AudioSettings, DeckStats, DeckSummary, EntryDraft, ImportResult, LibraryStats, SemanticRuntimeStatus, StorageSettings, StudyMode, SubmitResult, VoicevoxRuntimeStatus } from "./types";

export const api = {
  listDecks: () => invoke<DeckSummary[]>("list_decks"),
  createDeck: (name: string) =>
    invoke<DeckSummary>("create_deck", {
      name,
      sourceLanguage: "ko-KR",
      targetLanguage: "ja-JP",
    }),
  importEntries: (deckId: string, entries: EntryDraft[]) =>
    invoke<ImportResult>("import_entries", { deckId, entries }),
  startStudy: (deckId: string, stageIndex?: number) => invoke<SubmitResult>("start_study", { deckId, stageIndex }),
  updateDeck: (deckId: string, name: string, enabledModes: StudyMode[]) =>
    invoke<DeckSummary>("update_deck", { deckId, name, enabledModes }),
  deleteDeck: (deckId: string) => invoke<void>("delete_deck", { deckId }),
  exportDeck: (deckId: string) => invoke<string>("export_deck", { deckId }),
  importDeckExport: (payload: string) => invoke<DeckSummary>("import_deck_export", { payload }),
  recordStudyActivity: (deckId: string, mode: StudyMode | null, durationMs: number) =>
    invoke<void>("record_study_activity", { deckId, mode, durationMs }),
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
  timeoutCurrent: (variantId: string, kind: "recall" | "completion", answer: string, elapsedMs: number, typingDurationMs: number) =>
    invoke<SubmitResult>("timeout_current", { variantId, kind, answer, elapsedMs, typingDurationMs }),
  submitPitch: (variantId: string, patterns: number[]) =>
    invoke<SubmitResult>("submit_pitch", { variantId, patterns }),
  continueReview: () => invoke<SubmitResult>("continue_review"),
  continueStage: () => invoke<SubmitResult>("continue_stage"),
  adjudicate: (variantId: string, accept: boolean) =>
    invoke<SubmitResult>("adjudicate_answer", { variantId, accept }),
  stats: (deckId: string) => invoke<DeckStats[]>("deck_stats", { deckId }),
  libraryStats: () => invoke<LibraryStats>("library_stats"),
  semanticStatus: () => invoke<SemanticRuntimeStatus>("semantic_status"),
  voicevoxStatus: () => invoke<VoicevoxRuntimeStatus>("voicevox_status"),
  storageSettings: () => invoke<StorageSettings>("storage_settings"),
  pickStorageDirectory: () => invoke<string | null>("pick_storage_directory"),
  setStorageDirectory: (path: string | null) => invoke<StorageSettings>("set_storage_directory", { path }),
  audioSettings: () => invoke<AudioSettings>("audio_settings"),
  setAudioSettings: (settings: AudioSettings) => invoke<AudioSettings>("set_audio_settings", {
    autoPlay: settings.auto_play,
    volume: settings.volume,
    playbackRate: settings.playback_rate,
  }),
  exportBackup: () => invoke<string | null>("export_backup"),
  importBackup: () => invoke<boolean>("import_backup"),
  activateInputProfile: (language: string) => invoke<string | null>("activate_input_profile", { language }),
  exitStudy: () => invoke<void>("exit_study"),
};
