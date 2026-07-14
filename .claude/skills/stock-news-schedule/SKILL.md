---
name: stock-news-schedule
description: HK_Stock 주식판 뉴스 파이프라인 3단계 — 제작된 뉴스 풀(draft)을 날짜·시각에 배치해 예약 발행한다. 운영자가 "뉴스 예약해줘", "이번 주 스케줄 짜줘", "OO시에 배치", "풀에서 골라 예약", "발행 일정" 같은 요청을 할 때 사용. docs/news/pool.jsonl의 draft를 장중(09~18시 KST)에 분산 배치하고, ★승인 게이트 기본★ — 배치안만 출력한다. 서비스 계정 키 + 명시 승인 시에만 test-harness/news-schedule.mjs로 scheduledNews에 직접 시드하고 pool 상태를 scheduled로 갱신한다. 라이브(실수강생·실포인트) 시스템이므로 총량·시세는 직접 건드리지 않는다.
---

# stock-news-schedule — 예약 배치 (파이프라인 3/3)

풀의 draft → **예약 발행**. 기존 예약 시스템(`scheduledNews` + 매분 `publishScheduledNews`)에 연동.
**★승인 게이트 기본: 배치안만 출력. 라이브 쓰기는 키 + 명시 승인일 때만.★**

## 1) 읽기
1. `docs/news/pool.jsonl` — `status:"draft"` 항목이 배치 후보. `node docs/news/tools/pool.mjs list`로 훑기.
2. `docs/news/scenarios.md` — 아크 순서(예: tile 선언→반응→성과)를 지켜 시간 순서 배치.
3. (선택) 라이브 — 하우스풀·유동성 확인해 큰 호재 타이밍 조정.

## 2) 배치 규칙
- **장 운영시간**: 09:00 개장 / 18:00 마감(Asia/Seoul), 틱 09~17시. 예약 시각은 **09:00~18:00 KST**
  사이로. 마감 후·개장 전 시각은 피한다(체결·틱이 없음).
- **분산**: 하루 여러 건이면 시간대를 벌린다(예: 10:00, 13:00, 16:00). 한 종목 연타 자제.
- **아크 순서 준수**: 같은 시나리오의 단계는 날짜/시간이 순서대로.
- **하루 극성 균형**: 호재·악재·중립 섞기(악재 소폭 우위).
- **publishAt**: epoch ms. `publishScheduledNews`가 매분 `status:'pending'` & `publishAt<=now`를 발행.

## 3) 배치안 산출 (기본 — 쓰기 없음)
- 고른 draft에 각각 `publishAt`(epoch ms)을 매겨 **plan.json** 을 스크래치에 작성:
  `[{ "id":"chess-001", "publishAt": 1751596800000 }, ...]`
- **미리보기**(키 불필요): `node test-harness/news-schedule.mjs --dry <plan.json>`
  → 시각·[scope/target·pct%]·헤드라인 표로 검증(scope/target/pct/상태 검증 포함).
- 운영자에게 이 표 + 화면 ④ 붙여넣기용 목록을 제시하고 **승인 요청**. 여기서 멈춘다.

## 4) 라이브 예약 (승인 + 키 있을 때만)
- 운영자가 명시 승인하고 서비스 계정 키가 있으면:
  `node test-harness/news-schedule.mjs "<key.json>" <plan.json>`
  → `scheduledNews`에 문서 추가(`status:'pending'`, publishAt 등) + `pool.jsonl` 항목을
    `status:"scheduled"`(+ scheduledAt·scheduledId)로 갱신. 배포 스케줄러가 만기 시 자동 발행·정산.
- **직접 건드리지 말 것**: 시세·`housePool`·`stocks`. 예약 문서만 추가한다(정산은 `applyImpactNews`가).
- 키가 없으면: 배치안을 화면 ④(뉴스 작성+시세 조작) 또는 예약 UI에 붙여넣도록 안내만.

## 5) 마무리
예약(또는 배치안) 목록 — 시각·대상·pct·헤드라인 — 과 균형 근거를 3줄 이내로 요약.
취소는 운영자 UI(`cancelScheduledNews`) 또는 pending 문서 status 변경.
