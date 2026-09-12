import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const adapterPath = fileURLToPath(new URL("../public/vendor/hechima/hechima.js", import.meta.url));
const source = readFileSync(adapterPath, "utf8");
const context = {};
runInNewContext(source, context);
const resolveRomaji = context.Hechima.resolveRomaji;

function feedRomaji(input, flush = true) {
  let kana = "";
  let pend = "";
  for (const key of input) {
    ({ kana, pend } = resolveRomaji(kana, pend + key.toLowerCase(), false));
  }
  return flush ? resolveRomaji(kana, pend, true) : { kana, pend };
}

describe("Hechima romaji compatibility with Microsoft IME defaults", () => {
  it("commits nn immediately as ん", () => {
    expect(feedRomaji("nn", false)).toEqual({ kana: "ん", pend: "" });
    expect(feedRomaji("tanni").kana).toBe("たんい");
    expect(feedRomaji("nnna").kana).toBe("んな");
  });

  it("supports Microsoft IME c-row aliases", () => {
    expect(feedRomaji("cya").kana).toBe("ちゃ");
    expect(feedRomaji("cyi").kana).toBe("ちぃ");
    expect(feedRomaji("cyu").kana).toBe("ちゅ");
    expect(feedRomaji("cye").kana).toBe("ちぇ");
    expect(feedRomaji("cyo").kana).toBe("ちょ");
    expect(feedRomaji("ca").kana).toBe("か");
    expect(feedRomaji("cu").kana).toBe("く");
    expect(feedRomaji("co").kana).toBe("こ");
    expect(feedRomaji("ce").kana).toBe("せ");
    expect(feedRomaji("kwa").kana).toBe("くぁ");
  });

  it("supports the Microsoft IME extended y-row aliases", () => {
    const cases = {
      kyi: "きぃ", gyi: "ぎぃ", gye: "ぎぇ",
      syi: "しぃ", sye: "しぇ", zyi: "じぃ", zye: "じぇ",
      jyi: "じぃ", jye: "じぇ", tyi: "ちぃ", tye: "ちぇ",
      dyi: "ぢぃ", dye: "ぢぇ", nyi: "にぃ", nye: "にぇ",
      hyi: "ひぃ", hye: "ひぇ", byi: "びぃ", bye: "びぇ",
      pyi: "ぴぃ", pye: "ぴぇ", myi: "みぃ", mye: "みぇ",
      ryi: "りぃ", rye: "りぇ",
    };
    for (const [romaji, kana] of Object.entries(cases)) {
      expect(feedRomaji(romaji).kana, romaji).toBe(kana);
    }
  });

  it("supports the Microsoft IME extended foreign-sound aliases", () => {
    const cases = {
      wha: "うぁ", whi: "うぃ", whu: "う", whe: "うぇ", who: "うぉ",
      qwa: "くぁ", qwi: "くぃ", qwu: "くぅ", qwe: "くぇ", qwo: "くぉ",
      gwa: "ぐぁ", gwi: "ぐぃ", gwu: "ぐぅ", gwe: "ぐぇ", gwo: "ぐぉ",
      swa: "すぁ", swi: "すぃ", swu: "すぅ", swe: "すぇ", swo: "すぉ",
      twa: "とぁ", twi: "とぃ", twu: "とぅ", twe: "とぇ", two: "とぉ",
      dwa: "どぁ", dwi: "どぃ", dwu: "どぅ", dwe: "どぇ", dwo: "どぉ",
      fwa: "ふぁ", fwi: "ふぃ", fwu: "ふぅ", fwe: "ふぇ", fwo: "ふぉ",
      vya: "ヴゃ", vyi: "ヴぃ", vyu: "ヴゅ", vye: "ヴぇ", vyo: "ヴょ",
    };
    for (const [romaji, kana] of Object.entries(cases)) {
      expect(feedRomaji(romaji).kana, romaji).toBe(kana);
    }
  });

  it("supports Microsoft IME small-kana and n aliases", () => {
    const cases = {
      yi: "い", wu: "う", ye: "いぇ", xn: "ん",
      lyi: "ぃ", xyi: "ぃ", lye: "ぇ", xye: "ぇ",
      lka: "ヵ", xka: "ヵ", lke: "ヶ", xke: "ヶ",
      qya: "くゃ", qyu: "くゅ", qyo: "くょ",
      qyi: "くぃ", qye: "くぇ",
      fya: "ふゃ", fyu: "ふゅ", fyo: "ふょ", fyi: "ふぃ", fye: "ふぇ",
    };
    for (const [romaji, kana] of Object.entries(cases)) {
      expect(feedRomaji(romaji).kana, romaji).toBe(kana);
    }
  });
});
