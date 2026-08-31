from __future__ import annotations

import json
import io
import os
import re
import sys
import unicodedata
import contextlib
import urllib.parse
import urllib.request
import wave
from array import array
from typing import Any


SMALL = set("ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ")
VOICE_AUDIO_REVISION = "v5"
POST_PHONEME_LENGTH = 0.42
TAIL_SILENCE_SECONDS = 0.22
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
        if ch.isspace():
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
    heiban. Odaka therefore has the same within-word levels as heiban and is
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


def scope_for(text: str, token_count: int) -> str:
    if re.search(r"[。！？!?]", text):
        return "sentence"
    if token_count > 1 or re.search(r"\s", text):
        return "phrase"
    return "lexical"


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
        accent = parse_accent_types(tokens[0].get("accent_type"))
    return tokens, accent, version


def reading_from_openjtalk(text: str) -> tuple[str | None, str | None]:
    try:
        pyopenjtalk = import_pyopenjtalk()
        return hira(pyopenjtalk.g2p(text, kana=True)), getattr(pyopenjtalk, "__version__", None)
    except Exception:
        return None, None


def voicevox_request(base_url: str, path: str, params: dict[str, Any] | None = None, body: Any = None, binary: bool = False):
    query = urllib.parse.urlencode(params or {})
    url = base_url.rstrip("/") + path + ("?" + query if query else "")
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data if data is not None else (b"" if path.startswith("/accent_") or path.startswith("/audio_") or path.startswith("/mora_") or path.startswith("/synthesis") else None), method="POST" if path in {"/accent_phrases", "/audio_query", "/mora_data", "/synthesis"} else "GET")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = response.read()
    if binary:
        return payload
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


def synthesize_voicevox(
    base_url: str,
    reading: str,
    expected_morae: list[str],
    accent_type: int,
    speaker_id: int,
    path: str,
    speed_scale: float = 1.0,
    pitch_scale: float = 0.0,
) -> None:
    if valid_wav(path):
        return
    reading_kata = kata(reading)
    nucleus = accent_type if accent_type > 0 else len(expected_morae)
    kana_notation = voicevox_kana_notation(expected_morae, accent_type)
    phrases = voicevox_request(
        base_url,
        "/accent_phrases",
        {"text": kana_notation, "speaker": speaker_id, "is_kana": "true"},
    )
    if len(phrases) != 1:
        raise RuntimeError(f"VOICEVOX returned {len(phrases)} accent phrases for lexical reading {reading}")
    phrase = phrases[0]
    moras = phrase.get("moras", [])
    if len(moras) != len(expected_morae):
        raise RuntimeError(f"VOICEVOX mora mismatch for {reading}: expected={len(expected_morae)} actual={len(moras)}")
    if int(phrase.get("accent", -1)) != nucleus:
        raise RuntimeError(f"VOICEVOX kana accent mismatch for {reading}: expected={nucleus} actual={phrase.get('accent')}")
    controlled = voicevox_request(base_url, "/mora_data", {"speaker": speaker_id}, phrases)
    query = voicevox_request(base_url, "/audio_query", {"text": reading_kata, "speaker": speaker_id})
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
    accent_type: int,
    audio_dir: str,
) -> list[dict[str, Any]]:
    speakers = voicevox_request(base_url, "/speakers")
    profiles = resolve_voice_profiles(speakers)
    if not profiles:
        raise RuntimeError("VOICEVOX has none of TANREN's configured voice profiles")
    version = str(voicevox_request(base_url, "/version"))
    assets: list[dict[str, Any]] = []
    expected_paths: set[str] = set()
    for profile in profiles:
        path = os.path.join(audio_dir, f"{VOICE_AUDIO_REVISION}-{profile['voice_profile']}.wav")
        expected_paths.add(os.path.normcase(os.path.abspath(path)))
        synthesize_voicevox(
            base_url,
            reading,
            expected_morae,
            accent_type,
            profile["speaker_id"],
            path,
            float(profile.get("speed_scale", 1.0)),
            float(profile.get("pitch_scale", 0.0)),
        )
        assets.append({
            "cache_key": f"voicevox:{VOICE_AUDIO_REVISION}:{version}:{reading}:{accent_type}:{profile['voice_profile']}:{profile['speaker_id']}",
            "path": path,
            "provider": f"voicevox-{version}",
            "voice_profile": profile["voice_profile"],
            "age_band": profile["age_band"],
            "gender_presentation": profile["gender_presentation"],
            "speaker_id": profile["speaker_id"],
            "speaker_name": profile["speaker_name"],
            "accent_type": accent_type,
            "age_basis": profile.get("age_basis", "character_or_voice_profile"),
        })
    if os.path.isdir(audio_dir):
        for name in os.listdir(audio_dir):
            stale = os.path.join(audio_dir, name)
            if name.lower().endswith(".wav") and os.path.normcase(os.path.abspath(stale)) not in expected_paths:
                try:
                    os.remove(stale)
                except OSError:
                    pass
    return assets


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

    scope = scope_for(text, len(tokens))
    mora_list = morae(reading or "")
    token_reading = None
    if len(tokens) == 1 and tokens[0].get("reading"):
        token_reading = hira(str(tokens[0]["reading"]))
    reading_matches_lexicon = not reading or not token_reading or reading == token_reading
    accent_types = lexical_accent if scope == "lexical" and reading_matches_lexicon else None
    patterns = accent_contours(len(mora_list), accent_types)
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

    audio_assets: list[dict[str, Any]] = []
    audio_dir = req.get("audio_dir")
    voicevox_url = req.get("voicevox_url")
    if audio_dir and voicevox_url and scope == "lexical" and reading and accent_types:
        audio_assets = generate_voicevox_assets(
            str(voicevox_url),
            reading,
            mora_list,
            accent_types[0],
            str(audio_dir),
        )
    result = {
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
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
