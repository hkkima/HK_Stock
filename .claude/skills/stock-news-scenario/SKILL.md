---
name: stock-news-scenario
description: HK_Stock 주식판 뉴스 파이프라인 1단계 — 컨셉과 현재 시장을 읽고 "서사 틀(시나리오)"을 생성/갱신한다. 운영자가 "새 시나리오 짜줘", "OO팀 스토리라인 만들어", "서사 정리해줘", "큰 흐름 설계" 같은 요청을 할 때 사용. docs/news/concepts.md와 라이브 시장·강사 발행 피드를 바탕으로 아크·단계·극성·pct 가이드를 docs/news/scenarios.md에 쓴다. 실제 뉴스 문장은 만들지 않는다(그건 /stock-news-write).
---

# stock-news-scenario — 서사 틀 생성 (파이프라인 1/3)

컨셉 → **시나리오**. 실제 뉴스가 아니라 "큰 흐름"(아크·단계·극성 경향·pct 가이드)을 만든다.
결과는 `docs/news/scenarios.md`에 반영. 파이프라인 개요는 `docs/news/README.md`.

## 1) 읽기
1. `docs/news/concepts.md` — 종목 컨셉·설정·절대 규칙.
2. `docs/news/scenarios.md` — 기존 시나리오(중복·충돌 회피, 이어가기).
3. **라이브 시장**(공개 read, 키 불필요) — `test-harness/read_live.mjs` 패턴(firebase/app):
   - `stocks`: id·name·sector·price·status
   - `meta/stockBoard.news`: 최근 30건. 이 중 **강사 발행**(자유문장 — 대괄호 태그·바이라인·직접인용 등
     `functions/news.js`의 TPL 템플릿에 없는 문체)만 서사 근거로. 자동엔진 항목(TPL 매칭)은 톤 참고만.
   - **시중 유동성 M** = 학생 현금 + 주식평가 총합. 하우스풀(`meta/stockBoard.housePool`)도 확인.
     → 유동성 연동 스케일(예: 까미홀딩스)·하우스풀 소진 여부 판단에 사용.
     · test-harness에 firebase SDK가 없으면 `cd test-harness && npm install` 후 실행.

## 2) 시나리오 설계
각 시나리오는 다음을 담는다(기존 `scenarios.md` 형식 준수):
- **id**: 케밥케이스(예: `tile-art`). 뉴스가 `pool.jsonl`의 `scenario`로 연결.
- **대상**: scope(`all`/`stock`/`sector`/`trait`) + target(종목id/업종명/특성명).
- **극성 경향**: 호재/악재/중립 비율, 왕복/단계 여부.
- **pct 가이드**: 개별 ±2~6%, 업종/전체 ±1~3%. 하우스풀 마이너스면 큰 호재 자제·견제 우선.
- **아크 단계**: 순차 전개(선언→반응→성과 등). 이미 게시된 과거 뉴스와 이어지게.
- **톤/주의**: 특성명 비공개, 실명 비방 금지, 표면/이면(예: 체스의 신 사이비 서브텍스트).

## 3) 쓰기
- `docs/news/scenarios.md`를 갱신(새 시나리오 추가 또는 기존 아크 단계 진행).
- **뉴스 문장·시세는 만들지 않는다.** 다음 단계 `/stock-news-write`가 담당.
- 운영에 영향 주는 판단(하우스풀 상태, 스케일 구간)은 시나리오 메모에 남겨 write/schedule이 참고하게.

## 4) 마무리
추가/변경한 시나리오와 근거(어떤 컨셉·시장 신호를 반영했는지)를 3줄 이내로 요약.
