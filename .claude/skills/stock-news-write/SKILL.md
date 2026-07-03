---
name: stock-news-write
description: HK_Stock 주식판 뉴스 파이프라인 2단계 — 시나리오 틀을 바탕으로 실제 뉴스 헤드라인을 제작해 풀에 추가한다. 운영자가 "뉴스 만들어줘", "헤드라인 뽑아줘", "OO 시나리오로 뉴스 제작", "풀 채워줘", "이번 주 뉴스 준비" 같은 요청을 할 때 사용. docs/news/scenarios.md의 아크와 최근 피드를 반영해 text/scope/target/pct/polarity를 정하고 docs/news/pool.jsonl에 status:draft로 append한다. 게시·예약은 하지 않는다(그건 /stock-news-schedule).
---

# stock-news-write — 뉴스 제작 (파이프라인 2/3)

시나리오 → **실제 뉴스 항목**. `docs/news/pool.jsonl`에 `status:"draft"`로 추가한다.
게시·예약은 하지 않는다. 파이프라인 개요는 `docs/news/README.md`.

## 1) 읽기
1. `docs/news/scenarios.md` — 어떤 시나리오·아크 단계로 쓸지.
2. `docs/news/concepts.md` — 컨셉·절대 규칙·종목 id/sector.
3. `docs/news/pool.jsonl` — 기존 항목(중복 회피, id 채번, 아크 진행 상황).
4. **라이브 피드**(선택, 공개 read) — `test-harness/read_live.mjs` 패턴으로 `meta/stockBoard.news` 최근
   항목 확인해 최근 게시분과 문구 중복·유사 회피.

## 2) 제작 규칙
- 한 요청당 **3~5건** 권장. 개별/업종/전체를 적절히 섞고, 한 시나리오만 몰지 말 것.
- **헤드라인**: 본문 12~22자 헤드라인체(태그·바이라인 제외 기준). 재미·서사 우선.
- **극성**: 호재·악재·중립 섞되 **악재 소폭 우위**. 실명 비방·범죄 단정 금지.
- **특성(trait) 비공개**: 특성명·대상 종목 노출 금지. "일부 종목 동반 …"류 일반 표현만.
- **은근한 톤 유지**: 예) WEED는 직설 범죄 X, "특수화물·물동량"으로 암시만.
- **pct 결정**: 개별 ±2~6%, 업종/전체 ±1~3%. 확신 없으면 0(헤드라인만). 하우스풀 마이너스면
  큰 호재 자제. polarity는 pct 부호와 일치(0=flat).

## 3) 각 항목 필드 (pool.jsonl 스키마 — README 참조)
```json
{"id":"<시나리오prefix-번호>","scenario":"<scenarios.md id>","text":"<헤드라인>",
 "scope":"all|stock|sector|trait","target":"<종목id|업종명|특성명|null>",
 "pct":<숫자>,"polarity":"good|bad|flat","status":"draft","notes":"<근거·아크 단계>"}
```
- `id`는 기존과 겹치지 않게(시나리오 prefix + 증가 번호). `target`: stock=종목id, sector=업종명,
  all=null. `scope`/`target`/`pct` 의미는 `functions/index.js` `applyImpactNews`와 동일.

## 4) 쓰기
- 새 항목을 `pool.jsonl` **끝에 append**(한 줄=한 JSON). 기존 줄은 건드리지 않음.
- 편집 후 검증: `cd docs/news && node tools/pool.mjs list` 로 파싱·형식 확인.
- 사람 검토가 필요하면 `node tools/pool.mjs csv`(엑셀) 또는 `html`(웹뷰) 안내.

## 5) 마무리
추가한 헤드라인 목록과 각 근거(이은 시나리오/아크 단계, pct 선택 이유)를 3줄 이내로 요약.
아직 **게시 아님** — 예약/게시는 `/stock-news-schedule`.
