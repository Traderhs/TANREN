use std::collections::{HashMap, VecDeque};

use rand::{RngCore, SeedableRng, seq::SliceRandom};
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};

use crate::model::{EntryRecord, PitchQuestion, StageKind, StudyMode, StudyRange, SubmitResult, VariantKey};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PendingState {
    Review { variant: VariantKey, result: SubmitResult },
    StageTransition,
    Ambiguous {
        variant: VariantKey,
        answer: String,
        recall_latency_ms: u64,
        typing_duration_ms: u64,
        interkey_gaps_ms: Vec<u64>,
        ime_composition_ms: u64,
        method: String,
        score: Option<f64>,
    },
    Pitch { variant: VariantKey, question: PitchQuestion },
}

pub fn generate_stage_sequence(deck_size: usize, increment: usize, checkpoint: usize) -> Vec<StageKind> {
    if deck_size == 0 || increment == 0 || checkpoint == 0 { return Vec::new(); }
    let mut stages = Vec::new();
    let mut block_start = 0;
    while block_start < deck_size {
        let block_end = (block_start + checkpoint).min(deck_size);
        let mut end = (block_start + increment).min(block_end);
        loop {
            stages.push(StageKind::Expanding { start: block_start, end });
            if end == block_end { break; }
            end = (end + increment).min(block_end);
        }
        if block_start > 0 {
            stages.push(StageKind::Cumulative { end: block_end });
        }
        block_start = block_end;
    }
    stages
}

pub fn variants_for_stage(entries: &[EntryRecord], modes: &[StudyMode], stage: &StageKind) -> Vec<VariantKey> {
    let (start, end) = stage.range();
    entries[start.min(entries.len())..end.min(entries.len())]
        .iter()
        .flat_map(|entry| modes.iter().map(move |mode| VariantKey { entry_id: entry.id.clone(), mode: *mode }))
        .collect()
}

