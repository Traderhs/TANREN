# TANREN — FULL IMPLEMENTATION MASTER PROMPT

## 0. TASK

`TANREN (鍛錬)`이라는 Desktop-first, Local-first 언어 학습 프로그램을 처음부터 실제 동작하는 production-quality V1으로 구현하라.

TANREN의 목적은 Anki/FSRS 계열의 "최소 횟수로 장기 기억 유지"가 아니다.

핵심 철학은 다음과 같다.

> 전체 학습 범위를 반복적으로 확장하면서 이미 맞힌 항목까지 다시 실제 인출시키고,
> Recognition / Listening / Production을 제한시간 내 실제 입력으로 검사하여
> 언어 처리가 자동화될 때까지 반복한다.

이 프로그램은 버튼으로 "알아요"라고 자기평가하는 프로그램이 아니다.

사용자는 실제 답을 타이핑해야 한다.

일본어에서는 단순 의미/표현뿐 아니라 pitch accent/prosody도 학습 성공 조건에 포함할 수 있어야 한다.

절대로 구현을 scaffolding, mock, TODO, stub 수준에서 끝내지 마라.

실제 Desktop 프로그램을 빌드하고,
실제 학습 세션을 end-to-end로 실행하고,
테스트를 통과시키고,
설치/실행 가능한 상태까지 완성하라.


# 1. PRODUCT NAME

Product:
TANREN

Japanese:
鍛錬

Internal project identifier:
tanren


# 2. NON-GOALS

다음 기능은 구현하지 마라.

- FSRS
- SM-2
- 카드별 next_review_at
- 기억 확률 기반 복습
- Again / Hard / Good / Easy
- 일일 복습 부채
- streak 중심 gamification
- 영구 카드 졸업
- 날짜 기반 scheduling

TANREN의 핵심 회독 알고리즘을 SRS 형태로 "개선"하지 마라.


# 3. TARGET PLATFORM / ARCHITECTURE

V1 primary platform:

- Windows Desktop

향후 다음 확장이 가능해야 한다.

- Android
- iOS
- 다른 Desktop OS
- multi-device synchronization

권장 기술 구조:

- Tauri 2
- React + TypeScript UI
- Rust application/core backend
- SQLite local database
- Python sidecar for heavy language/NLP functionality where appropriate

Python sidecar는 다음과 같은 Desktop V1 기능을 담당할 수 있다.

- multilingual embeddings
- cross encoder / semantic verifier
- Japanese morphology
- UniDic
- pyopenjtalk / pyopenjtalk-plus
- Japanese pitch/prosody analysis
- audio generation

단:

StudyCore가 Python implementation detail을 알아서는 안 된다.

Language/NLP functionality는 provider interface 뒤에 숨겨라.

향후 mobile implementation에서는:

- native implementation
- ONNX
- remote enrichment service

등으로 provider만 교체할 수 있어야 한다.

Python sidecar와 Core 사이에는 안정적인 RPC/schema contract를 정의하라.


# 4. HIGH-LEVEL ARCHITECTURE

다음 계층을 분리한다.

TANREN
├── UI
│   ├── Deck List
│   ├── Deck Editor
│   ├── Study
│   └── Statistics
│
├── StudyCore
│   ├── Round
│   ├── Stage
│   ├── Variant generation
│   ├── queue/shuffle
│   ├── pass/fail
│   └── persistence
│
├── TimerCore
│   ├── RecallTimer
│   ├── CompletionTimer
│   └── TypingProfile
│
├── GradingCore
│   ├── ExactGrader
│   ├── SemanticGrader
│   ├── TargetFormGrader
│   └── PitchGrader
│
├── InputCore
│   ├── answer-language routing
│   ├── IME state
│   ├── composition event tracking
│   └── platform keyboard adapter
│
├── LanguagePack
│   ├── GenericLanguagePack
│   └── JapaneseLanguagePack
│
├── JapaneseAnalysis
│   ├── reading
│   ├── morphology
│   ├── lexical pitch
│   ├── phrase/sentence neutral prosody
│   └── audio
│
├── Persistence
│   ├── SQLite
│   ├── repositories
│   └── SyncJournal
│
└── PlatformAdapter
    └── Windows

StudyCore는 다음을 몰라야 한다.

- Japanese
- Korean
- Windows
- Tauri
- embedding model
- OpenJTalk
- IME implementation


# 5. CORE DATA MODEL

## Deck

최소 다음 필드를 가진다.

Deck
- id: UUID
- name
- source_language
- target_language
- enabled_modes
- increment_size
- checkpoint_size
- recall_timeout_by_mode
- adaptive_completion_timer_enabled
- pitch_policy
- strict_orthography
- current_round
- created_at
- updated_at
- revision
- deleted_at

기본값:

increment_size = 50
checkpoint_size = 300


## Entry

한 학습 대상은 DB에 한 번만 저장한다.

Entry
- id: UUID
- deck_id
- term
- meanings
- accepted_answers
- rejected_answers
- reading
- language
- metadata
- created_at
- updated_at
- revision
- deleted_at

단어/문장을 별도의 핵심 Entity type으로 분리하지 마라.

예:

見据える

도 Entry이고,

そんなこと言われても困るんだけど

도 Entry다.

LanguagePack이 text를 분석하여 lexical/phrase/sentence scope를 판단한다.


# 6. STUDY VARIANTS

Entry를 복제 저장하지 않는다.

