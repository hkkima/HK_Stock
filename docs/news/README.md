# 뉴스 파이프라인 — 컨셉 → 시나리오 → 뉴스 풀 → 예약

수강생 주식판(HK_Stock)의 **강사 발행 뉴스**를 서사 있게 대량 준비·운영하기 위한 저장소.
자동 뉴스 엔진(`functions/news.js`)의 저품질 랜덤 뉴스와 달리, 여기 뉴스는 **컨셉→시나리오→
개별 뉴스→예약**의 단계를 거쳐 "이어지는 이야기"로 게시된다.

## 데이터 흐름

```
concepts.md   (팀 컨셉·불변식 — 사람이 편집하는 설정집)
     │  ①/stock-news-scenario
     ▼
scenarios.md  (서사 틀: 아크·단계·극성·pct 가이드 — 큰 흐름)
     │  ②/stock-news-write
     ▼
pool.jsonl    (실제 뉴스 항목: text/scope/target/pct/… — 구조화된 뱅크)
     │  ③/stock-news-schedule   (★승인 게이트: 기본은 배치안만 출력)
     ▼
scheduledNews (라이브 예약 — publishScheduledNews가 매분 만기분 발행)
```

- **사람용 뷰**: `pool.jsonl`은 기계용이라, `tools/pool.mjs`로 엑셀(CSV) 또는 HTML 웹뷰로 변환/역파싱.

## 파일

| 파일 | 형식 | 편집 주체 | 내용 |
|---|---|---|---|
| `concepts.md` | 마크다운 | 사람(+스킬) | 종목별 컨셉·설정, 절대 규칙 |
| `scenarios.md` | 마크다운 | `/stock-news-scenario` | 서사 아크, 단계, 극성·pct 가이드 |
| `pool.jsonl` | JSONL(1줄=1건) | `/stock-news-write`, `/stock-news-schedule` | 실제 뉴스 항목 뱅크 |
| `tools/pool.mjs` | Node CLI(무의존성) | — | CSV/HTML/list 변환·역파싱 |

## pool.jsonl 레코드 스키마

한 줄에 JSON 객체 하나. 필드:

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | 고유 id(예: `chess-001`). 시나리오 prefix + 번호 권장 |
| `scenario` | string | `scenarios.md`의 시나리오 id |
| `text` | string | 헤드라인. 본문 12~22자 권장(태그·바이라인 제외 기준) |
| `scope` | `all`\|`stock`\|`sector`\|`trait` | 대상 범위 |
| `target` | string\|null | stock=종목id, sector=업종명, trait=특성명, all=null |
| `pct` | number | 시세 ±%(0 = 헤드라인만). 개별 ±2~6, 업종/전체 ±1~3 권장 |
| `polarity` | `good`\|`bad`\|`flat` | pct 부호와 일치(0이면 flat) |
| `status` | `draft`\|`scheduled`\|`published`\|`archived` | 진행 상태 |
| `notes` | string | 근거/아크 단계 메모 |
| `scheduledAt` | number? | 예약 시각(epoch ms). status=scheduled일 때 |
| `scheduledId` | string? | scheduledNews 문서 id. 직접 시드 시 |

> `scope`/`target`/`pct` 의미는 `functions/index.js`의 `applyImpactNews`와 동일. `trait`(특성)은
> **비공개** — 배지가 항상 "테마"로 나가고 특성명·대상 종목이 노출되지 않는다. 헤드라인 문구에서도
> 특성명을 쓰지 말 것.

## 사람용 뷰어 도구 (tools/pool.mjs)

의존성 없음(순수 Node). `docs/news/`에서 실행:

```bash
node tools/pool.mjs list              # 콘솔 표로 훑기
node tools/pool.mjs csv               # pool.jsonl → pool.csv (엑셀, 한글 깨짐 방지 BOM)
node tools/pool.mjs import pool.csv   # 엑셀에서 편집한 CSV → pool.jsonl 역파싱(덮어씀)
node tools/pool.mjs html              # pool.jsonl → pool.html (브라우저 필터/검색 웹뷰)
```

엑셀 워크플로: `csv`로 내보내 엑셀에서 편집 → `import`로 되돌리기(역파싱). id는 유지해야 매칭됨.

## 스킬

| 스킬 | 역할 |
|---|---|
| `/stock-news-scenario` | 컨셉+현재 시장 → 시나리오 틀 생성/갱신(`scenarios.md`) |
| `/stock-news-write` | 시나리오+최근 피드 → 뉴스 항목 생성(`pool.jsonl`에 추가) |
| `/stock-news-schedule` | 풀의 draft를 날짜·시각에 배치(★승인 게이트). 기존 예약 시스템 연동 |

## 라이브 시스템 주의

실수강생·실포인트. `pool.jsonl`은 **초안**일 뿐 게시가 아니다. 실제 게시는 예약(`scheduledNews`)
또는 운영자 화면 ④를 통해서만 일어난다. 총량 보존·특성 비공개 등 `CLAUDE.md`/`docs/HANDBOOK.md`
불변식을 깨지 않는다. 장 운영: **09:00 개장 / 18:00 마감**(Asia/Seoul), 틱 09~17시.
