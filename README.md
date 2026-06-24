# 📈 HK_Stock — 수강생 가상 주식판

수강생(23인, 3~4인 1팀 = 1기업)을 종목으로 하는 가상 주식 시스템.
**베팅판(HK_Betting)과 같은 포인트**를 공유하며, 시세는 학생 거래(AMM)로 움직이고
펀더멘탈(강사 평가·근태·과제·뉴스)은 배당과 시세조정으로 반영된다.

- 프론트: Vite + React 18 → GitHub Pages (베팅판과 **별도 리포/배포**)
- 백엔드: **베팅판과 같은 Firebase 프로젝트** (Firestore + Cloud Functions)
- 거래/배당/시세조정은 전부 **Cloud Functions(권위 실행)** — 클라이언트는 읽기 전용

> 포인트(`users.balance`)를 공유하려면 두 앱이 **같은 `projectId`** 를 써야 한다.
> 학생은 베팅판과 **같은 이름·PIN**으로 로그인한다.

---

## 경제 모델 한 줄 요약

```
전체 포인트 = Σ(학생 지갑) + Σ(AMM 리저브) + 하우스 풀     ← 항상 보존
```

이 합이 변하는 경로는 **하우스 풀 발행/소각(④)** 하나뿐. 나머지는 전부 자리 이동:

| 동작 | 흐름 | 효과 |
|---|---|---|
| 매수 | 지갑 → 리저브 | 시세 ↑ |
| 매도 | 리저브 → 지갑 | 시세 ↓ |
| 배당(②) | 하우스 풀 → 지갑 | 잘한 활동 보상(인플레) |
| 시세조정 상향(③) | 하우스 풀 → 리저브 | 좋은 펀더멘탈, 평가이익 |
| 시세조정 하향(③) | 리저브 → 하우스 풀 | 지각·사고 '소프트 패널티'(디플레) |
| 발행/소각(④) | 외부 ↔ 하우스 풀 | **유일한 총량 변동** |

지각·사고는 **마이너스 배당이 아니라 시세 하향**으로 처리(잔액을 뺏지 않음).
AMM 시세 공식: 매수/매도는 현재가로 즉시 체결 → 직후 `price ± round(price×q/L)`.
`L`(유동성계수)이 클수록 둔감. 종목별로 다르게 줄 수 있다.

---

## 디렉터리

```
src/
  domain/market.js     순수 AMM 엔진 (테스트 대상)  ─┐ 바이트 동일
  data/firebase.js     Firebase init + callable 래퍼   │
  data/store.js        구독 + 함수 호출                 │
  state/AppContext.jsx 세션/구독/파생값                 │
  pages/               시세·내자산·리더보드·운영자·로그인 │
functions/
  index.js             trade / upsertStock / payDividend / adjustPrice / postNews / mintToHouse
  market.js            순수 AMM 엔진 (권위 실행)       ─┘
firestore.rules        베팅+주식 통합 규칙 (공유 프로젝트용)
```

`src/domain/market.js` 와 `functions/market.js` 는 **반드시 동일**해야 한다(`diff` 로 점검).

---

## 로컬 실행

```bash
cp .env.example .env      # 베팅판과 같은 Firebase 값 + 운영자 이메일 채우기
npm install
npm run dev               # http://localhost:5290
npm test                  # AMM 엔진 단위 테스트
```

`.env` 가 비어 있으면 UI 미리보기만 되고 실데이터는 안 붙는다.

---

## 배포

### 1) Cloud Functions + 규칙 (베팅판과 같은 프로젝트)
함수 사용에는 **Blaze 요금제**가 필요(23명 규모면 무료 한도 안, 실비 ≈ $0). 예산 알림 설정 권장.

```bash
cd functions && npm install && cd ..
firebase use <베팅판과_같은_프로젝트ID>
firebase deploy --only functions,firestore:rules
```

- `functions/index.js` 의 `ADMIN_EMAILS` 와 `firestore.rules` 의 운영자 이메일,
  프론트 `VITE_ADMIN_EMAILS` **세 곳을 일치**시킬 것.
- `firestore.rules` 는 베팅+주식 **통합본**이다. 이걸 배포하면 베팅판도 그대로 동작한다.
  (베팅판 리포의 규칙과 어긋나지 않게, 규칙 변경은 이 파일을 기준으로 한다.)

### 2) 프론트 (GitHub Pages)
리포 이름이 `HK_Stock` 가 아니면 `vite.config.js` 의 base 를 맞춘다.
GitHub → Settings → Secrets 에 `VITE_FIREBASE_*`, `VITE_ADMIN_EMAILS`,
`VITE_FUNCTIONS_REGION` 등록 후 `main` 푸시 → Actions 가 자동 배포.

Firebase Console → Authentication → **익명 로그인 켜기**(거래 함수 호출에 필요),
**Google 로그인 켜기**(운영자), 승인된 도메인에 GitHub Pages 도메인 추가.

---

## 운영 흐름 (운영자)

1. **상장(①)** — 팀별로 종목 생성(시작가에 펀더멘탈 반영). 처음엔 '닫힘'.
2. **하우스 풀 발행(④)** — 배당·시세 상향에 쓸 재원을 미리 채워둔다.
3. **거래 열기** — 상장 종목을 '열기'로 전환하면 학생이 매매 시작.
4. 수업 종료/차시마다 **배당(②)·시세조정(③)·뉴스(④)** 로 펀더멘탈 반영.
5. **총량 점검** — 운영자 화면 상단에서 지갑+리저브+하우스 합계가
   발행/소각 외엔 변하지 않는지 확인.

---

## 보안 / 위협 모델 (솔직히)

- ✅ **자기 잔액 임의 증가 불가**: 매도·배당의 balance 증가는 Cloud Functions(Admin SDK)만.
  클라이언트 직접 증가는 규칙이 차단. AMM 체결가·시세 이동도 서버가 계산(클라 위조 무의미).
- ✅ **총량 보존**: 발행/소각을 제외한 모든 변동은 함수가 원장(`ledger`)에 기록하며 합계 불변.
- ⚠️ **신원은 경량**: 거래 함수가 `pinHash` 일치를 확인하지만, `users` 가 공개 읽기라
  pinHash 가 노출될 수 있다(베팅판도 동일). 즉 *남 대신 거래*(그리핑)는 완전 차단되지 않는다.
  자기 이득 취득(매수/매도/배당)은 함수 검증으로 막힌다.
  - 강화하려면: PIN 해시를 공개 읽기 아닌 별도 컬렉션으로 분리(베팅판과 함께). 후속 과제.
- 전 거래·정산은 `ledger`/`trades` 에 남아 **사후 감사·정정**이 가능.
