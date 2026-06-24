# HK_Stock 설계 메모

## 1. 목적·규모
- 수강생 성취감/학습 열정 ↑. 23인, 3~4인 1팀을 1기업(종목)으로.
- 시세는 학생 거래로, 펀더멘탈(강사 평가·근태·과제·뉴스)은 배당·시세조정으로.
- 베팅판(HK_Betting) 포인트를 **그대로 공유** — 같은 Firebase 프로젝트, 같은 `users`.

## 2. 시세 형성: AMM (호가창 ✕)
거래자 23명뿐이라 호가창은 유동성이 죽는다. 시스템이 상대가 되는 AMM 채택.

- 상태(종목): `price`(정수, 포인트/주), `liq`(L), `reserve`, `sharesOut`.
- 매수 q주: `cost = price·q`, 체결 후 `price += round(price·q/L)`.
- 매도 q주: `proceeds = price·q`, 체결 후 `price -= round(price·q/L)` (최저 1).
- 현재가로 즉시 체결 → 항상 유동성. `L` 클수록 둔감(종목별 변동성 연출 가능).

순수 함수 `domain/market.js` 에 격리, vitest 로 검증. `functions/market.js` 와 동일.

## 3. 포인트 회계 (총량 보존)
```
전체 = Σ 지갑 + Σ 리저브 + 하우스 풀
```
- 매수/매도: 지갑 ↔ 리저브 (보존)
- 배당: 하우스 풀 → 지갑 (보존, 잘한 활동 보상)
- 시세조정: `delta = (newPrice−oldPrice)·sharesOut` 만큼 하우스 풀 ↔ 리저브 (보존)
  - 상향 = 하우스→리저브(인플레), 하향 = 리저브→하우스(디플레, 소프트 패널티)
- 발행/소각: 외부 ↔ 하우스 풀 — **유일한 총량 변동 경로**

→ "총량 유지 + 통제된 인플레"는 "신규 포인트는 하우스 풀로만 들어온다"는 한 규칙으로 강제.
지각·사고는 마이너스 배당 대신 **시세 하향**(잔액 불침해, 디플레로 배당 인플레 상쇄).

## 4. 신뢰 경계: Cloud Functions
매도는 학생 잔액을 '증가'시켜야 하는데, 이는 베팅판 규칙(학생은 감소만)과 충돌.
→ 모든 거래/펀더멘탈을 **Cloud Functions(Admin SDK)** 가 원자 실행하고 `ledger` 기록.
클라이언트는 stocks/holdings/ledger/meta 를 **읽기만**. 직접 balance 증가는 규칙이 차단.

함수: `trade`, `upsertStock`, `payDividend`, `adjustPrice`, `postNews`, `mintToHouse`.

## 5. 데이터 모델 (Firestore, 공유 프로젝트)
```
users/{id}              { name, pinHash, balance }        ← 베팅과 공유
stocks/{id}             { name, team, price, liq, reserve, sharesOut, status }
holdings/{id__stockId}  { userId, stockId, shares, avgCost }
trades/{auto}           { userId, stockId, side, qty, price, cash, ts }
ledger/{auto}           { type, delta, ... , ts }          ← 감사 원장(추가전용)
meta/stockBoard         { housePool, news[] }
```
23인 × 7종목이면 holdings 최대 161개. 전체 구독해도 가볍다(RTDB 불필요, 베팅과 동일 스택).

## 6. 거래 모델
- **연속 거래**(장중 즉시 체결). 부하 시 `status` 토글로 장 열고 닫기.
- 펀더멘탈(배당·시세·뉴스)은 **차시/일 단위 배치**로 운영자가 일괄 적용.

## 7. 미해결 / 후속
- 신원: pinHash 공개 읽기 한계(그리핑 가능). PIN 해시 비공개 컬렉션 분리(베팅판 공동) 필요.
- `payDividend` 는 holdings 스냅을 트랜잭션 밖에서 읽음(저빈도 운영 동작이라 허용). 필요 시 tx 내 쿼리로.
- 시세 차트/일변동: 현재 미수집. `trades` 로 사후 차트 가능, 필요 시 `dayOpen` 필드 추가.
