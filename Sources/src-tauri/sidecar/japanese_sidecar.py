from __future__ import annotations

import json
import os
import re
import sys
import unicodedata
import wave
import contextlib
from typing import Any


SMALL = set("ゃゅょぁぃぅぇぉャュョァィゥェォ")


def import_pyopenjtalk():
    # pyopenjtalk-plus may print optional-backend notices while importing.
    # Keep stdout reserved for the JSON RPC response.
    with contextlib.redirect_stdout(sys.stderr):
        import pyopenjtalk  # type: ignore
    return pyopenjtalk


def hira(text: str) -> str:
    out = []
    for ch in text:
        code = ord(ch)
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def morae(reading: str) -> list[str]:
    result: list[str] = []
    for ch in reading:
        if ch.isspace():
            continue
        if ch in SMALL and result:
            result[-1] += ch
        else:
            result.append(ch)
    return result


def all_kana(text: str) -> bool:
    return all(ch.isspace() or "ぁ" <= ch <= "ゖ" or "ァ" <= ch <= "ヺ" or ch in "ー・" for ch in text)


def token_data(text: str) -> tuple[list[dict[str, Any]], list[int] | None, str | None]:
    try:
        import fugashi  # type: ignore
        tagger = fugashi.Tagger()
    except Exception:
        return [], None, None

    tokens: list[dict[str, Any]] = []
    accent: list[int] | None = None
    version = getattr(fugashi, "__version__", None)
    words = list(tagger(text))
    for word in words:
        feat = word.feature
        def f(name: str, default=None):
            return getattr(feat, name, default)
        atype = f("aType")
        if atype is None:
            atype = f("accentType")
        token = {
            "surface": word.surface,
            "lemma": f("lemma"),
            "reading": f("kana") or f("pron"),
            "pronunciation": f("pron"),
            "pos": f("pos1"),
            "conjugation": f("cForm"),
            "accent_type": atype,
        }
        tokens.append(token)
    if len(words) == 1:
        raw = tokens[0].get("accent_type")
        if raw not in (None, "", "*"):
            m = re.match(r"\d+", str(raw))
            if m:
                accent = [int(m.group(0))]
    return tokens, accent, version


def reading_from_openjtalk(text: str) -> tuple[str | None, str | None]:
    try:
        pyopenjtalk = import_pyopenjtalk()
        return hira(pyopenjtalk.g2p(text, kana=True)), getattr(pyopenjtalk, "__version__", None)
    except Exception:
        return None, None


def write_audio(text: str, path: str) -> bool:
    try:
        import numpy as np  # type: ignore
        pyopenjtalk = import_pyopenjtalk()
        audio, sample_rate = pyopenjtalk.tts(text)
        pcm = np.clip(audio, -1.0, 1.0)
        if pcm.dtype.kind == "f":
            pcm = (pcm * 32767.0).astype(np.int16)
        else:
            pcm = pcm.astype(np.int16)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with wave.open(path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(int(sample_rate))
            wf.writeframes(pcm.tobytes())
        return True
    except Exception:
        return False


def main() -> None:
    if len(sys.argv) > 1:
        raw = sys.argv[1]
    else:
        raw = sys.stdin.buffer.read().decode("utf-8-sig")
    req = json.loads(raw.lstrip("\ufeff"))
    text = unicodedata.normalize("NFKC", str(req["text"]).strip())
    hint = req.get("reading_hint")
    tokens, lexical_accent, fugashi_version = token_data(text)
    reading = hira(str(hint)) if hint else None
    openjtalk_version = None
    if not reading:
        reading, openjtalk_version = reading_from_openjtalk(text)
    if not reading and all_kana(text):
        reading = hira(text.replace("・", ""))

    scope = "lexical" if len(tokens) <= 1 and not re.search(r"[。！？!?\s]", text) else "phrase"
    patterns = [lexical_accent] if lexical_accent is not None and scope == "lexical" else None
    if patterns:
        provider = "unidic-fugashi"
        source = "UniDic lexical accent field"
        confidence = "CONSENSUS"
        model_version = fugashi_version
    elif reading:
        provider = "pyopenjtalk" if openjtalk_version else "builtin-kana"
        source = "OpenJTalk analysis" if openjtalk_version else "surface kana"
        confidence = "PREDICTED"
        model_version = openjtalk_version
    else:
        provider = "none"
        source = "unavailable"
        confidence = "PREDICTED"
        model_version = None

    audio_path = req.get("audio_path")
    audio_written = bool(audio_path and write_audio(text, str(audio_path)))
    result = {
        "normalized_text": text,
        "reading": reading,
        "scope": scope,
        "morae": morae(reading or ""),
        "tokens": tokens,
        "pitch_patterns": patterns,
        "provider": provider,
        "source": source,
        "confidence": confidence,
        "model_version": model_version,
        "audio_written": audio_written,
    }
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
