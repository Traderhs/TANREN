use std::{fs, path::{Path, PathBuf}};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use uuid::Uuid;

use crate::{
    model::{DeckRecord, DeckStats, DeckSummary, EntryDraft, EntryRecord, PitchConfidence, PitchQuestion, StudyMode},
    study::StudySession,
    timers::TypingProfileState,
};

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
        let db = Self { path, device_id: device_id() };
        db.migrate()?;
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
              recall_timeout_by_mode TEXT NOT NULL DEFAULT '{"recognition":3000,"listening":3000,"production":3000}',
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

            CREATE TABLE IF NOT EXISTS stage_states (
              deck_id TEXT PRIMARY KEY REFERENCES decks(id),
              round INTEGER NOT NULL,
              stage_index INTEGER NOT NULL,
              stage_label TEXT NOT NULL,
              state_json TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              device_id TEXT NOT NULL
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
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn create_deck(&self, name: &str, source_language: &str, target_language: &str) -> Result<DeckSummary, String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let modes = serde_json::to_string(&vec![StudyMode::Recognition, StudyMode::Listening, StudyMode::Production]).unwrap();
        let timestamp = now();
        tx.execute(
            "INSERT INTO decks(id,name,source_language,target_language,enabled_modes,created_at,updated_at,device_id) VALUES(?1,?2,?3,?4,?5,?6,?6,?7)",
            params![id, name, source_language, target_language, modes, timestamp, self.device_id],
        ).map_err(|e| e.to_string())?;
        journal(&tx, &id, "deck", &self.device_id, 1, "insert", &serde_json::json!({"name":name}))?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(DeckSummary { id, name: name.into(), source_language: source_language.into(), target_language: target_language.into(), enabled_modes: vec![StudyMode::Recognition,StudyMode::Listening,StudyMode::Production], entry_count: 0, current_round: 1, active_stage: None })
    }

    pub fn list_decks(&self) -> Result<Vec<DeckSummary>, String> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            r#"SELECT d.id,d.name,d.source_language,d.target_language,d.enabled_modes,d.current_round,
               COUNT(e.id),s.stage_label
               FROM decks d LEFT JOIN entries e ON e.deck_id=d.id AND e.deleted_at IS NULL
               LEFT JOIN stage_states s ON s.deck_id=d.id
               WHERE d.deleted_at IS NULL GROUP BY d.id ORDER BY d.created_at"#,
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            let modes: String = row.get(4)?;
            Ok(DeckSummary {
                id: row.get(0)?, name: row.get(1)?, source_language: row.get(2)?, target_language: row.get(3)?,
                enabled_modes: serde_json::from_str(&modes).unwrap_or_default(), current_round: row.get::<_, i64>(5)? as u32,
                entry_count: row.get::<_, i64>(6)? as usize, active_stage: row.get(7)?,
            })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())
    }

    pub fn deck(&self, id: &str) -> Result<DeckRecord, String> {
        let conn = self.conn()?;
        conn.query_row(
            "SELECT id,name,source_language,target_language,enabled_modes,increment_size,checkpoint_size,recall_timeout_by_mode,pitch_policy,strict_orthography,current_round FROM decks WHERE id=?1 AND deleted_at IS NULL",
            [id], |row| {
                let modes: String = row.get(4)?;
                let timeouts: String = row.get(7)?;
                let timeout_json: serde_json::Value = serde_json::from_str(&timeouts).unwrap_or_default();
                Ok(DeckRecord {
                    id: row.get(0)?, name: row.get(1)?, source_language: row.get(2)?, target_language: row.get(3)?,
                    enabled_modes: serde_json::from_str(&modes).unwrap_or_default(), increment_size: row.get::<_,i64>(5)? as usize,
                    checkpoint_size: row.get::<_,i64>(6)? as usize, recall_timeout_ms: timeout_json.get("recognition").and_then(|v| v.as_u64()).unwrap_or(3000),
                    pitch_policy: row.get(8)?, strict_orthography: row.get::<_,i64>(9)? != 0, current_round: row.get::<_,i64>(10)? as u32,
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

    pub fn import_entries(&self, deck_id: &str, target_language: &str, drafts: &[EntryDraft]) -> Result<usize, String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut next_pos: i64 = tx.query_row("SELECT COALESCE(MAX(position)+1,0) FROM entries WHERE deck_id=?1", [deck_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        let timestamp = now();
        let mut inserted = 0;
        for draft in drafts.iter().filter(|d| !d.term.trim().is_empty() && !d.meanings.is_empty()) {
            let id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO entries(id,deck_id,position,term,meanings,reading,language,created_at,updated_at,device_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8,?9)",
                params![id, deck_id, next_pos, draft.term.trim(), serde_json::to_string(&draft.meanings).unwrap(), draft.reading, target_language, timestamp, self.device_id],
            ).map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO enrichment_jobs(id,entry_id,status,updated_at) VALUES(?1,?2,'queued',?3)", params![Uuid::new_v4().to_string(),id,timestamp]).map_err(|e| e.to_string())?;
            journal(&tx, &id, "entry", &self.device_id, 1, "insert", &serde_json::json!({"deck_id":deck_id,"term":draft.term,"meanings":draft.meanings}))?;
            next_pos += 1;
            inserted += 1;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(inserted)
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
            tx.execute("UPDATE entry_aliases SET status=?1,updated_at=?2,revision=revision+1 WHERE id=?3", params![status,timestamp,id]).map_err(|e|e.to_string())?;
            journal(&tx,&id,"entry_alias",&self.device_id,2,"update",&serde_json::json!({"status":status}))?;
        } else {
            let id=Uuid::new_v4().to_string();
            tx.execute("INSERT INTO entry_aliases(id,entry_id,answer,status,created_at,updated_at,device_id) VALUES(?1,?2,?3,?4,?5,?5,?6)",params![id,entry_id,answer,status,timestamp,self.device_id]).map_err(|e|e.to_string())?;
            journal(&tx,&id,"entry_alias",&self.device_id,1,"insert",&serde_json::json!({"entry_id":entry_id,"answer":answer,"status":status}))?;
        }
        tx.commit().map_err(|e|e.to_string())
    }

    pub fn save_session(&self, session: &StudySession) -> Result<(), String> {
        let conn = self.conn()?;
        let timestamp = now();
        conn.execute(
            "INSERT INTO stage_states(deck_id,round,stage_index,stage_label,state_json,updated_at,device_id) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(deck_id) DO UPDATE SET round=excluded.round,stage_index=excluded.stage_index,stage_label=excluded.stage_label,state_json=excluded.state_json,updated_at=excluded.updated_at,device_id=excluded.device_id",
            params![session.deck_id,session.round,session.stage_index as i64,session.stage().label(),serde_json::to_string(session).map_err(|e|e.to_string())?,timestamp,self.device_id],
        ).map_err(|e|e.to_string())?;
        Ok(())
    }

    pub fn load_session(&self, deck_id: &str) -> Result<Option<StudySession>, String> {
        let conn = self.conn()?;
        let state: Option<String> = conn.query_row("SELECT state_json FROM stage_states WHERE deck_id=?1",[deck_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        state.map(|s|serde_json::from_str(&s).map_err(|e|e.to_string())).transpose()
    }

    pub fn clear_session_and_advance_round(&self, deck_id: &str) -> Result<(), String> {
        let mut conn=self.conn()?; let tx=conn.transaction().map_err(|e|e.to_string())?;
        tx.execute("DELETE FROM stage_states WHERE deck_id=?1",[deck_id]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE decks SET current_round=current_round+1,updated_at=?1,revision=revision+1 WHERE id=?2",params![now(),deck_id]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert_attempt(&self, entry_id:&str, deck_id:&str, variant:StudyMode, round:u32, stage:&str, answer:&str, base_correct:bool, pitch_correct:Option<bool>, joint_correct:bool, grading_method:&str, semantic_score:Option<f64>, recall_latency_ms:u64, typing_duration_ms:u64, failure_type:Option<&str>) -> Result<(),String> {
        let conn=self.conn()?;
        conn.execute(
            "INSERT INTO attempts(id,entry_id,deck_id,variant,round,stage,answer_text,base_correct,pitch_correct,joint_correct,grading_method,semantic_score,recall_latency_ms,typing_duration_ms,total_duration_ms,failure_type,timestamp,device_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
            params![Uuid::new_v4().to_string(),entry_id,deck_id,variant.as_str(),round,stage,answer,base_correct,pitch_correct,joint_correct,grading_method,semantic_score,recall_latency_ms,typing_duration_ms,recall_latency_ms+typing_duration_ms,failure_type,now(),self.device_id],
        ).map_err(|e|e.to_string())?;
        Ok(())
    }

    pub fn update_attempt_pitch(&self, deck_id:&str, entry_id:&str, variant:StudyMode, correct:bool, joint_correct:bool, failure_type:Option<&str>) -> Result<(),String> {
        let conn=self.conn()?;
        let id:Option<String>=conn.query_row("SELECT id FROM attempts WHERE deck_id=?1 AND entry_id=?2 AND variant=?3 ORDER BY timestamp DESC LIMIT 1",params![deck_id,entry_id,variant.as_str()],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(id)=id { conn.execute("UPDATE attempts SET pitch_correct=?1,joint_correct=?2,failure_type=COALESCE(?3,failure_type) WHERE id=?4",params![correct,joint_correct,failure_type,id]).map_err(|e|e.to_string())?; }
        Ok(())
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
        let morae=analysis.get("morae").and_then(|v|v.as_array()).map(|a|a.iter().filter_map(|v|v.as_str().map(String::from)).collect()).unwrap_or_default();
        let kind=analysis.get("scope").and_then(|v|v.as_str()).unwrap_or("lexical").to_string();
        let phrase_count=if kind=="lexical"{1}else{patterns.first().map(|p|p.len()).unwrap_or(1)};
        Ok(Some(PitchQuestion{kind,reading,morae,phrase_count,allowed_patterns:patterns,confidence,gate_enabled:gate}))
    }

    pub fn audio_path(&self, entry_id:&str)->Result<Option<String>,String>{
        let conn=self.conn()?;
        conn.query_row("SELECT path FROM audio_assets WHERE entry_id=?1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",[entry_id],|r|r.get(0)).optional().map_err(|e|e.to_string())
    }

    pub fn stats(&self, deck_id:&str)->Result<Vec<DeckStats>,String>{
        let conn=self.conn()?;
        let mut output=Vec::new();
        for mode in [StudyMode::Recognition,StudyMode::Listening,StudyMode::Production]{
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

    pub fn set_entry_analysis(&self, entry_id:&str, reading:Option<&str>, analysis_json:&serde_json::Value, provider:&str, source:&str, confidence:&str, model_version:Option<&str>, pitch_patterns:Option<&[Vec<u8>]>, scope:&str, audio:Option<(&str,&str)>) -> Result<(),String>{
        let mut conn=self.conn()?; let tx=conn.transaction().map_err(|e|e.to_string())?; let timestamp=now();
        tx.execute("UPDATE entries SET reading=COALESCE(?1,reading),updated_at=?2,revision=revision+1 WHERE id=?3",params![reading,timestamp,entry_id]).map_err(|e|e.to_string())?;
        let analysis_id:Option<String>=tx.query_row("SELECT id FROM japanese_analyses WHERE entry_id=?1",[entry_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let aid=analysis_id.unwrap_or_else(||Uuid::new_v4().to_string());
        tx.execute("INSERT INTO japanese_analyses(id,entry_id,normalized_text,reading,analysis_json,provider,source,confidence,model_version,created_at,updated_at,device_id) SELECT ?1,?2,term,?3,?4,?5,?6,?7,?8,?9,?9,?10 FROM entries WHERE id=?2 ON CONFLICT(entry_id) DO UPDATE SET reading=excluded.reading,analysis_json=excluded.analysis_json,provider=excluded.provider,source=excluded.source,confidence=excluded.confidence,model_version=excluded.model_version,updated_at=excluded.updated_at,revision=japanese_analyses.revision+1",params![aid,entry_id,reading,analysis_json.to_string(),provider,source,confidence,model_version,timestamp,self.device_id]).map_err(|e|e.to_string())?;
        if let Some(patterns)=pitch_patterns {
            tx.execute("DELETE FROM pitch_patterns WHERE analysis_id=?1",[&aid]).map_err(|e|e.to_string())?;
            tx.execute("INSERT INTO pitch_patterns(id,analysis_id,scope,patterns_json,preferred_pattern,provider,source,confidence,created_at,updated_at,device_id) VALUES(?1,?2,?3,?4,0,?5,?6,?7,?8,?8,?9)",params![Uuid::new_v4().to_string(),aid,scope,serde_json::to_string(patterns).unwrap(),provider,source,confidence,timestamp,self.device_id]).map_err(|e|e.to_string())?;
        }
        if let Some((cache_key,path))=audio { tx.execute("INSERT OR REPLACE INTO audio_assets(id,entry_id,cache_key,path,provider,created_at,updated_at,device_id) VALUES(?1,?2,?3,?4,?5,?6,?6,?7)",params![Uuid::new_v4().to_string(),entry_id,cache_key,path,provider,timestamp,self.device_id]).map_err(|e|e.to_string())?; }
        tx.execute("UPDATE enrichment_jobs SET status='done',updated_at=?1,last_error=NULL WHERE entry_id=?2",params![timestamp,entry_id]).map_err(|e|e.to_string())?;
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
        let chars_per_second = None::<f64>;
        let ime_latency = if profile.ime_conversion_latencies_ms.is_empty() { None } else { Some(profile.ime_conversion_latencies_ms.iter().sum::<f64>() / profile.ime_conversion_latencies_ms.len() as f64) };
        conn.execute(
            "INSERT INTO typing_profiles(id,deck_id,input_language,study_mode,input_method,sample_count,median_interkey_gap,p90_interkey_gap,p95_interkey_gap,chars_per_second,ime_conversion_latency,completion_distribution,updated_at) VALUES(?1,?2,?3,?4,'default',?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(deck_id,input_language,study_mode,input_method) DO UPDATE SET sample_count=excluded.sample_count,median_interkey_gap=excluded.median_interkey_gap,p90_interkey_gap=excluded.p90_interkey_gap,p95_interkey_gap=excluded.p95_interkey_gap,chars_per_second=excluded.chars_per_second,ime_conversion_latency=excluded.ime_conversion_latency,completion_distribution=excluded.completion_distribution,updated_at=excluded.updated_at",
            params![Uuid::new_v4().to_string(), deck_id, input_language, mode.as_str(), profile.sample_count as i64, median, p90, p95, chars_per_second, ime_latency, serde_json::to_string(profile).map_err(|e|e.to_string())?, timestamp],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn journal(tx:&Transaction<'_>, entity_id:&str, entity_type:&str, device_id:&str, revision:i64, operation:&str, payload:&serde_json::Value)->Result<(),String>{
    tx.execute("INSERT INTO sync_journal(op_id,entity_id,entity_type,device_id,revision,operation,payload,timestamp) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![Uuid::new_v4().to_string(),entity_id,entity_type,device_id,revision,operation,payload.to_string(),now()]).map_err(|e|e.to_string())?; Ok(())
}
fn ratio(n:usize,d:usize)->Option<f64>{if d==0{None}else{Some(n as f64/d as f64)}}
fn now()->String{Utc::now().to_rfc3339()}
fn device_id()->String{format!("windows:{}",std::env::var("COMPUTERNAME").unwrap_or_else(|_|"local".into()))}

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
}
