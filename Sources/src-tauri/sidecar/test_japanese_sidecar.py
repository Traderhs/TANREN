import os
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

import japanese_sidecar as jp


class PitchContourFixtures(unittest.TestCase):
    def test_lexical_accent_types_convert_to_canonical_mora_contours(self):
        self.assertEqual(jp.accent_contour(4, 0), [0, 1, 1, 1])  # heiban
        self.assertEqual(jp.accent_contour(4, 1), [1, 0, 0, 0])  # atamadaka
        self.assertEqual(jp.accent_contour(4, 3), [0, 1, 1, 0])  # nakadaka
        self.assertEqual(jp.accent_contour(4, 4), [0, 1, 1, 1])  # odaka; drop is after final mora
        self.assertEqual(jp.accent_contour(1, 0), [1])
        self.assertEqual(jp.accent_contour(1, 1), [1])
        self.assertIsNone(jp.accent_contour(3, 4))

    def test_multiple_unidic_accent_values_are_preserved_in_priority_order(self):
        self.assertEqual(jp.parse_accent_types("0,3,3"), [0, 3])
        self.assertEqual(jp.accent_contours(4, [0, 3]), [[0, 1, 1, 1], [0, 1, 1, 0]])


    def test_pitch_direction_is_corrected_without_a_fixed_large_jump(self):
        fixtures = [
            ([5.683, 5.618], [0, 1]),
            ([5.5, 5.55], [1, 0]),
            ([5.5, 5.53], [0, 1]),
            ([5.6, 5.55], [1, 0]),
        ]
        for pitches, contour in fixtures:
            with self.subTest(pitches=pitches, contour=contour):
                phrases = [{"moras": [{"pitch": pitch} for pitch in pitches]}]
                corrected = jp.enforce_pitch_contour(phrases, contour)
                left, right = [mora["pitch"] for mora in corrected[0]["moras"]]
                self.assertAlmostEqual(abs(right - left), abs(pitches[1] - pitches[0]))
                self.assertAlmostEqual(left + right, sum(pitches))
                self.assertGreater((right - left) * (contour[1] - contour[0]), 0)

    def test_pitch_correction_keeps_devoicing_and_same_level_motion(self):
        phrases = [{"moras": [{"pitch": pitch} for pitch in [0.0, 5.7, 5.65, 5.8]]}]
        corrected = jp.enforce_pitch_contour(phrases, [0, 1, 1, 0])
        pitches = [mora["pitch"] for mora in corrected[0]["moras"]]
        self.assertEqual(pitches[:2], [0.0, 5.7])
        self.assertGreater(pitches[2], pitches[3])
        flat = jp.enforce_pitch_contour([{"moras": [{"pitch": 5.5}, {"pitch": 5.5}]}], [0, 1])
        self.assertGreater(flat[0]["moras"][1]["pitch"], flat[0]["moras"][0]["pitch"])


class MoraFixtures(unittest.TestCase):
    def test_requested_mora_edge_cases(self):
        fixtures = {
            "きょう": ["きょ", "う"],
            "きゃく": ["きゃ", "く"],
            "がっこう": ["が", "っ", "こ", "う"],
            "しんぶん": ["し", "ん", "ぶ", "ん"],
            "スーパー": ["ス", "ー", "パ", "ー"],
            "コーヒー": ["コ", "ー", "ヒ", "ー"],
        }
        for reading, expected in fixtures.items():
            with self.subTest(reading=reading):
                self.assertEqual(jp.morae(reading), expected)


