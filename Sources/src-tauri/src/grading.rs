use unicode_normalization::UnicodeNormalization;

use crate::model::{EntryRecord, GradeDecision, GradeOutcome};

pub fn normalize_generic(input: &str) -> String {
    input
        .nfkc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c: char| c.is_ascii_punctuation() || "。、！？・「」『』（）".contains(c))
        .to_lowercase()
}

pub fn normalize_japanese(input: &str) -> String {
    normalize_generic(input)
        .chars()
        .map(|c| {
            if ('ァ'..='ヶ').contains(&c) {
                char::from_u32(c as u32 - 0x60).unwrap_or(c)
            } else {
                c
            }
        })
        .filter(|c| !c.is_whitespace())
        .collect()
}

fn kana_vowel(character: char) -> Option<char> {
    match character {
        'ぁ' | 'あ' | 'か' | 'が' | 'さ' | 'ざ' | 'た' | 'だ' | 'な' | 'は' | 'ば' | 'ぱ' | 'ま' | 'ゃ' | 'や' | 'ら' | 'ゎ' | 'わ' => Some('あ'),
        'ぃ' | 'い' | 'き' | 'ぎ' | 'し' | 'じ' | 'ち' | 'ぢ' | 'に' | 'ひ' | 'び' | 'ぴ' | 'み' | 'り' | 'ゐ' => Some('い'),
        'ぅ' | 'う' | 'く' | 'ぐ' | 'す' | 'ず' | 'つ' | 'づ' | 'ぬ' | 'ふ' | 'ぶ' | 'ぷ' | 'む' | 'ゅ' | 'ゆ' | 'る' | 'ゔ' => Some('う'),
        'ぇ' | 'え' | 'け' | 'げ' | 'せ' | 'ぜ' | 'て' | 'で' | 'ね' | 'へ' | 'べ' | 'ぺ' | 'め' | 'れ' | 'ゑ' => Some('え'),
        'ぉ' | 'お' | 'こ' | 'ご' | 'そ' | 'ぞ' | 'と' | 'ど' | 'の' | 'ほ' | 'ぼ' | 'ぽ' | 'も' | 'ょ' | 'よ' | 'ろ' | 'を' => Some('お'),
        _ => None,
    }
}

fn expand_prolonged_sound_marks(input: &str) -> Vec<String> {
    let mut variants = vec![String::new()];
    let mut last_vowel = None;

    for character in input.chars() {
        if character != 'ー' {
            if let Some(vowel) = kana_vowel(character) {
                last_vowel = Some(vowel);
            }
            for variant in &mut variants {
                variant.push(character);
            }
            continue;
        }

        let replacements: &[char] = match last_vowel {
            Some('あ') => &['あ'],
            Some('い') => &['い'],
            Some('う') => &['う'],
            Some('え') => &['え', 'い'],
            Some('お') => &['お', 'う'],
            _ => &['ー'],
        };

        let mut expanded = Vec::with_capacity(variants.len() * replacements.len());
        for variant in &variants {
            for replacement in replacements {
                let mut value = variant.clone();
                value.push(*replacement);
                expanded.push(value);
            }
        }
        variants = expanded;
    }

    variants
}

fn reading_matches(expected: &str, answer: &str) -> bool {
    let expected = normalize_japanese(expected);
    let answer = normalize_japanese(answer);
    if expected == answer {
        return true;
    }

    // Accept canonical long-vowel spelling for stored readings that use `ー`
    // (e.g. じゅーいち -> じゅういち), but do not expand a user's `ー`
    // backwards into an arbitrary kana sequence. Otherwise distinct words such
    // as シール normalize into the reading しいる and are falsely accepted.
    expand_prolonged_sound_marks(&expected).iter().any(|variant| variant == &answer)
}

fn unvoiced_kana(character: char) -> char {
    match character {
        'が' => 'か', 'ぎ' => 'き', 'ぐ' => 'く', 'げ' => 'け', 'ご' => 'こ',
        'ざ' => 'さ', 'じ' => 'し', 'ず' => 'す', 'ぜ' => 'せ', 'ぞ' => 'そ',
        'だ' => 'た', 'ぢ' => 'ち', 'づ' => 'つ', 'で' => 'て', 'ど' => 'と',
        'ば' | 'ぱ' => 'は', 'び' | 'ぴ' => 'ひ', 'ぶ' | 'ぷ' => 'ふ', 'べ' | 'ぺ' => 'へ', 'ぼ' | 'ぽ' => 'ほ',
        'ゔ' => 'う',
        _ => character,
    }
}

