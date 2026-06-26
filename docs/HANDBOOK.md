# HK_Stock 운영·설계 핸드북

> 수강생 가상 주식판. 설계 관점, 전체 기능, 데이터 모델, 운영자 레버, **예외·주의사항**을 한 곳에 정리한다.
> (변경이 잦은 부분은 코드가 진실원천 — 이 문서는 "왜·어떻게·함정"을 설명한다.)

---

## 0. 한눈에

- **무엇**: 23인(3~4인 1팀=1기업) 가상 주식 게임. 시세는 학생 거래로, 펀더멘탈(강사 평가·근태·과제·뉴스)은 배당·시세조정으로.
- **스택**: Vite + React 18 + Firebase(Firestore + Cloud Functions, 서울 리전 `asia-northeast3`). GitHub Pages 배포.
- **라이브**: 프론트 `https://hkkima.github.io/HK_Stock/`, 백엔드 프로젝트 `hk-chess-betting`(★베팅판과 공유★).
- **리포**: `github.com/hkkima/HK_Stock` (main 푸시 → Actions 자동 배포).

> 🛠 **개발을 이어받는 사람/에이전트는 [9. 개발자·에이전트 인수인계](#9-개발자에이전트-인수인계-먼저-읽기)를 먼저 읽어라.** 깨면 안 되는 불변식과 라이브 운영 작업 방식이 거기 있다.

---

## 1. 설계 관점 (왜 이렇게 만들었나)

### 1.1 포인트는 베팅판과 공유
`users` 컬렉션(이름·PIN·balance)을 베팅판과 **같은 Firebase 프로젝트에서 공유**한다. 학생은 같은 이름+PIN으로 로그인하고, 포인트가 두 시스템에서 통용된다.
→ 별도 지갑이면 정합이 깨지므로 단일 지갑을 쓴다.

### 1.2 시세 = 고정발행 본드커브 (호가창 ✕)
거래자가 23명뿐이라 진짜 호가창(주문매칭)은 유동성이 죽는다. 그래서 시스템이 상대가 되는 **AMM 본드커브**를 쓴다.
- `현재가 price(c) = base + slope·c` (c = 유통주식수 = 학생 보유 합).
- 매수 q주: 비용 = 곡선 적분 `Σ price(i)`. 매도: 같은 구간 적분.
- ★**사고 곧바로 팔면 정확히 본전** → 자기 거래로 포인트를 복사할 수 없다.★ (구버전의 "현재가 체결 후 가격 이동" AMM은 자기 매수가 가격을 올려 차익이 나는 버그가 있어 폐기.)
- **발행주식수(totalShares) 고정**, 전량 트레저리에서 출발. 학생은 트레저리에서 매매하고 발행량을 초과해 살 수 없다.

### 1.3 총량 보존
```
전체 포인트 = Σ(학생 지갑) + Σ(AMM 리저브) + 하우스 풀   ← 항상 일정
```
이 합은 **발행/소각(mintToHouse)** 으로만 변한다. 거래·배당·시세조정·뉴스·틱·스톡옵션은 전부 세 칸 사이의 이동일 뿐이다. 충돌·복사 방지를 위해 housePool은 **반드시 `FieldValue.increment`** 로만 갱신한다(절대값 set 금지).

### 1.4 거래는 결정적, 불확실성은 "노이즈 레이어"
- 매수/매도 체결은 **결정적 본드커브**(본전 보장 불변).
- "예측 불가"는 매 1분 **시세 틱**(랜덤 평균회귀 노이즈)이 만든다.
- ⚠️ 체결가 자체를 랜덤화하면 본전 보장이 깨져 **포인트 복사 버그가 재발**한다. 그래서 둘을 분리했다.

### 1.5 신뢰 경계 = Cloud Functions
모든 포인트·시세·보유 변동은 **함수(Admin SDK)** 만 한다. 클라이언트는 stocks/holdings/ledger/series/candles/meta 를 **읽기만** 한다. 직접 잔액 증가는 firestore.rules 가 차단한다.

---

## 2. 전체 기능

### 학생 화면
- **로그인**: 이름 + PIN(베팅판과 공유). 익명 Firebase 인증으로 함수 호출.
- **시세**: HK 종합지수(상단) · 뉴스 요약 · **큰 차트 + 우측 종목 리스트(선택형)** · 기간탭(1일=분봉 / 1주·전체=일봉) · 한국 증시 색(상승 빨강·하락 파랑) · 매수/매도(예상 체결액) · 호가 사다리.
- **내 자산**: 현금·주식 평가액·순자산, 보유 종목별 평가손익 + **매도** (스톡옵션 잠금분 제외).
- **뉴스 탭**: 전체 뉴스 피드(▲호재/▼악재 + 대상 뱃지).
- **리더보드**: 순자산(현금 + 보유 평가액) 순위.

### 운영자 화면 (섹션)
- **총량 점검 · 시장 통제**: 지갑/리저브/하우스/전체/시총 + **시장 전체 일괄 조정(±%)**.
- **① 상장**: 종목ID·기업명·팀·시작가·발행주식수·변동성·업종·특성.
- **상장 종목 표**: 발행수·변동성·업종·특성 인라인 편집, 거래 열기/닫기, **상폐**.
- **② 배당 · ③ 시세조정**: 배당(하우스풀→보유자) / 시세 목표가 설정.
- **④ 뉴스 · 발행**: 자동뉴스 ON/OFF·즉시 1건 / **뉴스 작성 + 시세 조작(전체/종목/업종/테마 + %)** / 하우스풀 발행·소각.
- **⑤ 멤버 · 스톡옵션**: 기업 멤버 지정 / 스톡옵션 지급.

### 자동(스케줄, 서울 시간)
- **09:00 개장 / 18:00 마감**: 상태 전환, 분봉 초기화, 일봉(OHLC) 집계, 전일종가 저장.
- **매 1분 시세 틱**: 종목별 평균회귀 노이즈.
- **장중 랜덤 자동뉴스**: 30분 슬롯마다 확률 발동(≈2.5건/일), 토글 ON일 때만.
- **예약 뉴스 발행**: 매분 만기된 예약(`scheduledNews`)을 자동 게시(종일). 운영자 ④에서 내용·대상·시세% + 시각 지정.

---

## 3. 데이터 모델 (Firestore, 베팅판과 공유 프로젝트)

```
users/{id}                  { name, pinHash, balance }            ← 베팅과 공유
stocks/{id}                 { name, team, sector, base, centerBase, slope,
                              totalShares, circulating, reserve, price,
                              prevClose, dayOpen, refPrice, status,
                              priceHistory[], members[] }
stocks/{id}/series/intraday { points:[{p,t}] }   분봉(롤링 600)
stocks/{id}/candles/{date}  { date, o, h, l, c }  일봉
stockTraits/{id}            { traits:[..] }       특성(비공개·운영자만 read)
holdings/{userId__stockId}  { userId, stockId, shares, locked, avgCost }
trades/{auto}               { userId, stockId, side, qty, price, cash, ts }
ledger/{auto}               { type, ... , ts }    감사 원장(추가전용)
meta/stockBoard             { housePool, news[], autoNewsEnabled }
```
- `price` = `base + slope·circulating` 캐시. `shares`는 잠금(스톡옵션) 포함 총보유, `locked`는 매도불가분.
- 23인 × 종목 수면 holdings 수백 개 수준 → 전체 구독 가벼움. 분봉만 선택 종목 1개 구독(대역폭 절약).

---

## 4. Cloud Functions (콜러블·스케줄)

| 함수 | 권한 | 역할 |
|---|---|---|
| `trade` | 학생 | 매수/매도(본드커브). 자사주 매수 차단, 잠금주식 매도 차단 |
| `upsertStock` | 운영 | 상장/수정(시세는 생성 시만, 이후 adjustPrice) |
| `payDividend` | 운영 | 하우스풀 → 보유자(perShare×보유) |
| `adjustPrice` | 운영 | 시세 목표가 설정(곡선 평행이동, 총량보존) |
| `marketReprice` | 운영 | **전체 종목 ±% 일괄 조정**(통합 디플레/인플레 레버) |
| `postNews` | 운영 | (구) 텍스트 뉴스 |
| `postImpactNews` | 운영 | **뉴스 작성 + 대상(전체/종목/업종/테마) 시세 동시 조작** (코어 `applyImpactNews` 공용) |
| `scheduleNews` / `cancelScheduledNews` | 운영 | **뉴스 예약 등록 / 취소** (지정 시각 자동 발행) |
| `publishScheduledNews` | 스케줄 | **매분 만기된 예약 뉴스 발행**(`applyImpactNews` 호출) |
| `triggerNews` / `setAutoNews` | 운영 | 즉시 랜덤 뉴스 / 자동뉴스 토글 |
| `mintToHouse` | 운영 | 하우스풀 발행/소각(유일한 총량 변동) |
| `grantOption` | 운영 | 멤버에게 거래금지 자사주 발행(하우스풀 대납) |
| `delistStock` | 운영 | 상폐(정산가×보유 지급 후 삭제) |
| `openMarket` / `closeMarket` | 스케줄 | 09:00 개장 / 18:00 마감 + 일봉 집계 |
| `marketTick` | 스케줄 | 매 1분 평균회귀 노이즈 |
| `autoNews` | 스케줄 | 장중 랜덤 뉴스 |

순수 엔진은 `functions/market.js`(본드커브), `functions/news.js`(뉴스), `functions/tick.js`(노이즈). `market.js`는 `src/domain/market.js`와 **바이트 동일**.

---

## 5. 운영자 레버 가이드

- **펀더멘탈 보상/패널티** → ③ 시세조정(특정 종목 목표가) 또는 ② 배당(현금 지급).
- **테마 이벤트** → ④ 뉴스작성+시세조작에서 업종/테마 선택 + % → 해당 종목 동반 등락 + 뉴스.
- **시장 과열 식히기** → 총량점검의 **시장 전체 일괄 조정**에 `-20` 등.
- **인플레(돈 공급) 조절** → ④ 발행/소각. 단 지갑은 베팅과 공유라 완전 통제는 두 앱 공동.
- **자사주/스톡옵션** → ⑤에서 멤버 지정 후 스톡옵션 지급(거래금지·배당O).
- **장 운영** → 자동(9~18시). 수동으로 종목별 거래 열기/닫기 가능.

---

## 6. ★ 예외 · 주의사항 (함정) ★

1. **돈 공급은 베팅판과 공유** — 총량(포인트)이 늘어도 주식판 누수가 아니라 **베팅 지급/정산**이 같은 지갑을 키운 경우가 많다. 라이브에서 total을 비원자적으로 재면 동시 거래로 ±수백 노이즈가 낀다(누수 아님).
2. **하우스 풀 음수 허용** — 틱·배당·옵션 등은 사전 잔액 체크 없이 increment로 차감하므로 하우스 풀이 음수가 될 수 있다. 총량은 보존(하우스가 "빚"). 0으로 맞추려면 발행(인플레)하거나 그냥 둔다.
3. **시세 하한 = 변동성 × 유통주식** — 본드커브라 `slope·circulating` 아래로는 ③로 못 내린다(곡선 음수 방지). 유통이 많은 종목은 바닥이 높다. 더 내리려면 변동성↓ 또는 학생 매도(유통↓) 또는 **액면분할**.
4. **변동성은 정수만** — 음수(역방향·음수가격)·소수(포인트 소수화·부동소수 오차로 본전보장 흔들림) 금지. 막아둠.
5. **스톡옵션이 저가·가파른 곡선 종목에선 가치 초과** — qty가 유통 대비 크면 발행이 시세를 밀어올려 의도한 값(예 5,000p)을 넘긴다(예: WEED 25주 ≈ 12,000p). 고가·소량 종목은 정확. 균등 보상하려면 qty를 작게 하거나 변동성을 낮춰라.
6. **액면분할 시 totalShares도 ×배수** — 유통만 ×배수 하면 유통>발행이 되어 이후 발행/옵션이 막힌다(실제 겪음). 분할은 holdings(shares·locked ×k, avgCost ÷k) + circulating·totalShares ×k + base·slope·refPrice·prevClose·priceHistory ÷k. 리저브는 불변(포인트 보존).
7. **변동성·분할 편집은 reserve를 곡선과 어긋나게** 만든다(과/부족 funding). 총량은 보존되지만 리저브에 "갇힌 초과분"이 생길 수 있다(상폐 시 하우스로 정산). 포인트 생성은 아님.
8. **운영자 구글 인증이 GitHub Pages에서 끊길 수 있음** — 새로고침 후 팝업 세션이 안 남으면 함수 호출이 빈 토큰으로 가 'internal' 발생. 상단 **빨간 재로그인 배너**가 뜨면 Google 재로그인. (실제 원인이 충돌이면 '일시 오류'로 표시.)
9. **PIN 해시가 공개 읽기** — users가 전체 공개라 pinHash 노출. 자기 이득(매수/매도/배당)은 함수 검증으로 막히지만 **사칭(그리핑)** 은 완전 차단 안 됨. 후속: PIN 해시 비공개 컬렉션 분리(베팅판 공동).
10. **Node에서 콜러블 직접 호출 불가** — Cloud Run + Node fetch의 Authorization 처리 차이로 인증 실패. 그래서 자동 운영/검증은 **서비스 계정 키 + Admin SDK** 로 한다(브라우저 경로는 정상).
11. **시가총액 = 현재가 × 발행주식수(totalShares)** — 발행수를 크게(5만·10만) 잡은 종목은 시총이 비현실적으로 커진다. 발행수를 학생 규모에 맞게(예 1,000~2,000) 잡는 게 좋다.
12. **HK 종합지수 베이스라인 = 도입일(2026-06-25)** — refPrice를 그날 현재가로 스냅샷. 등가중 수익률지수 `mean(price/refPrice)×100`. 시간 차트는 아직 없음(현재값만).
13. **특성(traits)은 비공개** — 학생 화면 뉴스 뱃지는 '테마'로만 표시(특성명 숨김). 운영자만 stockTraits read.
14. **변동성(slope)은 학생에게 숨김** — 시세 상세에서 제거(운영자 종목표에선 보임).
15. **자동 뉴스는 무작위·저빈도** — 1종목짜리 특성이 자주 걸려 "개별처럼" 보일 수 있다. 확실한 테마 동반등락은 ④ 뉴스작성+시세조작으로 직접.

---

## 7. 튜닝 포인트

- **변동성(slope)**: 종목 출렁임. 시세 틱 σ도 slope에 비례(slope 5 ≈ ±1%/틱, 상한 3%). 곡선 하한도 결정.
- **자동뉴스**: 비중 호재0.3/악재0.5/중립0.2, 빈도 ≈2.5건/일, 폭 ±3~8%. (`functions/news.js`)
- **시세 틱**: θ(회귀강도)=0.08, 1분 간격. (`functions/tick.js`)
- **배당·옵션 규모**: 학생 수·종목 수·하우스 풀 잔액 대비.
- **뉴스 문구**: `functions/news.js` TPL 또는 `/stock-news` 스킬로 보충.

---

## 8. 미해결 · 후속 아이디어

- PIN 해시 비공개 분리(사칭 차단, 베팅판 공동).
- 정식 "액면분할" 운영자 버튼(totalShares 자동 ×배수).
- HK 종합지수 시간 차트(이력 저장).
- 스톡옵션 잠금 해제(과정 종료 시 정산/매도 허용).
- 발행주식수 현실화(시총 왜곡 해소).
- 뉴스 개별 삭제/템플릿 편집 UI.

---

## 9. 개발자·에이전트 인수인계 (먼저 읽기)

라이브 시스템(실수강생 24명·실포인트, 베팅판과 공유)이다. **아래 불변식을 깨면 학생 데이터/포인트가 망가진다.**

### 9.1 절대 불변식 (깨면 안 됨)

1. **총량 보존 — housePool은 `FieldValue.increment`로만 변경.**
   `meta/stockBoard`를 read해서 housePool을 절대값으로 set 하지 마라. 시세 틱이 매분 이 문서를 갱신하므로 read-modify-write 트랜잭션은 충돌→재시도 초과→`internal` 에러가 난다(실제 겪음: 발행 버튼 먹통). 포인트를 옮기는 동작은 **반대편을 같은 increment로 정산**해 합계를 보존한다.
2. **체결은 결정적으로.** 매수/매도 가격에 랜덤을 넣지 마라 → "사고 곧바로 팔면 본전" 보장이 깨지고 **포인트 복사 버그가 재발**한다. 무작위성은 `tick.js` 노이즈 레이어로만(시세를 흔들되 체결식은 결정적).
3. **`market.js` 두 사본은 바이트 동일.** `src/domain/market.js` ≡ `functions/market.js` (`diff`로 점검). 한쪽만 고치면 프론트 미리보기와 서버 체결이 어긋난다.
4. **곡선 양수: `base ≥ 1`.** 시세 하향 시 `newBase < 1`이면 거부/클램프. 시세 하한 = `slope × circulating`.
5. **모든 포인트·시세·보유 변경은 Cloud Functions(Admin SDK)만.** 클라이언트는 읽기 전용. `firestore.rules`가 클라의 직접 잔액 증가를 차단. 새 쓰기 경로를 만들면 규칙도 같이 손본다.
6. **`users`는 베팅판과 공유.** `firestore.rules`는 베팅+주식 **통합본**(이 리포가 진실원천·상위집합). 베팅 규칙(참가자는 잔액 감소만 등)을 깨지 마라.

### 9.2 개발·배포 워크플로우

- 테스트/빌드: `npm test`(vitest, 순수 도메인만), `npm run build`, `npm run dev`(:5290). 도메인 로직은 `src/domain/market.js` 등 **순수 함수로 빼서 테스트**하는 게 컨벤션.
- 함수 배포: `firebase deploy --only functions --project hk-chess-betting`. 간헐적 `Internal error`는 GCP 일시장애 → ~45초 후 재시도. 첫 배포 시 IAM(컴퓨트 SA에 `cloudbuild.builds.builder`) 필요했음.
- 규칙 배포: `firebase deploy --only firestore:rules --project hk-chess-betting`.
- 프론트: `main` 푸시 → GitHub Actions → Pages. **리포 이름이 `HK_Stock`** 이어야 `vite.config.js` base(`/HK_Stock/`)와 맞는다.
- ★일치시킬 3쌍★: 리전(`asia-northeast3` = 프론트 `VITE_FUNCTIONS_REGION` = `setGlobalOptions` = 배포 리전) / 운영자 이메일(functions `ADMIN_EMAILS` = rules = 프론트 `VITE_ADMIN_EMAILS`) / market.js 두 사본.
- 셸은 PowerShell — `&&` 안 됨(`;` 또는 줄 분리). 커밋 메시지는 `-m` 여러 개로(여기서 heredoc은 자주 깨짐).

### 9.3 라이브 운영·검증은 "서비스 계정 키 + Admin SDK"로

- ★**Node에서 콜러블 함수 직접 호출이 안 된다**★ (Cloud Run + Node fetch의 Authorization 처리 차이로 인증 실패. 브라우저 경로는 정상). 그래서 시드·마이그레이션·일괄작업(발행·분할·옵션 지급 등)과 검증은 **firebase-admin(서비스 계정 키)으로 Firestore 직접 조작**한다. `test-harness/`에 패턴이 있다(`seed.mjs`). 키는 리포 밖·`.gitignore`, 사용 후 콘솔에서 로테이션.
- 검증: 순수 엔진을 키로 라이브 데이터에 실행(`applyTick`, `generateNews`)하거나, 브라우저를 preview 도구로 `localStorage` 세션 주입 후 구동. **`total()`(Σ지갑+Σ리저브+하우스) 측정은 비원자**라 동시 거래로 ±수백 노이즈가 낀다 — 한 동작의 보존은 통제된 환경에서 확인.
- 일괄 스크립트는 **부분 실패 대비**(예: 분할에서 `totalShares` ×배수를 빠뜨려 옵션 발행이 중간에 막혔던 사고). 트랜잭션·try/catch·진행로그·보존 체크를 넣어라.

### 9.4 위험 지역 (조심)

- `meta/stockBoard` = **핫 문서**(틱이 매분 housePool, autoNews가 news 배열 갱신). 여기를 read-modify-write 하면 충돌. increment 패턴 유지.
- `trade` 함수는 **실수강생이 실시간 사용**. 수정 시 본전보장·자사주 매수금지·잠금주식 매도금지 로직 보존.
- `slope`/`totalShares`/분할 편집은 `reserve`를 곡선과 **어긋나게** 한다(과/부족 funding). 총량은 보존되지만 "갇힌 초과분"이 생기고 상폐 정산에서 흡수된다. 포인트 생성은 아님.
- 변동성은 **정수만**(음수=역방향·음수가격, 소수=포인트 소수화·부동소수 오차로 본전보장 흔들림).

### 9.5 코드 지도

```
functions/
  index.js   콜러블·스케줄 17개 (assertAdmin/assertAuth, boardRef, appendHist)
  market.js  본드커브 순수엔진 (quoteBuy/Sell, rangeSum, priceAdjustDelta)  ← src와 동일
  news.js    뉴스 엔진(generateNews: 개별/업종/특성 타겟)
  tick.js    시세 틱(tickDelta: OU 평균회귀)
src/
  data/firebase.js   init + callable() 래퍼(에러→재로그인/일시오류 매핑) + watchAuth
  data/store.js      구독(stocks/holdings/users/board/series) + 함수 래퍼
  state/AppContext.jsx  세션·로그인·구독·인증상태(adminReauthNeeded)
  domain/market.js   ← functions/market.js와 바이트 동일
  pages/  MarketPage(시세·차트·지수·거래) PortfolioPage(매도) NewsPage
          LeaderboardPage AdminPage(운영 6섹션) LoginPage
firestore.rules  베팅+주식 통합본(진실원천)
test-harness/    서비스계정 키로 시드·검증(seed.mjs)
```

### 9.6 기능 추가 체크리스트

- 포인트를 옮기나? → **increment로 양쪽 정산** + 총량 보존 확인.
- `market.js`를 건드리나? → **두 사본 동기화**(diff).
- 콜러블 추가? → `store.js` 래퍼 + (운영자면) `assertAdmin` + 리전 일치 + UI.
- 새 컬렉션/하위컬렉션? → `firestore.rules`에 read 규칙(쓰기는 `if false`=함수만).
- 시세를 바꾸나? → `base≥1`, 곡선/리저브 정합, **펀더멘탈 변경이면 `centerBase`도 같이 이동**(노이즈가 새 기준으로 수렴).
- 학생에게 노출되나? → 특성(traits)·변동성(slope)은 **숨김** 정책 유지(뱃지 '테마', 변동성 비표시).
- 라이브 마이그레이션? → 보존 체크 + 부분실패 대비 + 키는 안전 처리.

### 9.7 의사결정 로그 (사용자가 선택한 관점 — 함부로 뒤집지 말 것)

- 거래 모델: **고정발행 본드커브**(P2P 호가창 ✕ — 유동성 문제).
- 거래 실행: **Cloud Functions 권위**(규칙 전용 ✕ — 매도 시 잔액 증가가 베팅 규칙과 충돌).
- 시세 틱: 1분, σ는 slope 비례(기준 ±1%), 중앙 수렴.
- 자동뉴스: 하루 2~3회, ±3~8%, 개별40/업종30/특성30(악재 비중 상향 0.5).
- 스톡옵션: 공식 발행(시세 반영)·거래금지.
- 시가총액: 발행주식수 기준.

---
### 9.8 까미 봇(외부 자동매매) — 앱 밖에 있음

까미는 플레이어 중 하나라 **앱(HK_Stock) 안에 UI/Cloud Function 으로 두지 않는다.** 별도 폴더
`C:\HK_Bot\kami-bot\`(독립 Node 스크립트)에서 서비스계정 키 + Admin SDK 로 거래한다.
- 시세 수학은 `functions/market.js` 를 **그대로 import**(본전보장·중복구현 방지). 거래 트랜잭션은
  `trade` 함수를 복제(현금 지갑↔리저브, housePool 불변, 총량 보존).
- 전략: 뉴스 반응형 + 공격형(순자산 75% 투자) + 분할 매매. 상세·튜닝은 `kami-bot/README.md`.
- ★실행 전 `node kami-bot.mjs --dry --once` 로 확인★. 실거래는 `node kami-bot.mjs`(장중 2분 루프).

---
*최종 갱신: 2026-06-26. 함수 20개(예약 뉴스 3종 추가), 라이브 운영 중. 까미 봇은 외부 스크립트(kami-bot/).*