pub fn study_ranges(deck_size: usize, increment: usize, checkpoint: usize) -> Vec<StudyRange> {
    generate_stage_sequence(deck_size, increment, checkpoint).into_iter().enumerate().map(|(stage_index, stage)| {
        let (start, end) = stage.range();
        StudyRange {
            stage_index,
            label: stage.label(),
            start,
            end,
            cumulative: matches!(stage, StageKind::Cumulative { .. }),
        }
    }).collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueState {
    pub seed: u64,
    pub remaining: Vec<VariantKey>,
    pub queue: VecDeque<VariantKey>,
    pub recent_entries: VecDeque<String>,
}

impl QueueState {
    pub fn new(mut variants: Vec<VariantKey>, seed: u64) -> Self {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        variants.shuffle(&mut rng);
        let queue = variants.iter().cloned().collect();
        Self { seed, remaining: variants, queue, recent_entries: VecDeque::new() }
    }

    pub fn remaining_count(&self) -> usize { self.remaining.len() }

    pub fn pop_next(&mut self, minimum_same_entry_gap: usize) -> Option<VariantKey> {
        if self.queue.is_empty() && !self.remaining.is_empty() {
            self.rebuild_queue();
        }
        if self.queue.is_empty() { return None; }

        let blocked: std::collections::HashSet<_> = self.recent_entries.iter().cloned().collect();
        let len = self.queue.len();
        let mut chosen = None;
        for _ in 0..len {
            let candidate = self.queue.pop_front().unwrap();
            if chosen.is_none() && (!blocked.contains(&candidate.entry_id) || len <= 2) {
                chosen = Some(candidate);
                break;
            }
            self.queue.push_back(candidate);
        }
        let chosen = chosen.or_else(|| self.queue.pop_front())?;
        self.recent_entries.push_back(chosen.entry_id.clone());
        while self.recent_entries.len() > minimum_same_entry_gap {
            self.recent_entries.pop_front();
        }
        Some(chosen)
    }

    pub fn mark_pass(&mut self, variant: &VariantKey) {
        self.remaining.retain(|v| v != variant);
        self.queue.retain(|v| v != variant);
    }

    pub fn mark_fail(&mut self, variant: &VariantKey) {
        if !self.remaining.contains(variant) {
            self.remaining.push(variant.clone());
        }
        self.queue.retain(|v| v != variant);
        self.queue.push_back(variant.clone());
    }

    fn rebuild_queue(&mut self) {
        let mut rng = ChaCha8Rng::seed_from_u64(self.seed ^ (self.remaining.len() as u64).wrapping_mul(0x9E3779B97F4A7C15));
        let mut values = self.remaining.clone();
        values.shuffle(&mut rng);
        self.queue = values.into();
        self.seed = rng.next_u64();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudySession {
    pub deck_id: String,
    pub round: u32,
    pub stage_index: usize,
    pub stage_sequence: Vec<StageKind>,
    pub queue: QueueState,
    pub current: Option<VariantKey>,
    pub stage_total: usize,
    #[serde(default)]
    pub pending: Option<PendingState>,
}

impl StudySession {
    pub fn new(deck_id: String, round: u32, entries: &[EntryRecord], modes: &[StudyMode], increment: usize, checkpoint: usize, seed: u64) -> Option<Self> {
        Self::new_at_stage(deck_id, round, entries, modes, increment, checkpoint, 0, seed)
    }

    pub fn new_at_stage(deck_id: String, round: u32, entries: &[EntryRecord], modes: &[StudyMode], increment: usize, checkpoint: usize, stage_index: usize, seed: u64) -> Option<Self> {
        let stage_sequence = generate_stage_sequence(entries.len(), increment, checkpoint);
        let stage = stage_sequence.get(stage_index)?.clone();
        let variants = variants_for_stage(entries, modes, &stage);
        let total = variants.len();
        Some(Self {
            deck_id,
            round,
            stage_index,
            stage_sequence,
            queue: QueueState::new(variants, seed),
            current: None,
            stage_total: total,
            pending: None,
        })
    }

    pub fn stage(&self) -> &StageKind { &self.stage_sequence[self.stage_index] }

    pub fn next_variant(&mut self, gap: usize) -> Option<VariantKey> {
        if self.current.is_some() { return None; }
        let next = self.queue.pop_next(gap)?;
        self.current = Some(next.clone());
        Some(next)
    }

    pub fn resolve_current(&mut self, variant: &VariantKey, passed: bool) -> Result<(), String> {
        if self.current.as_ref() != Some(variant) { return Err("variant is not the active card".into()); }
        if passed { self.queue.mark_pass(variant); } else { self.queue.mark_fail(variant); }
        self.current = None;
        Ok(())
    }

    pub fn recover_interrupted_card(&mut self) {
        if let Some(current) = self.current.take() { self.queue.mark_fail(&current); }
        self.pending = None;
    }

    pub fn advance_stage(&mut self, entries: &[EntryRecord], modes: &[StudyMode], seed: u64) -> bool {
        if self.stage_index + 1 >= self.stage_sequence.len() { return false; }
        self.stage_index += 1;
        let variants = variants_for_stage(entries, modes, self.stage());
        self.stage_total = variants.len();
        self.queue = QueueState::new(variants, seed ^ self.stage_index as u64);
        self.current = None;
        true
    }
}

pub fn entry_map(entries: &[EntryRecord]) -> HashMap<String, EntryRecord> {
    entries.iter().map(|e| (e.id.clone(), e.clone())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{PitchConfidence, SubmitStatus};

    fn labels(size: usize) -> Vec<String> {
        generate_stage_sequence(size, 50, 300).into_iter().map(|s| s.label()).collect()
    }

    #[test]
    fn exact_stage_sequences_cover_required_odd_sizes() {
        let cases = [49, 50, 51, 299, 300, 301, 599, 600, 601, 3042];
        for size in cases {
            let stages = generate_stage_sequence(size, 50, 300);
            assert!(!stages.is_empty(), "{size}");
            let last = stages.last().unwrap();
            assert_eq!(last.range().1, size, "{size}: {}", last.label());
        }
        assert_eq!(labels(49), vec!["0~49"]);
        assert_eq!(labels(50), vec!["0~50"]);
        assert_eq!(labels(51), vec!["0~50", "0~51"]);
        assert_eq!(labels(300), vec!["0~50", "0~100", "0~150", "0~200", "0~250", "0~300"]);
        assert_eq!(labels(301).last().unwrap(), "0~301 · cumulative");
        assert_eq!(labels(601).last().unwrap(), "0~601 · cumulative");
        assert_eq!(labels(3042).last().unwrap(), "0~3042 · cumulative");
    }

    #[test]
    fn selectable_ranges_match_cardbook_progression() {
        let labels: Vec<_> = study_ranges(600, 50, 300).into_iter().map(|range| range.label).collect();
        assert_eq!(labels, vec![
            "0~50", "0~100", "0~150", "0~200", "0~250", "0~300",
            "300~350", "300~400", "300~450", "300~500", "300~550", "300~600",
            "0~600 · cumulative",
        ]);
    }

    #[test]
    fn session_can_start_from_an_explicit_range() {
        let values = entries(600);
        let session = StudySession::new_at_stage("deck".into(), 1, &values, &[StudyMode::Reading], 50, 300, 7, 1).unwrap();
        assert_eq!(session.stage().label(), "300~400");
        assert_eq!(session.stage_total, 100);
    }

    #[test]
    fn failed_variant_stays_and_pass_removes_only_current_stage() {
        let v = VariantKey { entry_id: "a".into(), mode: StudyMode::Reading };
        let mut q = QueueState::new(vec![v.clone()], 1);
        let pulled = q.pop_next(10).unwrap();
        q.mark_fail(&pulled);
        assert_eq!(q.remaining_count(), 1);
        q.mark_pass(&pulled);
        assert_eq!(q.remaining_count(), 0);
    }

    #[test]
    fn same_entry_modes_do_not_have_to_clump() {
        let mut variants = Vec::new();
        for i in 0..20 {
            for mode in [StudyMode::Reading, StudyMode::Listening, StudyMode::Writing] {
                variants.push(VariantKey { entry_id: format!("e{i}"), mode });
            }
        }
        let mut q = QueueState::new(variants, 42);
        let mut prev = None;
        for _ in 0..40 {
            let v = q.pop_next(10).unwrap();
            if let Some(p) = &prev { assert_ne!(p, &v.entry_id); }
            prev = Some(v.entry_id);
        }
    }

    fn entries(count: usize) -> Vec<EntryRecord> {
        (0..count).map(|i| EntryRecord {
            id: format!("e{i}"), term: format!("term{i}"), meanings: vec![format!("meaning{i}")], reading: None,
        }).collect()
    }

    #[test]
    fn pass_review_then_exit_does_not_restore_variant() {
        let mut session = StudySession::new("deck".into(), 1, &entries(1), &[StudyMode::Reading], 50, 300, 1).unwrap();
        let variant = session.next_variant(10).unwrap();
        session.resolve_current(&variant, true).unwrap();
        session.recover_interrupted_card();
        assert!(session.current.is_none());
        assert_eq!(session.queue.remaining_count(), 0);
    }

    #[test]
    fn fail_review_then_exit_keeps_variant_required() {
        let mut session = StudySession::new("deck".into(), 1, &entries(1), &[StudyMode::Reading], 50, 300, 1).unwrap();
        let variant = session.next_variant(10).unwrap();
        session.resolve_current(&variant, false).unwrap();
        session.recover_interrupted_card();
        assert!(session.current.is_none());
        assert_eq!(session.queue.remaining_count(), 1);
        assert!(session.queue.queue.contains(&variant));
    }

    #[test]
    fn unresolved_exit_and_restart_do_not_lose_variant() {
        let mut session = StudySession::new("deck".into(), 1, &entries(1), &[StudyMode::Reading], 50, 300, 1).unwrap();
        let variant = session.next_variant(10).unwrap();
        let persisted = serde_json::to_string(&session).unwrap();
        let mut restarted: StudySession = serde_json::from_str(&persisted).unwrap();
        restarted.recover_interrupted_card();
        assert!(restarted.current.is_none());
        assert_eq!(restarted.next_variant(10), Some(variant));
    }

    #[test]
    fn stage_advance_does_not_consume_next_stage_card() {
        let values = entries(51);
        let mut session = StudySession::new("deck".into(), 1, &values, &[StudyMode::Reading], 50, 300, 1).unwrap();
        while let Some(variant) = session.next_variant(10) {
            session.resolve_current(&variant, true).unwrap();
        }
        assert!(session.advance_stage(&values, &[StudyMode::Reading], 2));
        assert!(session.current.is_none());
        assert_eq!(session.queue.queue.len(), session.stage_total);
        assert_eq!(session.queue.remaining_count(), session.stage_total);
    }

    #[test]
    fn completed_round_has_no_active_card() {
        let mut session = StudySession::new("deck".into(), 1, &entries(1), &[StudyMode::Reading], 50, 300, 1).unwrap();
        let variant = session.next_variant(10).unwrap();
        session.resolve_current(&variant, true).unwrap();
        assert!(session.current.is_none());
        assert_eq!(session.queue.remaining_count(), 0);
    }

    #[test]
    fn pitch_review_then_exit_preserves_the_pitch_outcome() {
        for passed in [true, false] {
            let mut session = StudySession::new("deck".into(), 1, &entries(1), &[StudyMode::Reading], 50, 300, 1).unwrap();
            let variant = session.next_variant(10).unwrap();
            session.resolve_current(&variant, passed).unwrap();
            session.recover_interrupted_card();
            assert!(session.current.is_none());
            assert_eq!(session.queue.remaining_count(), usize::from(!passed), "passed={passed}");
        }
    }

    #[test]
    fn pitch_failure_reappears_from_the_base_question_not_pitch_pending_state() {
        let mut session = StudySession::new("deck".into(), 1, &entries(1), &[StudyMode::Reading], 50, 300, 1).unwrap();
        let variant = session.next_variant(10).unwrap();
        session.resolve_current(&variant, false).unwrap();
        session.pending = Some(PendingState::Review {
            variant: variant.clone(),
            result: SubmitResult::simple(SubmitStatus::Review),
        });

        session.pending = None;
        let repeated = session.next_variant(10).unwrap();
        assert_eq!(repeated, variant);
        assert!(session.pending.is_none());
        assert_eq!(session.current, Some(variant));
    }

    #[test]
    fn restart_roundtrips_each_non_terminal_pending_state() {
        let mut active = StudySession::new("deck".into(), 1, &entries(1), &[StudyMode::Reading], 50, 300, 1).unwrap();
        let variant = active.next_variant(10).unwrap();

        active.pending = Some(PendingState::Ambiguous {
            variant: variant.clone(), answer: "pending".into(), recall_latency_ms: 10,
            typing_duration_ms: 20, interkey_gaps_ms: vec![5], ime_composition_ms: 0,
            method: "semantic".into(), score: Some(0.5),
        });
        let resumed: StudySession = serde_json::from_str(&serde_json::to_string(&active).unwrap()).unwrap();
        assert!(matches!(resumed.pending, Some(PendingState::Ambiguous { ref answer, .. }) if answer == "pending"));
        assert_eq!(resumed.current, Some(variant.clone()));

        active.pending = Some(PendingState::Pitch {
            variant: variant.clone(),
            question: PitchQuestion {
                kind: "lexical".into(), reading: "よみ".into(), morae: vec!["よ".into(), "み".into()],
                phrase_count: 1, allowed_patterns: vec![vec![1]], confidence: PitchConfidence::Verified,
                gate_enabled: true,
            },
        });
        let resumed: StudySession = serde_json::from_str(&serde_json::to_string(&active).unwrap()).unwrap();
        assert!(matches!(resumed.pending, Some(PendingState::Pitch { .. })));
        assert_eq!(resumed.current, Some(variant.clone()));

        active.resolve_current(&variant, true).unwrap();
        active.pending = Some(PendingState::Review { variant: variant.clone(), result: SubmitResult::simple(SubmitStatus::Review) });
        let resumed: StudySession = serde_json::from_str(&serde_json::to_string(&active).unwrap()).unwrap();
        assert!(matches!(resumed.pending, Some(PendingState::Review { .. })));
        assert!(resumed.current.is_none());

        active.pending = Some(PendingState::StageTransition);
        let resumed: StudySession = serde_json::from_str(&serde_json::to_string(&active).unwrap()).unwrap();
        assert!(matches!(resumed.pending, Some(PendingState::StageTransition)));
        assert!(resumed.current.is_none());
    }
}
