use std::{collections::{BTreeMap, HashMap, HashSet}, fs, path::{Path, PathBuf}};
use std::time::Duration;

use chrono::Utc;
use rusqlite::{params, params_from_iter, types::{Value as SqlValue, ValueRef}, Connection, OptionalExtension, Transaction};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::{
    model::{AudioAssetDraft, DeckRecord, DeckStats, DeckSummary, EntryDraft, EntryRecord, ImportResult, LibraryDeckStats, LibraryStats, LibraryStatsModePoint, LibraryStatsPoint, PitchConfidence, PitchQuestion, RecallTimeoutByMode, StudyMode},
    study::{study_ranges, StudySession},
    timers::TypingProfileState,
};

#[derive(Default)]
struct StatsAggregate {
    attempts: usize,
    base_correct: usize,
    pitch_attempts: usize,
    pitch_correct: usize,
    joint_correct: usize,
    recall_latencies: Vec<u64>,
    last_practiced_at: Option<String>,
}

impl StatsAggregate {
    fn record(&mut self, base_correct: bool, pitch_correct: Option<bool>, joint_correct: bool, recall_latency_ms: u64, timestamp: &str) {
        self.attempts += 1;
        self.base_correct += usize::from(base_correct);
        self.joint_correct += usize::from(joint_correct);
        if let Some(correct) = pitch_correct {
            self.pitch_attempts += 1;
            self.pitch_correct += usize::from(correct);
        }
        self.recall_latencies.push(recall_latency_ms);
        if self.last_practiced_at.as_deref().is_none_or(|latest| timestamp > latest) {
            self.last_practiced_at = Some(timestamp.to_string());
        }
    }

    fn median_recall_latency_ms(&self) -> Option<u64> {
        if self.recall_latencies.is_empty() { return None; }
        let mut values = self.recall_latencies.clone();
        values.sort_unstable();
        Some(values[values.len() / 2])
    }

    fn deck_stats(&self, mode: StudyMode) -> DeckStats {
        DeckStats {
            mode,
            base_accuracy: ratio(self.base_correct, self.attempts),
            pitch_accuracy: ratio(self.pitch_correct, self.pitch_attempts),
            joint_accuracy: ratio(self.joint_correct, self.attempts),
            median_recall_latency_ms: self.median_recall_latency_ms(),
            attempts: self.attempts,
        }
    }
}

fn history_mode_points(
    by_mode: &HashMap<StudyMode, StatsAggregate>,
    seen_entries_by_mode: &HashMap<StudyMode, HashSet<String>>,
) -> HashMap<StudyMode, LibraryStatsModePoint> {
    [StudyMode::Reading, StudyMode::Listening, StudyMode::Writing]
        .into_iter()
        .map(|mode| {
            let stats = by_mode.get(&mode);
            let point = LibraryStatsModePoint {
                attempts: stats.map_or(0, |value| value.attempts),
                seen_entry_count: seen_entries_by_mode.get(&mode).map_or(0, HashSet::len),
                base_accuracy: stats.and_then(|value| ratio(value.base_correct, value.attempts)),
                pitch_accuracy: stats.and_then(|value| ratio(value.pitch_correct, value.pitch_attempts)),
                median_recall_latency_ms: stats.and_then(StatsAggregate::median_recall_latency_ms),
                study_time_ms: 0,
            };
            (mode, point)
        })
        .collect()
}

