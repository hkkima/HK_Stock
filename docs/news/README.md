# docs/news — 주간 뉴스 자동 편성

수강생 주식판의 뉴스를 주 단위로 **편성(plan) → 예약(seed) → 자동 게시**하는 워크플로우.
자동 랜덤 엔진(`functions/news.js`)보다 맥락 있는 고품질 헤드라인을 내기 위한 것.
(배경·규칙 전문은 `../news-routine-prompt.md`, 스킬은 `.claude/skills/stock-news`.)

## 파일

- `plan-YYYY-MM-DD.json` — 그 주(월요일 기준)의 편성. `items[]` 각각:
  `{ date, time(KST), scope('all'|'stock'|'sector'), target, pct, text }`.
  **`trait` 스코프 금지**(특성 비공개), 대상은 항상 기업(팀), 헤드라인 12~24자, 악재 살짝 우위.
- `pool-status.json` — 최근 `--check/--status` 스냅샷(하우스풀·자동엔진·종목). 편성 근거·감사용.

## 하니스 — `test-harness/news-schedule.mjs`

```bash
node test-harness/news-schedule.mjs --check                 # 라이브 연결 확인 (공개 read, 키 불필요)
node test-harness/news-schedule.mjs --status                # pool-status.json 갱신 (키 불필요)
node test-harness/news-schedule.mjs --plan 2026-07-14        # 계획 스켈레톤 생성 (키 불필요)
node test-harness/news-schedule.mjs --seed <plan.json> --dry # 시드 미리보기 (키 불필요)
node test-harness/news-schedule.mjs --seed <plan.json> "<serviceAccount.json>"  # 실제 예약 (★키 필요)
```

## 동작 원리 (불변식 준수)

- 시드는 계획 항목을 `scheduledNews` 컬렉션에 **예약(status:'pending')만** 한다.
- 배포된 `publishScheduledNews`(매분 스케줄)가 만기 시각에 `applyImpactNews` 로 적용·정산한다.
  → 시세·`housePool`·총량 보존은 **Cloud Function 만** 건드린다. 하니스는 큐에 넣을 뿐 직접 조작 안 함.
- doc id 가 결정적(`plan_<planId>_<i>`)이라 **재실행해도 멱등**(이미 게시된 건은 건너뜀).

## ★ 쓰기(시드)는 서비스 계정 키 필요

`firestore.rules` 가 클라이언트 쓰기를 차단(`scheduledNews: allow write: if false`)한다.
따라서 실제 시드는 **firebase-admin + 서비스 계정 키**로만 가능하며, 키는 **리포 밖·`.gitignore`** 다.
`--check`/`--status`/`--plan`/`--seed --dry` 는 공개 read 라 키 없이 동작한다.

키 공급 방식(둘 중 하나):
- 인자로 키 파일 경로: `--seed <plan.json> "<serviceAccount.json>"` (로컬 운영자)
- 환경변수 `FIREBASE_SA_KEY_B64`(base64 인코딩된 키 JSON): 인자 없이 `--seed <plan.json>` 만 실행.
  프로비저닝된 환경(정기 트리거 세션 포함)이 이 방식을 쓴다. 키는 절대 로그·커밋 금지.

## 주간 정기 편성 (트리거)

매주 월 08:30 KST 정기 트리거가 이 워크플로우를 돌린다: `--check` → 그 주 계획 작성 →
`plan-<월요일>.json` 커밋/푸시. 시드는 키가 있는 환경에서 `--seed` 로 마무리한다(헤드리스 세션에
키가 없으면 계획만 커밋하고 운영자 시드를 대기). 자동 랜덤 엔진과 중복을 피하려면 운영자 화면 ④에서
자동 뉴스 토글을 **OFF** 로 두는 걸 권장한다.
