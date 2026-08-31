import os
import tempfile
import unittest
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

    def test_voicevox_synthesis_uses_tanren_accent_as_authority(self):
        calls = []

        def fake_request(base_url, path, params=None, body=None, binary=False):
            calls.append((path, params, body))
            if path == "/accent_phrases":
                return [{"moras": [{"text": "ミ"}, {"text": "ス"}, {"text": "エ"}, {"text": "ル"}], "accent": 3, "pause_mora": None, "is_interrogative": False}]
            if path == "/mora_data":
                return body
            if path == "/audio_query":
                return {"accent_phrases": [], "speedScale": 1.0, "pitchScale": 0.0, "intonationScale": 1.0, "volumeScale": 1.0, "prePhonemeLength": 0.1, "postPhonemeLength": 0.1, "outputSamplingRate": 24000, "outputStereo": False, "kana": ""}
            if path == "/synthesis":
                return b"RIFF" + b"\0" * 4 + b"WAVE" + b"\0" * 40
            raise AssertionError(path)

        with tempfile.TemporaryDirectory() as directory, patch.object(jp, "voicevox_request", side_effect=fake_request):
            path = os.path.join(directory, "controlled.wav")
            jp.synthesize_voicevox("http://voicevox", "みすえる", ["み", "す", "え", "る"], 3, 7, path)
            self.assertTrue(jp.valid_wav(path))
        mora_call = next(call for call in calls if call[0] == "/mora_data")
        accent_call = next(call for call in calls if call[0] == "/accent_phrases")
        synthesis_call = next(call for call in calls if call[0] == "/synthesis")
        self.assertEqual(accent_call[1]["text"], "ミスエ'ル")
        self.assertEqual(accent_call[1]["is_kana"], "true")
        self.assertEqual(mora_call[2][0]["accent"], 3)
        self.assertEqual(synthesis_call[2]["accent_phrases"][0]["accent"], 3)
        self.assertGreaterEqual(synthesis_call[2]["postPhonemeLength"], jp.POST_PHONEME_LENGTH)

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

    def test_heiban_uses_final_voicevox_nucleus_for_same_isolated_word_contour(self):
        captured = {}

        def fake_request(base_url, path, params=None, body=None, binary=False):
            if path == "/accent_phrases":
                return [{"moras": [{"text": "ガ"}, {"text": "ッ"}, {"text": "コ"}, {"text": "ウ"}], "accent": 4}]
            if path == "/mora_data":
                captured["accent"] = body[0]["accent"]
                return body
            if path == "/audio_query":
                return {"accent_phrases": []}
            if path == "/synthesis":
                return b"RIFF" + b"\0" * 4 + b"WAVE" + b"\0" * 40
            raise AssertionError(path)

        with tempfile.TemporaryDirectory() as directory, patch.object(jp, "voicevox_request", side_effect=fake_request):
            jp.synthesize_voicevox("http://voicevox", "がっこう", ["が", "っ", "こ", "う"], 0, 7, os.path.join(directory, "heiban.wav"))
        self.assertEqual(captured["accent"], 4)


if __name__ == "__main__":
    unittest.main()