#[derive(Debug, Clone)]
pub struct Database {
    path: PathBuf,
    device_id: String,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut db = Self { path, device_id: String::new() };
        db.migrate()?;
        db.device_id = match db.setting("device_id")? {
            Some(value) => value,
            None => {
                let value = format!("windows:{}", Uuid::new_v4());
                db.set_setting("device_id", Some(&value))?;
                value
            }
        };
        Ok(db)
    }

    fn conn(&self) -> Result<Connection, String> {
        let conn = Connection::open(&self.path).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
        Ok(conn)
    }

    fn migrate(&self) -> Result<(), String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version INTEGER PRIMARY KEY,
              applied_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS decks (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              source_language TEXT NOT NULL,
              target_language TEXT NOT NULL,
              enabled_modes TEXT NOT NULL,
              increment_size INTEGER NOT NULL DEFAULT 50,
              checkpoint_size INTEGER NOT NULL DEFAULT 300,
              recall_timeout_by_mode TEXT NOT NULL DEFAULT '{"reading":3000,"listening":3000,"writing":3000}',
              adaptive_completion_timer_enabled INTEGER NOT NULL DEFAULT 1,
              pitch_policy TEXT NOT NULL DEFAULT 'verified_only',
              strict_orthography INTEGER NOT NULL DEFAULT 0,
              current_round INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              deleted_at TEXT,
              device_id TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS entries (
              id TEXT PRIMARY KEY,
              deck_id TEXT NOT NULL REFERENCES decks(id),
              position INTEGER NOT NULL,
              term TEXT NOT NULL,
              meanings TEXT NOT NULL,
              reading TEXT,
              language TEXT NOT NULL,
              metadata TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              deleted_at TEXT,
              device_id TEXT NOT NULL,
              UNIQUE(deck_id, position)
            );

            CREATE TABLE IF NOT EXISTS entry_aliases (
              id TEXT PRIMARY KEY,
              entry_id TEXT NOT NULL REFERENCES entries(id),
              answer TEXT NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('accepted','rejected')),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              deleted_at TEXT,
              device_id TEXT NOT NULL,
              UNIQUE(entry_id, answer)
            );

            CREATE TABLE IF NOT EXISTS japanese_analyses (
              id TEXT PRIMARY KEY,
              entry_id TEXT NOT NULL UNIQUE REFERENCES entries(id),
              normalized_text TEXT NOT NULL,
              reading TEXT,
              analysis_json TEXT NOT NULL,
              provider TEXT NOT NULL,
              source TEXT NOT NULL,
              confidence TEXT NOT NULL,
              model_version TEXT,
              manual_override INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              deleted_at TEXT,
              device_id TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS pitch_patterns (
              id TEXT PRIMARY KEY,
              analysis_id TEXT NOT NULL REFERENCES japanese_analyses(id),
              scope TEXT NOT NULL,
              patterns_json TEXT NOT NULL,
              preferred_pattern INTEGER,
              provider TEXT NOT NULL,
              source TEXT NOT NULL,
              confidence TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              deleted_at TEXT,
              device_id TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS audio_assets (
              id TEXT PRIMARY KEY,
              entry_id TEXT NOT NULL REFERENCES entries(id),
              cache_key TEXT NOT NULL UNIQUE,
              path TEXT NOT NULL,
              provider TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              deleted_at TEXT,
              device_id TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS study_sessions (
              id TEXT PRIMARY KEY,
              deck_id TEXT NOT NULL REFERENCES decks(id),
              round INTEGER NOT NULL,
              status TEXT NOT NULL,
              started_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              device_id TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS study_activity (
              date TEXT NOT NULL,
              deck_id TEXT NOT NULL REFERENCES decks(id),
              mode TEXT NOT NULL,
              duration_ms INTEGER NOT NULL DEFAULT 0,
              updated_at TEXT NOT NULL,
              device_id TEXT NOT NULL,
              PRIMARY KEY(date, deck_id, mode, device_id)
            );

            CREATE TABLE IF NOT EXISTS stage_states (
              deck_id TEXT PRIMARY KEY REFERENCES decks(id),
              round INTEGER NOT NULL,
              stage_index INTEGER NOT NULL,
              stage_label TEXT NOT NULL,
              state_json TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              device_id TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS stage_completions (
              deck_id TEXT NOT NULL REFERENCES decks(id),
              stage_label TEXT NOT NULL,
              first_completed_round INTEGER NOT NULL,
              first_completed_at TEXT NOT NULL,
              PRIMARY KEY(deck_id, stage_label)
            );

            CREATE TABLE IF NOT EXISTS attempts (
              id TEXT PRIMARY KEY,
              entry_id TEXT NOT NULL REFERENCES entries(id),
              deck_id TEXT NOT NULL REFERENCES decks(id),
              variant TEXT NOT NULL,
              round INTEGER NOT NULL,
              stage TEXT NOT NULL,
              answer_text TEXT NOT NULL,
              base_correct INTEGER NOT NULL,
              pitch_correct INTEGER,
              joint_correct INTEGER NOT NULL,
              grading_method TEXT NOT NULL,
              semantic_score REAL,
              recall_latency_ms INTEGER NOT NULL,
              typing_duration_ms INTEGER NOT NULL,
              total_duration_ms INTEGER NOT NULL,
              failure_type TEXT,
              timestamp TEXT NOT NULL,
              device_id TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS typing_profiles (
              id TEXT PRIMARY KEY,
              deck_id TEXT NOT NULL REFERENCES decks(id),
              input_language TEXT NOT NULL,
              study_mode TEXT NOT NULL,
              input_method TEXT NOT NULL DEFAULT 'default',
              sample_count INTEGER NOT NULL DEFAULT 0,
              median_interkey_gap REAL,
              p90_interkey_gap REAL,
              p95_interkey_gap REAL,
              chars_per_second REAL,
              ime_conversion_latency REAL,
              completion_distribution TEXT NOT NULL DEFAULT '[]',
              updated_at TEXT NOT NULL,
              UNIQUE(deck_id, input_language, study_mode, input_method)
            );

            CREATE TABLE IF NOT EXISTS grading_decisions (
              id TEXT PRIMARY KEY,
              entry_id TEXT NOT NULL REFERENCES entries(id),
              answer TEXT NOT NULL,
              decision TEXT NOT NULL,
              model_score REAL,
              method TEXT NOT NULL,
              timestamp TEXT NOT NULL,
              device_id TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS semantic_embeddings (
              normalized_text TEXT NOT NULL,
              purpose TEXT NOT NULL,
              model_id TEXT NOT NULL,
              model_version TEXT NOT NULL,
              dimension INTEGER NOT NULL,
              embedding BLOB NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY(normalized_text, purpose, model_id, model_version, dimension)
            );

            CREATE TABLE IF NOT EXISTS sync_journal (
              op_id TEXT PRIMARY KEY,
              entity_id TEXT NOT NULL,
              entity_type TEXT NOT NULL,
              device_id TEXT NOT NULL,
              revision INTEGER NOT NULL,
              operation TEXT NOT NULL,
              payload TEXT NOT NULL,
              timestamp TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS enrichment_jobs (
              id TEXT PRIMARY KEY,
              entry_id TEXT NOT NULL UNIQUE REFERENCES entries(id),
              status TEXT NOT NULL DEFAULT 'queued',
              attempts INTEGER NOT NULL DEFAULT 0,
              last_error TEXT,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS app_settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            "#,
        ).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?1)",
            [now()],
        ).map_err(|e| e.to_string())?;
        let phase5_migrated: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=2)",
            [],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if !phase5_migrated {
            tx.execute(
                "DELETE FROM pitch_patterns WHERE provider='unidic-fugashi' AND confidence!='MANUAL'",
                [],
            ).map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE enrichment_jobs SET status='queued',attempts=0,last_error=NULL,updated_at=?1 WHERE entry_id IN (SELECT entry_id FROM japanese_analyses WHERE provider='unidic-fugashi')",
                [now()],
            ).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES(2, ?1)",
                [now()],
            ).map_err(|e| e.to_string())?;
        }
        let voicevox_migrated: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=3)",
            [],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if !voicevox_migrated {
            tx.execute_batch(
                r#"
                ALTER TABLE audio_assets ADD COLUMN voice_profile TEXT NOT NULL DEFAULT 'legacy';
                ALTER TABLE audio_assets ADD COLUMN age_band TEXT NOT NULL DEFAULT 'unknown';
                ALTER TABLE audio_assets ADD COLUMN gender_presentation TEXT NOT NULL DEFAULT 'unknown';
                ALTER TABLE audio_assets ADD COLUMN speaker_id INTEGER;
                ALTER TABLE audio_assets ADD COLUMN speaker_name TEXT;
                ALTER TABLE audio_assets ADD COLUMN accent_type INTEGER;
                CREATE TABLE IF NOT EXISTS audio_playback_state (
                  entry_id TEXT PRIMARY KEY REFERENCES entries(id),
                  next_index INTEGER NOT NULL DEFAULT 0,
                  updated_at TEXT NOT NULL
                );
                DELETE FROM audio_assets;
                "#,
            ).map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE enrichment_jobs SET status='queued',attempts=0,last_error=NULL,updated_at=?1 WHERE entry_id IN (SELECT id FROM entries WHERE deleted_at IS NULL)",
                [now()],
            ).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES(3, ?1)",
                [now()],
            ).map_err(|e| e.to_string())?;
        }
        let voice_pool_v2_migrated: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=4)",
            [],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if !voice_pool_v2_migrated {
            tx.execute("DELETE FROM audio_assets", []).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM audio_playback_state", []).map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE enrichment_jobs SET status='queued',attempts=0,last_error=NULL,updated_at=?1 WHERE entry_id IN (SELECT id FROM entries WHERE deleted_at IS NULL)",
                [now()],
            ).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES(4, ?1)",
                [now()],
            ).map_err(|e| e.to_string())?;
        }
        let voice_pool_v3_migrated: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=5)",
            [],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if !voice_pool_v3_migrated {
            tx.execute("DELETE FROM audio_assets", []).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM audio_playback_state", []).map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE enrichment_jobs SET status='queued',attempts=0,last_error=NULL,updated_at=?1 WHERE entry_id IN (SELECT id FROM entries WHERE deleted_at IS NULL)",
                [now()],
            ).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES(5, ?1)",
                [now()],
            ).map_err(|e| e.to_string())?;
        }
        let voice_pool_v4_migrated: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=6)",
            [],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if !voice_pool_v4_migrated {
            tx.execute("DELETE FROM audio_assets", []).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM audio_playback_state", []).map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE enrichment_jobs SET status='queued',attempts=0,last_error=NULL,updated_at=?1 WHERE entry_id IN (SELECT id FROM entries WHERE deleted_at IS NULL)",
                [now()],
            ).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES(6, ?1)",
                [now()],
            ).map_err(|e| e.to_string())?;
        }
        let voice_pool_v5_migrated: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=7)",
            [],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if !voice_pool_v5_migrated {
            tx.execute("DELETE FROM audio_assets", []).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM audio_playback_state", []).map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE enrichment_jobs SET status='queued',attempts=0,last_error=NULL,updated_at=?1 WHERE entry_id IN (SELECT id FROM entries WHERE deleted_at IS NULL)",
                [now()],
            ).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES(7, ?1)",
                [now()],
            ).map_err(|e| e.to_string())?;
        }
        let stage_completion_migrated: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=8)",
            [],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if !stage_completion_migrated {
            tx.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS stage_completions (
                  deck_id TEXT NOT NULL REFERENCES decks(id),
                  stage_label TEXT NOT NULL,
                  first_completed_round INTEGER NOT NULL,
                  first_completed_at TEXT NOT NULL,
                  PRIMARY KEY(deck_id, stage_label)
                );
                "#,
            ).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES(8, ?1)",
                [now()],
            ).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn create_deck(&self, name: &str, source_language: &str, target_language: &str) -> Result<DeckSummary, String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let modes = serde_json::to_string(&vec![StudyMode::Reading, StudyMode::Listening, StudyMode::Writing]).unwrap();
        let timestamp = now();
        tx.execute(
            "INSERT INTO decks(id,name,source_language,target_language,enabled_modes,created_at,updated_at,device_id) VALUES(?1,?2,?3,?4,?5,?6,?6,?7)",
            params![id, name, source_language, target_language, modes, timestamp, self.device_id],
        ).map_err(|e| e.to_string())?;
        journal(&tx, &id, "deck", &self.device_id, 1, "insert", &serde_json::json!({"name":name}))?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(DeckSummary { id, name: name.into(), source_language: source_language.into(), target_language: target_language.into(), enabled_modes: vec![StudyMode::Reading,StudyMode::Listening,StudyMode::Writing], entry_count: 0, current_round: 1, active_stage: None, study_ranges: Vec::new(), completed_range_count: 0 })
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn()?;
        match conn.query_row("SELECT value FROM app_settings WHERE key=?1", [key], |row| row.get(0)) {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn set_setting(&self, key: &str, value: Option<&str>) -> Result<(), String> {
        let conn = self.conn()?;
        if let Some(value) = value {
            conn.execute(
                "INSERT INTO app_settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                params![key, value, now()],
            ).map_err(|e| e.to_string())?;
        } else {
            conn.execute("DELETE FROM app_settings WHERE key=?1", [key]).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn list_decks(&self) -> Result<Vec<DeckSummary>, String> {
        let conn = self.conn()?;
        let mut decks = {
            let mut stmt = conn.prepare(
                r#"SELECT d.id,d.name,d.source_language,d.target_language,d.enabled_modes,d.current_round,
                   COUNT(e.id),s.stage_label,d.increment_size,d.checkpoint_size
                   FROM decks d LEFT JOIN entries e ON e.deck_id=d.id AND e.deleted_at IS NULL
                   LEFT JOIN stage_states s ON s.deck_id=d.id
                   WHERE d.deleted_at IS NULL GROUP BY d.id ORDER BY d.created_at"#,
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                let modes: String = row.get(4)?;
                let entry_count = row.get::<_, i64>(6)? as usize;
                Ok(DeckSummary {
                    id: row.get(0)?, name: row.get(1)?, source_language: row.get(2)?, target_language: row.get(3)?,
                    enabled_modes: serde_json::from_str(&modes).unwrap_or_default(), current_round: row.get::<_, i64>(5)? as u32,
                    entry_count, active_stage: row.get(7)?, study_ranges: study_ranges(entry_count, row.get::<_, i64>(8)? as usize, row.get::<_, i64>(9)? as usize),
                    completed_range_count: 0,
                })
            }).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?
        };

        let mut completed_stmt = conn.prepare("SELECT stage_label FROM stage_completions WHERE deck_id=?1").map_err(|e| e.to_string())?;
        for deck in &mut decks {
            let completed = completed_stmt
                .query_map([&deck.id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<HashSet<_>, _>>()
                .map_err(|e| e.to_string())?;
            deck.completed_range_count = deck.study_ranges.iter().filter(|range| completed.contains(&range.label)).count();
        }
        Ok(decks)
    }

    pub fn mark_stage_completed(&self, deck_id: &str, stage_label: &str, round: u32) -> Result<(), String> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT OR IGNORE INTO stage_completions(deck_id,stage_label,first_completed_round,first_completed_at) VALUES(?1,?2,?3,?4)",
            params![deck_id, stage_label, round as i64, now()],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn deck(&self, id: &str) -> Result<DeckRecord, String> {
        let conn = self.conn()?;
        conn.query_row(
            "SELECT id,name,source_language,target_language,enabled_modes,increment_size,checkpoint_size,recall_timeout_by_mode,adaptive_completion_timer_enabled,pitch_policy,strict_orthography,current_round FROM decks WHERE id=?1 AND deleted_at IS NULL",
            [id], |row| {
                let modes: String = row.get(4)?;
                let timeouts: String = row.get(7)?;
                let recall_timeout_by_mode = serde_json::from_str::<RecallTimeoutByMode>(&timeouts).unwrap_or_default();
                Ok(DeckRecord {
                    id: row.get(0)?, name: row.get(1)?, source_language: row.get(2)?, target_language: row.get(3)?,
                    enabled_modes: serde_json::from_str(&modes).unwrap_or_default(), increment_size: row.get::<_,i64>(5)? as usize,
                    checkpoint_size: row.get::<_,i64>(6)? as usize, recall_timeout_by_mode,
                    adaptive_completion_timer_enabled: row.get::<_,i64>(8)? != 0,
                    pitch_policy: row.get(9)?, strict_orthography: row.get::<_,i64>(10)? != 0, current_round: row.get::<_,i64>(11)? as u32,
                })
            },
        ).map_err(|e| e.to_string())
    }

    pub fn entries(&self, deck_id: &str) -> Result<Vec<EntryRecord>, String> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare("SELECT id,term,meanings,reading FROM entries WHERE deck_id=?1 AND deleted_at IS NULL ORDER BY position").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([deck_id], |row| {
            let meanings: String = row.get(2)?;
            Ok(EntryRecord { id: row.get(0)?, term: row.get(1)?, meanings: serde_json::from_str(&meanings).unwrap_or_default(), reading: row.get(3)? })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())
    }

    pub fn import_entries(&self, deck_id: &str, target_language: &str, drafts: &[EntryDraft]) -> Result<ImportResult, String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut next_pos: i64 = tx.query_row("SELECT COALESCE(MAX(position)+1,0) FROM entries WHERE deck_id=?1", [deck_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        let timestamp = now();
        let mut inserted = 0;
        let mut duplicates = 0;
        for draft in drafts.iter().filter(|d| !d.term.trim().is_empty() && !d.meanings.is_empty()) {
            let meanings = serde_json::to_string(&draft.meanings).map_err(|e| e.to_string())?;
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM entries WHERE deck_id=?1 AND term=?2 AND meanings=?3 AND COALESCE(reading,'')=COALESCE(?4,'') AND deleted_at IS NULL)",
                params![deck_id, draft.term.trim(), meanings, draft.reading], |row| row.get(0),
            ).map_err(|e| e.to_string())?;
            if exists { duplicates += 1; continue; }
            let id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO entries(id,deck_id,position,term,meanings,reading,language,created_at,updated_at,device_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8,?9)",
                params![id, deck_id, next_pos, draft.term.trim(), meanings, draft.reading, target_language, timestamp, self.device_id],
            ).map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO enrichment_jobs(id,entry_id,status,updated_at) VALUES(?1,?2,'queued',?3)", params![Uuid::new_v4().to_string(),id,timestamp]).map_err(|e| e.to_string())?;
            journal(&tx, &id, "entry", &self.device_id, 1, "insert", &serde_json::json!({"deck_id":deck_id,"term":draft.term,"meanings":draft.meanings}))?;
            next_pos += 1;
            inserted += 1;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(ImportResult { inserted, duplicates })
    }

    pub fn update_deck(&self, deck_id: &str, name: &str, enabled_modes: &[StudyMode]) -> Result<(), String> {
        if name.trim().is_empty() { return Err("deck name cannot be empty".into()); }
        if enabled_modes.is_empty() { return Err("at least one study mode must be enabled".into()); }
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let revision: i64 = tx.query_row("SELECT revision+1 FROM decks WHERE id=?1 AND deleted_at IS NULL", [deck_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        let modes = serde_json::to_string(enabled_modes).map_err(|e| e.to_string())?;
        tx.execute("UPDATE decks SET name=?1,enabled_modes=?2,updated_at=?3,revision=?4,device_id=?5 WHERE id=?6", params![name.trim(), modes, now(), revision, self.device_id, deck_id]).map_err(|e| e.to_string())?;
        journal(&tx, deck_id, "deck", &self.device_id, revision, "update", &serde_json::json!({"name":name.trim(),"enabled_modes":enabled_modes}))?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn delete_deck(&self, deck_id: &str) -> Result<(), String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let revision: i64 = tx.query_row("SELECT revision+1 FROM decks WHERE id=?1 AND deleted_at IS NULL", [deck_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        let timestamp = now();
        tx.execute("UPDATE decks SET deleted_at=?1,updated_at=?1,revision=?2,device_id=?3 WHERE id=?4", params![timestamp, revision, self.device_id, deck_id]).map_err(|e| e.to_string())?;
        journal(&tx, deck_id, "deck", &self.device_id, revision, "delete", &serde_json::json!({"deleted_at":timestamp}))?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn aliases(&self, entry_id: &str) -> Result<(Vec<String>, Vec<String>), String> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare("SELECT answer,status FROM entry_aliases WHERE entry_id=?1 AND deleted_at IS NULL").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([entry_id], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?))).map_err(|e| e.to_string())?;
        let mut accepted = Vec::new(); let mut rejected = Vec::new();
        for row in rows { let (a,s)=row.map_err(|e|e.to_string())?; if s=="accepted" {accepted.push(a)} else {rejected.push(a)} }
        Ok((accepted,rejected))
    }

    pub fn set_alias(&self, entry_id: &str, answer: &str, accepted: bool) -> Result<(), String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let status = if accepted { "accepted" } else { "rejected" };
        let timestamp = now();
        let existing: Option<String> = tx.query_row("SELECT id FROM entry_aliases WHERE entry_id=?1 AND answer=?2", params![entry_id,answer], |r| r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(id)=existing {
            tx.execute("UPDATE entry_aliases SET status=?1,updated_at=?2,revision=revision+1,device_id=?3,deleted_at=NULL WHERE id=?4", params![status,timestamp,self.device_id,id]).map_err(|e|e.to_string())?;
            let revision: i64 = tx.query_row("SELECT revision FROM entry_aliases WHERE id=?1", [&id], |row| row.get(0)).map_err(|e| e.to_string())?;
            journal(&tx,&id,"entry_alias",&self.device_id,revision,"update",&serde_json::json!({"status":status}))?;
        } else {
            let id=Uuid::new_v4().to_string();
            tx.execute("INSERT INTO entry_aliases(id,entry_id,answer,status,created_at,updated_at,device_id) VALUES(?1,?2,?3,?4,?5,?5,?6)",params![id,entry_id,answer,status,timestamp,self.device_id]).map_err(|e|e.to_string())?;
            journal(&tx,&id,"entry_alias",&self.device_id,1,"insert",&serde_json::json!({"entry_id":entry_id,"answer":answer,"status":status}))?;
        }
        tx.commit().map_err(|e|e.to_string())
    }

    pub fn cached_embedding(&self, normalized_text: &str, purpose: &str, model_id: &str, model_version: &str, dimension: usize) -> Result<Option<Vec<f32>>, String> {
        let conn = self.conn()?;
        let bytes: Option<Vec<u8>> = conn.query_row(
            "SELECT embedding FROM semantic_embeddings WHERE normalized_text=?1 AND purpose=?2 AND model_id=?3 AND model_version=?4 AND dimension=?5",
            params![normalized_text, purpose, model_id, model_version, dimension as i64],
            |row| row.get(0),
        ).optional().map_err(|e| e.to_string())?;
        bytes.map(|bytes| {
            if bytes.len() != dimension * 4 { return Err("cached embedding dimension mismatch".into()); }
            Ok(bytes.chunks_exact(4).map(|v| f32::from_le_bytes([v[0], v[1], v[2], v[3]])).collect())
        }).transpose()
    }

    pub fn cache_embedding(&self, normalized_text: &str, purpose: &str, model_id: &str, model_version: &str, embedding: &[f32]) -> Result<(), String> {
        let conn = self.conn()?;
        let bytes: Vec<u8> = embedding.iter().flat_map(|value| value.to_le_bytes()).collect();
        conn.execute(
            "INSERT INTO semantic_embeddings(normalized_text,purpose,model_id,model_version,dimension,embedding,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(normalized_text,purpose,model_id,model_version,dimension) DO UPDATE SET embedding=excluded.embedding,updated_at=excluded.updated_at",
            params![normalized_text, purpose, model_id, model_version, embedding.len() as i64, bytes, now()],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn semantic_candidates(&self) -> Result<Vec<String>, String> {
        let conn = self.conn()?;
        let mut values = Vec::new();
        let mut meanings = conn.prepare("SELECT meanings FROM entries WHERE deleted_at IS NULL").map_err(|e| e.to_string())?;
        let rows = meanings.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        for row in rows {
            values.extend(serde_json::from_str::<Vec<String>>(&row.map_err(|e| e.to_string())?).unwrap_or_default());
        }
        let mut aliases = conn.prepare("SELECT answer FROM entry_aliases WHERE deleted_at IS NULL").map_err(|e| e.to_string())?;
        let rows = aliases.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        for row in rows { values.push(row.map_err(|e| e.to_string())?); }
        Ok(values)
    }

    pub fn save_session(&self, session: &StudySession) -> Result<(), String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let timestamp = now();
        tx.execute(
            "INSERT INTO stage_states(deck_id,round,stage_index,stage_label,state_json,updated_at,device_id) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(deck_id) DO UPDATE SET round=excluded.round,stage_index=excluded.stage_index,stage_label=excluded.stage_label,state_json=excluded.state_json,updated_at=excluded.updated_at,device_id=excluded.device_id",
            params![session.deck_id,session.round,session.stage_index as i64,session.stage().label(),serde_json::to_string(session).map_err(|e|e.to_string())?,timestamp,self.device_id],
        ).map_err(|e|e.to_string())?;
        let revision: i64 = tx.query_row("SELECT COALESCE(MAX(revision),0)+1 FROM sync_journal WHERE entity_id=?1 AND entity_type='stage_state'", [&session.deck_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        journal(&tx, &session.deck_id, "stage_state", &self.device_id, revision, "upsert", &serde_json::json!({"round":session.round,"stage_index":session.stage_index,"stage_label":session.stage().label()}))?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn record_study_activity(&self, deck_id: &str, mode: Option<StudyMode>, duration_ms: u64) -> Result<(), String> {
        if duration_ms == 0 { return Ok(()); }
        let conn = self.conn()?;
        let timestamp = now();
        let date = timestamp.get(..10).unwrap_or(timestamp.as_str());
        let mode = mode.map(StudyMode::as_str).unwrap_or("all");
        conn.execute(
            "INSERT INTO study_activity(date,deck_id,mode,duration_ms,updated_at,device_id) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(date,deck_id,mode,device_id) DO UPDATE SET duration_ms=study_activity.duration_ms+excluded.duration_ms,updated_at=excluded.updated_at",
            params![date, deck_id, mode, duration_ms as i64, timestamp, self.device_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_session(&self, deck_id: &str) -> Result<Option<StudySession>, String> {
        let conn = self.conn()?;
        let state: Option<String> = conn.query_row("SELECT state_json FROM stage_states WHERE deck_id=?1",[deck_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        state.map(|s|serde_json::from_str(&s).map_err(|e|e.to_string())).transpose()
    }

    pub fn clear_session_and_advance_round(&self, deck_id: &str) -> Result<(), String> {
        let mut conn=self.conn()?; let tx=conn.transaction().map_err(|e|e.to_string())?;
        let stage_revision: i64 = tx.query_row("SELECT COALESCE(MAX(revision),0)+1 FROM sync_journal WHERE entity_id=?1 AND entity_type='stage_state'", [deck_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM stage_states WHERE deck_id=?1",[deck_id]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE decks SET current_round=current_round+1,updated_at=?1,revision=revision+1 WHERE id=?2",params![now(),deck_id]).map_err(|e|e.to_string())?;
        let deck_revision: i64 = tx.query_row("SELECT revision FROM decks WHERE id=?1", [deck_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        journal(&tx, deck_id, "stage_state", &self.device_id, stage_revision, "delete", &serde_json::json!({}))?;
        journal(&tx, deck_id, "deck", &self.device_id, deck_revision, "update", &serde_json::json!({"current_round_increment":1}))?;
        tx.commit().map_err(|e|e.to_string())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert_attempt(&self, entry_id:&str, deck_id:&str, variant:StudyMode, round:u32, stage:&str, answer:&str, base_correct:bool, pitch_correct:Option<bool>, joint_correct:bool, grading_method:&str, semantic_score:Option<f64>, recall_latency_ms:u64, typing_duration_ms:u64, failure_type:Option<&str>) -> Result<(),String> {
        let mut conn=self.conn()?;
        let tx=conn.transaction().map_err(|e|e.to_string())?;
        let id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO attempts(id,entry_id,deck_id,variant,round,stage,answer_text,base_correct,pitch_correct,joint_correct,grading_method,semantic_score,recall_latency_ms,typing_duration_ms,total_duration_ms,failure_type,timestamp,device_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
            params![id,entry_id,deck_id,variant.as_str(),round,stage,answer,base_correct,pitch_correct,joint_correct,grading_method,semantic_score,recall_latency_ms,typing_duration_ms,recall_latency_ms+typing_duration_ms,failure_type,now(),self.device_id],
        ).map_err(|e|e.to_string())?;
        journal(&tx, &id, "attempt", &self.device_id, 1, "insert", &serde_json::json!({"entry_id":entry_id,"deck_id":deck_id,"variant":variant,"round":round,"stage":stage}))?;
        tx.commit().map_err(|e|e.to_string())
    }

    pub fn update_attempt_pitch(&self, deck_id:&str, entry_id:&str, variant:StudyMode, correct:bool, joint_correct:bool, failure_type:Option<&str>) -> Result<(),String> {
        let mut conn=self.conn()?;
        let tx=conn.transaction().map_err(|e|e.to_string())?;
        let id:Option<String>=tx.query_row("SELECT id FROM attempts WHERE deck_id=?1 AND entry_id=?2 AND variant=?3 ORDER BY timestamp DESC LIMIT 1",params![deck_id,entry_id,variant.as_str()],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(id)=id {
            tx.execute("UPDATE attempts SET pitch_correct=?1,joint_correct=?2,failure_type=COALESCE(?3,failure_type) WHERE id=?4",params![correct,joint_correct,failure_type,id]).map_err(|e|e.to_string())?;
            journal(&tx, &id, "attempt", &self.device_id, 2, "update", &serde_json::json!({"pitch_correct":correct,"joint_correct":joint_correct,"failure_type":failure_type}))?;
        }
        tx.commit().map_err(|e|e.to_string())
    }

    pub fn pitch_question(&self, entry_id:&str, predicted_gate:bool) -> Result<Option<PitchQuestion>,String> {
        let conn=self.conn()?;
        let row:Option<(String,String,String,String)>=conn.query_row(
            "SELECT COALESCE(a.reading,''),a.analysis_json,p.patterns_json,p.confidence FROM japanese_analyses a JOIN pitch_patterns p ON p.analysis_id=a.id WHERE a.entry_id=?1 AND a.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY CASE p.confidence WHEN 'MANUAL' THEN 1 WHEN 'VERIFIED' THEN 2 WHEN 'CONSENSUS' THEN 3 ELSE 4 END LIMIT 1",
            [entry_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|e|e.to_string())?;
        let Some((reading,analysis_json,patterns_json,confidence))=row else{return Ok(None)};
        let analysis:serde_json::Value=serde_json::from_str(&analysis_json).unwrap_or_default();
        let patterns:Vec<Vec<u8>>=serde_json::from_str(&patterns_json).unwrap_or_default();
        let confidence=match confidence.as_str(){"MANUAL"=>PitchConfidence::Manual,"VERIFIED"=>PitchConfidence::Verified,"CONSENSUS"=>PitchConfidence::Consensus,_=>PitchConfidence::Predicted};
        let gate=confidence.gates_by_default() || predicted_gate;
        let morae:Vec<String>=analysis.get("morae").and_then(|v|v.as_array()).map(|a|a.iter().filter_map(|v|v.as_str().map(String::from)).collect()).unwrap_or_default();
        let kind=analysis.get("scope").and_then(|v|v.as_str()).unwrap_or("lexical").to_string();
        if kind != "lexical" || morae.is_empty() || patterns.is_empty() || patterns.iter().any(|pattern| pattern.len()!=morae.len() || pattern.iter().any(|level| *level>1)) {
            return Ok(None);
        }
        let phrase_count=if kind=="lexical"{1}else{patterns.first().map(|p|p.len()).unwrap_or(1)};
        Ok(Some(PitchQuestion{kind,reading,morae,phrase_count,allowed_patterns:patterns,confidence,gate_enabled:gate}))
    }

    pub fn next_audio_path(&self, entry_id:&str)->Result<Option<String>,String>{
        let mut conn=self.conn()?;
        let tx=conn.transaction().map_err(|e|e.to_string())?;
        let mut stmt=tx.prepare("SELECT path FROM audio_assets WHERE entry_id=?1 AND deleted_at IS NULL ORDER BY CASE age_band WHEN 'child' THEN 1 WHEN 'adolescent' THEN 2 WHEN 'young_adult' THEN 3 WHEN 'middle_aged' THEN 4 WHEN 'senior' THEN 5 ELSE 6 END, CASE gender_presentation WHEN 'feminine' THEN 1 WHEN 'neutral' THEN 2 WHEN 'masculine' THEN 3 ELSE 4 END, voice_profile, cache_key").map_err(|e|e.to_string())?;
        let paths=stmt.query_map([entry_id],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        drop(stmt);
        if paths.is_empty(){tx.commit().map_err(|e|e.to_string())?;return Ok(None)}
        let next:i64=tx.query_row("SELECT next_index FROM audio_playback_state WHERE entry_id=?1",[entry_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?.unwrap_or(0);
        let path=paths[next.rem_euclid(paths.len() as i64) as usize].clone();
        tx.execute(
            "INSERT INTO audio_playback_state(entry_id,next_index,updated_at) VALUES(?1,?2,?3) ON CONFLICT(entry_id) DO UPDATE SET next_index=excluded.next_index,updated_at=excluded.updated_at",
            params![entry_id,next+1,now()],
        ).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())?;
        Ok(Some(path))
    }

    pub fn relocate_audio_paths(&self, old_root: &Path, new_root: &Path) -> Result<(), String> {
        let mut conn = self.conn()?;
        let paths = {
            let mut stmt = conn.prepare("SELECT id,path FROM audio_assets WHERE deleted_at IS NULL").map_err(|e| e.to_string())?;
            stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (id, path) in paths {
            let Ok(relative) = Path::new(&path).strip_prefix(old_root) else { continue; };
            let relocated = new_root.join(relative).to_string_lossy().to_string();
            tx.execute("UPDATE audio_assets SET path=?1,updated_at=?2 WHERE id=?3", params![relocated, now(), id]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn stats(&self, deck_id:&str)->Result<Vec<DeckStats>,String>{
        let conn=self.conn()?;
        let mut output=Vec::new();
        for mode in [StudyMode::Reading,StudyMode::Listening,StudyMode::Writing]{
            let mut stmt=conn.prepare("SELECT base_correct,pitch_correct,joint_correct,recall_latency_ms FROM attempts WHERE deck_id=?1 AND variant=?2").map_err(|e|e.to_string())?;
            let rows=stmt.query_map(params![deck_id,mode.as_str()],|r|Ok((r.get::<_,i64>(0)?!=0,r.get::<_,Option<i64>>(1)?.map(|v|v!=0),r.get::<_,i64>(2)?!=0,r.get::<_,i64>(3)? as u64))).map_err(|e|e.to_string())?;
            let data=rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
            let attempts=data.len();
            let base_accuracy=ratio(data.iter().filter(|r|r.0).count(),attempts);
            let pitch_vals:Vec<bool>=data.iter().filter_map(|r|r.1).collect();
            let pitch_accuracy=ratio(pitch_vals.iter().filter(|&&v|v).count(),pitch_vals.len());
            let joint_accuracy=ratio(data.iter().filter(|r|r.2).count(),attempts);
            let mut latency:Vec<u64>=data.iter().map(|r|r.3).collect(); latency.sort_unstable();
            let median=if latency.is_empty(){None}else{Some(latency[latency.len()/2])};
            output.push(DeckStats{mode,base_accuracy,pitch_accuracy,joint_accuracy,median_recall_latency_ms:median,attempts});
        }
        Ok(output)
    }

    pub fn library_stats(&self) -> Result<LibraryStats, String> {
        let conn = self.conn()?;
        let decks = {
            let mut stmt = conn.prepare(
                "SELECT d.id,d.name,COUNT(e.id),d.current_round FROM decks d LEFT JOIN entries e ON e.deck_id=d.id AND e.deleted_at IS NULL WHERE d.deleted_at IS NULL GROUP BY d.id ORDER BY d.created_at",
            ).map_err(|e| e.to_string())?;
            stmt.query_map([], |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? as usize,
                row.get::<_, i64>(3)? as u32,
            ))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };

        let mut overall = StatsAggregate::default();
        let mut by_mode: HashMap<StudyMode, StatsAggregate> = HashMap::new();
        let mut by_deck: HashMap<String, StatsAggregate> = decks.iter()
            .map(|(id, _, _, _)| (id.clone(), StatsAggregate::default()))
            .collect();
        let mut seen_entries = HashSet::new();
        let mut seen_entries_by_mode: HashMap<StudyMode, HashSet<String>> = HashMap::new();
        let mut history = Vec::new();
        let mut history_date: Option<String> = None;

        let mut stmt = conn.prepare(
            "SELECT a.deck_id,a.entry_id,a.variant,a.base_correct,a.pitch_correct,a.joint_correct,a.recall_latency_ms,a.timestamp FROM attempts a JOIN decks d ON d.id=a.deck_id WHERE d.deleted_at IS NULL ORDER BY a.timestamp,a.id",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)? != 0,
            row.get::<_, Option<i64>>(4)?.map(|value| value != 0),
            row.get::<_, i64>(5)? != 0,
            row.get::<_, i64>(6)? as u64,
            row.get::<_, String>(7)?,
        ))).map_err(|e| e.to_string())?;

        for row in rows {
            let (deck_id, entry_id, variant, base_correct, pitch_correct, joint_correct, recall_latency_ms, timestamp) = row.map_err(|e| e.to_string())?;
            let date = timestamp.get(..10).unwrap_or(timestamp.as_str()).to_string();
            if history_date.as_deref().is_some_and(|previous| previous != date) {
                history.push(LibraryStatsPoint {
                    date: history_date.take().unwrap(),
                    attempts: overall.attempts,
                    seen_entry_count: seen_entries.len(),
                    base_accuracy: ratio(overall.base_correct, overall.attempts),
                    pitch_accuracy: ratio(overall.pitch_correct, overall.pitch_attempts),
                    median_recall_latency_ms: overall.median_recall_latency_ms(),
                    study_time_ms: 0,
                    modes: history_mode_points(&by_mode, &seen_entries_by_mode),
                });
            }
            history_date = Some(date);
            let mode = match variant.as_str() {
                "reading" => StudyMode::Reading,
                "listening" => StudyMode::Listening,
                "writing" => StudyMode::Writing,
                _ => continue,
            };
            seen_entries.insert(entry_id.clone());
            seen_entries_by_mode.entry(mode).or_default().insert(entry_id);
            overall.record(base_correct, pitch_correct, joint_correct, recall_latency_ms, &timestamp);
            by_mode.entry(mode).or_default().record(base_correct, pitch_correct, joint_correct, recall_latency_ms, &timestamp);
            if let Some(deck) = by_deck.get_mut(&deck_id) {
                deck.record(base_correct, pitch_correct, joint_correct, recall_latency_ms, &timestamp);
            }
        }
        if let Some(date) = history_date {
            history.push(LibraryStatsPoint {
                date,
                attempts: overall.attempts,
                seen_entry_count: seen_entries.len(),
                base_accuracy: ratio(overall.base_correct, overall.attempts),
                pitch_accuracy: ratio(overall.pitch_correct, overall.pitch_attempts),
                median_recall_latency_ms: overall.median_recall_latency_ms(),
                study_time_ms: 0,
                modes: history_mode_points(&by_mode, &seen_entries_by_mode),
            });
        }

        let mut activity_by_date: BTreeMap<String, HashMap<String, u64>> = BTreeMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT s.date,s.mode,SUM(s.duration_ms) FROM study_activity s JOIN decks d ON d.id=s.deck_id WHERE d.deleted_at IS NULL GROUP BY s.date,s.mode ORDER BY s.date",
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? as u64,
            ))).map_err(|e| e.to_string())?;
            for row in rows {
                let (date, mode, duration_ms) = row.map_err(|e| e.to_string())?;
                *activity_by_date.entry(date).or_default().entry(mode).or_default() += duration_ms;
            }
        }

        let mut attempt_history = history.into_iter().map(|point| (point.date.clone(), point)).collect::<BTreeMap<_, _>>();
        let mut dates = BTreeMap::<String, ()>::new();
        dates.extend(attempt_history.keys().cloned().map(|date| (date, ())));
        dates.extend(activity_by_date.keys().cloned().map(|date| (date, ())));
        let mut history = Vec::with_capacity(dates.len());
        let mut last_attempt_point: Option<LibraryStatsPoint> = None;
        let mut cumulative_study_time_ms = 0u64;
        let mut cumulative_mode_study_time: HashMap<StudyMode, u64> = HashMap::new();
        for date in dates.into_keys() {
            if let Some(point) = attempt_history.remove(&date) {
                last_attempt_point = Some(point);
            }
            if let Some(activity) = activity_by_date.get(&date) {
                for (mode, duration_ms) in activity {
                    cumulative_study_time_ms += *duration_ms;
                    let parsed_mode = match mode.as_str() {
                        "reading" => Some(StudyMode::Reading),
                        "listening" => Some(StudyMode::Listening),
                        "writing" => Some(StudyMode::Writing),
                        _ => None,
                    };
                    if let Some(parsed_mode) = parsed_mode {
                        *cumulative_mode_study_time.entry(parsed_mode).or_default() += *duration_ms;
                    }
                }
            }
            let mut point = last_attempt_point.clone().unwrap_or_else(|| LibraryStatsPoint {
                date: date.clone(),
                attempts: 0,
                seen_entry_count: 0,
                base_accuracy: None,
                pitch_accuracy: None,
                median_recall_latency_ms: None,
                study_time_ms: 0,
                modes: history_mode_points(&HashMap::new(), &HashMap::new()),
            });
            point.date = date;
            point.study_time_ms = cumulative_study_time_ms;
            for mode in [StudyMode::Reading, StudyMode::Listening, StudyMode::Writing] {
                if let Some(mode_point) = point.modes.get_mut(&mode) {
                    mode_point.study_time_ms = cumulative_mode_study_time.get(&mode).copied().unwrap_or(0);
                }
            }
            history.push(point);
        }

        let mode_stats = [StudyMode::Reading, StudyMode::Listening, StudyMode::Writing]
            .into_iter()
            .map(|mode| by_mode.remove(&mode).unwrap_or_default().deck_stats(mode))
            .collect();
        let mut deck_stats = decks.into_iter().map(|(deck_id, deck_name, entry_count, current_round)| {
            let stats = by_deck.remove(&deck_id).unwrap_or_default();
            LibraryDeckStats {
                deck_id,
                deck_name,
                entry_count,
                current_round,
                attempts: stats.attempts,
                base_accuracy: ratio(stats.base_correct, stats.attempts),
                joint_accuracy: ratio(stats.joint_correct, stats.attempts),
                median_recall_latency_ms: stats.median_recall_latency_ms(),
                last_practiced_at: stats.last_practiced_at,
            }
        }).collect::<Vec<_>>();
        deck_stats.sort_by(|left, right| right.last_practiced_at.cmp(&left.last_practiced_at).then_with(|| left.deck_name.cmp(&right.deck_name)));

        Ok(LibraryStats {
            deck_count: deck_stats.len(),
            active_deck_count: deck_stats.iter().filter(|deck| deck.attempts > 0).count(),
            entry_count: deck_stats.iter().map(|deck| deck.entry_count).sum(),
            seen_entry_count: seen_entries.len(),
            attempts: overall.attempts,
            base_accuracy: ratio(overall.base_correct, overall.attempts),
            pitch_accuracy: ratio(overall.pitch_correct, overall.pitch_attempts),
            joint_accuracy: ratio(overall.joint_correct, overall.attempts),
            median_recall_latency_ms: overall.median_recall_latency_ms(),
            study_time_ms: cumulative_study_time_ms,
            mode_stats,
            deck_stats,
            history,
        })
    }

    pub fn set_entry_analysis(&self, entry_id:&str, reading:Option<&str>, analysis_json:&serde_json::Value, provider:&str, source:&str, confidence:&str, model_version:Option<&str>, pitch_patterns:Option<&[Vec<u8>]>, scope:&str, audio:&[AudioAssetDraft]) -> Result<(),String>{
        let mut conn=self.conn()?; let tx=conn.transaction().map_err(|e|e.to_string())?; let timestamp=now();
        tx.execute("UPDATE entries SET reading=COALESCE(?1,reading),updated_at=?2,revision=revision+1 WHERE id=?3",params![reading,timestamp,entry_id]).map_err(|e|e.to_string())?;
        let analysis_id:Option<String>=tx.query_row("SELECT id FROM japanese_analyses WHERE entry_id=?1",[entry_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let analysis_existed = analysis_id.is_some();
        let aid=analysis_id.unwrap_or_else(||Uuid::new_v4().to_string());
        tx.execute("INSERT INTO japanese_analyses(id,entry_id,normalized_text,reading,analysis_json,provider,source,confidence,model_version,created_at,updated_at,device_id) SELECT ?1,?2,term,?3,?4,?5,?6,?7,?8,?9,?9,?10 FROM entries WHERE id=?2 ON CONFLICT(entry_id) DO UPDATE SET reading=excluded.reading,analysis_json=excluded.analysis_json,provider=excluded.provider,source=excluded.source,confidence=excluded.confidence,model_version=excluded.model_version,updated_at=excluded.updated_at,revision=japanese_analyses.revision+1",params![aid,entry_id,reading,analysis_json.to_string(),provider,source,confidence,model_version,timestamp,self.device_id]).map_err(|e|e.to_string())?;
        let old_pitch: Vec<(String, i64)> = {
            let mut stmt = tx.prepare("SELECT id,revision FROM pitch_patterns WHERE analysis_id=?1 AND confidence!='MANUAL'").map_err(|e| e.to_string())?;
            stmt.query_map([&aid], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        tx.execute("DELETE FROM pitch_patterns WHERE analysis_id=?1 AND confidence!='MANUAL'",[&aid]).map_err(|e|e.to_string())?;
        for (id, revision) in old_pitch { journal(&tx, &id, "pitch_pattern", &self.device_id, revision + 1, "delete", &serde_json::json!({"analysis_id":aid}))?; }
        if let Some(patterns)=pitch_patterns {
            let pitch_id = Uuid::new_v4().to_string();
            tx.execute("INSERT INTO pitch_patterns(id,analysis_id,scope,patterns_json,preferred_pattern,provider,source,confidence,created_at,updated_at,device_id) VALUES(?1,?2,?3,?4,0,?5,?6,?7,?8,?8,?9)",params![pitch_id,aid,scope,serde_json::to_string(patterns).unwrap(),provider,source,confidence,timestamp,self.device_id]).map_err(|e|e.to_string())?;
            journal(&tx, &pitch_id, "pitch_pattern", &self.device_id, 1, "insert", &serde_json::json!({"analysis_id":aid,"scope":scope,"provider":provider,"source":source,"confidence":confidence}))?;
        }
        let old_audio: Vec<(String, i64)> = {
            let mut stmt = tx.prepare("SELECT id,revision FROM audio_assets WHERE entry_id=?1").map_err(|e| e.to_string())?;
            stmt.query_map([entry_id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        tx.execute("DELETE FROM audio_assets WHERE entry_id=?1",[entry_id]).map_err(|e|e.to_string())?;
        for (id, revision) in old_audio { journal(&tx, &id, "audio_asset", &self.device_id, revision + 1, "delete", &serde_json::json!({"entry_id":entry_id}))?; }
        tx.execute("DELETE FROM audio_playback_state WHERE entry_id=?1",[entry_id]).map_err(|e|e.to_string())?;
        for asset in audio {
            let audio_id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO audio_assets(id,entry_id,cache_key,path,provider,voice_profile,age_band,gender_presentation,speaker_id,speaker_name,accent_type,created_at,updated_at,device_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?13)",
                params![audio_id,entry_id,asset.cache_key,asset.path,asset.provider,asset.voice_profile,asset.age_band,asset.gender_presentation,asset.speaker_id,asset.speaker_name,asset.accent_type.map(|v|v as i64),timestamp,self.device_id],
            ).map_err(|e|e.to_string())?;
            journal(&tx, &audio_id, "audio_asset", &self.device_id, 1, "insert", &serde_json::json!({"entry_id":entry_id,"cache_key":asset.cache_key,"provider":asset.provider,"voice_profile":asset.voice_profile}))?;
        }
        tx.execute("UPDATE enrichment_jobs SET status='done',updated_at=?1,last_error=NULL WHERE entry_id=?2",params![timestamp,entry_id]).map_err(|e|e.to_string())?;
        let entry_revision: i64 = tx.query_row("SELECT revision FROM entries WHERE id=?1", [entry_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        let analysis_revision: i64 = tx.query_row("SELECT revision FROM japanese_analyses WHERE id=?1", [&aid], |row| row.get(0)).map_err(|e| e.to_string())?;
        journal(&tx, entry_id, "entry", &self.device_id, entry_revision, "update", &serde_json::json!({"reading":reading}))?;
        journal(&tx, &aid, "japanese_analysis", &self.device_id, analysis_revision, if analysis_existed { "update" } else { "insert" }, &serde_json::json!({"entry_id":entry_id,"provider":provider,"source":source,"confidence":confidence,"model_version":model_version}))?;
        tx.commit().map_err(|e|e.to_string())
    }

    pub fn queued_enrichment(&self, limit:usize)->Result<Vec<EntryRecord>,String>{
        let conn=self.conn()?; let mut stmt=conn.prepare("SELECT e.id,e.term,e.meanings,e.reading FROM enrichment_jobs j JOIN entries e ON e.id=j.entry_id WHERE j.status IN ('queued','failed') AND j.attempts<3 ORDER BY e.position LIMIT ?1").map_err(|e|e.to_string())?;
        let rows=stmt.query_map([limit as i64],|r|{let m:String=r.get(2)?;Ok(EntryRecord{id:r.get(0)?,term:r.get(1)?,meanings:serde_json::from_str(&m).unwrap_or_default(),reading:r.get(3)?})}).map_err(|e|e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
    }

    pub fn fail_enrichment(&self,entry_id:&str,error:&str)->Result<(),String>{let conn=self.conn()?;conn.execute("UPDATE enrichment_jobs SET status='failed',attempts=attempts+1,last_error=?1,updated_at=?2 WHERE entry_id=?3",params![error,now(),entry_id]).map_err(|e|e.to_string())?;Ok(())}

    pub fn typing_profile(&self, deck_id: &str, input_language: &str, mode: StudyMode) -> Result<TypingProfileState, String> {
        let conn = self.conn()?;
        let raw: Option<String> = conn.query_row(
            "SELECT completion_distribution FROM typing_profiles WHERE deck_id=?1 AND input_language=?2 AND study_mode=?3 AND input_method='default'",
            params![deck_id, input_language, mode.as_str()], |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?;
        Ok(raw.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default())
    }

    pub fn update_typing_profile(&self, deck_id: &str, input_language: &str, mode: StudyMode, profile: &TypingProfileState) -> Result<(), String> {
        let conn = self.conn()?;
        let timestamp = now();
        let median = profile.median_gap();
        let p90 = profile.p90_gap();
        let p95 = profile.p95_gap();
        let chars_per_second = profile.median_chars_per_second();
        let ime_latency = if profile.ime_conversion_latencies_ms.is_empty() { None } else { Some(profile.ime_conversion_latencies_ms.iter().sum::<f64>() / profile.ime_conversion_latencies_ms.len() as f64) };
        conn.execute(
            "INSERT INTO typing_profiles(id,deck_id,input_language,study_mode,input_method,sample_count,median_interkey_gap,p90_interkey_gap,p95_interkey_gap,chars_per_second,ime_conversion_latency,completion_distribution,updated_at) VALUES(?1,?2,?3,?4,'default',?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(deck_id,input_language,study_mode,input_method) DO UPDATE SET sample_count=excluded.sample_count,median_interkey_gap=excluded.median_interkey_gap,p90_interkey_gap=excluded.p90_interkey_gap,p95_interkey_gap=excluded.p95_interkey_gap,chars_per_second=excluded.chars_per_second,ime_conversion_latency=excluded.ime_conversion_latency,completion_distribution=excluded.completion_distribution,updated_at=excluded.updated_at",
            params![Uuid::new_v4().to_string(), deck_id, input_language, mode.as_str(), profile.sample_count as i64, median, p90, p95, chars_per_second, ime_latency, serde_json::to_string(profile).map_err(|e|e.to_string())?, timestamp],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn export_deck(&self, deck_id: &str) -> Result<String, String> {
        self.deck(deck_id)?;
        let conn = self.conn()?;
        let queries = [
            ("decks", "SELECT * FROM decks WHERE id=?1"),
            ("entries", "SELECT * FROM entries WHERE deck_id=?1 ORDER BY position"),
            ("entry_aliases", "SELECT a.* FROM entry_aliases a JOIN entries e ON e.id=a.entry_id WHERE e.deck_id=?1"),
            ("japanese_analyses", "SELECT a.* FROM japanese_analyses a JOIN entries e ON e.id=a.entry_id WHERE e.deck_id=?1"),
            ("pitch_patterns", "SELECT p.* FROM pitch_patterns p JOIN japanese_analyses a ON a.id=p.analysis_id JOIN entries e ON e.id=a.entry_id WHERE e.deck_id=?1"),
            ("audio_assets", "SELECT a.* FROM audio_assets a JOIN entries e ON e.id=a.entry_id WHERE e.deck_id=?1"),
            ("audio_playback_state", "SELECT a.* FROM audio_playback_state a JOIN entries e ON e.id=a.entry_id WHERE e.deck_id=?1"),
            ("stage_states", "SELECT * FROM stage_states WHERE deck_id=?1"),
            ("stage_completions", "SELECT * FROM stage_completions WHERE deck_id=?1"),
            ("attempts", "SELECT * FROM attempts WHERE deck_id=?1 ORDER BY timestamp"),
            ("typing_profiles", "SELECT * FROM typing_profiles WHERE deck_id=?1"),
            ("grading_decisions", "SELECT g.* FROM grading_decisions g JOIN entries e ON e.id=g.entry_id WHERE e.deck_id=?1"),
            ("enrichment_jobs", "SELECT j.* FROM enrichment_jobs j JOIN entries e ON e.id=j.entry_id WHERE e.deck_id=?1"),
            ("sync_journal", "SELECT j.* FROM sync_journal j WHERE j.entity_id=?1 OR j.entity_id IN (SELECT id FROM entries WHERE deck_id=?1) OR j.entity_id IN (SELECT id FROM entry_aliases WHERE entry_id IN (SELECT id FROM entries WHERE deck_id=?1)) OR j.entity_id IN (SELECT id FROM japanese_analyses WHERE entry_id IN (SELECT id FROM entries WHERE deck_id=?1)) OR j.entity_id IN (SELECT id FROM pitch_patterns WHERE analysis_id IN (SELECT id FROM japanese_analyses WHERE entry_id IN (SELECT id FROM entries WHERE deck_id=?1))) OR j.entity_id IN (SELECT id FROM audio_assets WHERE entry_id IN (SELECT id FROM entries WHERE deck_id=?1)) OR j.entity_id IN (SELECT id FROM attempts WHERE deck_id=?1) ORDER BY j.timestamp"),
        ];
        let mut tables = Map::new();
        for (name, sql) in queries { tables.insert(name.into(), Value::Array(query_json(&conn, sql, [deck_id])?)); }
        serde_json::to_string_pretty(&serde_json::json!({
            "format": "tanren-portable-deck",
            "version": 1,
            "exported_at": now(),
            "tables": tables,
        })).map_err(|e| e.to_string())
    }

    pub fn import_deck_export(&self, payload: &str) -> Result<String, String> {
        let root: Value = serde_json::from_str(payload.trim_start_matches('\u{feff}')).map_err(|e| format!("invalid TANREN JSON: {e}"))?;
        if root.get("format").and_then(Value::as_str) != Some("tanren-portable-deck") || root.get("version").and_then(Value::as_i64) != Some(1) {
            return Err("unsupported TANREN export format/version".into());
        }
        let tables = root.get("tables").and_then(Value::as_object).ok_or("export is missing tables")?;
        let deck_rows = tables.get("decks").and_then(Value::as_array).ok_or("export is missing deck")?;
        if deck_rows.len() != 1 { return Err("a portable deck export must contain exactly one deck".into()); }
        let deck_id = deck_rows[0].get("id").and_then(Value::as_str).ok_or("export deck id is missing")?.to_string();
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM decks WHERE id=?1)", [&deck_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        if exists { return Err("this deck already exists; restore into a fresh TANREN database or delete the existing database first".into()); }
        let order = ["decks", "entries", "entry_aliases", "japanese_analyses", "pitch_patterns", "audio_assets", "audio_playback_state", "stage_states", "stage_completions", "attempts", "typing_profiles", "grading_decisions", "enrichment_jobs", "sync_journal"];
        for table in order {
            if let Some(rows) = tables.get(table).and_then(Value::as_array) {
                for row in rows { insert_json_row(&tx, table, row)?; }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(deck_id)
    }

    pub fn export_backup(&self, path: &Path) -> Result<(), String> {
        if path == self.path {
            return Err("현재 TANREN 데이터 파일에는 백업을 덮어쓸 수 없어요.".into());
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if path.exists() {
            fs::remove_file(path).map_err(|e| format!("기존 백업 파일을 덮어쓸 수 없어요: {e}"))?;
        }
        let source = self.conn()?;
        let mut destination = Connection::open(path).map_err(|e| e.to_string())?;
        let backup = rusqlite::backup::Backup::new(&source, &mut destination).map_err(|e| e.to_string())?;
        backup.run_to_completion(128, Duration::from_millis(5), None).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn import_backup(&self, path: &Path) -> Result<(), String> {
        if path == self.path {
            return Err("현재 TANREN 데이터 파일은 백업으로 가져올 수 없어요.".into());
        }
        if !path.is_file() {
            return Err("백업 파일을 찾을 수 없어요.".into());
        }
        let source = Connection::open(path).map_err(|e| format!("백업 파일을 열 수 없어요: {e}"))?;
        let valid: bool = source.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations') AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='decks')",
            [],
            |row| row.get(0),
        ).map_err(|e| format!("TANREN 백업 파일이 아니에요: {e}"))?;
        if !valid {
            return Err("TANREN 백업 파일이 아니에요.".into());
        }
        let integrity: String = source.query_row("PRAGMA quick_check", [], |row| row.get(0)).map_err(|e| e.to_string())?;
        if integrity != "ok" {
            return Err("백업 파일이 손상되어 있어요.".into());
        }
        {
            let mut destination = self.conn()?;
            let backup = rusqlite::backup::Backup::new(&source, &mut destination).map_err(|e| e.to_string())?;
            backup.run_to_completion(128, Duration::from_millis(5), None).map_err(|e| e.to_string())?;
        }
        self.migrate()?;
        self.set_setting("device_id", Some(&self.device_id))?;
        Ok(())
    }
}

fn query_json<'a, const N: usize>(conn: &Connection, sql: &str, values: [&'a str; N]) -> Result<Vec<Value>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let columns: Vec<String> = stmt.column_names().iter().map(|name| (*name).to_string()).collect();
    let rows = stmt.query_map(params_from_iter(values), |row| {
        let mut object = Map::new();
        for (index, name) in columns.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(value) => Value::from(value),
                ValueRef::Real(value) => Value::from(value),
                ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
                ValueRef::Blob(_) => return Err(rusqlite::Error::InvalidColumnType(index, name.clone(), rusqlite::types::Type::Blob)),
            };
            object.insert(name.clone(), value);
        }
        Ok(Value::Object(object))
    }).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn insert_json_row(tx: &Transaction<'_>, table: &str, value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or_else(|| format!("{table} row is not an object"))?;
    if object.is_empty() || object.keys().any(|key| !key.chars().all(|ch| ch == '_' || ch.is_ascii_alphanumeric())) {
        return Err(format!("{table} contains invalid columns"));
    }
    let columns: Vec<_> = object.keys().cloned().collect();
    let placeholders = (1..=columns.len()).map(|index| format!("?{index}")).collect::<Vec<_>>().join(",");
    let sql = format!("INSERT INTO {table}({}) VALUES({placeholders})", columns.join(","));
    let values: Result<Vec<SqlValue>, String> = columns.iter().map(|column| json_sql_value(&object[column])).collect();
    tx.execute(&sql, params_from_iter(values?)).map_err(|e| format!("could not restore {table}: {e}"))?;
    Ok(())
}

fn json_sql_value(value: &Value) -> Result<SqlValue, String> {
    match value {
        Value::Null => Ok(SqlValue::Null),
        Value::Bool(value) => Ok(SqlValue::Integer(i64::from(*value))),
        Value::Number(value) if value.is_i64() => Ok(SqlValue::Integer(value.as_i64().unwrap())),
        Value::Number(value) if value.is_u64() => i64::try_from(value.as_u64().unwrap()).map(SqlValue::Integer).map_err(|_| "integer is too large".into()),
        Value::Number(value) => value.as_f64().map(SqlValue::Real).ok_or_else(|| "invalid number".into()),
        Value::String(value) => Ok(SqlValue::Text(value.clone())),
        _ => Err("nested JSON values are not valid database columns".into()),
    }
}

fn journal(tx:&Transaction<'_>, entity_id:&str, entity_type:&str, device_id:&str, revision:i64, operation:&str, payload:&serde_json::Value)->Result<(),String>{
    tx.execute("INSERT INTO sync_journal(op_id,entity_id,entity_type,device_id,revision,operation,payload,timestamp) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![Uuid::new_v4().to_string(),entity_id,entity_type,device_id,revision,operation,payload.to_string(),now()]).map_err(|e|e.to_string())?; Ok(())
}
fn ratio(n:usize,d:usize)->Option<f64>{if d==0{None}else{Some(n as f64/d as f64)}}
fn now()->String{Utc::now().to_rfc3339()}

#[cfg(test)]
mod tests{
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn migration_and_roundtrip_are_durable(){
        let dir=tempdir().unwrap(); let path=dir.path().join("tanren.db");
        let db=Database::open(&path).unwrap(); let deck=db.create_deck("日本語","ko-KR","ja-JP").unwrap();
        db.import_entries(&deck.id,"ja-JP",&[EntryDraft{term:"見据える".into(),meanings:vec!["내다보다".into()],reading:Some("みすえる".into())}]).unwrap();
        drop(db);
        let reopened=Database::open(&path).unwrap(); assert_eq!(reopened.entries(&deck.id).unwrap().len(),1); assert_eq!(reopened.list_decks().unwrap()[0].entry_count,1);
    }

    #[test]
    fn imports_append_after_existing_cards_and_skip_exact_duplicates() {
        let dir = tempdir().unwrap();
        let db = Database::open(dir.path().join("tanren.db")).unwrap();
        let deck = db.create_deck("append", "ko-KR", "ja-JP").unwrap();
        let first = EntryDraft { term: "先".into(), meanings: vec!["앞".into()], reading: Some("さき".into()) };
        let second = EntryDraft { term: "後".into(), meanings: vec!["뒤".into()], reading: Some("あと".into()) };
        assert_eq!(db.import_entries(&deck.id, "ja-JP", &[first.clone()]).unwrap(), ImportResult { inserted: 1, duplicates: 0 });
        assert_eq!(db.import_entries(&deck.id, "ja-JP", &[first, second]).unwrap(), ImportResult { inserted: 1, duplicates: 1 });
        assert_eq!(db.entries(&deck.id).unwrap().into_iter().map(|entry| entry.term).collect::<Vec<_>>(), vec!["先", "後"]);
    }

    #[test]
    fn library_stats_aggregate_every_deck_and_keep_inactive_decks_visible() {
        let dir = tempdir().unwrap();
        let db = Database::open(dir.path().join("tanren.db")).unwrap();
        let reading_deck = db.create_deck("Reading", "ko-KR", "ja-JP").unwrap();
        let listening_deck = db.create_deck("Listening", "ko-KR", "ja-JP").unwrap();
        db.create_deck("Not started", "ko-KR", "ja-JP").unwrap();
        let draft = EntryDraft { term: "猫".into(), meanings: vec!["고양이".into()], reading: Some("ねこ".into()) };
        db.import_entries(&reading_deck.id, "ja-JP", &[draft.clone()]).unwrap();
        db.import_entries(&listening_deck.id, "ja-JP", &[draft]).unwrap();
        let reading_entry = db.entries(&reading_deck.id).unwrap().remove(0);
        let listening_entry = db.entries(&listening_deck.id).unwrap().remove(0);
        db.insert_attempt(&reading_entry.id, &reading_deck.id, StudyMode::Reading, 1, "0~1", "고양이", true, Some(true), true, "exact", None, 400, 100, None).unwrap();
        db.insert_attempt(&listening_entry.id, &listening_deck.id, StudyMode::Listening, 1, "0~1", "猫", false, Some(false), false, "exact", None, 800, 100, None).unwrap();
        db.record_study_activity(&reading_deck.id, Some(StudyMode::Reading), 2_500).unwrap();
        db.record_study_activity(&listening_deck.id, Some(StudyMode::Listening), 3_500).unwrap();
        db.record_study_activity(&reading_deck.id, None, 500).unwrap();

        let stats = db.library_stats().unwrap();
        assert_eq!(stats.deck_count, 3);
        assert_eq!(stats.active_deck_count, 2);
        assert_eq!(stats.entry_count, 2);
        assert_eq!(stats.seen_entry_count, 2);
        assert_eq!(stats.attempts, 2);
        assert_eq!(stats.base_accuracy, Some(0.5));
        assert_eq!(stats.pitch_accuracy, Some(0.5));
        assert_eq!(stats.joint_accuracy, Some(0.5));
        assert_eq!(stats.median_recall_latency_ms, Some(800));
        assert_eq!(stats.study_time_ms, 6_500);
        assert_eq!(stats.history.last().map(|point| point.attempts), Some(2));
        assert_eq!(stats.history.last().map(|point| point.seen_entry_count), Some(2));
        assert_eq!(stats.history.last().map(|point| point.study_time_ms), Some(6_500));
        let latest_history = stats.history.last().unwrap();
        assert_eq!(latest_history.modes.get(&StudyMode::Reading).map(|point| (point.attempts, point.seen_entry_count, point.base_accuracy)), Some((1, 1, Some(1.0))));
        assert_eq!(latest_history.modes.get(&StudyMode::Listening).map(|point| (point.attempts, point.seen_entry_count, point.base_accuracy)), Some((1, 1, Some(0.0))));
        assert_eq!(latest_history.modes.get(&StudyMode::Reading).map(|point| point.study_time_ms), Some(2_500));
        assert_eq!(latest_history.modes.get(&StudyMode::Listening).map(|point| point.study_time_ms), Some(3_500));
        assert_eq!(stats.mode_stats.iter().map(|mode| mode.attempts).collect::<Vec<_>>(), vec![1, 1, 0]);
        assert_eq!(stats.deck_stats.iter().filter(|deck| deck.attempts == 0).count(), 1);
    }

    #[test]
    fn portable_export_roundtrips_deck_entries_aliases_progress_attempts_and_enrichment() {
        let source_dir = tempdir().unwrap();
        let source = Database::open(source_dir.path().join("source.db")).unwrap();
        let deck = source.create_deck("portable", "ko-KR", "ja-JP").unwrap();
        source.import_entries(&deck.id, "ja-JP", &[EntryDraft { term: "猫".into(), meanings: vec!["고양이".into()], reading: Some("ねこ".into()) }]).unwrap();
        let entry = source.entries(&deck.id).unwrap().remove(0);
        source.set_alias(&entry.id, "냥이", true).unwrap();
        source.insert_attempt(&entry.id, &deck.id, StudyMode::Reading, 1, "0~1", "고양이", true, None, true, "exact", None, 500, 200, None).unwrap();
        let session = StudySession::new(deck.id.clone(), 1, &[entry.clone()], &[StudyMode::Reading], 50, 300, 1).unwrap();
        source.save_session(&session).unwrap();
        source.set_entry_analysis(&entry.id, Some("ねこ"), &serde_json::json!({"scope":"lexical","morae":["ね","こ"]}), "fixture", "fixture", "VERIFIED", Some("1"), Some(&[vec![1,0]]), "lexical", &[]).unwrap();

        let payload = source.export_deck(&deck.id).unwrap();
        let exported: Value = serde_json::from_str(&payload).unwrap();
        let journal = exported["tables"]["sync_journal"].as_array().unwrap();
        assert!(journal.iter().any(|row| row["entity_type"] == "attempt"));
        assert!(journal.iter().any(|row| row["entity_type"] == "stage_state"));
        assert!(journal.iter().any(|row| row["entity_type"] == "japanese_analysis"));
        assert!(journal.iter().any(|row| row["entity_type"] == "pitch_pattern"));
        let destination_dir = tempdir().unwrap();
        let destination = Database::open(destination_dir.path().join("destination.db")).unwrap();
        assert_eq!(destination.import_deck_export(&payload).unwrap(), deck.id);
        assert_eq!(destination.entries(&deck.id).unwrap().len(), 1);
        assert_eq!(destination.aliases(&entry.id).unwrap().0, vec!["냥이"]);
        assert!(destination.load_session(&deck.id).unwrap().is_some());
        assert_eq!(destination.stats(&deck.id).unwrap()[0].attempts, 1);
        assert!(destination.pitch_question(&entry.id, false).unwrap().is_some());
    }

    #[test]
    fn full_backup_restores_learning_history_and_statistics() {
        let source_dir = tempdir().unwrap();
        let source = Database::open(source_dir.path().join("source.db")).unwrap();
        let deck = source.create_deck("backup", "ko-KR", "ja-JP").unwrap();
        source.import_entries(&deck.id, "ja-JP", &[EntryDraft {
            term: "猫".into(), meanings: vec!["고양이".into()], reading: Some("ねこ".into()),
        }]).unwrap();
        let entry = source.entries(&deck.id).unwrap().remove(0);
        source.insert_attempt(&entry.id, &deck.id, StudyMode::Reading, 1, "0~1", "고양이", true, Some(true), true, "exact", None, 420, 180, None).unwrap();
        source.record_study_activity(&deck.id, Some(StudyMode::Reading), 7_500).unwrap();
        source.set_setting("audio_volume", Some("0.65")).unwrap();

        let backup_path = source_dir.path().join("all-data.tanren");
        source.export_backup(&backup_path).unwrap();

        let destination_dir = tempdir().unwrap();
        let destination = Database::open(destination_dir.path().join("destination.db")).unwrap();
        destination.import_backup(&backup_path).unwrap();
        let stats = destination.library_stats().unwrap();
        assert_eq!(stats.deck_count, 1);
        assert_eq!(stats.attempts, 1);
        assert_eq!(stats.seen_entry_count, 1);
        assert_eq!(stats.study_time_ms, 7_500);
        assert_eq!(stats.base_accuracy, Some(1.0));
        assert_eq!(stats.pitch_accuracy, Some(1.0));
        assert_eq!(destination.setting("audio_volume").unwrap().as_deref(), Some("0.65"));
    }

    #[test]
    fn recall_timeout_and_adaptive_timer_are_loaded_per_mode() {
        let dir = tempdir().unwrap();
        let db = Database::open(dir.path().join("tanren.db")).unwrap();
        let deck = db.create_deck("timers", "ko-KR", "ja-JP").unwrap();
        db.conn().unwrap().execute(
            "UPDATE decks SET recall_timeout_by_mode=?1, adaptive_completion_timer_enabled=0 WHERE id=?2",
            params![r#"{"reading":2100,"listening":3200,"writing":4300}"#, deck.id],
        ).unwrap();
        let loaded = db.deck(&deck.id).unwrap();
        assert_eq!(loaded.recall_timeout_by_mode.for_mode(StudyMode::Reading), 2_100);
        assert_eq!(loaded.recall_timeout_by_mode.for_mode(StudyMode::Listening), 3_200);
        assert_eq!(loaded.recall_timeout_by_mode.for_mode(StudyMode::Writing), 4_300);
        assert!(!loaded.adaptive_completion_timer_enabled);
    }

    #[test]
    fn pitch_questions_use_mora_contours_and_confidence_gate_policy() {
        let dir = tempdir().unwrap();
        let db = Database::open(dir.path().join("tanren.db")).unwrap();
        let deck = db.create_deck("pitch", "ko-KR", "ja-JP").unwrap();
        db.import_entries(&deck.id, "ja-JP", &[
            EntryDraft { term: "見据える".into(), meanings: vec!["내다보다".into()], reading: Some("みすえる".into()) },
            EntryDraft { term: "予測".into(), meanings: vec!["예측".into()], reading: Some("よそく".into()) },
            EntryDraft { term: "東京 大学".into(), meanings: vec!["도쿄 대학".into()], reading: Some("とうきょうだいがく".into()) },
            EntryDraft { term: "不明".into(), meanings: vec!["불명".into()], reading: Some("ふめい".into()) },
        ]).unwrap();
        let entries = db.entries(&deck.id).unwrap();
        let lexical = serde_json::json!({"scope":"lexical","morae":["み","す","え","る"]});
        db.set_entry_analysis(
            &entries[0].id, Some("みすえる"), &lexical, "fixture", "verified fixture", "CONSENSUS", None,
            Some(&[vec![0,1,1,0], vec![0,1,1,1]]), "lexical", &[],
        ).unwrap();
        let question = db.pitch_question(&entries[0].id, false).unwrap().unwrap();
        assert!(question.gate_enabled);
        assert_eq!(question.allowed_patterns, vec![vec![0,1,1,0], vec![0,1,1,1]]);

        let predicted = serde_json::json!({"scope":"lexical","morae":["よ","そ","く"]});
        db.set_entry_analysis(
            &entries[1].id, Some("よそく"), &predicted, "fixture", "prediction fixture", "PREDICTED", None,
            Some(&[vec![0,1,0]]), "lexical", &[],
        ).unwrap();
        assert!(!db.pitch_question(&entries[1].id, false).unwrap().unwrap().gate_enabled);
        assert!(db.pitch_question(&entries[1].id, true).unwrap().unwrap().gate_enabled);

        let phrase = serde_json::json!({"scope":"phrase","morae":["と","う","きょ","う","だ","い","が","く"]});
        db.set_entry_analysis(
            &entries[2].id, Some("とうきょうだいがく"), &phrase, "fixture", "phrase prediction", "PREDICTED", None,
            Some(&[vec![0,1,1,1,1,1,1,0]]), "phrase", &[],
        ).unwrap();
        assert!(db.pitch_question(&entries[2].id, true).unwrap().is_none());

        let unavailable = serde_json::json!({"scope":"lexical","morae":["ふ","め","い"]});
        db.set_entry_analysis(
            &entries[3].id, Some("ふめい"), &unavailable, "fixture", "unavailable", "PREDICTED", None,
            None, "lexical", &[],
        ).unwrap();
        assert!(db.pitch_question(&entries[3].id, false).unwrap().is_none());
    }

    #[test]
    fn legacy_numeric_pitch_rows_are_not_exposed_as_contours() {
        let dir = tempdir().unwrap();
        let db = Database::open(dir.path().join("tanren.db")).unwrap();
        let deck = db.create_deck("legacy", "ko-KR", "ja-JP").unwrap();
        db.import_entries(&deck.id, "ja-JP", &[EntryDraft {
            term: "見据える".into(), meanings: vec!["내다보다".into()], reading: Some("みすえる".into()),
        }]).unwrap();
        let entry = db.entries(&deck.id).unwrap().remove(0);
        let analysis = serde_json::json!({"scope":"lexical","morae":["み","す","え","る"]});
        db.set_entry_analysis(
            &entry.id, Some("みすえる"), &analysis, "fixture", "legacy fixture", "VERIFIED", None,
            Some(&[vec![3]]), "lexical", &[],
        ).unwrap();
        assert!(db.pitch_question(&entry.id, false).unwrap().is_none());
    }

    #[test]
    fn audio_assets_rotate_deterministically_across_voice_profiles() {
        let dir = tempdir().unwrap();
        let db = Database::open(dir.path().join("tanren.db")).unwrap();
        let deck = db.create_deck("audio", "ko-KR", "ja-JP").unwrap();
        db.import_entries(&deck.id, "ja-JP", &[EntryDraft {
            term: "社会".into(), meanings: vec!["사회".into()], reading: Some("しゃかい".into()),
        }]).unwrap();
        let entry = db.entries(&deck.id).unwrap().remove(0);
        let analysis = serde_json::json!({"scope":"lexical","morae":["しゃ","か","い"]});
        let assets = [
            AudioAssetDraft { cache_key:"v1".into(), path:"child.wav".into(), provider:"voicevox".into(), voice_profile:"child_feminine".into(), age_band:"child".into(), gender_presentation:"feminine".into(), speaker_id:Some(1), speaker_name:Some("春歌ナナ".into()), accent_type:Some(1) },
            AudioAssetDraft { cache_key:"v2".into(), path:"adolescent.wav".into(), provider:"voicevox".into(), voice_profile:"adolescent_masculine".into(), age_band:"adolescent".into(), gender_presentation:"masculine".into(), speaker_id:Some(2), speaker_name:Some("白上虎太郎".into()), accent_type:Some(1) },
            AudioAssetDraft { cache_key:"v3".into(), path:"young-adult.wav".into(), provider:"voicevox".into(), voice_profile:"young_adult_feminine".into(), age_band:"young_adult".into(), gender_presentation:"feminine".into(), speaker_id:Some(3), speaker_name:Some("No.7".into()), accent_type:Some(1) },
            AudioAssetDraft { cache_key:"v4".into(), path:"middle-aged.wav".into(), provider:"voicevox".into(), voice_profile:"middle_aged_masculine".into(), age_band:"middle_aged".into(), gender_presentation:"masculine".into(), speaker_id:Some(4), speaker_name:Some("麒ヶ島宗麟".into()), accent_type:Some(1) },
            AudioAssetDraft { cache_key:"v5".into(), path:"senior.wav".into(), provider:"voicevox".into(), voice_profile:"senior_masculine".into(), age_band:"senior".into(), gender_presentation:"masculine".into(), speaker_id:Some(5), speaker_name:Some("ちび式じい".into()), accent_type:Some(1) },
        ];
        db.set_entry_analysis(&entry.id, Some("しゃかい"), &analysis, "fixture", "fixture", "CONSENSUS", None, Some(&[vec![1,0,0]]), "lexical", &assets).unwrap();
        let sequence = (0..6).map(|_| db.next_audio_path(&entry.id).unwrap().unwrap()).collect::<Vec<_>>();
        assert_eq!(sequence, vec!["child.wav", "adolescent.wav", "young-adult.wav", "middle-aged.wav", "senior.wav", "child.wav"]);
    }
}