Study 시 다음 Variant를 동적으로 생성한다.

- Recognition
- Listening
- Production

예:

Entry:
見据える
Meaning:
내다보다 / 전망하다

Recognition:
見据える
→ Korean meaning

Listening:
Japanese audio
→ Japanese textual form

Production:
내다보다 / 전망하다
→ 見据える

1000 entries이고 3 mode가 활성화되어 있다면:

1000 × 3 = 3000 StudyVariants

로 취급한다.


# 7. MODE SEMANTICS

## Recognition

Question:
target-language text

Answer:
source-language meaning

예:

見据える
→ 사용자가 "내다보다" 입력

목표:

목표 언어 표기를 보고 의미를 즉시 인출할 수 있는가.


## Listening

Question:
target-language audio

Audio는 question stage에서 기본적으로 1회만 재생한다.

Answer:
target-language textual form / accepted reading

예:

audio: みすえる
→ 見据える
또는
→ みすえる

목표:

한 번 들은 뒤 표현 자체를 바로 식별할 수 있는가.


## Production

Question:
source-language meaning

Answer:
exact target expression

예:

내다보다 / 전망하다
→ 見据える

semantic equivalent를 썼다고 성공시키지 않는다.

예:

target = 見据える
answer = 予想する

이면 의미가 비슷하더라도 FAIL이다.

Production은 해당 Entry 표현 자체의 능동 인출을 검사한다.


# 8. JAPANESE PITCH AS SECOND-STAGE GATE

Japanese Entry에서 pitch 학습이 활성화되어 있고,
해당 Entry의 pitch 정보가 grading 가능한 신뢰도를 가진 경우,
각 Variant는 다음 조건을 만족해야 PASS한다.

Variant PASS
=
Base Question PASS
AND
Pitch Question PASS

즉 Pitch를 4번째 독립 Variant로 만들지 않는다.

Recognition / Listening / Production 각각의 두 번째 단계로 둔다.


## State

BASE QUESTION
│
├── FAIL
│    ├── full answer review
│    └── VARIANT FAIL
│
└── PASS
     ↓
  PITCH QUESTION
     │
     ├── FAIL
     │    ├── pitch review
     │    └── VARIANT FAIL
     │
     └── PASS
          ↓
      VARIANT PASS


Pitch에서 틀렸다면 해당 Variant는 현재 Stage에서 제거하지 않는다.

다시 등장할 때는 Base부터 다시 푼다.


# 9. PITCH STATISTICS

학습 성공 여부와 통계 저장을 분리한다.

예:

Recognition base accuracy
Recognition pitch accuracy
Recognition joint accuracy

Listening base accuracy
Listening pitch accuracy
Listening joint accuracy

Production base accuracy
Production pitch accuracy
Production joint accuracy


Listening은 이미 audio를 들은 뒤 pitch 문제를 풀기 때문에:

Recognition / Production pitch
→ Pitch Recall

Listening pitch
→ Pitch Perception

으로 통계 semantic을 구분한다.


# 10. PITCH GRADING POLICY

잘못된 pitch를 반복 암기시키는 것은 치명적인 문제다.

따라서 pitch source에는 반드시 provenance와 confidence를 저장한다.

PitchConfidence:

- MANUAL
- VERIFIED
- CONSENSUS
- PREDICTED

기본 grading policy:

MANUAL
VERIFIED
CONSENSUS
→ PASS 조건으로 사용 가능

PREDICTED
→ 기본적으로 정답 화면에는 보여주되 PASS gate로 강제하지 않는다.

Deck option으로 predicted pitch까지 grading할 수 있게 할 수 있으나 기본값은 OFF.


# 11. GENERAL PITCH REPRESENTATION

Pitch는 "단어 기능"이 아니다.

Japanese text annotation이다.

다음을 모두 처리할 수 있는 data representation을 설계하라.

- 단어
- 복합어
- 구
- 문장

내부 데이터는 UI 문자열이 아닌 구조화된 representation이어야 한다.

예:

JapaneseAnalysis
- normalized_text
- reading
- tokens[]
- morae[]
- lexical_accents[]
- accent_phrases[]
- phrase_boundaries[]
- nuclei[]
- neutral_prosody
- source
- confidence
- manual_override

렌더링 문자열 자체를 DB ground truth로 저장하지 마라.


# 12. PITCH ANSWER UI / CODEC

단어와 문장에 동일한 abstraction을 사용할 수 있게 PitchAnswerCodec을 만든다.

## Lexical

예:

み | す | え | る

accent nucleus / drop position을 입력할 수 있어야 한다.

다음 두 입력 방식을 모두 지원 가능하게 구조화하라.

- numeric accent type
- keyboard-driven mora/drop selector

V1에서는 keyboard 중심 입력을 우선한다.


## Phrase / Sentence

문장을 단순 하나의 accent number로 표현하지 않는다.

JapaneseAnalysis에서 결정한 accent phrase segmentation을 기준으로,
각 phrase의 nucleus / accent pattern을 답하게 할 수 있는 구조를 만든다.

예:

phrase 1 : nucleus 0
phrase 2 : nucleus 2
phrase 3 : nucleus 1

UI에서는:

- Arrow / Tab으로 phrase 이동
- 숫자 입력 또는 drop selector
- Enter 제출

이 가능해야 한다.

