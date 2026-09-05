use std::collections::{HashSet, VecDeque};

use rand::{RngCore, SeedableRng, seq::SliceRandom};
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};

use crate::model::{EntryRecord, PitchQuestion, StudyMode, StudyRange, SubmitResult, VariantKey};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PendingState {
    Review { variant: VariantKey, result: SubmitResult },
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

pub fn study_ranges(deck_size: usize, increment: usize, checkpoint: usize) -> Vec<StudyRange> {
    if deck_size == 0 || increment == 0 || checkpoint == 0 { return Vec::new(); }
    let mut ranges = Vec::new();
    let mut block_start = 0;
    while block_start < deck_size {
        let block_end = (block_start + checkpoint).min(deck_size);
        let mut end = (block_start + increment).min(block_end);
        loop {
            ranges.push(StudyRange {
                label: format!("{}~{}", block_start, end - 1),
                start: block_start,
                end,
                cumulative: false,
            });
            if end == block_end { break; }
            end = (end + increment).min(block_end);
        }
        if block_start > 0 {
            ranges.push(StudyRange {
                label: format!("0~{} · cumulative", block_end - 1),
                start: 0,
                end: block_end,
                cumulative: true,
            });
        }
        block_start = block_end;
    }
    ranges
}

#[cfg(test)]
fn entry_slots(entries: &[EntryRecord]) -> Vec<Option<String>> {
    entries.iter().map(|entry| Some(entry.id.clone())).collect()
}

fn variants_for_slots(entry_slots: &[Option<String>], entries: &[EntryRecord], modes: &[StudyMode], range: &StudyRange) -> Vec<VariantKey> {
    let active_ids: HashSet<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
    entry_slots[range.start.min(entry_slots.len())..range.end.min(entry_slots.len())]
        .iter()
        .filter_map(|entry_id| entry_id.as_deref())
        .filter(|entry_id| active_ids.contains(*entry_id))
        .flat_map(|entry_id| modes.iter().map(move |mode| VariantKey { entry_id: entry_id.to_string(), mode: *mode }))
        .collect()
}

pub fn stage_study_range(deck_size: usize, increment: usize, checkpoint: usize, stage: u32) -> Option<StudyRange> {
    if stage == 0 { return None; }
    study_ranges(deck_size, increment, checkpoint).into_iter().nth(stage as usize - 1)
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
    }

    pub fn retain_entries(&mut self, active_ids: &HashSet<&str>) {
        self.remaining.retain(|variant| active_ids.contains(variant.entry_id.as_str()));
        self.queue.retain(|variant| active_ids.contains(variant.entry_id.as_str()));
        self.recent_entries.retain(|entry_id| active_ids.contains(entry_id.as_str()));
    }

    fn add_variants(&mut self, variants: impl IntoIterator<Item = VariantKey>) {
        let mut changed = false;
        for variant in variants {
            if self.remaining.contains(&variant) {
                continue;
            }
            self.remaining.push(variant);
            changed = true;
        }
        if changed {
            self.rebuild_queue();
        }
    }

    #[cfg(test)]
    pub fn remove_entry(&mut self, entry_id: &str) {
        self.remaining.retain(|variant| variant.entry_id != entry_id);
        self.queue.retain(|variant| variant.entry_id != entry_id);
        self.recent_entries.retain(|recent| recent != entry_id);
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
    pub stage: u32,
    pub study_range: StudyRange,
    pub entry_slots: Vec<Option<String>>,
    pub active_duration_ms: u64,
    pub queue: QueueState,
    pub current: Option<VariantKey>,
    pub range_total: usize,
    pub pending: Option<PendingState>,
}

impl StudySession {
    #[cfg(test)]
    pub fn new(deck_id: String, stage: u32, entries: &[EntryRecord], modes: &[StudyMode], increment: usize, checkpoint: usize, seed: u64) -> Option<Self> {
        Self::new_for_stage_with_slots(deck_id, stage, entry_slots(entries), entries, modes, increment, checkpoint, seed)
    }

    #[cfg(test)]
    pub fn new_for_stage(deck_id: String, stage: u32, entries: &[EntryRecord], modes: &[StudyMode], increment: usize, checkpoint: usize, seed: u64) -> Option<Self> {
        Self::new_for_stage_with_slots(deck_id, stage, entry_slots(entries), entries, modes, increment, checkpoint, seed)
    }

    pub fn new_for_stage_with_slots(
        deck_id: String,
        stage: u32,
        entry_slots: Vec<Option<String>>,
        entries: &[EntryRecord],
        modes: &[StudyMode],
        increment: usize,
        checkpoint: usize,
        seed: u64,
    ) -> Option<Self> {
        let study_range = stage_study_range(entry_slots.len(), increment, checkpoint, stage)?;
        let variants = variants_for_slots(&entry_slots, entries, modes, &study_range);
        let total = variants.len();
        Some(Self {
            deck_id,
            stage,
            study_range,
            entry_slots,
            active_duration_ms: 0,
            queue: QueueState::new(variants, seed),
            current: None,
            range_total: total,
            pending: None,
        })
    }

    #[cfg(test)]
    pub fn scheduled_entry_count(&self) -> usize {
        self.entry_slots.len()
    }

    pub fn sync_entries(&mut self, entries: &[EntryRecord], modes: &[StudyMode]) {
        let active_ids: HashSet<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        for slot in &mut self.entry_slots {
            if slot.as_deref().is_some_and(|entry_id| !active_ids.contains(entry_id)) {
                *slot = None;
            }
        }
        self.queue.retain_entries(&active_ids);
        if self.current.as_ref().is_some_and(|variant| !active_ids.contains(variant.entry_id.as_str())) {
            self.current = None;
        }
        let pending_entry_id = match self.pending.as_ref() {
            Some(PendingState::Review { variant, .. })
            | Some(PendingState::Ambiguous { variant, .. })
            | Some(PendingState::Pitch { variant, .. }) => Some(variant.entry_id.as_str()),
            None => None,
        };
        if pending_entry_id.is_some_and(|entry_id| !active_ids.contains(entry_id)) {
            self.pending = None;
        }
        self.range_total = variants_for_slots(&self.entry_slots, entries, modes, &self.study_range).len();
    }

    pub fn expand_schedule(
        &mut self,
        entry_slots: Vec<Option<String>>,
        study_range: StudyRange,
        entries: &[EntryRecord],
        modes: &[StudyMode],
    ) {
        let old_ids: HashSet<String> = self.entry_slots
            [self.study_range.start.min(self.entry_slots.len())..self.study_range.end.min(self.entry_slots.len())]
            .iter()
            .filter_map(|entry_id| entry_id.clone())
            .collect();
        let new_ids = entry_slots
            [study_range.start.min(entry_slots.len())..study_range.end.min(entry_slots.len())]
            .iter()
            .filter_map(|entry_id| entry_id.clone())
            .filter(|entry_id| !old_ids.contains(entry_id))
            .collect::<HashSet<_>>();

        self.entry_slots = entry_slots;
        self.study_range = study_range;
        let active_ids: HashSet<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        self.queue.add_variants(
            new_ids
                .iter()
                .filter(|entry_id| active_ids.contains(entry_id.as_str()))
                .flat_map(|entry_id| modes.iter().map(move |mode| VariantKey {
                    entry_id: entry_id.clone(),
                    mode: *mode,
                })),
        );
        self.sync_entries(entries, modes);
    }

    #[cfg(test)]
    pub fn remove_entry(&mut self, entry_id: &str) {
        for slot in &mut self.entry_slots {
            if slot.as_deref() == Some(entry_id) {
                *slot = None;
            }
        }
        self.queue.remove_entry(entry_id);
        if self.current.as_ref().is_some_and(|variant| variant.entry_id == entry_id) {
            self.current = None;
        }
        let pending_matches = match self.pending.as_ref() {
            Some(PendingState::Review { variant, .. })
            | Some(PendingState::Ambiguous { variant, .. })
            | Some(PendingState::Pitch { variant, .. }) => variant.entry_id == entry_id,
            None => false,
        };
        if pending_matches {
            self.pending = None;
        }
    }

    pub fn range(&self) -> &StudyRange { &self.study_range }

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

}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{PitchConfidence, SubmitStatus};

    const INCREMENT: usize = 50;
    const CHECKPOINT: usize = 500;

    fn labels(size: usize) -> Vec<String> {
        study_ranges(size, INCREMENT, CHECKPOINT).into_iter().map(|range| range.label).collect()
    }

    #[test]
    fn exact_progression_ranges_cover_required_odd_sizes() {
        let cases = [49, 50, 51, 499, 500, 501, 999, 1000, 1001, 3042];
        for size in cases {
            let ranges = study_ranges(size, INCREMENT, CHECKPOINT);
            assert!(!ranges.is_empty(), "{size}");
            let last = ranges.last().unwrap();
            assert_eq!(last.end, size, "{size}: {}", last.label);
        }
        assert_eq!(labels(49), vec!["0~48"]);
        assert_eq!(labels(50), vec!["0~49"]);
        assert_eq!(labels(51), vec!["0~49", "0~50"]);
        assert_eq!(labels(500), vec!["0~49", "0~99", "0~149", "0~199", "0~249", "0~299", "0~349", "0~399", "0~449", "0~499"]);
        assert_eq!(labels(501).last().unwrap(), "0~500 · cumulative");
        assert_eq!(labels(999).last().unwrap(), "0~998 · cumulative");
        assert_eq!(labels(1000).last().unwrap(), "0~999 · cumulative");
        assert_eq!(labels(1001).last().unwrap(), "0~1000 · cumulative");
        assert_eq!(labels(3000).last().unwrap(), "0~2999 · cumulative");
        assert_eq!(labels(3042).last().unwrap(), "0~3041 · cumulative");
        assert_eq!(labels(5999).last().unwrap(), "0~5998 · cumulative");
    }

    #[test]
    fn selectable_ranges_match_cardbook_progression() {
        let labels: Vec<_> = study_ranges(1000, INCREMENT, CHECKPOINT).into_iter().map(|range| range.label).collect();
        assert_eq!(labels, vec![
            "0~49", "0~99", "0~149", "0~199", "0~249", "0~299", "0~349", "0~399", "0~449", "0~499",
            "500~549", "500~599", "500~649", "500~699", "500~749", "500~799", "500~849", "500~899", "500~949", "500~999",
            "0~999 · cumulative",
        ]);
    }

    #[test]
    fn each_stage_maps_to_exactly_one_progression_range() {
        let expected = [
            "0~49", "0~99", "0~149", "0~199", "0~249",
            "0~299", "0~349", "0~399", "0~449", "0~499",
        ];
        for (index, label) in expected.into_iter().enumerate() {
            assert_eq!(stage_study_range(500, INCREMENT, CHECKPOINT, index as u32 + 1).unwrap().label, label);
        }
        assert!(stage_study_range(500, INCREMENT, CHECKPOINT, 11).is_none());
    }

    #[test]
    fn session_uses_exactly_the_range_owned_by_its_stage() {
        let values = entries(600);
        let session = StudySession::new_for_stage("deck".into(), 12, &values, &[StudyMode::Reading], INCREMENT, CHECKPOINT, 1).unwrap();
        assert_eq!(session.range().label, "500~599");
        assert_eq!(session.range_total, 100);
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
    fn retries_start_only_after_every_item_in_the_current_pass_was_seen() {
        let variants = (0..6).map(|i| VariantKey { entry_id: format!("e{i}"), mode: StudyMode::Reading }).collect::<Vec<_>>();
        let mut queue = QueueState::new(variants, 7);
        let mut first_pass = Vec::new();
        let mut failed = Vec::new();
        for index in 0..6 {
            let variant = queue.pop_next(0).unwrap();
            assert!(!first_pass.contains(&variant));
            first_pass.push(variant.clone());
            if index == 1 || index == 4 {
                failed.push(variant.clone());
                queue.mark_fail(&variant);
            } else {
                queue.mark_pass(&variant);
            }
        }
        assert!(queue.queue.is_empty());
        assert_eq!(queue.remaining_count(), 2);
        let retry_a = queue.pop_next(0).unwrap();
        let retry_b = queue.pop_next(0).unwrap();
        assert!(failed.contains(&retry_a));
        assert!(failed.contains(&retry_b));
        assert_ne!(retry_a, retry_b);
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
        let mut session = StudySession::new("deck".into(), 1, &entries(1), &[StudyMode::Reading], INCREMENT, CHECKPOINT, 1).unwrap();
        let variant = session.next_variant(10).unwrap();
        session.resolve_current(&variant, true).unwrap();
        session.recover_interrupted_card();
        assert!(session.current.is_none());
        assert_eq!(session.queue.remaining_count(), 0);
    }

    #[test]
    fn fail_review_then_exit_keeps_variant_required() {
        let mut session = StudySession::new("deck".into(), 1, &entries(1), &[StudyMode::Reading], INCREMENT, CHECKPOINT, 1).unwrap();
        let variant = session.next_variant(10).unwrap();
        session.resolve_current(&variant, false).unwrap();
        session.recover_interrupted_card();
        assert!(session.current.is_none());
        assert_eq!(session.queue.remaining_count(), 1);
        assert_eq!(session.next_variant(10), Some(variant));
    }

    #[test]
    fn unresolved_exit_and_restart_do_not_lose_variant() {
        let mut session = StudySession::new("deck".into(), 1, &entries(1), &[StudyMode::Reading], INCREMENT, CHECKPOINT, 1).unwrap();
        let variant = session.next_variant(10).unwrap();
        let persisted = serde_json::to_string(&session).unwrap();
        let mut restarted: StudySession = serde_json::from_str(&persisted).unwrap();
        restarted.recover_interrupted_card();
        assert!(restarted.current.is_none());
        assert_eq!(restarted.next_variant(10), Some(variant));
    }

    #[test]
    fn deleting_a_boundary_entry_does_not_pull_the_next_slot_forward() {
        let values = entries(51);
        let mut session = StudySession::new("deck".into(), 1, &values, &[StudyMode::Reading], INCREMENT, CHECKPOINT, 1).unwrap();
        let remaining: Vec<_> = values.into_iter().filter(|entry| entry.id != "e49").collect();

        session.remove_entry("e49");
        session.sync_entries(&remaining, &[StudyMode::Reading]);

        assert_eq!(session.scheduled_entry_count(), 51);
        assert_eq!(session.range().label, "0~49");
        assert_eq!(session.range_total, 49);
        assert!(!session.queue.remaining.iter().any(|variant| variant.entry_id == "e50"));

    }

    #[test]
    fn entries_added_mid_stage_wait_for_the_next_stage_snapshot() {
        let first_stage_entries = entries(50);
        let mut session = StudySession::new("deck".into(), 1, &first_stage_entries, &[StudyMode::Reading], INCREMENT, CHECKPOINT, 1).unwrap();
        let with_new_entry = entries(51);

        session.sync_entries(&with_new_entry, &[StudyMode::Reading]);
        assert_eq!(session.scheduled_entry_count(), 50);
        assert_eq!(session.range().label, "0~49");
        assert!(!session.queue.remaining.iter().any(|variant| variant.entry_id == "e50"));

        let next_stage = StudySession::new("deck".into(), 2, &with_new_entry, &[StudyMode::Reading], INCREMENT, CHECKPOINT, 2).unwrap();
        assert_eq!(next_stage.scheduled_entry_count(), 51);
        assert_eq!(next_stage.range().label, "0~50");
        assert!(next_stage.queue.remaining.iter().any(|variant| variant.entry_id == "e50"));
    }

    #[test]
    fn completed_stage_has_no_active_card() {
        let mut session = StudySession::new("deck".into(), 1, &entries(1), &[StudyMode::Reading], INCREMENT, CHECKPOINT, 1).unwrap();
        let variant = session.next_variant(10).unwrap();
        session.resolve_current(&variant, true).unwrap();
        assert!(session.current.is_none());
        assert_eq!(session.queue.remaining_count(), 0);
    }

    #[test]
    fn pitch_review_then_exit_preserves_the_pitch_outcome() {
        for passed in [true, false] {
            let mut session = StudySession::new("deck".into(), 1, &entries(1), &[StudyMode::Reading], INCREMENT, CHECKPOINT, 1).unwrap();
            let variant = session.next_variant(10).unwrap();
            session.resolve_current(&variant, passed).unwrap();
            session.recover_interrupted_card();
            assert!(session.current.is_none());
            assert_eq!(session.queue.remaining_count(), usize::from(!passed), "passed={passed}");
        }
    }

    #[test]
    fn pitch_failure_reappears_from_the_base_question_not_pitch_pending_state() {
        let mut session = StudySession::new("deck".into(), 1, &entries(1), &[StudyMode::Reading], INCREMENT, CHECKPOINT, 1).unwrap();
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
        let mut active = StudySession::new("deck".into(), 1, &entries(1), &[StudyMode::Reading], INCREMENT, CHECKPOINT, 1).unwrap();
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

    }
}
