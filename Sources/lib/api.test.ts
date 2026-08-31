import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { api } from "./api";

describe("study command payloads", () => {
  beforeEach(() => invoke.mockReset());

  it.each([true, false])("adjudicates from backend pending data (accept=%s)", async (accept) => {
    invoke.mockResolvedValue({ status: "review" });
    await api.adjudicate("entry:recognition", accept);
    expect(invoke).toHaveBeenCalledWith("adjudicate_answer", { variantId: "entry:recognition", accept });
  });

  it("uses an explicit command to enter the next stage", async () => {
    invoke.mockResolvedValue({ status: "pass", card: {} });
    await api.continueStage();
    expect(invoke).toHaveBeenCalledWith("continue_stage");
  });

  it("binds timeout requests to the card variant that created the timer", async () => {
    invoke.mockResolvedValue({ status: "review" });
    await api.timeoutCurrent("entry:listening", "completion", "答", 4200, 1200);
    expect(invoke).toHaveBeenCalledWith("timeout_current", {
      variantId: "entry:listening", kind: "completion", answer: "答", elapsedMs: 4200, typingDurationMs: 1200,
    });
  });

  it("activates the answer language after the study input is focused", async () => {
    invoke.mockResolvedValue(null);
    await api.activateInputProfile("ko-KR");
    expect(invoke).toHaveBeenCalledWith("activate_input_profile", { language: "ko-KR" });
  });
});
