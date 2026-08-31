use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TypingProfileState {
    pub sample_count: usize,
    pub interkey_gaps_ms: Vec<f64>,
    pub completion_durations_ms: Vec<f64>,
    pub ime_conversion_latencies_ms: Vec<f64>,
    #[serde(default)]
    pub chars_per_second_samples: Vec<f64>,
}

impl TypingProfileState {
    const WINDOW: usize = 400;
    const MAX_VALID_INTERKEY_GAP_MS: u64 = 3_000;
    const MAX_VALID_COMPLETION_MS: u64 = 60_000;
    const MAX_VALID_IME_MS: u64 = 30_000;

    pub fn observe(&mut self, gaps: &[u64], completion_ms: u64, ime_ms: u64, answer_chars: usize) {
        if gaps.is_empty()
            || answer_chars == 0
            || completion_ms == 0
            || completion_ms > Self::MAX_VALID_COMPLETION_MS
            || ime_ms > Self::MAX_VALID_IME_MS
            || gaps.iter().any(|&g| g > Self::MAX_VALID_INTERKEY_GAP_MS)
        {
            return;
        }
        self.sample_count += 1;
        self.interkey_gaps_ms.extend(gaps.iter().copied().map(|v| v as f64));
        self.completion_durations_ms.push(completion_ms as f64);
        if ime_ms > 0 { self.ime_conversion_latencies_ms.push(ime_ms as f64); }
        self.chars_per_second_samples.push(answer_chars as f64 * 1_000.0 / completion_ms as f64);
        trim(&mut self.interkey_gaps_ms, Self::WINDOW * 8);
        trim(&mut self.completion_durations_ms, Self::WINDOW);
        trim(&mut self.ime_conversion_latencies_ms, Self::WINDOW);
        trim(&mut self.chars_per_second_samples, Self::WINDOW);
    }

    pub fn median_gap(&self) -> Option<f64> { percentile(&self.interkey_gaps_ms, 0.50) }
    pub fn p90_gap(&self) -> Option<f64> { percentile(&self.interkey_gaps_ms, 0.90) }
    pub fn p95_gap(&self) -> Option<f64> { percentile(&self.interkey_gaps_ms, 0.95) }
    pub fn median_chars_per_second(&self) -> Option<f64> { percentile(&self.chars_per_second_samples, 0.50) }

    pub fn allowed_idle_ms(&self) -> Option<u64> {
        match self.sample_count {
            0..=99 => None,
            100..=299 => Some(self.p95_gap().unwrap_or(700.0).max(700.0) as u64 + 2_000),
            _ => Some(self.p95_gap().unwrap_or(500.0).max(350.0) as u64 + 850),
        }
    }

    pub fn completion_timed_out(&self, max_idle_gap_ms: u64) -> bool {
        self.allowed_idle_ms().is_some_and(|limit| max_idle_gap_ms > limit)
    }
}

fn trim(values: &mut Vec<f64>, max: usize) {
    if values.len() > max { values.drain(0..values.len() - max); }
}

fn percentile(values: &[f64], p: f64) -> Option<f64> {
    if values.is_empty() { return None; }
    let mut copy = values.to_vec();
    copy.sort_by(|a, b| a.total_cmp(b));
    let idx = ((copy.len() - 1) as f64 * p).round() as usize;
    copy.get(idx).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warmup_keeps_completion_timer_off() {
        let mut profile = TypingProfileState::default();
        for _ in 0..99 { profile.observe(&[180, 220], 900, 0, 4); }
        assert_eq!(profile.allowed_idle_ms(), None);
        profile.observe(&[180, 220], 900, 0, 4);
        assert!(profile.allowed_idle_ms().unwrap() > 2_000);
    }

    #[test]
    fn mature_profile_detects_thinking_pause() {
        let mut profile = TypingProfileState::default();
        for _ in 0..320 { profile.observe(&[160, 220, 240, 190], 900, 0, 4); }
        assert!(!profile.completion_timed_out(600));
        assert!(profile.completion_timed_out(5_500));
    }

    #[test]
    fn timeout_samples_do_not_contaminate_profile() {
        let mut profile = TypingProfileState::default();
        profile.observe(&[200, 5_500], 10_000, 0, 4);
        assert_eq!(profile.sample_count, 0);
    }

    #[test]
    fn successful_samples_calculate_chars_per_second() {
        let mut profile = TypingProfileState::default();
        profile.observe(&[200, 200, 200], 2_000, 0, 4);
        assert_eq!(profile.median_chars_per_second(), Some(2.0));
    }

    #[test]
    fn abnormal_ime_and_missing_activity_do_not_count_as_samples() {
        let mut profile = TypingProfileState::default();
        profile.observe(&[], 1_000, 0, 1);
        profile.observe(&[200], 31_000, 31_000, 2);
        assert_eq!(profile.sample_count, 0);
    }
}
