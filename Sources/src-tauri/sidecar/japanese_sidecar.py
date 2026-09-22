from __future__ import annotations

import json
import copy
import hashlib
import html
import shutil
import io
import os
import re
import sys
import unicodedata
import contextlib
import math
import time
import urllib.parse
import urllib.error
import urllib.request
import wave
from array import array
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any


SMALL = set("ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ")
VOICE_AUDIO_REVISION = "v8"
POST_PHONEME_LENGTH = 0.42
TAIL_SILENCE_SECONDS = 0.22
_KANJIUM_ACCENTS: dict[tuple[str, str], list[int]] | None = None
_WIKTIONARY_ACCENTS: dict[tuple[str, str], list[int]] | None = None
_KANJIUM_BY_READING: dict[str, set[tuple[int, ...]]] | None = None
_WIKTIONARY_BY_READING: dict[str, set[tuple[int, ...]]] | None = None
_KANJIUM_ACCENTS_PATH: str | None = None
_WIKTIONARY_ACCENTS_PATH: str | None = None
VOICE_PROFILES = [
    {
        "voice_profile": "child_feminine",
        "age_band": "child",
        "gender_presentation": "feminine",
        "speaker_name": "春歌ナナ",
    },
    {
        "voice_profile": "child_masculine",
        "age_band": "child",
        "gender_presentation": "masculine",
        "speaker_name": "ずんだもん",
        "age_basis": "acoustic_presentation",
    },
    {
        "voice_profile": "adolescent_feminine",
        "age_band": "adolescent",
        "gender_presentation": "feminine",
        "speaker_name": "四国めたん",
    },
    {
        "voice_profile": "adolescent_masculine",
        "age_band": "adolescent",
        "gender_presentation": "masculine",
        "speaker_name": "雀松朱司",
        "age_basis": "acoustic_presentation",
        "speed_scale": 1.03,
        "pitch_scale": 0.025,
    },
    {
        "voice_profile": "young_adult_feminine",
        "age_band": "young_adult",
        "gender_presentation": "feminine",
        "speaker_name": "春日部つむぎ",
    },
    {
        "voice_profile": "young_adult_masculine",
        "age_band": "young_adult",
        "gender_presentation": "masculine",
        "speaker_name": "青山龍星",
    },
    {
        "voice_profile": "middle_aged_feminine",
        "age_band": "middle_aged",
        "gender_presentation": "feminine",
        "speaker_name": "後鬼",
    },
    {
        "voice_profile": "middle_aged_masculine",
        "age_band": "middle_aged",
        "gender_presentation": "masculine",
        "speaker_name": "剣崎雌雄",
    },
    {
        "voice_profile": "senior_feminine",
        "age_band": "senior",
        "gender_presentation": "feminine",
        "speaker_name": "東北イタコ",
        "age_basis": "acoustic_presentation",
        "speed_scale": 0.90,
        "pitch_scale": -0.08,
    },
    {
        "voice_profile": "senior_masculine",
        "age_band": "senior",
        "gender_presentation": "masculine",
        "speaker_name": "麒ヶ島宗麟",
        "age_basis": "acoustic_presentation",
        "speed_scale": 0.92,
        "pitch_scale": -0.04,
    },
]


_VOICEVOX_METADATA_CACHE: dict[str, tuple[list[dict[str, Any]], str]] = {}
_FUGASHI_TAGGER: Any = None
_FUGASHI_VERSION: str | None = None
_PYOPENJTALK_MODULE: Any = None


