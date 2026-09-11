use super::*;
use grading::{grade_form_with_reading, grade_reading_deterministic};
use model::AudioAssetDraft;

fn seed_analysis(db: &Database, entry: &EntryRecord) {
    let reading = entry.reading.as_deref().unwrap();
    let morae: Vec<String> = reading.chars().map(|c| c.to_string()).collect();
    let analysis = serde_json::json!({"scope":"lexical", "morae":morae, "tokens":[{"surface":entry.term,"reading":reading}]});
    db.set_entry_analysis(&entry.id, Some(reading), &analysis, "fixture", "fixture", "VERIFIED", None,
        Some(&[vec![1, 0]]), "lexical", &[AudioAssetDraft {
            cache_key: format!("{}-{reading}", entry.term), path: format!("{reading}.wav"), provider: "fixture".into(),
            voice_profile: "fixture".into(), age_band: "young_adult".into(), gender_presentation: "feminine".into(),
            speaker_id: None, speaker_name: None, accent_type: Some(1),
        }]).unwrap();
}

#[test]
fn edited_meanings_must_not_reuse_previous_manual_decisions() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path().join("aliases.db")).unwrap();
    let deck = db.create_deck("edit aliases", "ko-KR", "ja-JP").unwrap();
    db.import_entries(&deck.id, "ja-JP", &[EntryDraft { term:"猫".into(), meanings:vec!["고양이".into()], reading:Some("ねこ".into()) }]).unwrap();
    let entry = db.entries(&deck.id).unwrap().remove(0);
    db.set_alias(&entry.id, "옛 정답", true).unwrap();
    db.set_alias(&entry.id, "새 정답", false).unwrap();
    db.update_entry(&deck.id, &entry.id, &EntryDraft {term:entry.term, meanings:vec!["새 정답".into()], reading:entry.reading}).unwrap();
    let updated = db.entries(&deck.id).unwrap().remove(0);
    let (accepted, rejected) = db.aliases(&entry.id).unwrap();
    assert!(accepted.is_empty() && rejected.is_empty());
    assert_eq!(grade_reading_deterministic(&updated, "새 정답", &accepted, &rejected).unwrap().decision, GradeDecision::Pass);
    assert!(grade_reading_deterministic(&updated, "옛 정답", &accepted, &rejected).is_none());
}

#[test]
fn changed_pronunciation_must_not_accept_stale_analysis_while_enrichment_is_pending() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path().join("pronunciation.db")).unwrap();
    let deck = db.create_deck("edit pronunciation", "ko-KR", "ja-JP").unwrap();
    db.import_entries(&deck.id, "ja-JP", &[EntryDraft {term:"猫".into(), meanings:vec!["고양이".into()], reading:Some("ねこ".into())}]).unwrap();
    let old = db.entries(&deck.id).unwrap().remove(0);
    seed_analysis(&db, &old);
    db.update_entry(&deck.id, &old.id, &EntryDraft {term:"犬".into(), meanings:vec!["개".into()], reading:Some("いぬ".into())}).unwrap();
    let updated = db.entries(&deck.id).unwrap().remove(0);
    let orthographic = db.japanese_orthographic_reading(&old.id).unwrap();
    assert_eq!(grade_form_with_reading(&updated, "ねこ", false, orthographic.as_deref()).decision, GradeDecision::Fail);
    assert!(orthographic.is_none());
    seed_analysis(&db, &updated);
    assert_eq!(db.japanese_orthographic_reading(&old.id).unwrap().as_deref(), Some("いぬ"));
}