class ScopeAndCacheFixtures(unittest.TestCase):
    def test_kana_lexeme_isu_resolves_unidic_lemma_and_confirmed_pitch(self):
        tokens, accent_types, _ = jp.token_data("いす")
        self.assertEqual(len(tokens), 1)
        self.assertEqual(tokens[0]["lemma"], "椅子")
        self.assertEqual(tokens[0]["reading"], "イス")
        self.assertEqual(accent_types, [0])

        result = jp.analyze_request({"text": "いす", "reading_hint": "いす"})
        self.assertEqual(result["provider"], "unidic-fugashi")
        self.assertEqual(result["confidence"], "CONSENSUS")
        self.assertEqual(result["accent_types"], [0])
        self.assertEqual(result["pitch_patterns"], [[0, 1]])

    def test_pronunciation_spelling_can_match_unidic_accent(self):
        result = jp.analyze_request({"text": "おはよう", "reading_hint": "おはよー"})
        self.assertEqual(result["provider"], "unidic-fugashi")
        self.assertEqual(result["confidence"], "CONSENSUS")
        self.assertEqual(result["accent_types"], [0])

    def test_voicevox_native_accent_is_used_only_when_unidic_has_no_lexical_accent(self):
        calls = []

        def fake_request(base_url, path, params=None, body=None, binary=False):
            calls.append((path, params, body))
            if path == "/audio_query":
                return {"accent_phrases": [{"moras": [{"text": "ジュ"}, {"text": "ー"}, {"text": "サ"}, {"text": "ン"}], "accent": 2}], "speedScale": 1.0, "pitchScale": 0.0, "postPhonemeLength": 0.1}
            if path == "/synthesis":
                return b"RIFF" + b"\0" * 4 + b"WAVE" + b"\0" * 40
            raise AssertionError(path)

        with tempfile.TemporaryDirectory() as directory, patch.object(jp, "voicevox_request", side_effect=fake_request):
            path = os.path.join(directory, "native.wav")
            jp.synthesize_voicevox("http://voicevox", "じゅーさん", ["じゅ", "ー", "さ", "ん"], None, 7, path)
            self.assertTrue(jp.valid_wav(path))
        self.assertEqual([call[0] for call in calls], ["/audio_query", "/synthesis"])

    def test_long_vowel_heiban_falls_back_from_voicevox_kana_parser_and_keeps_unidic_accent(self):
        calls = []

        def fake_request(base_url, path, params=None, body=None, binary=False):
            calls.append((path, params, body))
            if path == "/audio_query":
                return {"accent_phrases": [{"moras": [{"text": "オ"}, {"text": "ハ"}], "accent": 2}, {"moras": [{"text": "ヨ"}, {"text": "ー"}], "accent": 1}], "speedScale": 1.0, "pitchScale": 0.0, "postPhonemeLength": 0.1}
            if path == "/accent_phrases" and params.get("is_kana") == "true":
                raise urllib.error.HTTPError("http://voicevox", 400, "Bad Request", None, None)
            if path == "/accent_phrases":
                return [{"moras": [{"text": "オ"}, {"text": "ハ"}, {"text": "ヨ"}, {"text": "ー"}], "accent": 2}]
            if path == "/mora_data":
                return body
            if path == "/synthesis":
                return b"RIFF" + b"\0" * 4 + b"WAVE" + b"\0" * 40
            raise AssertionError(path)

        with tempfile.TemporaryDirectory() as directory, patch.object(jp, "voicevox_request", side_effect=fake_request):
            path = os.path.join(directory, "ohayo.wav")
            jp.synthesize_voicevox("http://voicevox", "おはよー", ["お", "は", "よ", "ー"], 0, 7, path)
            self.assertTrue(jp.valid_wav(path))
        fallback_call = next(call for call in calls if call[0] == "/accent_phrases" and call[1].get("is_kana") == "false")
        mora_call = next(call for call in calls if call[0] == "/mora_data")
        self.assertEqual(fallback_call[1]["text"], "おはよー")
        self.assertEqual(mora_call[2][0]["accent"], 4)

    def test_compound_inflected_phrase_and_sentence_scope(self):
        self.assertEqual(jp.scope_for("国際連合", 1), "lexical")  # dictionary compound when source has one lexical token
        self.assertEqual(jp.scope_for("こおりつけ", 1), "lexical")  # inflected lexical form with its own UniDic aType
        self.assertEqual(jp.scope_for("東京 大学", 2), "phrase")
        self.assertEqual(jp.scope_for("東京大学へ行く。", 4), "sentence")

    def test_existing_persistent_voicevox_audio_is_reused_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "cached.wav")
            with open(path, "wb") as handle:
                handle.write(b"RIFF" + b"\0" * 4 + b"WAVE" + b"\0" * 40)
            with patch.object(jp, "voicevox_request", side_effect=AssertionError("cached TTS must not use network")):
                jp.synthesize_voicevox("http://127.0.0.1:1", "みすえる", ["み", "す", "え", "る"], 3, 1, path)

    def test_voice_profiles_cover_five_age_bands_and_gender_diversity(self):
        speakers = []
        for index, profile in enumerate(jp.VOICE_PROFILES, start=1):
            speakers.append({"name": profile["speaker_name"], "styles": [{"name": "ノーマル", "id": index}]})
        resolved = jp.resolve_voice_profiles(speakers)
        self.assertEqual(len(jp.VOICE_PROFILES), 10)
        self.assertEqual(len(resolved), 10)
        self.assertEqual({item["age_band"] for item in resolved}, {"child", "adolescent", "young_adult", "middle_aged", "senior"})
        for age_band in {"child", "adolescent", "young_adult", "middle_aged", "senior"}:
            genders = {item["gender_presentation"] for item in resolved if item["age_band"] == age_band}
            self.assertEqual(genders, {"feminine", "masculine"}, age_band)
        speaker_names = {item["speaker_name"] for item in resolved}
        child_masculine = next(item for item in resolved if item["voice_profile"] == "child_masculine")
        self.assertEqual(child_masculine["speaker_name"], "ずんだもん")
        self.assertNotIn("白上虎太郎", speaker_names)
        self.assertNotIn("玄野武宏", speaker_names)
        self.assertIn("雀松朱司", speaker_names)

    def test_voicevox_metadata_is_cached_for_the_lifetime_of_the_warm_sidecar(self):
        jp._VOICEVOX_METADATA_CACHE.clear()
        calls = []

        def fake_request(base_url, path, params=None, body=None, binary=False):
            calls.append(path)
            if path == "/speakers":
                return [
                    {"name": profile["speaker_name"], "styles": [{"name": "ノーマル", "id": index}]}
                    for index, profile in enumerate(jp.VOICE_PROFILES, start=1)
                ]
            if path == "/version":
                return "test-version"
            raise AssertionError(path)

        with patch.object(jp, "voicevox_request", side_effect=fake_request):
            first = jp.voicevox_metadata("http://voicevox")
            second = jp.voicevox_metadata("http://voicevox")
        self.assertIs(first, second)
        self.assertEqual(calls, ["/speakers", "/version"])

    def test_voicevox_warmup_initializes_every_configured_profile(self):
        jp._VOICEVOX_METADATA_CACHE.clear()
        initialized = []

        def fake_request(base_url, path, params=None, body=None, binary=False):
            if path == "/speakers":
                return [
                    {"name": profile["speaker_name"], "styles": [{"name": "ノーマル", "id": index}]}
                    for index, profile in enumerate(jp.VOICE_PROFILES, start=1)
                ]
            if path == "/version":
                return "test-version"
            if path == "/initialize_speaker":
                initialized.append(int(params["speaker"]))
                return None
            raise AssertionError(path)

        with patch.object(jp, "voicevox_request", side_effect=fake_request), patch.object(jp.os, "cpu_count", return_value=8):
            self.assertEqual(jp.warm_voicevox_profiles("http://voicevox"), 10)
        self.assertEqual(sorted(initialized), list(range(1, 11)))

    def test_adaptive_tts_ceiling_scales_with_runtime_hardware(self):
        with patch.object(jp.os, "cpu_count", return_value=1):
            self.assertEqual(jp.AdaptiveTtsScheduler.ceiling(10), 1)
        with patch.object(jp.os, "cpu_count", return_value=16):
            self.assertEqual(jp.AdaptiveTtsScheduler.ceiling(10), 5)
        with patch.object(jp.os, "cpu_count", return_value=64):
            self.assertEqual(jp.AdaptiveTtsScheduler.ceiling(3), 3)

    def test_voicevox_synthesis_uses_tanren_accent_as_authority(self):
        calls = []

        def fake_request(base_url, path, params=None, body=None, binary=False):
            calls.append((path, params, body))
            if path == "/accent_phrases":
                return [{"moras": [{"text": "ミ"}, {"text": "ス"}, {"text": "エ"}, {"text": "ル"}], "accent": 1, "pause_mora": None, "is_interrogative": False}]
            if path == "/mora_data":
                return body
            if path == "/audio_query":
                return {"accent_phrases": [{"moras": [{"text": "ミ"}, {"text": "ス"}]}, {"moras": [{"text": "エ"}, {"text": "ル"}]}], "speedScale": 1.0, "pitchScale": 0.0, "intonationScale": 1.0, "volumeScale": 1.0, "prePhonemeLength": 0.1, "postPhonemeLength": 0.1, "outputSamplingRate": 24000, "outputStereo": False, "kana": ""}
            if path == "/synthesis":
                return b"RIFF" + b"\0" * 4 + b"WAVE" + b"\0" * 40
            raise AssertionError(path)

        with tempfile.TemporaryDirectory() as directory, patch.object(jp, "voicevox_request", side_effect=fake_request):
            path = os.path.join(directory, "controlled.wav")
            jp.synthesize_voicevox("http://voicevox", "みすえる", ["み", "す", "え", "る"], 3, 7, path)
            self.assertTrue(jp.valid_wav(path))
        mora_call = next(call for call in calls if call[0] == "/mora_data")
        accent_call = next(call for call in calls if call[0] == "/accent_phrases")
        query_call = next(call for call in calls if call[0] == "/audio_query")
        synthesis_call = next(call for call in calls if call[0] == "/synthesis")
        self.assertEqual(accent_call[1]["text"], "ミスエ'ル")
        self.assertEqual(accent_call[1]["is_kana"], "true")
        self.assertEqual(query_call[1]["text"], "みすえる")
        self.assertEqual(mora_call[2][0]["accent"], 3)
        self.assertEqual(len(synthesis_call[2]["accent_phrases"]), 1)
        self.assertEqual(synthesis_call[2]["accent_phrases"][0]["accent"], 3)
        self.assertGreaterEqual(synthesis_call[2]["postPhonemeLength"], jp.POST_PHONEME_LENGTH)

    def test_synthesis_preserves_phonemes_and_timing_while_correcting_accent_across_entries(self):
        import copy
        import io
        import wave

        audio = io.BytesIO()
        with wave.open(audio, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(24000)
            writer.writeframes(b"\0" * 480)

        fixtures = [
            ("いす", 0, ["i", "u"], [5.683, 5.618]),
            ("すき", 2, ["U", "i"], [0.0, 5.871]),
            ("あした", 3, ["a", "I", "a"], [5.813, 0.0, 5.721]),
            ("がっこう", 0, ["a", "cl", "o", "o"], [5.594, 0.0, 5.931, 6.030]),
            ("しんぶん", 0, ["i", "N", "u", "N"], [6.023, 6.057, 5.939, 5.870]),
            ("おはよう", 0, ["o", "a", "o", "o"], [5.599, 5.812, 5.925, 5.946]),
            ("みすえる", 3, ["i", "u", "e", "u"], [5.5, 5.6, 5.7, 5.65]),
        ]
        for reading, accent, vowels, pitches in fixtures:
            with self.subTest(reading=reading):
                expected_morae = jp.morae(reading)
                model_moras = [
                    {"text": jp.kata(text), "vowel": vowel, "pitch": pitch,
                     "vowel_length": 0.1 + index * 0.01,
                     "consonant": None, "consonant_length": None}
                    for index, (text, vowel, pitch) in enumerate(zip(expected_morae, vowels, pitches))
                ]
                captured = {}

                def fake_request(base_url, path, params=None, body=None, binary=False):
                    if path == "/audio_query":
                        self.assertEqual(params["text"], reading)
                        return {"accent_phrases": [{"moras": copy.deepcopy(model_moras), "accent": 1}]}
                    if path == "/mora_data":
                        captured["accent"] = body[0]["accent"]
                        self.assertEqual(body[0]["moras"], model_moras)
                        return copy.deepcopy(body)
                    if path == "/synthesis":
                        captured["query"] = copy.deepcopy(body)
                        return audio.getvalue()
                    raise AssertionError(f"Matched text phonemes must not be replaced: {path}")

                with tempfile.TemporaryDirectory() as directory, patch.object(jp, "voicevox_request", side_effect=fake_request):
                    jp.synthesize_voicevox("http://voicevox", reading, expected_morae, accent, 8, os.path.join(directory, "speech.wav"))
                self.assertEqual(captured["accent"], accent or len(expected_morae))
                actual_moras = captured["query"]["accent_phrases"][0]["moras"]
                for before, after in zip(model_moras, actual_moras):
                    self.assertEqual({key: value for key, value in before.items() if key != "pitch"},
                                     {key: value for key, value in after.items() if key != "pitch"})
                    if before["pitch"] == 0:
                        self.assertEqual(after["pitch"], 0)
                contour = jp.accent_contour(len(expected_morae), accent)
                for index in range(len(contour) - 1):
                    left, right = actual_moras[index]["pitch"], actual_moras[index + 1]["pitch"]
                    if left > 0 and right > 0 and contour[index] != contour[index + 1]:
                        self.assertGreater((right - left) * (contour[index + 1] - contour[index]), 0)

    def test_audio_revision_matches_rust_and_invalidates_previous_cache_names(self):
        from pathlib import Path
        rust_source = (Path(__file__).parent.parent / "src" / "japanese.rs").read_text(encoding="utf-8")
        self.assertIn(f'VOICE_AUDIO_REVISION: &str = "{jp.VOICE_AUDIO_REVISION}"', rust_source)
        self.assertNotIn(jp.VOICE_AUDIO_REVISION, {"v6", "v7"})

    def test_soften_wav_tail_preserves_voiced_samples_and_appends_silence(self):
        import io
        import struct
        import wave

        source = io.BytesIO()
        with wave.open(source, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(24000)
            writer.writeframes(struct.pack("<" + "h" * 240, *([12000] * 240)))
        softened = jp.soften_wav_tail(source.getvalue())
        with wave.open(io.BytesIO(softened), "rb") as reader:
            frame_count = reader.getnframes()
            frames = reader.readframes(frame_count)
        self.assertGreater(frame_count, 240)
        samples = struct.unpack("<" + "h" * (len(frames) // 2), frames)
        self.assertEqual(samples[:240], (12000,) * 240)
        self.assertEqual(samples[-1], 0)

    def test_heiban_uses_final_voicevox_nucleus_for_same_isolated_entry_contour(self):
        captured = {}

        def fake_request(base_url, path, params=None, body=None, binary=False):
            if path == "/accent_phrases":
                return [{"moras": [{"text": "ガ"}, {"text": "ッ"}, {"text": "コ"}, {"text": "ウ"}], "accent": 1}]
            if path == "/mora_data":
                captured["accent"] = body[0]["accent"]
                return body
            if path == "/audio_query":
                return {"accent_phrases": [{"moras": [{"text": "ガ"}, {"text": "ッ"}, {"text": "コ"}, {"text": "ウ"}], "accent": 1}]}
            if path == "/synthesis":
                return b"RIFF" + b"\0" * 4 + b"WAVE" + b"\0" * 40
            raise AssertionError(path)

        with tempfile.TemporaryDirectory() as directory, patch.object(jp, "voicevox_request", side_effect=fake_request):
            jp.synthesize_voicevox("http://voicevox", "がっこう", ["が", "っ", "こ", "う"], 0, 7, os.path.join(directory, "heiban.wav"))
        self.assertEqual(captured["accent"], 4)


if __name__ == "__main__":
    unittest.main()
