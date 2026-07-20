# HK_Stock — 에이전트/개발자 우선 컨텍스트

수강생 가상 주식판. Vite+React+Firebase(Cloud Functions, 서울 `asia-northeast3`), GitHub Pages.
백엔드 프로젝트 `hk-chess-betting`(★베팅판과 `users`/포인트 공유★). 라이브: `hkkima.github.io/HK_Stock`.

**먼저 `docs/HANDBOOK.md`(특히 §9 인수인계)를 읽어라.** 라이브 시스템(실수강생 24명·실포인트)이다.

## 절대 깨면 안 되는 불변식
1. **총량 보존**: `meta/stockBoard.housePool`은 `FieldValue.increment`로만 변경. read-modify-write 금지(틱이 매분 갱신 → 충돌·`internal`). 포인트 이동은 반대편을 같은 increment로 정산.
2. **체결은 결정적**: 매매 가격에 랜덤 넣지 마라(본전보장 깨짐 → 포인트 복사 재발). 무작위는 `tick.js` 노이즈만.
3. **`src/domain/market.js` ≡ `functions/market.js`**, **`src/domain/events.js` ≡ `functions/events.js`** (각 바이트 동일, `diff` 점검).
4. **`base ≥ 1`** (곡선 양수). 시세 하한 = `slope × circulating`.
5. **포인트·시세·보유 변경은 Cloud Functions(Admin SDK)만**. 클라 읽기 전용, `firestore.rules`가 차단.
6. **`firestore.rules`는 베팅+주식 통합본**(이 리포가 진실원천). 베팅 규칙 깨지 마라.
7. **★팀 = 주식★**: 별도 companies 컬렉션 없음. `stocks/{id}`에 `ceoUserId`(대표)·`corpBalance`(팀 금고)가 얹혀 있다.
   **상장=팀 생성, 상장폐지=팀 해산** → `delistStock`은 잔여 `corpBalance`를 housePool로 회수해야 총량이 보존된다(반영됨).
   총량보존 집합 = `Σ지갑 + Σreserve + **ΣcorpBalance** + housePool + Σescrow`.
8. **`users` 문서 ID ≠ 이름 슬러그일 수 있다**(박지수=`pj15oo`, 이유진=`yoojin`). 조회는 name 필드 폴백 필수.

## 팀 경제 함수 (2026-07-20 배포)
`grantTeamPoints`(운영자: 금고 충전) · `paySalary`(주급, **소득세 10%**→housePool) · `payBonus`(상여, **15%**)
· `payTeamDividend`(자사주 배당) · `redeemCorpService`(교환소 소각). 전부 **CEO만**(`stocks.ceoUserId`+PIN) · 공개 원장 `teamLedger`.
`upsertStock`은 `ceoUserId`를 받고 신규 상장 시 `corpBalance:0` 초기화 — **상장 폼·멤버 테이블에 대표 지정 UI 있음**.
`subscribeShares`(**유상증자 청약** — 팀원만·대금 전액 금고·신주 3일 락업). ★신주는 무담보(reserve 미증가)라
**매도 시 곡선수령을 금고에서 지급**(회사 환매책임) — `trade` 매도 경로가 `holdings.offerShares`/`offerUnlockAt`로 분기한다.
금고가 부족하면 매도 거부. 이 분기가 없으면 housePool 이 대납해 드레인 루프가 생긴다. 회계 검증 = `test-harness/offer_conservation.mjs`.

## 운영/검증 방식
- ★Node에서 콜러블 직접 호출 불가(Cloud Run 인증)★ → 시드·마이그레이션·일괄작업·검증은 **서비스 계정 키 + firebase-admin**으로 Firestore 직접 조작(`test-harness/` 참고). 키는 리포 밖·`.gitignore`.
- 배포: 함수 `firebase deploy --only functions --project hk-chess-betting` / 프론트 `main` 푸시→Actions. 셸 PowerShell(`&&`✕, 커밋 `-m` 여러 개).
- 일치: 리전·운영자이메일(3곳)·market.js 두 사본·events.js 두 사본.

## 코드 지도
`functions/`: index.js(콜러블·스케줄), market.js(곡선), news.js(자동뉴스), events.js(강사 이벤트 카탈로그), tick.js.
`src/`: data/firebase.js·store.js, state/AppContext.jsx, domain/market.js·events.js, pages/(Market·Portfolio·News·Leaderboard·Admin·Login).

- **강사 이벤트**(출결·과제·프로젝트 퀄리티): 자동 랜덤 뉴스와 분리된 별도 레버. 운영자 화면 📣 섹션 →
  `postInstructorEvent`(scope:'stock', kind:'instructor') → 코어 `applyImpactNews`. 프리셋 = `events.js` 두 사본.
- **뉴스 생성 Claude 루틴** 프롬프트: `docs/news-routine-prompt.md`(저품질 자동 엔진 대체용 스케줄 프롬프트).

기능 추가/위험지역/의사결정 로그는 `docs/HANDBOOK.md` §6, §9 참고.
