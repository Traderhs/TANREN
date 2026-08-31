# TANREN

TANREN은 Windows용 일본어 능동 인출 학습 앱입니다. 덱을 만들고 TSV/CSV를 가져오면 일본어 분석·pitch·audio enrichment를 백그라운드에서 준비하고, Recognition / Listening / Production을 50장 증분과 300장 누적 Stage로 반복합니다.

## Requirements

- Windows 10/11 x64
- Node.js + npm
- Rust stable MSVC toolchain
- Python 3는 sidecar를 **빌드할 때만** 필요합니다. 설치된 앱의 실행에는 Python이나 개발 venv가 필요하지 않습니다.

## Build and run

`Sources`에서 실행합니다.

```powershell
cd D:\Dev\TANREN\Sources
npm ci
npm run sidecar:build
npm run dev
```

Frontend production assets만 빌드하려면 `npm run build`, Rust backend는 `cargo build --manifest-path src-tauri\Cargo.toml`을 사용합니다.

## Test

```powershell
cd D:\Dev\TANREN\Sources
npm test
cargo test --manifest-path src-tauri\Cargo.toml
npm run sidecar:test
```

Windows input-profile smoke test는 실제 키보드 프로필을 잠시 바꾸므로 기본 `cargo test`에서는 ignored입니다. 명시적으로 실행하려면 다음을 사용합니다.

```powershell
cargo test --manifest-path src-tauri\Cargo.toml windows_input_profile_smoke_restores_original_profile -- --ignored
```

## Package

```powershell
cd D:\Dev\TANREN\Sources
npm run package
```

이 명령은 PyInstaller one-file language sidecar를 먼저 만들고 NSIS installer를 생성합니다. 결과는 `Results\cargo-target\release\bundle\nsis`에 있습니다.

## Import, review ranges, and export

- TSV, CSV, pasted text, UTF-8 BOM, LF/CRLF, quoted CSV를 지원합니다.
- 기본 열은 `term, meaning, reading(optional)`이며 여러 뜻은 `/`로 구분합니다.
- malformed 행은 행 번호와 함께 보고되고, 다른 valid 행은 계속 저장됩니다.
- 정확히 같은 항목은 중복 저장하지 않습니다. 신규 항목의 고정 `position`은 항상 기존 항목 뒤에 배정됩니다.
- 덱 카드의 범위 카드는 `0~50 ... 0~300`, `300~350 ... 300~600`, `0~600` 순서로 원하는 Stage를 직접 시작합니다. Resume은 저장된 Stage를 이어갑니다.
- Deck editor의 portable JSON export는 덱 설정, entries, aliases, Stage state, attempts/statistics, typing/grading state, Japanese analysis, pitch/audio metadata와 관련 sync journal을 보존합니다. Restore는 UUID 충돌을 피하기 위해 해당 덱이 없는 새 데이터베이스에서 사용합니다.

## Data locations

- DB: `%APPDATA%\app.tanren.desktop\tanren.db`
- audio cache: `%APPDATA%\app.tanren.desktop\audio`
- 기본 semantic/VOICEVOX runtime: `%APPDATA%\app.tanren.desktop\semantic`
- Settings에서 semantic/VOICEVOX runtime 폴더만 바꿀 수 있습니다. DB와 audio cache는 app-data에 유지됩니다.
- 격리 테스트나 portable 운영이 필요한 경우에만 `TANREN_APP_DATA_HOME` 환경 변수로 DB/audio app-data 루트를 지정할 수 있습니다.

## Architecture

React/Vite frontend가 Tauri commands를 호출하고, Rust backend가 SQLite migration, deterministic StudyCore, grading, persistence와 Windows input profile을 담당합니다. Bundled Python sidecar는 일본어 형태·reading 분석을 수행하며, semantic embedding과 VOICEVOX runtime은 로컬 provider로 동작합니다. Cloud sync/network layer는 구현하지 않았고 모든 sync 대상 mutation을 local journal에 기록합니다.

## Known limitations

- semantic model과 VOICEVOX runtime은 최초 준비 시 다운로드가 필요할 수 있으며, 준비 전에는 deterministic grading 또는 audio 없는 경로로 제한됩니다.
- Listening은 해당 항목의 audio가 아직 준비되지 않으면 시작할 수 없습니다.
- portable restore는 같은 UUID의 덱이 이미 있는 DB에 merge하지 않습니다. 새 설치/새 DB 복구용입니다.
- installer signing과 자동 업데이트는 포함하지 않습니다.
- Windows WebView UI 전체 시나리오는 수동 acceptance가 필요합니다. core/unit 테스트만으로 native UI acceptance를 대체하지 않습니다.
