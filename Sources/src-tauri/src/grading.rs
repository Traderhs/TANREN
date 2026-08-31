use std::collections::HashSet;

use unicode_normalization::UnicodeNormalization;

use crate::model::{EntryRecord, GradeDecision, GradeOutcome, StudyMode};

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

pub fn grade_form(entry: &EntryRecord, answer: &str, strict_orthography: bool) -> GradeOutcome {
    let answer = normalize_japanese(answer);
    if answer == normalize_japanese(&entry.term) {
        return GradeOutcome { decision: GradeDecision::Pass, method: "exact_form", score: None };
    }
    if !strict_orthography {
        if let Some(reading) = &entry.reading {
            if answer == normalize_japanese(reading) {
                return GradeOutcome { decision: GradeDecision::Pass, method: "accepted_reading", score: None };
            }
        }
    }
    GradeOutcome { decision: GradeDecision::Fail, method: "form_mismatch", score: None }
}

pub fn grade_recognition(
    entry: &EntryRecord,
    answer: &str,
    accepted: &[String],
    rejected: &[String],
) -> GradeOutcome {
    grade_recognition_deterministic(entry, answer, accepted, rejected).unwrap_or(GradeOutcome {
        decision: GradeDecision::Ambiguous,
        method: "semantic_unavailable",
        score: None,
    })
}

pub fn grade_recognition_deterministic(
    entry: &EntryRecord,
    answer: &str,
    accepted: &[String],
    rejected: &[String],
) -> Option<GradeOutcome> {
    let norm = normalize_generic(answer);
    let canonical: HashSet<_> = entry.meanings.iter().map(|v| normalize_generic(v)).collect();
    if canonical.contains(&norm) {
        return Some(GradeOutcome { decision: GradeDecision::Pass, method: "exact_meaning", score: Some(1.0) });
    }
    if accepted.iter().any(|v| normalize_generic(v) == norm) {
        return Some(GradeOutcome { decision: GradeDecision::Pass, method: "accepted_alias", score: Some(1.0) });
    }
    if rejected.iter().any(|v| normalize_generic(v) == norm) {
        return Some(GradeOutcome { decision: GradeDecision::Fail, method: "rejected_alias", score: Some(0.0) });
    }
    None
}

pub fn grade(mode: StudyMode, entry: &EntryRecord, answer: &str, accepted: &[String], rejected: &[String], strict_orthography: bool) -> GradeOutcome {
    match mode {
        StudyMode::Recognition => grade_recognition(entry, answer, accepted, rejected),
        StudyMode::Listening | StudyMode::Production => grade_form(entry, answer, strict_orthography),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> EntryRecord {
        EntryRecord {
            id: "e".into(),
            term: "見据える".into(),
            meanings: vec!["내다보다".into(), "전망하다".into()],
            reading: Some("みすえる".into()),
        }
    }

    #[test]
    fn exact_and_alias_grading() {
        assert_eq!(grade_recognition(&entry(), "내다보다", &[], &[]).decision, GradeDecision::Pass);
        assert_eq!(grade_recognition(&entry(), "앞날을 내다보다", &["앞날을 내다보다".into()], &[]).decision, GradeDecision::Pass);
        assert_eq!(grade_recognition(&entry(), "예상하다", &[], &["예상하다".into()]).decision, GradeDecision::Fail);
    }

    #[test]
    fn production_is_target_form_not_semantic_equivalent() {
        assert_eq!(grade_form(&entry(), "予想する", false).decision, GradeDecision::Fail);
        assert_eq!(grade_form(&entry(), "みすえる", false).decision, GradeDecision::Pass);
        assert_eq!(grade_form(&entry(), "ミスエル", false).decision, GradeDecision::Pass);
        assert_eq!(grade_form(&entry(), "みすえる", true).decision, GradeDecision::Fail);
    }
}