#[test]
fn edit_sequence_matrix_432_cases() {
    let mut cases = 0;
    for mode in [StudyMode::Reading, StudyMode::Listening, StudyMode::Writing] {
        for stage in [1, 2, 10] {
            for edit in 0..8 {
                for aliases in [false, true] {
                    let directory = tempfile::tempdir().unwrap();
                    let db = Database::open(directory.path().join("matrix.db")).unwrap();
                    let deck = db.create_deck("edit matrix", "ko-KR", "ja-JP").unwrap();
                    let original = EntryDraft {term:"猫".into(), meanings:vec!["고양이".into(), "동물".into()], reading:Some("ねこ".into())};
                    let mut drafts = vec![original.clone(); 451];
                    for (index, draft) in drafts.iter_mut().enumerate().skip(1) { draft.term = format!("表現{index}"); }
                    db.import_entries(&deck.id, "ja-JP", &drafts).unwrap();
                    let entries = db.entries(&deck.id).unwrap();
                    let target = &entries[0];
                    seed_analysis(&db, target);
                    if aliases { db.set_alias(&target.id, "예전 / 수동판정", true).unwrap(); }
                    let mut session = StudySession::new_for_stage(deck.id.clone(), stage, &entries, &[mode], 50, 500, 1).unwrap();
                    let variant = VariantKey {entry_id:target.id.clone(), mode};
                    session.current = Some(variant.clone());
                    session.resolve_current(&variant, false).unwrap();
                    session.pending = Some(PendingState::Review {variant:variant.clone(), result:review_result(target, Some("MANUAL_UNKNOWN"), "review")});
                    db.save_session(&session).unwrap();
                    let before = serde_json::to_value(&session).unwrap();
                    let mut draft = original.clone();
                    match edit {
                        0 | 1 => {}, // open/cancel and unchanged save
                        2 => draft.meanings.push("애완동물".into()),
                        3 => { draft.meanings.pop(); },
                        4 => draft.meanings = vec!["새 뜻".into(), "다른 뜻".into()],
                        5 => draft.meanings.reverse(),
                        6 => { draft.term = "犬".into(); draft.reading = Some("いぬ".into()); },
                        7 => draft.reading = Some("ネコ".into()),
                        _ => unreachable!(),
                    }
                    if edit > 0 {
                        let pronunciation_changed = db.update_entry(&deck.id, &target.id, &draft).unwrap();
                        assert_eq!(pronunciation_changed, edit >= 6);
                    }
                    let updated = find_entry(&db, &deck.id, &target.id).unwrap();
                    assert_eq!(updated.term, draft.term);
                    assert_eq!(updated.meanings, draft.meanings);
                    assert_eq!(serde_json::to_value(db.load_session(&deck.id, stage).unwrap().unwrap()).unwrap(), before);
                    assert_eq!(db.first_audio_path(&target.id).unwrap().is_none(), edit >= 6);
                    assert_eq!(db.pitch_question(&target.id, true).unwrap().is_none(), edit >= 6);
                    let (accepted, rejected) = db.aliases(&target.id).unwrap();
                    for answer in [original.meanings.join(" / "), draft.meanings.join(" / "), String::new()] {
                        cases += 1;
                        let outcome = grade_reading_deterministic(&updated, &answer, &accepted, &rejected);
                        let mut actual: Vec<_> = answer.split(" / ").map(String::from).collect(); actual.sort();
                        let mut expected = draft.meanings.clone(); expected.sort();
                        if actual == expected { assert_eq!(outcome.unwrap().decision, GradeDecision::Pass, "edit={edit} stage={stage}"); }
                        else { assert!(!outcome.is_some_and(|outcome| outcome.decision == GradeDecision::Pass)); }
                        let form = grade_form_with_reading(&updated, &original.term, true, None);
                        assert_eq!(form.decision == GradeDecision::Pass, edit != 6);
                    }
                    // Repeated edit back to the original must restore the answer without changing progress.
                    db.update_entry(&deck.id, &target.id, &original).unwrap();
                    let restored = find_entry(&db, &deck.id, &target.id).unwrap();
                    assert_eq!(restored.meanings, original.meanings);
                    assert_eq!(serde_json::to_value(db.load_session(&deck.id, stage).unwrap().unwrap()).unwrap(), before);
                }
            }
        }
    }
    assert_eq!(cases, 432);
    println!("EDIT_MATRIX: {cases} scenarios passed");
}