fn has_kana_voicing_conflict(canonical: &str, alternative: &str) -> bool {
    let canonical = normalize_japanese(canonical);
    let alternative = normalize_japanese(alternative);
    canonical.chars().count() == alternative.chars().count()
        && canonical.chars().zip(alternative.chars()).any(|(left, right)| {
            left != right && unvoiced_kana(left) == unvoiced_kana(right)
        })
}

#[cfg(test)]
pub fn grade_form(entry: &EntryRecord, answer: &str, strict_orthography: bool) -> GradeOutcome {
    grade_form_with_reading(entry, answer, strict_orthography, None)
}

pub fn grade_form_with_reading(
    entry: &EntryRecord,
    answer: &str,
    strict_orthography: bool,
    orthographic_reading: Option<&str>,
) -> GradeOutcome {
    let answer = normalize_japanese(answer);
    if answer == normalize_japanese(&entry.term) {
        return GradeOutcome { decision: GradeDecision::Pass, method: "exact_form", score: None };
    }
    if !strict_orthography {
        if let Some(reading) = &entry.reading {
            if reading_matches(reading, &answer) {
                return GradeOutcome { decision: GradeDecision::Pass, method: "accepted_reading", score: None };
            }
        }
        if let Some(orthographic_reading) = orthographic_reading {
            let conflicts_with_canonical = entry.reading.as_deref().is_some_and(|canonical| {
                has_kana_voicing_conflict(canonical, orthographic_reading)
            });
            if !conflicts_with_canonical && reading_matches(orthographic_reading, &answer) {
                return GradeOutcome { decision: GradeDecision::Pass, method: "accepted_orthographic_reading", score: None };
            }
        }
    }
    GradeOutcome { decision: GradeDecision::Fail, method: "form_mismatch", score: None }
}

pub fn grade_reading_deterministic(
    entry: &EntryRecord,
    answer: &str,
    accepted: &[String],
    rejected: &[String],
) -> Option<GradeOutcome> {
    let norm = normalize_generic(answer);
    let parts = split_reading_answer(answer, entry.meanings.len());
    if parts.len() != entry.meanings.len() {
        return Some(GradeOutcome { decision: GradeDecision::Fail, method: "meaning_count_mismatch", score: Some(0.0) });
    }
    if accepted.iter().any(|v| normalize_generic(v) == norm) {
        return Some(GradeOutcome { decision: GradeDecision::Pass, method: "accepted_alias", score: Some(1.0) });
    }
    if rejected.iter().any(|v| normalize_generic(v) == norm) {
        return Some(GradeOutcome { decision: GradeDecision::Fail, method: "rejected_alias", score: Some(0.0) });
    }
    let mut expected: Vec<_> = entry.meanings.iter().map(|v| normalize_generic(v)).collect();
    let mut actual: Vec<_> = parts.iter().map(|v| normalize_generic(v)).collect();
    expected.sort_unstable();
    actual.sort_unstable();
    if expected == actual {
        return Some(GradeOutcome { decision: GradeDecision::Pass, method: "exact_meanings", score: Some(1.0) });
    }
    None
}