Phrase boundary 자체를 grading 대상으로 만드는 기능은 architecture상 확장 가능하게 두되,
V1에서 필수로 강제할 필요는 없다.

Sentence pitch는 neutral standard Japanese prosody임을 UI에 표시한다.


# 13. STUDY SCREEN INPUT UX

Study는 keyboard-first다.

Question 표시 즉시 answer input에 focus한다.

예:

見据える

> __________________

3.0


## 사용자가 알면

답을 타이핑하고 Enter.


## 사용자가 전혀 모르면

빈 input 상태에서 Enter.

빈 Enter는:

MANUAL_UNKNOWN

으로 즉시 FAIL 처리한다.

Whitespace-only input 역시 UNKNOWN이다.

예:

""
" "
"　"

모두 동일하게 처리한다.


# 14. FIRST-SEEN WORDS

별도의 "신규 카드 학습 화면"을 만들지 않는다.

처음 보는 Entry라도 동일한 Study flow를 사용한다.

첫 등장:

모름
→ 빈 Enter
→ 정답 확인

다음 등장:

실제 retrieval attempt

계속 실패:

현재 Stage에서 반복

성공:

현재 Stage에서 제거

즉:

실패 후 정답 확인 자체가 최초 학습이다.


# 15. FAILURE TYPES

알고리즘상 모두 FAIL이지만 통계에는 반드시 분리한다.

FailureType:

- MANUAL_UNKNOWN
- RECALL_TIMEOUT
- COMPLETION_TIMEOUT
- WRONG_ANSWER
- PITCH_WRONG
- GRADING_REJECTED

이를 통해 다음을 구분 가능하게 한다.

- 아예 모름
- 생각이 늦음
- 첫 글자만 쓰고 멈춤
- 잘못 알고 있음
- pitch만 틀림


# 16. RECALL TIMER

카드가 표시되는 순간 RecallTimer 시작.

첫 "유효한 실제 답 입력" 순간 정지.

예:

card shown
↓
2.1 sec
↓
"내"
↓
RecallTimer stop

저장:

recall_latency = 2.1 sec

RecallTimer는 typing speed를 측정하지 않는다.

답을 떠올려 입력을 시작하기까지의 시간을 측정한다.


# 17. RECALL TIMEOUT

Deck/mode별 configurable.

초기 기본값 예:

3 seconds

해당 시간 동안 유효 입력이 없으면:

RECALL_TIMEOUT
→ FAIL 확정
→ answer review

이후 성공으로 뒤집을 수 없다.


# 18. ADAPTIVE COMPLETION TIMER

첫 글자만 입력하고 그 뒤 생각하는 행위를 방지해야 한다.

예:

見据える
→ "내"
→ 8초 정지
→ "다보다"

이를 허용하지 않는다.

첫 유효 입력 이후:

CompletionTimer

를 사용한다.

단 고정 N초 timer가 아니다.

사용자의 실제 typing behavior를 학습한 rule-based adaptive timer를 사용한다.


# 19. TYPING PROFILE

다음 단위로 profile을 분리한다.

- input language
- study mode
- input method/script where useful

예:

Korean Recognition
Japanese Listening
Japanese Production

TypingProfile:

- sample_count
- median_interkey_gap
- p90_interkey_gap
- p95_interkey_gap
- chars_per_second
- IME conversion latency
- completion duration distribution

간단한 rolling window / EWMA / percentile 기반으로 구현한다.

복잡한 ML 모델을 만들지 마라.


# 20. ADAPTATION WARMUP

초반에는 사용자가 앱과 IME에 적응해야 한다.

예시 정책:

0~100 valid samples
→ Completion timeout OFF

100~300
→ very loose soft timeout

300+
→ adaptive timer

이 숫자들은 configuration으로 둔다.


# 21. IDLE-BASED COMPLETION DETECTION

전체 typing duration보다 inter-key idle gap을 중요하게 본다.

정상:

み
0.2s
す
0.2s
え
0.2s
る

의심:

み
5.5s
すえる

각 유효 typing event가 들어올 때마다 idle deadline을 갱신한다.

대략:

allowed idle
=
recent p95 inter-key gap
+
safety buffer

형태의 rule을 사용한다.

단 실제 formula는 사용자 경험을 망치지 않도록 보수적으로 설계한다.


# 22. IME COMPOSITION SUPPORT

일본어 IME는:

みすえる
→ conversion
→ 見据える

과정에서 composition/candidate selection 시간이 필요하다.

다음을 감지해야 한다.

- compositionstart
- compositionupdate
- compositionend
- IME candidate selection period where detectable

IME가 정상적으로 composition 중인 시간은 일반 idle timeout과 동일하게 취급하지 않는다.

"생각해서 멈춤"과
"IME 조작 때문에 멈춤"을 최대한 구분한다.


# 23. TYPING PROFILE CONTAMINATION PREVENTION

모르는 단어에서 긴 정지가 발생했다고 그것을 정상 타속으로 학습하지 마라.

TypingProfile update sample은 최소:

- valid submitted answer
- 정상 typing activity
- 극단적 idle 없음
- 정상 IME composition

조건을 만족해야 한다.

실패/timeout sample은 통계에는 기록하지만 typing baseline update에는 기본적으로 사용하지 않는다.


# 24. RECOGNITION GRADING

Recognition은 의미의 자유로운 표현을 허용해야 한다.

예:

canonical:
내다보다

accepted:
전망하다
앞날을 내다보다

