import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { api } from "./api";

describe("study command payloads", () => {
  beforeEach(() => invoke.mockReset());

  it.each([true, false])("adjudicates from backend pending data (accept=%s)", async (accept) => {
    invoke.mockResolvedValue({ status: "review" });
    await api.adjudicate("entry:reading", accept);
    expect(invoke).toHaveBeenCalledWith("adjudicate_answer", { variantId: "entry:reading", accept });
  });

  it("binds timeout requests to the card variant that created the timer", async () => {
    invoke.mockResolvedValue({ status: "review" });
    await api.timeoutCurrent("entry:listening", "completion", "答", "뜻", 4200, 1200);
    expect(invoke).toHaveBeenCalledWith("timeout_current", {
      variantId: "entry:listening", kind: "completion", answer: "答", meaningAnswer: "뜻", elapsedMs: 4200, typingDurationMs: 1200,
    });
  });

  it("submits listening form and meaning together", async () => {
    invoke.mockResolvedValue({ status: "review" });
    await api.submitAnswer("entry:listening", "答", "뜻", 800, 1200, [120, 90], 200, 900, [140, 110], 150);
    expect(invoke).toHaveBeenCalledWith("submit_answer", {
      variantId: "entry:listening", answer: "答", meaningAnswer: "뜻", recallLatencyMs: 800,
      typingDurationMs: 1200, interkeyGapsMs: [120, 90], imeCompositionMs: 200,
      meaningTypingDurationMs: 900, meaningInterkeyGapsMs: [140, 110], meaningImeCompositionMs: 150,
    });
  });

  it("activates the answer language after the study input is focused", async () => {
    invoke.mockResolvedValue(null);
    await api.activateInputProfile("ko-KR");
    expect(invoke).toHaveBeenCalledWith("activate_input_profile", { language: "ko-KR" });
  });

  it("loads and updates one entry through the shared edit path", async () => {
    invoke.mockResolvedValueOnce({ entry: { id: "entry", term: "猫", meanings: ["고양이"] }, pitch: null });
    await api.entryDetails("deck", "entry");
    expect(invoke).toHaveBeenLastCalledWith("entry_details", { deckId: "deck", entryId: "entry" });
  });

});