class AdaptiveTtsScheduler:
    """Self-tuning bounded concurrency for VOICEVOX synthesis.

    The scheduler deliberately does not assume a particular CPU/GPU.  It uses
    the host's logical CPU count only to derive a conservative exploration
    ceiling, then adjusts the active concurrency from measured throughput and
    request failures.  State lives for the lifetime of the sidecar process, so
    later entries reuse what the current machine/runtime has already learned.
    """

    def __init__(self) -> None:
        self.limit = 0
        self.best_rate = 0.0

    @staticmethod
    def ceiling(task_count: int) -> int:
        logical_cpus = max(1, os.cpu_count() or 1)
        # Sublinear growth prevents a high-core-count host from flooding a
        # single VOICEVOX engine while still allowing faster machines to probe
        # more parallelism.  Runtime measurements decide whether to keep it.
        adaptive_cap = max(1, min(logical_cpus, int(math.sqrt(logical_cpus)) + 1))
        return max(1, min(task_count, adaptive_cap))

    def map(self, items: list[Any], operation) -> list[Any]:
        if not items:
            return []

        ceiling = self.ceiling(len(items))
        if self.limit <= 0:
            self.limit = min(ceiling, max(2, (ceiling + 1) // 2))
        self.limit = min(max(1, self.limit), ceiling)

        pending = list(enumerate(items))
        results: list[Any] = [None] * len(items)
        attempts = [0] * len(items)

        while pending:
            target_width = min(self.limit, ceiling)
            width = min(target_width, len(pending))
            full_wave = width == target_width
            wave = pending[:width]
            pending = pending[width:]
            started = time.perf_counter()
            failures: list[tuple[int, Any, Exception]] = []

            with ThreadPoolExecutor(max_workers=width, thread_name_prefix="tanren-tts") as executor:
                future_to_item = {
                    executor.submit(operation, item): (index, item)
                    for index, item in wave
                }
                for future in as_completed(future_to_item):
                    index, item = future_to_item[future]
                    try:
                        results[index] = future.result()
                    except Exception as error:
                        failures.append((index, item, error))

            elapsed = max(time.perf_counter() - started, 1e-6)
            successes = len(wave) - len(failures)
            rate = successes / elapsed

            if failures:
                # Engine contention, memory pressure, or transient HTTP errors
                # cause immediate backoff. Failed profiles are retried at the
                # reduced width so a too-aggressive probe does not fail an entry.
                self.limit = max(1, width // 2)
                for index, item, error in failures:
                    attempts[index] += 1
                    if attempts[index] >= 3:
                        raise RuntimeError(
                            f"VOICEVOX synthesis failed after adaptive retries: {error}"
                        ) from error
                    pending.append((index, item))
                continue

            # Additive exploration while throughput remains close to the best
            # observed rate; retreat when extra parallelism hurts materially.
            # The reference slowly decays so the tuner can relearn after the
            # host's load or accelerator availability changes at runtime.
            if not full_wave:
                continue
            reference_rate = self.best_rate
            self.best_rate = max(rate, reference_rate * 0.96)
            if width < ceiling and (reference_rate <= 0.0 or rate >= reference_rate * 1.03):
                self.limit = width + 1
            elif width > 1 and reference_rate > 0.0 and rate < reference_rate * 0.75:
                self.limit = width - 1
            else:
                self.limit = width

        return results


_TTS_SCHEDULER = AdaptiveTtsScheduler()


def import_pyopenjtalk():
    global _PYOPENJTALK_MODULE
    if _PYOPENJTALK_MODULE is not None:
        return _PYOPENJTALK_MODULE
    # pyopenjtalk-plus may print optional-backend notices while importing.
    # Keep stdout reserved for the JSON RPC response.
    with contextlib.redirect_stdout(sys.stderr):
        import pyopenjtalk  # type: ignore
    _PYOPENJTALK_MODULE = pyopenjtalk
    return _PYOPENJTALK_MODULE


def hira(text: str) -> str:
    out = []
    for ch in text:
        code = ord(ch)
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def kata(text: str) -> str:
    out = []
    for ch in text:
        code = ord(ch)
        if 0x3041 <= code <= 0x3096:
            out.append(chr(code + 0x60))
        else:
            out.append(ch)
    return "".join(out)


def morae(reading: str) -> list[str]:
    result: list[str] = []
    for ch in reading:
        if ch.isspace() or unicodedata.category(ch).startswith("P"):
            continue
        if ch in SMALL and result:
            result[-1] += ch
        else:
            result.append(ch)
    return result


def parse_accent_types(raw: Any) -> list[int] | None:
    if raw in (None, "", "*"):
        return None
    values = [int(value) for value in re.findall(r"\d+", str(raw))]
    return list(dict.fromkeys(values)) or None


def accent_contour(mora_count: int, accent_type: int) -> list[int] | None:
    """Return canonical Tokyo lexical L/H levels (0=L, 1=H).

    UniDic aType is the mora after which the lexical accent falls; 0 is
    heiban. Odaka therefore has the same within-token levels as heiban and is
    distinguished losslessly by downstep_after_mora in analysis metadata.
    """
    if mora_count <= 0 or accent_type < 0 or accent_type > mora_count:
        return None
    if mora_count == 1:
        return [1]
    if accent_type == 1:
        return [1] + [0] * (mora_count - 1)
    contour = [0] + [1] * (mora_count - 1)
    if 1 < accent_type < mora_count:
        for index in range(accent_type, mora_count):
            contour[index] = 0
    return contour


def accent_contours(mora_count: int, accent_types: list[int] | None) -> list[list[int]] | None:
    if not accent_types:
        return None
    values = [value for accent in accent_types if (value := accent_contour(mora_count, accent)) is not None]
    return values or None


def enforce_pitch_contour(accent_phrases: list[dict[str, Any]], contour: list[int]) -> list[dict[str, Any]]:
    """Correct lexical pitch direction without exaggerating small model transitions.

    Preserve the model's pitch distance when reversing an incorrect edge. A
    fixed minimum on every L/H edge turns subtle movements into large jumps.
    Only an exactly flat edge needs a small nonzero target.
    """
    if len(accent_phrases) != 1:
        return accent_phrases
    moras = accent_phrases[0].get("moras", [])
    if len(moras) != len(contour):
        return accent_phrases

    pitches: list[float | None] = []
    for mora in moras:
        raw = mora.get("pitch")
        try:
            pitch = float(raw)
        except (TypeError, ValueError):
            pitch = None
        pitches.append(pitch if pitch is not None and pitch > 0 else None)

    target_gaps = [
        abs(right - left) if left is not None and right is not None and right != left else 0.02
        for left, right in zip(pitches, pitches[1:])
    ]
    for _ in range(max(1, len(contour))):
        changed = False
        for index in range(len(contour) - 1):
            if contour[index] == contour[index + 1]:
                continue
            left = pitches[index]
            right = pitches[index + 1]
            if left is None or right is None:
                continue
            signed_gap = right - left if contour[index] < contour[index + 1] else left - right
            if signed_gap >= target_gaps[index]:
                continue
            correction = (target_gaps[index] - signed_gap) / 2.0
            if contour[index] < contour[index + 1]:
                pitches[index] = max(0.01, left - correction)
                pitches[index + 1] = right + correction
            else:
                pitches[index] = left + correction
                pitches[index + 1] = max(0.01, right - correction)
            changed = True
        if not changed:
            break

    for mora, pitch in zip(moras, pitches):
        if pitch is not None:
            mora["pitch"] = pitch
    return accent_phrases


def scope_for(text: str, token_count: int) -> str:
    if re.search(r"[。！？!?]", text):
        return "sentence"
    if token_count > 1 or re.search(r"\s", text):
        return "phrase"
    return "lexical"


def all_kana(text: str) -> bool:
    return all(ch.isspace() or "ぁ" <= ch <= "ゖ" or "ァ" <= ch <= "ヺ" or ch in "ー・" for ch in text)


def token_data(text: str) -> tuple[list[dict[str, Any]], list[int] | None, str | None]:
    global _FUGASHI_TAGGER, _FUGASHI_VERSION
    try:
        if _FUGASHI_TAGGER is None:
            unidic_override = os.environ.get("TANREN_UNIDIC_DIR")
            if unidic_override:
                import unidic  # type: ignore
                unidic.DICDIR = unidic_override
            import fugashi  # type: ignore
            _FUGASHI_TAGGER = fugashi.Tagger()
            _FUGASHI_VERSION = getattr(fugashi, "__version__", None)
        tagger = _FUGASHI_TAGGER
    except Exception as error:
        raise RuntimeError(f"UniDic/Fugashi initialization failed: {error}") from error

    tokens: list[dict[str, Any]] = []
    accent: list[int] | None = None
    raw_tokens = list(tagger(text))
    if text and not raw_tokens:
        raise RuntimeError(f"UniDic/Fugashi returned no tokens for lexical input: {text}")
    for tokenized in raw_tokens:
        feat = tokenized.feature
        def f(name: str, default=None):
            return getattr(feat, name, default)
        atype = f("aType")
        if atype is None:
            atype = f("accentType")
        token = {
            "surface": tokenized.surface,
            "lemma": f("lemma"),
            "reading": f("kana") or f("pron"),
            "pronunciation": f("pron"),
            "pos": f("pos1"),
            "conjugation": f("cForm"),
            "accent_type": atype,
        }
        tokens.append(token)
    if len(raw_tokens) == 1:
        accent = parse_accent_types(tokens[0].get("accent_type"))
    return tokens, accent, _FUGASHI_VERSION


def _masked_context(term: str, expected_reading: str, text: str) -> str | None:
    tokens, _, _ = token_data(text)
    matched_surface = None
    for token in tokens:
        surface = str(token.get("surface") or "")
        lemma = str(token.get("lemma") or "")
        token_reading = hira(str(token.get("reading") or token.get("pronunciation") or ""))
        if surface == term or lemma == term:
            if expected_reading and token_reading and token_reading != expected_reading:
                continue
            matched_surface = surface
            break
    if not matched_surface:
        for start in range(len(tokens)):
            surface_parts: list[str] = []
            reading_parts: list[str] = []
            for token in tokens[start:]:
                surface = str(token.get("surface") or "")
                if not surface:
                    break
                surface_parts.append(surface)
                combined_surface = "".join(surface_parts)
                if not term.startswith(combined_surface):
                    break
                token_reading = hira(str(token.get("reading") or token.get("pronunciation") or ""))
                if token_reading and token_reading != "*":
                    reading_parts.append(token_reading)
                if combined_surface == term:
                    combined_reading = "".join(reading_parts)
                    if expected_reading and combined_reading and combined_reading != expected_reading:
                        break
                    matched_surface = combined_surface
                    break
            if matched_surface:
                break
    if not matched_surface:
        return None
    display_text = text.replace(matched_surface, "＿＿", 1)
    if term in display_text:
        return None
    return display_text


def mediawiki_listening_hint(
    term: str,
    reading: str,
    endpoint: str,
    provider: str,
    license_text: str,
) -> dict[str, Any] | None:
    query = urllib.parse.urlencode({
        "action": "query",
        "format": "json",
        "list": "search",
        "srsearch": f'"{term}"',
        "srwhat": "text",
        "srlimit": "20",
        "srprop": "snippet",
    })
    request = urllib.request.Request(
        endpoint + "?" + query,
        headers={"User-Agent": "TANREN/1.2.0 (listening homophone hint)"},
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None
    candidates = []
    search_results = (payload.get("query") or {}).get("search") or []

    def add_candidate(text: str, title: str, page_id: int) -> None:
        text = unicodedata.normalize("NFKC", re.sub(r"\s+", " ", text).strip(" …"))
        if not text or term not in text:
            return
        try:
            display_text = _masked_context(term, reading, text)
        except Exception:
            return
        if not display_text:
            return
        candidates.append({
            "sentence_id": page_id,
            "sentence_text": text,
            "display_text": display_text,
            "owner": title,
            "license": license_text,
            "provider": provider,
            "attribution": f"{provider} · {title} · {license_text}",
        })

    for result in search_results:
        raw = html.unescape(re.sub(r"<[^>]+>", "", str(result.get("snippet") or "")))
        add_candidate(
            raw,
            str(result.get("title") or provider),
            int(result.get("pageid") or 0),
        )

    page_ids = [str(result.get("pageid")) for result in search_results if result.get("pageid")]
    if page_ids:
        detail_query = urllib.parse.urlencode({
            "action": "query",
            "format": "json",
            "prop": "extracts",
            "explaintext": "1",
            "pageids": "|".join(page_ids),
        })
        detail_request = urllib.request.Request(
            endpoint + "?" + detail_query,
            headers={"User-Agent": "TANREN/1.2.0 (listening homophone hint)"},
        )
        try:
            with urllib.request.urlopen(detail_request, timeout=12) as response:
                detail_payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            detail_payload = {}
        pages = ((detail_payload.get("query") or {}).get("pages") or {})
        for page in pages.values():
            title = str(page.get("title") or provider)
            page_id = int(page.get("pageid") or 0)
            extract = str(page.get("extract") or "")
            for fragment in re.split(r"(?<=[。！？!?])|[\r\n]+", extract):
                if term in fragment:
                    add_candidate(fragment, title, page_id)
    if not candidates:
        return None
    return min(candidates, key=lambda item: (len(item["sentence_text"]), item["sentence_id"]))


def aozora_listening_hint(term: str, reading: str) -> dict[str, Any] | None:
    query = urllib.parse.urlencode({"word": term})
    request = urllib.request.Request(
        "https://myokoym.net/aozorasearch/search?" + query,
        headers={"User-Agent": "TANREN/1.2.0 (listening homophone hint)"},
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            page = response.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, UnicodeDecodeError):
        return None

    candidates = []
    result_pattern = re.compile(
        r"<li>\s*<h4>\s*<a href=[\"'](?P<card>https://www\.aozora\.gr\.jp/cards/[^\"']+)[\"']>"
        r"(?P<title>.*?)</a>\s*</h4>.*?<p class=[\"']author[\"']>\s*(?P<author>.*?)\s*</p>"
        r".*?</h5>\s*<p>\s*(?P<snippet>.*?)\s*</p>",
        re.DOTALL,
    )
    for match in result_pattern.finditer(page):
        title = html.unescape(re.sub(r"<[^>]+>", "", match.group("title"))).strip()
        author = html.unescape(re.sub(r"<[^>]+>", "", match.group("author"))).strip()
        card_url = html.unescape(match.group("card")).strip()
        snippet = html.unescape(re.sub(r"<[^>]+>", "", match.group("snippet")))
        for fragment in re.split(r"\s*/\s*", snippet):
            text = unicodedata.normalize(
                "NFKC",
                re.sub(r"\s+", " ", fragment).strip(" .…\r\n\t"),
            )
            if not text or term not in text:
                continue
            try:
                display_text = _masked_context(term, reading, text)
            except Exception:
                continue
            if not display_text:
                continue
            card_match = re.search(r"card(\d+)\.html", card_url)
            candidates.append({
                "sentence_id": int(card_match.group(1)) if card_match else 0,
                "sentence_text": text,
                "display_text": display_text,
                "owner": author or title or "Aozora Bunko",
                "license": "see Aozora Bunko work rights",
                "provider": "Aozora Bunko",
                "attribution": f"青空文庫 · {title} · {author}".strip(" ·"),
            })
    if not candidates:
        return None
    return min(candidates, key=lambda item: (len(item["sentence_text"]), item["sentence_id"]))


def jreibun_listening_hint(term: str, reading: str) -> dict[str, Any] | None:
    request = urllib.request.Request(
        "https://jisho.org/search/" + urllib.parse.quote(term + " #sentences"),
        headers={"User-Agent": "Mozilla/5.0 TANREN/1.2.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            page = response.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, UnicodeDecodeError):
        return None

    candidates = []
    for block in page.split('<li class="entry sentence clearfix">')[1:]:
        if "inline_copyright jreibun" not in block:
            continue
        sentence_match = re.search(
            r'<ul class="japanese_sentence[^"]*"[^>]*>(.*?)</ul>',
            block,
            re.DOTALL,
        )
        if not sentence_match:
            continue
        sentence_html = re.sub(
            r'<span class="furigana">.*?</span>',
            "",
            sentence_match.group(1),
            flags=re.DOTALL,
        )
        text = html.unescape(re.sub(r"<[^>]+>", "", sentence_html))
        text = unicodedata.normalize("NFKC", re.sub(r"\s+", "", text).strip())
        if not text or term not in text:
            continue
        try:
            display_text = _masked_context(term, reading, text)
        except Exception:
            continue
        if not display_text:
            continue
        detail_match = re.search(r"/sentences/([0-9a-f]+)", block)
        debug_match = re.search(r'<div class="debug">jreibun/(\d+)/(\d+)</div>', block)
        sentence_id = 0
        if debug_match:
            sentence_id = int(debug_match.group(1)) * 1000 + int(debug_match.group(2))
        candidates.append({
            "sentence_id": sentence_id,
            "sentence_text": text,
            "display_text": display_text,
            "owner": "Jreibun",
            "license": "see Jreibun source",
            "provider": "Jreibun",
            "attribution": "Jreibun (TUFS) · via Jisho.org"
                + (f" · {detail_match.group(1)}" if detail_match else ""),
        })
    if not candidates:
        return None
    return min(candidates, key=lambda item: (len(item["sentence_text"]), item["sentence_id"]))


def jisho_dictionary_hint(term: str, reading: str) -> dict[str, Any] | None:
    query = urllib.parse.urlencode({"keyword": term})
    request = urllib.request.Request(
        "https://jisho.org/api/v1/search/words?" + query,
        headers={"User-Agent": "TANREN/1.2.0 (listening homophone hint)"},
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None

    for result in payload.get("data") or []:
        matched = False
        for form in result.get("japanese") or []:
            word = unicodedata.normalize("NFKC", str(form.get("word") or form.get("reading") or "").strip())
            form_reading = hira(unicodedata.normalize("NFKC", str(form.get("reading") or "").strip()))
            if word == term and (not reading or not form_reading or form_reading == reading):
                matched = True
                break
        if not matched:
            continue
        for sense in result.get("senses") or []:
            definitions = [str(value).strip() for value in (sense.get("english_definitions") or []) if str(value).strip()]
            if not definitions:
                continue
            definition = "; ".join(definitions[:3])
            digest = hashlib.sha256((term + "\0" + reading).encode("utf-8")).hexdigest()
            return {
                "sentence_id": int(digest[:15], 16),
                "sentence_text": definition,
                "display_text": definition,
                "owner": "EDRDG",
                "license": "EDRDG licence",
                "provider": "JMdict",
                "attribution": "JMdict / EDRDG · via Jisho.org",
            }
    return None


def rakuten_recipe_hint(term: str) -> dict[str, Any] | None:
    request = urllib.request.Request(
        "https://recipe.rakuten.co.jp/search/" + urllib.parse.quote(term) + "/",
        headers={"User-Agent": "Mozilla/5.0 TANREN/1.2.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            page = response.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, UnicodeDecodeError):
        return None

    match = re.search(r"<title>(.*?)</title>", page, re.DOTALL | re.IGNORECASE)
    if not match:
        return None
    title = html.unescape(re.sub(r"<[^>]+>", "", match.group(1))).strip()
    if term not in title:
        return None
    title = re.sub(r"\s*[|｜]\s*楽天レシピ.*$", "", title).strip()
    digest = hashlib.sha256(("rakuten-recipe\0" + term).encode("utf-8")).hexdigest()
    return {
        "sentence_id": int(digest[:15], 16),
        "sentence_text": title,
        "display_text": title.replace(term, "＿＿", 1),
        "owner": "Rakuten Recipe",
        "license": "see source page",
        "provider": "Rakuten Recipe",
        "attribution": "楽天レシピ検索",
    }


def tatoeba_listening_hint(term: str, reading: str | None = None) -> dict[str, Any] | None:
    term = unicodedata.normalize("NFKC", term.strip())
    expected_reading = hira(unicodedata.normalize("NFKC", str(reading or "").strip()))
    if not term:
        return None
    query = urllib.parse.urlencode({
        "lang": "jpn",
        "q": term,
        "sort": "words",
        "is_unapproved": "no",
    })
    request = urllib.request.Request(
        "https://api.tatoeba.org/v1/sentences?" + query,
        headers={"User-Agent": "TANREN/1.2.0 (listening homophone hint)"},
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        payload = {"data": []}

    candidates: list[dict[str, Any]] = []
    for sentence in payload.get("data") or []:
        text = unicodedata.normalize("NFKC", str(sentence.get("text") or "").strip())
        owner = sentence.get("owner")
        if not text or not owner:
            continue
        display_text = _masked_context(term, expected_reading, text)
        if not display_text:
            continue
        candidates.append({
            "sentence_id": int(sentence["id"]),
            "sentence_text": text,
            "display_text": display_text,
            "owner": str(owner),
            "license": str(sentence.get("license") or "CC BY 2.0 FR"),
            "provider": "Tatoeba",
            "attribution": f"Tatoeba #{int(sentence['id'])} · {owner} · {str(sentence.get('license') or 'CC BY 2.0 FR')}",
        })
    if candidates:
        return min(candidates, key=lambda item: (len(item["sentence_text"]), item["sentence_id"]))

    for endpoint, provider, license_text in (
        ("https://ja.wikipedia.org/w/api.php", "Japanese Wikipedia", "CC BY-SA 4.0"),
        ("https://ja.wiktionary.org/w/api.php", "Japanese Wiktionary", "CC BY-SA 4.0"),
        ("https://ja.wikisource.org/w/api.php", "Japanese Wikisource", "see source page"),
        ("https://ja.wikibooks.org/w/api.php", "Japanese Wikibooks", "see source page"),
        ("https://ja.wikinews.org/w/api.php", "Japanese Wikinews", "see source page"),
    ):
        hint = mediawiki_listening_hint(term, expected_reading, endpoint, provider, license_text)
        if hint:
            return hint

    hint = jreibun_listening_hint(term, expected_reading)
    if hint:
        return hint

    hint = aozora_listening_hint(term, expected_reading)
    if hint:
        return hint

    hint = jisho_dictionary_hint(term, expected_reading)
    if hint:
        return hint

    return rakuten_recipe_hint(term)


def reading_from_openjtalk(text: str) -> tuple[str | None, str | None]:
    try:
        pyopenjtalk = import_pyopenjtalk()
        text = re.sub(
            r"(?<!\d)\d{1,3}(?:,\d{3})+(?!\d)",
            lambda match: match.group(0).replace(",", ""),
            text,
        )
        return hira(pyopenjtalk.g2p(text, kana=True)), getattr(pyopenjtalk, "__version__", None)
    except Exception:
        return None, None


def load_kanjium_accents(path: str | None) -> dict[tuple[str, str], list[int]]:
    global _KANJIUM_ACCENTS, _KANJIUM_BY_READING, _KANJIUM_ACCENTS_PATH
    normalized_path = os.path.abspath(path) if path else None
    if _KANJIUM_ACCENTS is not None and _KANJIUM_ACCENTS_PATH == normalized_path:
        return _KANJIUM_ACCENTS
    values: dict[tuple[str, str], list[int]] = {}
    by_reading: dict[str, set[tuple[int, ...]]] = {}
    if path:
        with open(path, "r", encoding="utf-8") as source:
            for raw_line in source:
                line = raw_line.rstrip("\r\n")
                if not line:
                    continue
                fields = line.split("\t")
                if len(fields) != 3:
                    continue
                word = unicodedata.normalize("NFKC", fields[0].strip())
                reading = hira(unicodedata.normalize("NFKC", fields[1].strip()))
                try:
                    positions = [int(value) for value in fields[2].split(",") if value.strip() != ""]
                except ValueError:
                    continue
                if word and reading and positions:
                    values[(word, reading)] = positions
                    by_reading.setdefault(reading, set()).add(tuple(positions))
    _KANJIUM_ACCENTS = values
    _KANJIUM_BY_READING = by_reading
    _KANJIUM_ACCENTS_PATH = normalized_path
    return values


def load_wiktionary_accents(path: str | None) -> dict[tuple[str, str], list[int]]:
    global _WIKTIONARY_ACCENTS, _WIKTIONARY_BY_READING, _WIKTIONARY_ACCENTS_PATH
    normalized_path = os.path.abspath(path) if path else None
    if _WIKTIONARY_ACCENTS is not None and _WIKTIONARY_ACCENTS_PATH == normalized_path:
        return _WIKTIONARY_ACCENTS
    values: dict[tuple[str, str], list[int]] = {}
    by_reading: dict[str, set[tuple[int, ...]]] = {}
    if path:
        with open(path, "r", encoding="utf-8") as source:
            payload = json.load(source)
        for entry in payload.get("entries") or []:
            word = unicodedata.normalize("NFKC", str(entry.get("word") or "").strip())
            reading = hira(unicodedata.normalize("NFKC", str(entry.get("reading") or "").strip()))
            raw_positions = entry.get("pitch_positions")
            if not word or not reading or not isinstance(raw_positions, list):
                continue
            try:
                positions = [int(value) for value in raw_positions]
            except (TypeError, ValueError):
                continue
            if positions:
                values[(word, reading)] = positions
                by_reading.setdefault(reading, set()).add(tuple(positions))
    _WIKTIONARY_ACCENTS = values
    _WIKTIONARY_BY_READING = by_reading
    _WIKTIONARY_ACCENTS_PATH = normalized_path
    return values


def open_pitch_accent(
    text: str,
    reading: str,
    mora_count: int,
    kanjium_path: str | None,
    wiktionary_path: str | None,
) -> tuple[list[int] | None, str | None]:
    key = (
        unicodedata.normalize("NFKC", text.strip()),
        hira(unicodedata.normalize("NFKC", reading.strip())),
    )
    for source, values in (
        ("Kanjium pitch accent database", load_kanjium_accents(kanjium_path)),
        ("Japanese Wiktionary pitch accent", load_wiktionary_accents(wiktionary_path)),
    ):
        accent_types = values.get(key)
        if not accent_types:
            continue
        valid = [value for value in accent_types if 0 <= value <= mora_count]
        if valid:
            return valid, source
    reading_candidates: set[tuple[int, ...]] = set()
    if _KANJIUM_BY_READING is not None:
        reading_candidates.update(_KANJIUM_BY_READING.get(key[1], set()))
    if _WIKTIONARY_BY_READING is not None:
        reading_candidates.update(_WIKTIONARY_BY_READING.get(key[1], set()))
    if len(reading_candidates) == 1:
        candidate = next(iter(reading_candidates))
        valid = [value for value in candidate if 0 <= value <= mora_count]
        if len(valid) == len(candidate):
            return valid, "Open pitch dictionaries (unique reading match)"
    return None, None


def voicevox_request(base_url: str, path: str, params: dict[str, Any] | None = None, body: Any = None, binary: bool = False):
    query = urllib.parse.urlencode(params or {})
    url = base_url.rstrip("/") + path + ("?" + query if query else "")
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    post_paths = {"/accent_phrases", "/audio_query", "/mora_data", "/synthesis", "/initialize_speaker"}
    request = urllib.request.Request(url, data=data if data is not None else (b"" if path in post_paths else None), method="POST" if path in post_paths else "GET")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = response.read()
    if binary:
        return payload
    if not payload:
        return None
    return json.loads(payload.decode("utf-8"))


def valid_wav(path: str) -> bool:
    try:
        if os.path.getsize(path) <= 44:
            return False
        with open(path, "rb") as handle:
            header = handle.read(12)
        return header[:4] == b"RIFF" and header[8:12] == b"WAVE"
    except OSError:
        return False


def soften_wav_tail(wav_bytes: bytes) -> bytes:
    """Preserve synthesized speech exactly and guarantee a silent tail.

    Do not fade or rewrite voiced samples here: even a short synthetic fade can
    shave off the natural release of a final mora. VOICEVOX handles the speech
    envelope; this cache post-process only ensures playback has room to end.
    """
    try:
        source = io.BytesIO(wav_bytes)
        with wave.open(source, "rb") as reader:
            channels = reader.getnchannels()
            sample_width = reader.getsampwidth()
            sample_rate = reader.getframerate()
            frames = reader.readframes(reader.getnframes())
            compression = reader.getcomptype()
            compression_name = reader.getcompname()
        if sample_width != 2 or channels <= 0 or sample_rate <= 0:
            return wav_bytes

        samples = array("h")
        samples.frombytes(frames)
        if sys.byteorder != "little":
            samples.byteswap()

        frame_count = len(samples) // channels
        threshold = 64
        last_voiced = -1
        for frame_index in range(frame_count - 1, -1, -1):
            base = frame_index * channels
            if any(abs(samples[base + channel]) > threshold for channel in range(channels)):
                last_voiced = frame_index
                break

        existing_tail = max(0, frame_count - last_voiced - 1)
        required_tail = int(sample_rate * TAIL_SILENCE_SECONDS)
        if existing_tail < required_tail:
            samples.extend([0] * ((required_tail - existing_tail) * channels))

        if sys.byteorder != "little":
            samples.byteswap()
        output = io.BytesIO()
        with wave.open(output, "wb") as writer:
            writer.setnchannels(channels)
            writer.setsampwidth(sample_width)
            writer.setframerate(sample_rate)
            writer.setcomptype(compression, compression_name)
            writer.writeframes(samples.tobytes())
        return output.getvalue()
    except (OSError, wave.Error, ValueError):
        return wav_bytes


def voicevox_kana_notation(expected_morae: list[str], accent_type: int) -> str:
    if not expected_morae:
        raise ValueError("VOICEVOX kana notation requires at least one mora")
    nucleus = accent_type if accent_type > 0 else len(expected_morae)
    if nucleus < 1 or nucleus > len(expected_morae):
        raise ValueError(f"invalid accent type {accent_type} for {len(expected_morae)} morae")
    parts = [kata(mora) for mora in expected_morae]
    parts[nucleus - 1] += "'"
    return "".join(parts)


def resolve_voice_profiles(speakers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    resolved: list[dict[str, Any]] = []
    by_name = {str(speaker.get("name")): speaker for speaker in speakers}
    for profile in VOICE_PROFILES:
        speaker = by_name.get(profile["speaker_name"])
        if not speaker:
            continue
        styles = [style for style in speaker.get("styles", []) if style.get("type", "talk") == "talk"]
        if not styles:
            continue
        style = next((value for value in styles if str(value.get("name")) in {"ノーマル", "Normal"}), styles[0])
        resolved.append({**profile, "speaker_id": int(style["id"]), "style_name": str(style.get("name", ""))})
    return resolved


def voicevox_metadata(base_url: str) -> tuple[list[dict[str, Any]], str]:
    cached = _VOICEVOX_METADATA_CACHE.get(base_url)
    if cached is not None:
        return cached
    speakers = voicevox_request(base_url, "/speakers")
    profiles = resolve_voice_profiles(speakers)
    if not profiles:
        raise RuntimeError("VOICEVOX has none of TANREN's configured voice profiles")
    version = str(voicevox_request(base_url, "/version"))
    cached = (profiles, version)
    _VOICEVOX_METADATA_CACHE[base_url] = cached
    return cached


def voicevox_native_accent_type(
    base_url: str,
    reading: str,
    expected_morae: list[str],
) -> tuple[int | None, str | None]:
    if not expected_morae:
        return None, None
    profiles, version = voicevox_metadata(base_url)
    query = voicevox_request(
        base_url,
        "/audio_query",
        {"text": hira(reading), "speaker": profiles[0]["speaker_id"]},
    )
    phrases = query.get("accent_phrases", []) if isinstance(query, dict) else []
    if not phrases:
        return None, version

    flattened_morae: list[str] = []
    phrase_morae: list[list[dict[str, Any]]] = []
    for phrase in phrases:
        if not isinstance(phrase, dict):
            return None, version
        if phrase.get("pause_mora") is not None:
            return None, version
        moras = phrase.get("moras", [])
        if not isinstance(moras, list):
            return None, version
        typed_moras = [mora for mora in moras if isinstance(mora, dict)]
        if len(typed_moras) != len(moras):
            return None, version
        phrase_morae.append(typed_moras)
        flattened_morae.extend(hira(str(mora.get("text", ""))) for mora in typed_moras)

    normalized_expected = [hira(mora) for mora in expected_morae]
    if flattened_morae != normalized_expected:
        return None, version

    for phrase, moras in zip(phrases, phrase_morae):
        if not moras:
            continue
        try:
            accent = int(phrase.get("accent"))
        except (TypeError, ValueError):
            return None, version
        if accent < 1 or accent > len(moras):
            return None, version
        # VOICEVOX occasionally splits one explicitly supplied lexical reading
        # into multiple accent phrases (e.g. せっくす -> せっく / す). TANREN's
        # entry is still one learning unit, so use the first lexical downstep
        # against the flattened mora sequence instead of discarding the pitch.
        return accent, version

    return None, version


def voicevox_pitch_contour(
    base_url: str,
    reading: str,
    expected_morae: list[str],
) -> tuple[list[int] | None, str | None]:
    if not expected_morae:
        return None, None
    profiles, version = voicevox_metadata(base_url)
    query = voicevox_request(
        base_url,
        "/audio_query",
        {"text": hira(reading), "speaker": profiles[0]["speaker_id"]},
    )
    phrases = query.get("accent_phrases", []) if isinstance(query, dict) else []
    if not phrases:
        return None, version

    flattened_morae: list[str] = []
    contour: list[int] = []
    for phrase in phrases:
        if not isinstance(phrase, dict):
            return None, version
        moras = phrase.get("moras", [])
        if not isinstance(moras, list):
            return None, version
        typed_moras = [mora for mora in moras if isinstance(mora, dict)]
        if len(typed_moras) != len(moras):
            return None, version
        if not typed_moras:
            continue
        try:
            accent = int(phrase.get("accent"))
        except (TypeError, ValueError):
            return None, version
        phrase_contour = accent_contour(len(typed_moras), accent)
        if phrase_contour is None:
            return None, version
        flattened_morae.extend(hira(str(mora.get("text", ""))) for mora in typed_moras)
        contour.extend(phrase_contour)

    def pronunciation_key(mora: str) -> str:
        normalized = hira(mora)
        return {"を": "お", "は": "わ", "へ": "え"}.get(normalized, normalized)

    def mora_vowel(mora: str) -> str | None:
        if not mora:
            return None
        last = mora[-1]
        for vowel, kana in (
            ("あ", "ぁあかがさざただなはばぱまゃやらわゎゕ"),
            ("い", "ぃいきぎしじちぢにひびぴみりゐ"),
            ("う", "ぅうくぐすずつづぬふぶぷむゅゆるゔ"),
            ("え", "ぇえけげせぜてでねへべぺめれゑゖ"),
            ("お", "ぉおこごそぞとどのほぼぽもょよろを"),
        ):
            if last in kana:
                return vowel
        return None

    def pronunciation_keys(morae: list[str]) -> list[str]:
        keys: list[str] = []
        previous: str | None = None
        for mora in morae:
            normalized = pronunciation_key(mora)
            if normalized == "ー" and previous:
                normalized = mora_vowel(previous) or normalized
            keys.append(normalized)
            if normalized != "ー":
                previous = normalized
        return keys

    normalized_actual = pronunciation_keys(flattened_morae)
    normalized_expected = pronunciation_keys(expected_morae)
    if normalized_actual == normalized_expected:
        return contour, version

    def long_extension(previous: str | None, current: str) -> str | None:
        if previous is None:
            return None
        previous_vowel = mora_vowel(previous)
        if current == "ー":
            return previous_vowel
        if current not in {"あ", "い", "う", "え", "お"}:
            return None
        current_vowel = mora_vowel(current)
        if previous_vowel is None or current_vowel is None:
            return None
        if current_vowel == previous_vowel:
            return previous_vowel
        if previous_vowel == "お" and current == "う":
            return "お"
        if previous_vowel == "え" and current == "い":
            return "え"
        return None

    # VOICEVOX sometimes realizes or absorbs a long vowel as a separate mora
    # even though the reading supplied to it is identical. Project the engine's
    # contour back onto TANREN's mora sequence instead of dropping pitch data.
    mapping: list[int] = []
    expected_index = 0
    actual_index = 0
    while expected_index < len(normalized_expected) and actual_index < len(normalized_actual):
        expected = normalized_expected[expected_index]
        actual = normalized_actual[actual_index]
        if expected == actual:
            mapping.append(actual_index)
            expected_index += 1
            actual_index += 1
            continue

        expected_extension = long_extension(
            normalized_expected[expected_index - 1] if expected_index else None,
            expected,
        )
        actual_extension = long_extension(
            normalized_actual[actual_index - 1] if actual_index else None,
            actual,
        )
        if expected_extension and expected_extension == actual_extension:
            mapping.append(actual_index)
            expected_index += 1
            actual_index += 1
            continue
        if expected_extension:
            mapping.append(max(0, actual_index - 1))
            expected_index += 1
            continue
        if actual_extension:
            actual_index += 1
            continue
        break

    while expected_index < len(normalized_expected):
        expected_extension = long_extension(
            normalized_expected[expected_index - 1] if expected_index else None,
            normalized_expected[expected_index],
        )
        if not expected_extension or not normalized_actual:
            break
        mapping.append(len(normalized_actual) - 1)
        expected_index += 1

    while actual_index < len(normalized_actual):
        actual_extension = long_extension(
            normalized_actual[actual_index - 1] if actual_index else None,
            normalized_actual[actual_index],
        )
        if not actual_extension:
            break
        actual_index += 1

    if expected_index == len(normalized_expected) and actual_index == len(normalized_actual) and len(mapping) == len(expected_morae):
        return [contour[min(index, len(contour) - 1)] for index in mapping], version

    # The query was created from this exact reading, so a remaining mismatch is
    # a frontend mora-segmentation difference rather than a different utterance.
    # Preserve the engine's pitch shape by projecting it across TANREN's mora count.
    if contour and expected_morae:
        if len(expected_morae) == 1:
            return [contour[0]], version
        last = len(contour) - 1
        projected = [contour[round(index * last / (len(expected_morae) - 1))] for index in range(len(expected_morae))]
        return projected, version
    return None, version


def warm_voicevox_profiles(base_url: str) -> int:
    profiles, _ = voicevox_metadata(base_url)

    def initialize(profile: dict[str, Any]) -> None:
        voicevox_request(
            base_url,
            "/initialize_speaker",
            {"speaker": profile["speaker_id"], "skip_reinit": "true"},
        )

    # Speaker initialization is intentionally serialized. DirectML can spike
    # memory usage when several voice models initialize at once, which can kill
    # the VOICEVOX engine before enrichment begins.
    for profile in profiles:
        initialize(profile)
    return len(profiles)


def lexical_voicevox_phrase(
    phrases: list[dict[str, Any]],
    expected_morae: list[str],
    accent_type: int,
) -> tuple[list[dict[str, Any]], int] | None:
    """Collapse VOICEVOX's lexical phrase splitting while preserving its mora data."""
    if not phrases or not expected_morae:
        return None

    actual_moras: list[dict[str, Any]] = []
    for phrase in phrases:
        if not isinstance(phrase, dict) or phrase.get("pause_mora") is not None:
            return None
        moras = phrase.get("moras", [])
        if not isinstance(moras, list) or any(not isinstance(mora, dict) for mora in moras):
            return None
        actual_moras.extend(copy.deepcopy(moras))
    if not actual_moras:
        return None

    def vowel_for(value: str) -> str | None:
        if not value:
            return None
        last = hira(value)[-1]
        for vowel, kana in (
            ("あ", "ぁあかがさざただなはばぱまゃやらわゎゕ"),
            ("い", "ぃいきぎしじちぢにひびぴみりゐ"),
            ("う", "ぅうくぐすずつづぬふぶぷむゅゆるゔ"),
            ("え", "ぇえけげせぜてでねへべぺめれゑゖ"),
            ("お", "ぉおこごそぞとどのほぼぽもょよろを"),
        ):
            if last in kana:
                return vowel
        return None

    def normalize_actual(value: str) -> str:
        result = ""
        previous = ""
        for char in hira(value):
            if char == "ー" and previous:
                result += vowel_for(previous) or char
            else:
                result += char
                previous = char
        return result

    actual_text = normalize_actual("".join(str(mora.get("text", "")) for mora in actual_moras))
    expected_variants = {""}
    previous_expected = ""
    for mora in expected_morae:
        normalized = hira(mora)
        if normalized == "ー" and previous_expected:
            vowel = vowel_for(previous_expected)
            replacements = [vowel, ""] if vowel else [normalized]
        else:
            replacements = [normalize_actual(normalized)]
            previous_expected = normalized
        expected_variants = {prefix + replacement for prefix in expected_variants for replacement in replacements}
    # The query itself was created from this exact reading. VOICEVOX can still
    # split one contracted mora into two (e.g. きゅ -> キ|ユ, じぇ -> ジ|エ),
    # so require a compatible normalized span instead of identical kana glyphs.
    if actual_text not in expected_variants and len(actual_text) not in {len(value) for value in expected_variants}:
        return None

    if accent_type <= 0:
        nucleus = len(actual_moras)
    else:
        expected_prefix = "".join(expected_morae[:accent_type])
        target_length = len(normalize_actual(expected_prefix))
        nucleus = len(actual_moras)
        consumed = 0
        for index, mora in enumerate(actual_moras, start=1):
            consumed += len(normalize_actual(str(mora.get("text", ""))))
            if consumed >= target_length:
                nucleus = index
                break

    phrase = copy.deepcopy(phrases[0])
    phrase["moras"] = actual_moras
    phrase["accent"] = max(1, min(nucleus, len(actual_moras)))
    phrase["pause_mora"] = None
    phrase["is_interrogative"] = False
    return [phrase], phrase["accent"]


def synthesize_voicevox(
    base_url: str,
    reading: str,
    expected_morae: list[str],
    accent_type: int | None,
    speaker_id: int,
    path: str,
    speed_scale: float = 1.0,
    pitch_scale: float = 0.0,
    source_query: dict[str, Any] | None = None,
) -> None:
    if valid_wav(path):
        return
    # Let the text frontend resolve Japanese long vowels and devoicing. Forcing
    # katakana can turn e.g. おはよう's final long /o/ into a separate /u/.
    reading_text = hira(reading)
    query = copy.deepcopy(source_query) if source_query is not None else voicevox_request(base_url, "/audio_query", {"text": reading_text, "speaker": speaker_id})
    if accent_type is not None:
        phrases = query["accent_phrases"]
        lexical = lexical_voicevox_phrase(phrases, expected_morae, accent_type)
        if lexical is None:
            kana_notation = voicevox_kana_notation(expected_morae, accent_type)
            try:
                phrases = voicevox_request(
                    base_url,
                    "/accent_phrases",
                    {"text": kana_notation, "speaker": speaker_id, "is_kana": "true"},
                )
            except urllib.error.HTTPError as error:
                if error.code != 400:
                    raise
                phrases = voicevox_request(
                    base_url,
                    "/accent_phrases",
                    {"text": reading_text, "speaker": speaker_id, "is_kana": "false"},
                )
            lexical = lexical_voicevox_phrase(phrases, expected_morae, accent_type)
        if lexical is None:
            raise RuntimeError(f"VOICEVOX lexical mora layout did not match reading {reading}")
        phrases, nucleus = lexical
        controlled = voicevox_request(base_url, "/mora_data", {"speaker": speaker_id}, phrases)
        contour = accent_contour(len(phrases[0]["moras"]), nucleus)
        if contour:
            controlled = enforce_pitch_contour(controlled, contour)
        # audio_query may split a dictionary entry into multiple accent phrases.
        # TANREN's lexical analysis is authoritative when UniDic supplied an accent,
        # so keep the query envelope but replace its segmentation with the explicit phrase.
        query["accent_phrases"] = controlled
    query["speedScale"] = speed_scale
    query["pitchScale"] = pitch_scale
    query["postPhonemeLength"] = max(float(query.get("postPhonemeLength", 0.0)), POST_PHONEME_LENGTH)
    wav = voicevox_request(
        base_url,
        "/synthesis",
        {"speaker": speaker_id, "enable_interrogative_upspeak": "false"},
        query,
        binary=True,
    )
    if len(wav) <= 44 or wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
        raise RuntimeError("VOICEVOX synthesis did not return a valid WAV")
    wav = soften_wav_tail(wav)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    partial = path + ".partial"
    with open(partial, "wb") as handle:
        handle.write(wav)
    os.replace(partial, path)


def generate_voicevox_assets(
    base_url: str,
    reading: str,
    expected_morae: list[str],
    accent_type: int | None,
    audio_dir: str,
    shared_cache_dir: str | None = None,
) -> list[dict[str, Any]]:
    profiles, version = voicevox_metadata(base_url)
    paths = {
        profile["voice_profile"]: os.path.join(
            audio_dir, f"{VOICE_AUDIO_REVISION}-{profile['voice_profile']}.wav"
        )
        for profile in profiles
    }
    cached_paths = {}
    if shared_cache_dir:
        os.makedirs(shared_cache_dir, exist_ok=True)
        for profile in profiles:
            identity = json.dumps([VOICE_AUDIO_REVISION, version, reading, expected_morae,
                                   accent_type, profile], ensure_ascii=False, sort_keys=True)
            digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
            cached_paths[profile["voice_profile"]] = os.path.join(shared_cache_dir, digest + ".wav")
    expected_paths = {
        os.path.normcase(os.path.abspath(path))
        for path in paths.values()
    }

    # Lexical synthesis replaces all speaker-dependent mora data below. The
    # text frontend and query envelope can therefore be shared across voices.
    # Native phrase/sentence queries retain their existing per-speaker path.
    source_query = None
    missing_profiles = [profile for profile in profiles if not valid_wav(paths[profile["voice_profile"]])]
    synthesis_profiles = [profile for profile in missing_profiles
                          if not valid_wav(cached_paths.get(profile["voice_profile"], ""))]
    if synthesis_profiles and accent_type is not None:
        try:
            source_query = voicevox_request(base_url, "/audio_query", {
                "text": hira(reading), "speaker": synthesis_profiles[0]["speaker_id"],
            })
        except Exception:
            # Preserve the scheduler's per-profile retries if preparation fails.
            source_query = None

    def synthesize_profile(profile: dict[str, Any]) -> dict[str, Any]:
        path = paths[profile["voice_profile"]]
        cached_path = cached_paths.get(profile["voice_profile"])
        if not valid_wav(path) and cached_path and valid_wav(cached_path):
            os.makedirs(audio_dir, exist_ok=True)
            # Entry files stay independent: pronunciation edits and deletion
            # cannot change another entry's cached waveform.
            shutil.copyfile(cached_path, path + ".partial")
            os.replace(path + ".partial", path)
        synthesize_voicevox(
            base_url,
            reading,
            expected_morae,
            accent_type,
            profile["speaker_id"],
            path,
            float(profile.get("speed_scale", 1.0)),
            float(profile.get("pitch_scale", 0.0)),
            source_query,
        )
        if cached_path and not valid_wav(cached_path):
            # The producer always replaces WAVs atomically; linking this first
            # immutable result avoids storing a second copy of unique audio.
            try:
                os.link(path, cached_path)
            except FileExistsError:
                if not valid_wav(cached_path):
                    shutil.copyfile(path, cached_path + ".partial")
                    os.replace(cached_path + ".partial", cached_path)
            except OSError:
                shutil.copyfile(path, cached_path + ".partial")
                os.replace(cached_path + ".partial", cached_path)
        accent_identity = str(accent_type) if accent_type is not None else "native"
        return {
            "cache_key": f"voicevox:{VOICE_AUDIO_REVISION}:{version}:{reading}:{accent_identity}:{profile['voice_profile']}:{profile['speaker_id']}",
            "path": path,
            "provider": f"voicevox-{version}",
            "voice_profile": profile["voice_profile"],
            "age_band": profile["age_band"],
            "gender_presentation": profile["gender_presentation"],
            "speaker_id": profile["speaker_id"],
            "speaker_name": profile["speaker_name"],
            "accent_type": accent_type,
            "age_basis": profile.get("age_basis", "character_or_voice_profile"),
        }

    generated = dict(zip(
        (profile["voice_profile"] for profile in missing_profiles),
        _TTS_SCHEDULER.map(missing_profiles, synthesize_profile),
    ))
    assets = [generated[profile["voice_profile"]] if profile["voice_profile"] in generated
              else synthesize_profile(profile) for profile in profiles]
    if os.path.isdir(audio_dir):
        for name in os.listdir(audio_dir):
            stale = os.path.join(audio_dir, name)
            if name.lower().endswith(".wav") and os.path.normcase(os.path.abspath(stale)) not in expected_paths:
                try:
                    os.remove(stale)
                except OSError:
                    pass
    return assets


def analyze_request(req: dict[str, Any]) -> dict[str, Any]:
    text = unicodedata.normalize("NFKC", str(req["text"]).strip())
    hint = req.get("reading_hint")
    tokens, lexical_accent, fugashi_version = token_data(text)
    reading = hira(str(hint)) if hint else None
    openjtalk_version = None
    if not reading:
        reading, openjtalk_version = reading_from_openjtalk(text)
    if not reading and all_kana(text):
        reading = hira(text.replace("・", ""))

    scope = scope_for(text, len(tokens))
    mora_list = morae(reading or "")
    token_reading = None
    token_pronunciation = None
    if len(tokens) == 1 and tokens[0].get("reading"):
        token_reading = hira(str(tokens[0]["reading"]))
    if len(tokens) == 1 and tokens[0].get("pronunciation"):
        token_pronunciation = hira(str(tokens[0]["pronunciation"]))
    reading_matches_lexicon = (
        not reading
        or not token_reading
        or reading == token_reading
        or reading == token_pronunciation
    )
    accent_types = lexical_accent if scope == "lexical" and reading_matches_lexicon else None
    patterns = accent_contours(len(mora_list), accent_types)
    audio_dir = req.get("audio_dir")
    voicevox_url = req.get("voicevox_url")
    open_pitch_source = None
    voicevox_fallback_version = None
    voicevox_pitch_source = None
    if not patterns and reading:
        accent_types, open_pitch_source = open_pitch_accent(
            text,
            reading,
            len(mora_list),
            req.get("kanjium_path"),
            req.get("wiktionary_pitch_path"),
        )
        patterns = accent_contours(len(mora_list), accent_types)
    if not patterns and voicevox_url and scope == "lexical" and reading:
        native_accent, voicevox_fallback_version = voicevox_native_accent_type(
            str(voicevox_url),
            reading,
            mora_list,
        )
        if native_accent is not None:
            accent_types = [native_accent]
            patterns = accent_contours(len(mora_list), accent_types)
            if patterns:
                voicevox_pitch_source = "VOICEVOX lexical accent phrase"
    if not patterns and voicevox_url and reading:
        native_contour, voicevox_fallback_version = voicevox_pitch_contour(
            str(voicevox_url),
            reading,
            mora_list,
        )
        if native_contour is not None:
            patterns = [native_contour]
            voicevox_pitch_source = "VOICEVOX accent phrases"
    if patterns:
        if open_pitch_source:
            provider = "open-pitch-dictionary"
            source = open_pitch_source
            confidence = "VERIFIED"
            model_version = None
        elif voicevox_pitch_source:
            provider = f"voicevox-{voicevox_fallback_version or 'unknown'}"
            source = voicevox_pitch_source
            confidence = "PREDICTED"
            model_version = voicevox_fallback_version
        else:
            provider = "unidic-fugashi"
            source = "UniDic lexical accent field"
            confidence = "CONSENSUS"
            model_version = fugashi_version
    elif reading:
        provider = "pyopenjtalk" if openjtalk_version else "builtin-kana"
        source = "OpenJTalk analysis" if openjtalk_version else "surface kana"
        confidence = "UNAVAILABLE"
        model_version = openjtalk_version
    else:
        provider = "none"
        source = "unavailable"
        confidence = "UNAVAILABLE"
        model_version = None

    audio_assets: list[dict[str, Any]] = []
    if audio_dir and voicevox_url and reading:
        audio_assets = generate_voicevox_assets(
            str(voicevox_url),
            reading,
            mora_list,
            accent_types[0] if accent_types else None,
            str(audio_dir),
            shared_cache_dir=os.path.join(os.path.dirname(os.path.abspath(str(audio_dir))), ".voicevox-cache"),
        )
    return {
        "normalized_text": text,
        "reading": reading,
        "scope": scope,
        "morae": mora_list,
        "tokens": tokens,
        "pitch_patterns": patterns,
        "accent_types": accent_types,
        "downstep_after_mora": [None if value == 0 else value for value in accent_types] if accent_types else None,
        "provider": provider,
        "source": source,
        "confidence": confidence,
        "model_version": model_version,
        "audio_written": bool(audio_assets),
        "audio_assets": audio_assets,
    }


def handle_request(req: dict[str, Any]) -> dict[str, Any]:
    if req.get("op") == "warm":
        # Pay language-runtime initialization while the app is otherwise idle,
        # not when the user is waiting for a newly added entry.
        token_data("かな")
        import_pyopenjtalk()
        voicevox_url = req.get("voicevox_url")
        warmed_profiles = warm_voicevox_profiles(str(voicevox_url)) if voicevox_url else 0
        return {"warm": True, "voicevox_profiles": warmed_profiles}
    if req.get("op") == "listening_hint":
        return {"hint": tatoeba_listening_hint(
            str(req.get("term") or ""),
            str(req.get("reading") or "") or None,
        )}
    return analyze_request(req)


def write_json_line(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> None:
    if len(sys.argv) > 1:
        req = json.loads(sys.argv[1].lstrip("\ufeff"))
        json.dump(handle_request(req), sys.stdout, ensure_ascii=False)
        return

    # Line-delimited JSON keeps this process alive across entries.  Imports,
    # UniDic/OpenJTalk modules, VOICEVOX metadata, and adaptive TTS tuning are
    # therefore reused instead of being paid for on every entry.
    for raw in sys.stdin.buffer:
        text = raw.decode("utf-8-sig").strip()
        if not text:
            continue
        try:
            req = json.loads(text.lstrip("\ufeff"))
            write_json_line(handle_request(req))
        except json.JSONDecodeError:
            # Invalid transport input is a protocol failure, not an
            # enrichment failure.  Do not emit application JSON for it.
            raise
        except Exception as error:
            # Application-level failures must not tear down the warm worker.
            # The caller receives the error for this entry and can retry/fail
            # its enrichment job while later requests keep using this process.
            write_json_line({"error": str(error)})


if __name__ == "__main__":
    main()