user:
미래를 내다보다

이 경우 정답으로 인정 가능해야 한다.

그러나 단순 embedding cosine threshold 하나로 판정하지 마라.

다음 pipeline을 구현한다.

1. normalization
2. exact match
3. accepted alias
4. rejected alias
5. multilingual embedding
6. semantic verifier / cross encoder
7. ambiguous user adjudication


# 25. NORMALIZATION

언어별 normalization layer를 둔다.

최소:

- Unicode normalization
- whitespace
- punctuation
- case where applicable
- Korean spacing tolerance where sensible
- Japanese kana normalization where sensible

Normalization 때문에 실제 의미 차이가 사라지면 안 된다.


# 26. ACCEPTED / REJECTED ALIASES

Entry마다:

accepted_answers[]
rejected_answers[]

를 유지한다.

Semantic grader가 애매하면:

정답:
내다보다 / 전망하다

입력:
미래를 바라보다

[정답 인정]
[오답]

사용자가 정답 인정:

accepted_answers += input

오답:

rejected_answers += input

다음부터 같은 표현은 deterministic하게 채점한다.

즉 사용하면서 semantic grader가:

probabilistic model
→ personalized deterministic dictionary

방향으로 수렴해야 한다.


# 27. SEMANTIC MODEL

Multilingual model abstraction을 사용한다.

권장 초기 backend:

- BGE-M3 계열 multilingual embedding
- ambiguous case에 multilingual cross encoder / reranker

그러나 특정 모델 이름을 StudyCore에 hard-code하지 마라.

SemanticBackend interface를 만든다.

SemanticBackend
├── EmbeddingBackend
├── CrossEncoderBackend
└── future backend


# 28. SEMANTIC DECISION

단순:

similarity > 0.8 = PASS

같은 global threshold를 사용하지 마라.

최소 다음 정보를 고려한다.

- positive score
- accepted meaning similarity
- rejected/confusable similarity
- positive-negative margin
- answer length
- language pair

예:

증가하다
감소하다

허락하다
금지하다

처럼 동일 semantic neighborhood에 있지만 반대 의미인 표현을 잘못 PASS시키지 않도록 한다.

확실한 정답:
PASS

확실한 오답:
FAIL

애매:
AMBIGUOUS

threshold는 configuration/calibration 가능해야 한다.


# 29. GRADING CALIBRATION

사용자 adjudication 결과를 저장한다.

향후:

- threshold calibration
- false positive inspection
- false negative inspection

이 가능하도록 한다.

Debug/Stats 화면에서 semantic grading decision을 추적 가능하게 한다.

단 일반 Study UI에는 복잡한 model score를 노출하지 않아도 된다.


# 30. LISTENING / PRODUCTION GRADER

기본적으로 deterministic form matching을 사용한다.

순서 예:

- Unicode normalize
- Japanese kana normalize
- whitespace normalize
- accepted orthographies
- accepted readings
- manual aliases


## Japanese default

target:
見据える

다음은 기본적으로 accepted 가능:

見据える
みすえる
ミスエル

Deck option:

strict_orthography = false

일 때 위와 같이 허용.

strict_orthography = true

일 때:

見据える = PASS
みすえる = FAIL

기본값은 false.


# 31. ANSWER REVIEW

Base FAIL 또는 Pitch 결과 이후 정답 review 화면을 제공한다.

시간 제한 없음.

예:

見据える
みすえる

내다보다 / 전망하다

[pitch visualization]

audio

사용자는 충분히 보고 학습할 수 있다.

Enter:

다음 카드

Review 화면에서 spend time은 Recall/Completion timer와 완전히 분리한다.


# 32. ORIGINAL ROTATION ALGORITHM — MUST PRESERVE

회독 알고리즘은 다음 구조를 정확히 유지한다.

기본:

Increment = 50 entries
Block = 300 entries


## First block

0~50
0~100
0~150
0~200
0~250
0~300

각 stage는 완전히 CLEAR해야 다음 stage로 이동한다.


## Second block

300~350
300~400
300~450
300~500
300~550
300~600

완료 후:

0~600

누적 총복습.


## Third

600~650
...
600~900

완료 후:

0~900


계속:

900~1200
→ 0~1200

1200~1500
→ 0~1500

...


# 33. IMPORTANT STAGE BEHAVIOR

0~50 stage에서 PASS한 Entry도

0~100 stage가 시작되면 다시 출제된다.

즉:

Previous Stage PASS
!= Permanent Graduation

영구 졸업 상태를 만들지 마라.


# 34. STAGE INTERNAL LOOP

예:

0~50
3 mode enabled

50 × 3
= 150 variants

초기 remaining:
150

PASS:
현재 Stage remaining에서 제거

FAIL:
remaining에 유지

예:

150
→ 51
→ 17
→ 5
→ 1
→ 0

0이면 STAGE CLEAR.


# 35. FAILED VARIANT REQUEUE

FAIL한 Variant는 즉시 다음 카드로 다시 보여주지 않는다.

shuffle/spacing 안에서 다시 배치한다.

최근 동일 Entry가 다시 등장하지 않도록 cooldown을 적용한다.

단 이는 SRS scheduling이 아니다.

단순 anti-clumping이다.


# 36. SAME ENTRY ANTI-CLUMPING

같은 Entry의:

Recognition
Listening
Production

이 연속으로 나오지 않게 한다.

예:

