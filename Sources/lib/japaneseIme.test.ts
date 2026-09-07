import { describe, expect, it } from "vitest";
import { japaneseImeEnterCommitsYomi, japaneseImeKeyStartsInput, japaneseImeKeyTap } from "./japaneseIme";

describe("TANREN local Japanese IME key normalization", () => {
  it("uses the physical letter key even when the OS IME reports Process", () => {
    const tap = japaneseImeKeyTap({
      key: "Process",
      code: "KeyN",
      repeat: false,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
    expect(tap.key).toBe("n");
    expect(japaneseImeKeyStartsInput(tap)).toBe(true);
  });

  it("preserves shift for latin letters and punctuation", () => {
    expect(japaneseImeKeyTap({ key: "Process", code: "KeyA", repeat: false, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false }).key).toBe("A");
    expect(japaneseImeKeyTap({ key: "Process", code: "Slash", repeat: false, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false }).key).toBe("?");
  });

  it("maps the physical space key to conversion space", () => {
    expect(japaneseImeKeyTap({ key: "Process", code: "Space", repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }).key).toBe(" ");
  });

  it("submits on Enter only for unconverted yomi", () => {
    expect(japaneseImeEnterCommitsYomi([{ text: "いす", kind: "yomi" }])).toBe(true);
    expect(japaneseImeEnterCommitsYomi([{ text: "椅子", kind: "focus", candidates: ["椅子"] }])).toBe(false);
    expect(japaneseImeEnterCommitsYomi([])).toBe(false);
  });
});
