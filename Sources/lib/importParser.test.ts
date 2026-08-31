import { describe, expect, it } from "vitest";
import { parseEntryText } from "./importParser";

describe("parseEntryText", () => {
  it("supports BOM, CRLF, TSV, headers, and keeps valid rows around malformed rows", () => {
    const parsed = parseEntryText("\uFEFFterm\tmeaning\r\n見据える\t내다보다 / 전망하다\r\n잘못됨\t\r\n躊躇う\t망설이다");
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.issues).toEqual([{ row: 3, message: "뜻이 비어 있습니다.", raw: "잘못됨\t" }]);
  });

  it("supports quoted CSV commas, quotes, LF, and optional reading", () => {
    const parsed = parseEntryText('"term","meaning","reading"\n"目安","기준, 표준","めやす"\n"言う","""말하다"" / 이르다"');
    expect(parsed.issues).toEqual([]);
    expect(parsed.entries[0]).toEqual({ term: "目安", meanings: ["기준, 표준"], reading: "めやす" });
    expect(parsed.entries[1].meanings).toEqual(['"말하다"', "이르다"]);
  });

  it("reports duplicate pasted rows without discarding unique rows", () => {
    const parsed = parseEntryText("猫,고양이\n猫,고양이\n犬,개");
    expect(parsed.entries.map((entry) => entry.term)).toEqual(["猫", "犬"]);
    expect(parsed.issues[0].message).toContain("중복");
  });
});