見据える Recognition
見据える Listening
見据える Production

금지.

minimum_same_entry_gap을 사용한다.

가능한 경우 기본 최소 gap 예:

10 variants

단 remaining pool이 작아져 constraint를 만족시킬 수 없으면 graceful하게 완화한다.


# 37. ODD DECK SIZE

Deck size가 300의 배수가 아닐 수 있다.

예:

3042

마지막 block은:

3000~3042

를 학습한 뒤:

0~3042

누적 총복습.

그 후:

Round Complete


# 38. NEXT ROUND

전체 Round가 끝나면:

Round 1 COMPLETE

사용자가 다음 Round를 시작하면:

0~50

부터 다시 시작한다.

이전 Round에서 card graduation은 없다.


# 39. STAGE GENERATION MUST BE TESTED

다음 deck sizes에 대한 unit tests를 작성한다.

- 49
- 50
- 51
- 299
- 300
- 301
- 599
- 600
- 601
- 3042

모든 stage sequence가 요구사항과 정확히 일치해야 한다.


# 40. JAPANESE LANGUAGE PACK

JapaneseLanguagePack은 일본어 text가 들어오면 가능한 annotation을 자동 생성한다.

최소:

- normalization
- reading
- morphology
- lexical pitch
- phrase/sentence neutral prosody
- audio


# 41. JAPANESE MORPHOLOGY

V1에서는 다음 계열을 사용할 수 있다.

- UniDic
- fugashi or equivalent

추출:

- surface
- lemma
- reading
- pronunciation
- POS
- conjugation
- accent-related lexical fields where available


# 42. LEXICAL PITCH ACCURACY PRINCIPLE

사전에 있는 단어를 neural predictor로 추정하지 마라.

우선순위:

1. manual override
2. high-quality curated lexical provider
3. secondary lexical provider / consensus
4. UniDic lexical accent information
5. prediction fallback

목표:

jpdb / OJAD Word Search 수준의 lexical accent accuracy.

jpdb/OJAD 자체를 runtime scraper/API dependency로 사용하지 마라.

라이선스가 불명확하거나 재배포가 제한된 데이터를 무단 포함하지 마라.

Provider architecture로 만들어 사용자가 합법적으로 보유한 외부 dictionary를 import할 수 있게 확장 가능하게 한다.


# 43. PITCH KEY

Lexical lookup key에서 surface 하나만 사용하지 마라.

최소:

- surface
- reading
- lemma/POS where needed

를 고려한다.

동일 표기라도 reading/POS에 따라 accent가 다를 수 있다.


# 44. MULTIPLE VALID ACCENTS

하나의 lexical item에 복수의 표준 pitch가 존재할 수 있다.

따라서:

accent = 2

하나만 저장하지 말고:

patterns[]
preferred_pattern

구조를 지원한다.

사용자 답이 허용된 pattern 중 하나와 일치하면 PASS 가능.


# 45. SENTENCE / PHRASE PROSODY

일본어 text가 phrase/sentence이면:

- morphology
- lexical accents
- accent phrase segmentation
- accent sandhi
- accent nucleus
- neutral standard Japanese prosody

를 분석한다.

V1 backend로:

- OpenJTalk full-context labels
- pyopenjtalk / pyopenjtalk-plus
- optional Marine-style estimator as fallback

등을 사용할 수 있다.

Marine/neural estimate를 high-confidence dictionary truth처럼 취급하지 마라.

문장 prosody는:

Neutral / Standard Japanese Prosody

로 표시한다.


# 46. PITCH CONFIDENCE / PROVENANCE

Pitch result마다:

- provider
- source
- confidence
- model/version
- manual_override

를 저장한다.

UI에서는 최소:

Verified
Consensus
Predicted
Manual

을 구분할 수 있어야 한다.


# 47. PITCH BENCHMARK HARNESS

Pitch engine 정확도를 검증할 benchmark tool을 만든다.

목표:

lexical:
jpdb/OJAD Word Search reference 수준

phrase/sentence:
OJAD Suzuki-kun 수준의 neutral prosody를 목표

단:

외부 사이트를 scraping하지 마라.

Benchmark input은:

- local CSV/JSON fixture
- 사용자 제공 reference dataset

을 사용할 수 있게 한다.

출력:

- total cases
- exact agreement
- partial agreement
- source breakdown
- confidence breakdown
- mismatches

를 생성한다.


# 48. JAPANESE AUDIO

JapaneseAnalysis 결과를 audio backend와 공유한다.

가능한 한:

Pitch visualization
Audio pronunciation

이 동일한 front-end/prosody analysis를 기반으로 하도록 한다.

UI가 표시하는 accent와 audio가 전혀 다른 결과가 되지 않게 한다.

Audio generation은 enrichment 시 precompute/cache 가능하게 한다.

Study 중 매번 heavyweight generation하지 마라.


# 49. LANGUAGE ENRICHMENT

일본어 Entry 추가 시 예:

見据える

입력만 해도 자동으로 가능한 값을 제안한다.

- reading
- pitch
- audio
- morphology

Meaning은 grading ground truth이므로 자동 확정하지 않는다.

자동 meaning suggestion을 구현한다면:

사용자가 확인/수정 후 저장

하도록 한다.


# 50. INPUT LANGUAGE ROUTING

Deck:

source_language = ko-KR
target_language = ja-JP

이면:

Recognition answer
→ ko-KR input