pub fn split_reading_answer(answer: &str, expected_count: usize) -> Vec<String> {
    let trimmed = answer.trim_matches(|c: char| c.is_whitespace() || c == '\u{3000}');
    if trimmed.is_empty() {
        return Vec::new();
    }

    let has_explicit_separator = trimmed.chars().any(|c| matches!(c, ',' | '，' | '/' | '／' | ';' | '；' | '\n' | '\r' | '\t' | '\u{3000}'));
    if has_explicit_separator {
        return trimmed
            .split(|c| matches!(c, ',' | '，' | '/' | '／' | ';' | '；' | '\n' | '\r' | '\t' | '\u{3000}'))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect();
    }

    if expected_count > 1 {
        let whitespace_parts: Vec<_> = trimmed.split_whitespace().collect();
        if whitespace_parts.len() == expected_count {
            return whitespace_parts.into_iter().map(ToOwned::to_owned).collect();
        }
    }

    vec![trimmed.to_owned()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> EntryRecord {
        EntryRecord {
            id: "e".into(),
            term: "見据える".into(),
            meanings: vec!["내다보다".into()],
            reading: Some("みすえる".into()),
        }
    }

    #[test]
    fn exact_and_alias_grading() {
        assert_eq!(grade_reading_deterministic(&entry(), "내다보다", &[], &[]).unwrap().decision, GradeDecision::Pass);
        assert_eq!(grade_reading_deterministic(&entry(), "앞날을 내다보다", &["앞날을 내다보다".into()], &[]).unwrap().decision, GradeDecision::Pass);
        assert_eq!(grade_reading_deterministic(&entry(), "예상하다", &[], &["예상하다".into()]).unwrap().decision, GradeDecision::Fail);
    }

    #[test]
    fn multiple_meanings_require_all_answers_but_ignore_order() {
        let mut value = entry();
        value.meanings = vec!["걸다".into(), "전화하다".into(), "시간을 들이다".into()];
        assert_eq!(grade_reading_deterministic(&value, "시간을 들이다 / 걸다 / 전화하다", &[], &[]).unwrap().decision, GradeDecision::Pass);
        assert_eq!(grade_reading_deterministic(&value, "걸다 / 전화하다", &[], &[]).unwrap().decision, GradeDecision::Fail);
    }

    #[test]
    fn reading_answer_separator_supports_safe_space_fallback() {
        assert_eq!(split_reading_answer("걸다, 전화하다", 2), vec!["걸다", "전화하다"]);
        assert_eq!(split_reading_answer("걸다　전화하다", 2), vec!["걸다", "전화하다"]);
        assert_eq!(split_reading_answer("걸다 전화하다", 2), vec!["걸다", "전화하다"]);
        assert_eq!(split_reading_answer("전화를 걸다 시간을 들이다", 2), vec!["전화를 걸다 시간을 들이다"]);
    }

    #[test]
    fn writing_is_target_form_not_semantic_equivalent() {
        assert_eq!(grade_form(&entry(), "予想する", false).decision, GradeDecision::Fail);
        assert_eq!(grade_form(&entry(), "みすえる", false).decision, GradeDecision::Pass);
        assert_eq!(grade_form(&entry(), "ミスエル", false).decision, GradeDecision::Pass);
        assert_eq!(grade_form(&entry(), "みすえる", true).decision, GradeDecision::Fail);
    }

    #[test]
    fn reading_accepts_equivalent_long_vowel_spelling() {
        let mut value = entry();
        value.term = "11".into();
        value.reading = Some("じゅーいち".into());
        assert_eq!(grade_form(&value, "じゅういち", false).decision, GradeDecision::Pass);
        assert_eq!(grade_form(&value, "ジュウイチ", false).decision, GradeDecision::Pass);
        assert_eq!(grade_form(&value, "じゅういち", true).decision, GradeDecision::Fail);
    }

    #[test]
    fn answer_long_mark_does_not_collapse_distinct_reading() {
        let mut value = entry();
        value.term = "強いる".into();
        value.reading = Some("しいる".into());
        assert_eq!(grade_form(&value, "シール", false).decision, GradeDecision::Fail);
        assert_eq!(grade_form(&value, "しいる", false).decision, GradeDecision::Pass);
        assert_eq!(grade_form(&value, "シイル", false).decision, GradeDecision::Pass);
    }

    #[test]
    fn orthographic_reading_accepts_written_particle_spelling() {
        let mut value = entry();
        value.term = "今日はいい天気ですね".into();
        value.reading = Some("きょーわいいてんきですね".into());
        assert_eq!(
            grade_form_with_reading(&value, "きょうはいいてんきですね", false, Some("キョウハイイテンキデスネ")).decision,
            GradeDecision::Pass,
        );
        assert_eq!(grade_form(&value, "きょうはいいてんきですね", false).decision, GradeDecision::Fail);
    }

    #[test]
    fn orthographic_reading_does_not_override_canonical_voicing() {
        let mut value = entry();
        value.term = "精算所".into();
        value.reading = Some("せいさんじょ".into());
        assert_eq!(
            grade_form_with_reading(&value, "せいさんしょ", false, Some("セイサンショ")).decision,
            GradeDecision::Fail,
        );
        assert_eq!(
            grade_form_with_reading(&value, "せいさんじょ", false, Some("セイサンショ")).decision,
            GradeDecision::Pass,
        );
    }

    #[test]
    fn orthographic_reading_still_allows_non_voicing_fallback() {
        let mut value = entry();
        value.term = "月".into();
        value.reading = Some("つきみ".into());
        assert_eq!(
            grade_form_with_reading(&value, "つき", false, Some("ツキ")).decision,
            GradeDecision::Pass,
        );
    }
}