Listening answer
→ ja-JP input

Production answer
→ ja-JP input

Pitch question
→ numeric/pitch editor이므로 언어 IME와 독립적으로 처리 가능

Mode별 answer language를 InputCore가 계산한다.


# 51. WINDOWS KEYBOARD / IME DETECTION

Windows에서 설치된 input locale/profile을 감지한다.

Windows APIs / TSF를 사용한다.

가능한 adapter:

WindowsInputAdapter

기능:

- installed input profiles query
- current input profile query
- activate target profile
- Japanese IME mode control
- restore previous profile


# 52. JAPANESE IME AUTO SWITCH

Japanese answer가 필요한 카드가 뜨기 전에:

ja-JP Japanese IME
+
IME Open
+
Hiragana / Native input mode

상태로 전환한다.

단순히 ja-JP locale만 활성화하고 Latin `A` mode에 남겨두지 마라.

현대 Windows에서는 TSF를 우선 사용한다.

legacy IMM API는 fallback으로만 사용한다.


# 53. KOREAN AUTO SWITCH

Recognition처럼 Korean answer가 필요한 경우:

ko-KR

input profile로 자동 전환한다.

카드 전환과 IME 전환 때문에 input focus가 깨지지 않게 한다.


# 54. MISSING INPUT METHOD

필요한 OS input method가 설치되어 있지 않으면 자동으로 시스템 설정을 임의 변경하지 마라.

예:

Japanese input method not installed

UI:

- Windows language settings 열기
- Internal Romaji fallback 사용

일본어는 fallback으로:

misueru
→ みすえる

같은 internal romaji-to-kana transliteration을 제공할 수 있다.

그러나 OS IME가 설치되어 있으면 기본적으로 OS IME를 사용한다.


# 55. RESTORE INPUT PROFILE

Study 시작 직전 input profile을 저장한다.

Study 종료 시 원래 profile을 복구한다.

앱을 종료하거나 Study에서 나왔을 때 사용자의 Windows input language가 일본어로 강제된 채 남지 않게 한다.


# 56. PAUSE POLICY

Study에는 Pause 기능을 만들지 마라.

가능:

- Study 계속
- Study 종료

Study 창 focus가 장시간 사라지거나 app background/minimize 상황이면
현재 card timing을 무효화하고 session suspend/exit 정책을 명확히 적용한다.

해당 상황에서 사용자가 timer를 우회할 수 없게 한다.


# 57. STUDY PERSISTENCE

사용자가 Study를 중간에 나가도 정확하게 복원되어야 한다.

저장:

- round
- stage type
- stage start/end
- remaining variants
- deterministic shuffle seed/state
- attempts
- current deck progress

다음 실행에서 해당 Stage를 이어서 수행한다.

DB commit은 안전하게 수행한다.


# 58. DATABASE

SQLite 사용.

Migration system을 반드시 둔다.

핵심 table 예:

- decks
- entries
- entry_aliases
- japanese_analyses
- pitch_patterns
- audio_assets
- study_sessions
- stage_states
- attempts
- typing_profiles
- grading_decisions
- sync_journal
- app_settings

schema는 normalize하되 과도한 추상화는 피한다.


# 59. ATTEMPT LOG

각 attempt에 최소 다음을 기록한다.

- id
- entry_id
- deck_id
- variant
- round
- stage
- answer_text
- base_correct
- pitch_correct
- joint_correct
- grading_method
- semantic_score if applicable
- recall_latency_ms
- typing_duration_ms
- total_duration_ms
- failure_type
- timestamp
- device_id


# 60. STATISTICS

최소 다음을 제공한다.

Per Deck:

Recognition
- base accuracy
- pitch accuracy
- joint accuracy
- median recall latency

Listening
- base accuracy
- pitch perception accuracy
- joint accuracy
- median recall latency

Production
- base accuracy
- pitch recall accuracy
- joint accuracy
- median recall latency


Per Entry:

예:

見据える

Recognition 96%
Listening 74%
Production 55%
Pitch Recall 48%
Pitch Perception 88%


통계는 Study scheduling에 사용하지 않는다.


# 61. SYNC-READY LOCAL-FIRST DESIGN

V1에서 cloud server를 완성할 필요는 없다.

그러나 DB/schema는 처음부터 sync 가능한 형태로 설계한다.

모든 sync entity:

- UUID
- revision
- created_at
- updated_at
- deleted_at
- device_id

Mutation은 SyncJournal에 기록한다.


# 62. SYNC JOURNAL

예:

SyncOp
- op_id
- entity_id
- entity_type
- device_id
- revision
- operation
- payload
- timestamp

Attempt history는 append-only로 sync 가능하게 설계한다.

Deck/Entry 수정은 향후 conflict resolution 가능하게 한다.


# 63. ACTIVE STUDY SESSION OWNERSHIP

향후 multi-device sync에서 같은 Deck을 두 기기에서 동시에 Study하면 Stage remaining state가 충돌할 수 있다.

따라서 architecture상:

active study session lease / ownership

개념을 지원 가능하게 설계한다.

V1 local-only에서는 실제 server lease를 구현하지 않아도 된다.


# 64. IMPORT / EXPORT

최소:

CSV
JSON

지원.

예:

term,meaning
見据える,내다보다
躊躇う,망설이다

만 import해도 Japanese enrichment가 나중에:

reading
pitch
audio

를 생성 가능해야 한다.

대량 수천 개 import가 가능해야 한다.


# 65. BACKGROUND ENRICHMENT

대량 import 시 UI를 block하지 않는다.

Entry 저장
→ enrichment job queue
→ Japanese analysis
→ pitch
→ audio

형태.

progress를 표시한다.

실패한 enrichment는 retry 가능하게 한다.


# 66. UI SCREENS

V1 핵심 화면은 4개다.

1. Deck List
2. Deck Editor
3. Study
4. Statistics

쓸데없는 화면/소셜 기능을 추가하지 마라.


# 67. STUDY UI PRIORITY

Study 화면은 최대한 방해가 없어야 한다.

중요 요소:

- question
- answer input
- recall timer
- current mode indicator
- current answer language indicator
- remaining count
- progress
- Exit

Mouse 없이 학습 가능해야 한다.


# 68. KEYBOARD UX

최소 keyboard flow:

Question
→ type answer
→ Enter

Unknown
→ empty Enter

Review
→ Enter next

Pitch:
→ keyboard pitch input
→ Enter

Ambiguous semantic grade:
→ hotkey로 Accept / Reject

Study 대부분을 keyboard에서 손을 떼지 않고 수행 가능하게 한다.


# 69. VISUAL DESIGN

Desktop utility답게 깔끔하고 빠르게 만든다.

- 과도한 animation 금지
- card transition latency 최소화
- input focus 항상 안정적
- dark/light theme 가능
- timer는 읽히되 불필요하게 압박감을 주는 animation 금지

성능과 입력 흐름이 디자인보다 우선이다.


# 70. PERFORMANCE

Study card transition은 즉시 느껴져야 한다.

목표:

- exact grading: effectively instant
- cached semantic grading: low latency
- heavy cross-encoder: ambiguous case에만 실행
- pitch/audio: precomputed/cache 우선

NLP model load가 Study 첫 카드를 막지 않게 background preload 가능하게 한다.


# 71. OFFLINE-FIRST

핵심 학습은 인터넷 없이 동작해야 한다.

필수 core functionality:

- deck
- study
- timer
- grading where local model available
- Japanese analysis
- persistence
- stats

모두 offline-first.

외부 web service를 runtime single point of failure로 두지 마라.


# 72. MODEL MANAGEMENT

Heavy model은 app binary에 무조건 포함하지 않아도 된다.

ModelManager를 만든다.

- model installed 여부
- version
- checksum
- download/install
- storage path
- update
- CPU/GPU backend

를 관리할 수 있게 한다.

모델이 없을 경우 deterministic grader는 계속 동작해야 한다.


# 73. JAPANESE DATA LICENSING

라이선스가 불명확한 pitch dictionary를 무단 bundle하지 마라.

각 provider마다:

- source
- license metadata
- redistribution_allowed

를 명확히 관리한다.

jpdb/OJAD를 scraper로 사용하지 않는다.

그들은 benchmark/reference일 뿐 runtime dependency가 아니다.


# 74. TESTS — STUDY CORE

반드시 unit/integration test 작성.

검증:

- 50 increment
- 300 block
- cumulative 0~N
- stage reactivation
- no permanent graduation
- odd deck sizes
- round restart
- fail requeue
- pitch failure keeps variant alive
- anti-clumping


# 75. TESTS — TIMERS

가상 clock을 사용하여 deterministic test 작성.

검증:

- recall timer starts on card
- stops at first valid input
- whitespace는 valid input 아님
- empty Enter = unknown
- recall timeout
- completion timeout
- typing profile warmup
- adaptive timeout
- IME composition exemption
- profile contamination prevention


# 76. TESTS — GRADING

다음 포함:

Exact:
내다보다 == 내다보다

Accepted alias:
전망하다 → accepted

Rejected:
예상하다 → rejected

Semantic:
앞날을 내다보다 → accepted semantic candidate

Antonym/confusable:
증가하다 vs 감소하다
허락하다 vs 금지하다

Ambiguous path:
manual adjudication

Production:
見据える target
予想する answer
→ FAIL

Kana:
みすえる accepted when strict orthography OFF


# 77. TESTS — JAPANESE

최소:

- reading extraction
- lexical accent parsing
- multi-pattern accent
- source precedence
- manual override
- confidence
- OOV predicted result
- phrase/sentence analysis
- pitch answer codec
- audio cache key


# 78. TESTS — WINDOWS INPUT

Platform adapter는 interface로 만들고 mock test 가능해야 한다.

실제 Windows integration test에서 가능한 경우:

- installed layouts query
- ko-KR activation
- ja-JP activation
- Japanese IME open/native mode
- restore previous layout

검증.


# 79. TESTS — PERSISTENCE

- app restart
- Stage resume
- remaining variants exact restore
- round restore
- attempt log durability
- typing profile restore
- migration test
- corrupted optional cache recovery


# 80. END-TO-END DEMO DECK

개발용 sample deck을 제공한다.

예:

50~100 Japanese entries

Recognition / Listening / Production / pitch를 실제로 테스트할 수 있게 한다.

단 production database와 test fixture를 명확히 분리한다.


# 81. ACCEPTANCE TEST — REAL STUDY SESSION

실제 프로그램을 실행하고 다음을 end-to-end 검증하라.

1. Japanese deck 생성
2. Entry import
3. enrichment 실행
4. Study 시작
5. Recognition answer
6. pitch answer
7. Listening
8. Production
9. empty Enter
10. wrong answer
11. recall timeout
12. completion timeout
13. Stage FAIL 재등장
14. Stage clear
15. 0~50 → 0~100 progression
16. 종료
17. 앱 재실행
18. 동일 Stage resume
19. stats 확인


# 82. DO NOT CHEAT TESTS

테스트를 통과시키기 위해 production logic을 우회하거나 hard-code하지 마라.

실제 production path가 테스트되는 구조로 만들어라.


# 83. LOGGING

Debug logging 제공.

최소:

- study state transition
- grading path
- semantic backend latency
- keyboard profile switch
- Japanese enrichment provider
- pitch source/confidence
- timer state
- DB errors

민감한 사용자 입력을 무조건 verbose log에 남기지 않도록 logging level/privacy를 고려한다.


# 84. ERROR HANDLING

Language sidecar가 죽어도 앱 전체가 즉시 죽지 않게 한다.

예:

semantic model unavailable
→ deterministic grading 계속
→ ambiguous case fallback

Japanese enrichment failure
→ Entry 저장 유지
→ retry 가능

audio failure
→ audio 없이 Study 가능

pitch unavailable
→ pitch gate 비활성 / warning
→ 잘못된 fabricated pitch 사용 금지


# 85. IMPLEMENTATION PRIORITY

순서는 다음과 같이 권장한다.

Phase 1
- project/bootstrap
- DB
- Deck/Entry
- StudyCore
- 50/300 algorithm
- persistence

Phase 2
- Study UI
- typing
- timers
- three modes
- deterministic grading

Phase 3
- semantic grading
- alias learning
- stats

Phase 4
- Windows IME auto-switch
- typing profile / adaptive timer

Phase 5
- Japanese enrichment
- reading
- lexical pitch
- phrase/sentence prosody
- audio
- pitch quiz

Phase 6
- import/export
- sync journal
- packaging
- end-to-end tests

단 각 phase를 stub으로 남긴 채 종료하지 말고,
최종적으로 전부 연결된 production path를 완성한다.


# 86. CODE QUALITY

요구:

- clear module boundaries
- typed schemas
- migrations
- deterministic StudyCore
- minimal global state
- no giant God object
- testable clocks/random generators/platform adapters
- async heavy work outside UI thread
- crash-safe persistence
- clean shutdown
- meaningful error messages


# 87. DOCUMENTATION

프로젝트에 다음 문서를 작성한다.

README.md
- build
- run
- test
- package

docs/architecture.md
- module architecture
- StudyCore
- LanguagePack
- provider contracts

docs/study_algorithm.md
- exact 50/300 algorithm
- stage examples
- failure behavior

docs/grading.md
- semantic grading
- alias learning

docs/japanese.md
- reading
- pitch
- confidence/provenance
- audio

docs/input.md
- Windows IME handling
- adaptive timer

docs/sync.md
- future sync architecture


# 88. FINAL VERIFICATION REPORT

구현 완료 후 반드시 실제 결과를 보고한다.

다음 형식으로 정리한다.

## Build
PASS / FAIL

## Tests
총 테스트 수
PASS
FAIL

## Study algorithm
PASS / FAIL

## Recognition
PASS / FAIL

## Listening
PASS / FAIL

## Production
PASS / FAIL

## Pitch gate
PASS / FAIL

## Semantic grading
PASS / FAIL

## Adaptive typing timer
PASS / FAIL

## Windows IME switching
PASS / FAIL

## Japanese enrichment
PASS / FAIL

## Persistence/resume
PASS / FAIL

## Import/export
PASS / FAIL

## Sync-ready schema
PASS / FAIL

## Packaging
PASS / FAIL

실제로 검증하지 않은 항목을 PASS라고 쓰지 마라.


# 89. PRODUCT PRINCIPLE — DO NOT VIOLATE

TANREN의 핵심은 이것이다.

모르면 바로 실패한다.
알면 실제로 답을 생성한다.
느리게 떠오르면 실패할 수 있다.
첫 글자만 입력하고 생각하는 것도 제한한다.
Base뿐 아니라 정확한 일본어 pitch까지 학습한다.
실패하면 현재 Stage에서 다시 나온다.
맞았더라도 다음 확대 Stage에서는 다시 나온다.
학습 범위는 50개씩 커진다.
300개 단위로 누적 전체 복습한다.
전체를 끝내면 다시 전체 Round를 시작할 수 있다.

반복을 줄이려고 하지 마라.

이 프로그램은:

"최소 반복으로 기억을 유지하는 시스템"

이 아니라

"많은 반복을 실제 능동 인출로 바꾸어 자동화시키는 시스템"

이다.


# 90. FINAL REQUIREMENT

최종 결과는 실제 사용 가능한 TANREN V1이어야 한다.

단순 architecture proposal을 제출하지 마라.
단순 UI mockup을 제출하지 마라.
placeholder backend를 제출하지 마라.
테스트 숫자만 늘리지 마라.

실제:

Deck 생성
→ 데이터 import
→ 자동 enrichment
→ Study
→ 입력
→ 자동 채점
→ pitch
→ 반복
→ Stage progression
→ 종료
→ 재실행
→ 이어서 학습

이 전체 경로가 동작해야 한다.

현재 요구사항을 만족하는 범위 안에서는 과도한 기능 추가나 불필요한 재설계를 하지 마라.