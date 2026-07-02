# DP 교환소 설계 (DP Exchange)

> 수강생이 게임 포인트(`balance`)를 **DP(따봉포인트)** 로 바꾸고, DP로 현물 상품(치킨·가챠 등)을 교환하는 시스템.
> 별도 프론트엔드 + **같은 Firebase 프로젝트(`hk-chess-betting`)**. 모든 쓰기는 Cloud Functions(Admin SDK) 권위.
> 최종 확정: 2026-06-25. 상위 컨텍스트는 `docs/HANDBOOK.md`(불변식), 경제 결정은 메모리 `hk-stock-roadmap`.

---

## 1. 설계 결정 (확정)

- **DP는 별도 통화** — `balance`(게임 포인트, 베팅·주식 공유)와 다른, 실예산(치킨 등)이 걸린 재화.
- **보상 정책: 포인트 XOR DP.** 현재 정기 보상은 **포인트(배당식 UBI)**, DP 직접 지급은 **특수 이벤트(추석 등)만**. 따라서 학생이 상품을 더 받으려면 **교환소(포인트→DP)** 가 주 통로.
- **매수 곡선 = 개인별 누적 2차곡선, 매주 초기화.**
  - n번째(이번 주) DP 한계가 = `R0 + k·i²` (i = 이번 주 이미 산 개수, 0-index). 확정값 **R0=10,000, k=1,000, exp=2**.
  - 곡선 카운터는 **매주(Asia/Seoul) 리셋**. 누적 매수는 유한 포인트(게임 5개월 종료)로 자연 상한.
- **매도(DP→balance)는 OFF** (게임 포인트 인플레 방지). 설정 플래그로 잠금.
- **현물 상품 = 고정가 카탈로그 + 재고 한정.**
- **예산 가드** = 유한 포인트 × 가파른 2차곡선(+ 선택적 백스톱 캡). worst ≈ 50만 이내.

### 불변식 (HANDBOOK §9.1 연장)
1. **`balance` 총량 보존**: 교환은 지갑↔하우스풀 이동. `convertToDP`는 `balance` 차감분을 `housePool`에 **`FieldValue.increment`로** 더한다(반대편 정산). board는 read 금지.
2. **DP는 별도 통화** — 발행(grant)·소각(redeem)은 게임 총량과 무관, 전용 ledger 기록.
3. **쓰기는 함수만** — 클라 읽기 전용, `firestore.rules`가 차단.
4. **`market.js` 안 건드림** — 곡선은 별도 순수 엔진 `functions/dpcurve.js`.
5. **결정적 정수 연산** — R0·k·i² 모두 정수, 비용 정수. 부동소수 없음.

---

## 2. 통화·보존 모델

```
게임 포인트(balance):  Σ지갑 + Σ리저브 + housePool   ← 항상 보존 (기존 불변식)
DP:                    Σ(dpAccounts.dp)              ← grant로 발행, redeem으로 소각(실예산 소비)

convertToDP(qty):  balance −cost  →  housePool +cost(increment) ,  dp +qty       [게임포인트 보존, DP 발행]
redeemGoods(g):    dp −priceDP ,  goods.stock −1 ,  redemption(pending)           [DP 소각 = 실예산 소비]
grantDP(amt):      dp +amt                                                          [이벤트 발행]
(sell OFF)
```

- `convertToDP`에서 포인트가 housePool로 흘러들어가 **housePool은 양수로 커질 수 있음**(정상). 반드시 increment.
- DP 소각(redeem)은 게임 포인트와 무관 — 강사진이 오프라인으로 상품 지급(실예산 차감).

---

## 3. 데이터 모델 (Firestore)

```
dpAccounts/{userId}     { dp, weekKey, weekCount, totalBought, updatedAt }
                          dp        = 보유 DP
                          weekKey   = 현재 주 키(예 "2026-W26", Asia/Seoul)
                          weekCount = 이번 주 매수 DP 수(곡선 인덱스, 주마다 0 리셋)
                          totalBought = 과정 누적 매수(백스톱 캡·통계용)

dpGoods/{id}            { name, priceDP, stock, active, sort }     현물 카탈로그
dpRedemptions/{auto}    { userId, name, goodsId, goodsName, priceDP,
                          status: 'pending'|'fulfilled'|'cancelled', ts, fulfilledAt }
meta/dpExchange         { R0, k, exp, sellEnabled:false, perWeekCap:null,
                          perCourseCap:null, redeemEnabled:true, convertEnabled:true }
ledger/{auto}           { type:'dp_convert'|'dp_redeem'|'dp_grant', userId, ... , ts }
users/{id}              (기존, 공유) — balance·pinHash 사용. DP는 dpAccounts에 분리.
```

- DP를 `users`에 안 넣고 `dpAccounts`로 분리: 베팅과 공유되는 `users` 문서를 안 건드림.
- `meta/dpExchange`로 파라미터를 런타임 조정(재배포 불필요).

---

## 4. 곡선 엔진 `functions/dpcurve.js` (순수)

```js
// 개인별 누적 2차곡선. i = 이번 주 이미 산 DP 수(0-index). 정수 연산.
export function marginal(i, R0, k, exp) {
  return Math.round(R0 + k * Math.pow(i, exp));
}
// startCount(=weekCount)에서 qty개를 살 때 총 포인트 비용.
export function rangeCost(startCount, qty, R0, k, exp) {
  let s = 0;
  for (let i = startCount; i < startCount + qty; i++) s += marginal(i, R0, k, exp);
  return s;
}
// 예산(가용 포인트)로 startCount부터 살 수 있는 최대 수량.
export function maxBuyable(startCount, budget, R0, k, exp) {
  let n = 0, c = 0;
  for (;;) { const next = marginal(startCount + n, R0, k, exp); if (c + next > budget) break; c += next; n++; }
  return n;
}
export const DP_DEFAULTS = { R0: 10000, k: 1000, exp: 2 };
```

확정값에서 한계가: 1번째 10,000 · 2번째 11,000 · 3번째 14,000 · 4번째 19,000 · 5번째 26,000 …
주 가용(2,000×5=10,000)=R0 → 보통 **주 1개**, 저축 시 2차라 급격히 비싸짐.

---

## 5. 주간 초기화

```js
// Asia/Seoul 기준 ISO 주 키. 매 호출 시 현재 주와 비교해 weekCount 리셋.
function seoulWeekKey(d = new Date()) {
  const s = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = (s.getDay() + 6) % 7;                 // 월=0
  s.setDate(s.getDate() - day + 3);                 // 목요일
  const firstThu = new Date(s.getFullYear(), 0, 4);
  const week = 1 + Math.round(((s - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return `${s.getFullYear()}-W${String(week).padStart(2, '0')}`;
}
```
`convertToDP` 진입 시 `weekKey !== seoulWeekKey()` 이면 `weekCount = 0`으로 보고 계산.

---

## 6. Cloud Functions (asia-northeast3, `functions/index.js`에 추가)

> 학생용은 PIN 검증(`trade`와 동일 패턴), 운영자용은 `assertAdmin`. region·운영자이메일은 기존과 일치.

### 6.1 `convertToDP` — 학생: 포인트 → DP (곡선·주간 리셋)
```js
import { rangeCost, DP_DEFAULTS } from './dpcurve.js';

export const convertToDP = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, qty } = req.data || {};
  const q = Math.floor(Number(qty));
  if (!userId || !Number.isInteger(q) || q <= 0) throw new HttpsError('invalid-argument', 'userId/qty(1+) 필요.');

  const cfg = (await db.doc('meta/dpExchange').get()).data() || {};
  if (cfg.convertEnabled === false) throw new HttpsError('failed-precondition', '교환이 일시 중지되었습니다.');
  const R0 = cfg.R0 ?? DP_DEFAULTS.R0, k = cfg.k ?? DP_DEFAULTS.k, exp = cfg.exp ?? DP_DEFAULTS.exp;
  const wk = seoulWeekKey();

  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const aRef = db.doc(`dpAccounts/${userId}`);
    const [uSnap, aSnap] = await Promise.all([tx.get(uRef), tx.get(aRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    const user = uSnap.data();
    if (user.pinHash && pinHash !== user.pinHash) throw new HttpsError('permission-denied', 'PIN 불일치.');

    const acc = aSnap.exists ? aSnap.data() : { dp: 0, weekKey: wk, weekCount: 0, totalBought: 0 };
    const weekCount = acc.weekKey === wk ? (acc.weekCount || 0) : 0;       // 주 바뀌면 리셋
    if (cfg.perWeekCap && weekCount + q > cfg.perWeekCap) throw new HttpsError('failed-precondition', `주간 한도 초과(${cfg.perWeekCap}).`);
    if (cfg.perCourseCap && (acc.totalBought || 0) + q > cfg.perCourseCap) throw new HttpsError('failed-precondition', '과정 한도 초과.');

    const cost = rangeCost(weekCount, q, R0, k, exp);
    const balance = user.balance || 0;
    if (cost > balance) throw new HttpsError('failed-precondition', `포인트가 부족합니다(필요 ${cost}).`);

    tx.update(uRef, { balance: balance - cost });
    tx.set(aRef, {
      userId, dp: (acc.dp || 0) + q, weekKey: wk, weekCount: weekCount + q,
      totalBought: (acc.totalBought || 0) + q, updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(boardRef(), { housePool: FieldValue.increment(cost) }, { merge: true }); // 포인트 회수(보존)
    tx.set(db.collection('ledger').doc(), { type: 'dp_convert', userId, qty: q, cost, weekKey: wk, ts: FieldValue.serverTimestamp() });
    return { qty: q, cost, newDp: (acc.dp || 0) + q, newBalance: balance - cost, weekCount: weekCount + q };
  });
});
```

### 6.2 `redeemGoods` — 학생: DP → 현물(고정가·재고 차감)
```js
export const redeemGoods = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, goodsId } = req.data || {};
  if (!userId || !goodsId) throw new HttpsError('invalid-argument', 'userId/goodsId 필요.');

  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const aRef = db.doc(`dpAccounts/${userId}`);
    const gRef = db.doc(`dpGoods/${goodsId}`);
    const [uSnap, aSnap, gSnap] = await Promise.all([tx.get(uRef), tx.get(aRef), tx.get(gRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    if (uSnap.data().pinHash && pinHash !== uSnap.data().pinHash) throw new HttpsError('permission-denied', 'PIN 불일치.');
    if (!gSnap.exists) throw new HttpsError('not-found', '상품을 찾을 수 없습니다.');
    const g = gSnap.data();
    if (g.active === false) throw new HttpsError('failed-precondition', '교환 불가 상품입니다.');
    if ((g.stock || 0) <= 0) throw new HttpsError('failed-precondition', '재고가 없습니다.');
    const acc = aSnap.exists ? aSnap.data() : { dp: 0 };
    if ((acc.dp || 0) < g.priceDP) throw new HttpsError('failed-precondition', 'DP가 부족합니다.');

    tx.update(aRef, { dp: (acc.dp || 0) - g.priceDP, updatedAt: FieldValue.serverTimestamp() });
    tx.update(gRef, { stock: g.stock - 1 });
    tx.set(db.collection('dpRedemptions').doc(), {
      userId, name: uSnap.data().name || userId, goodsId, goodsName: g.name, priceDP: g.priceDP,
      status: 'pending', ts: FieldValue.serverTimestamp(),
    });
    tx.set(db.collection('ledger').doc(), { type: 'dp_redeem', userId, goodsId, priceDP: g.priceDP, ts: FieldValue.serverTimestamp() });
    return { goodsId, priceDP: g.priceDP, newDp: (acc.dp || 0) - g.priceDP };
  });
});
```

### 6.3 운영자 함수
```js
// 이벤트 DP 지급(개별/일괄). amount<0이면 회수.
export const grantDP = onCall(async (req) => {
  assertAdmin(req);
  const { userIds, amount, memo } = req.data || {};
  const amt = Math.floor(Number(amount));
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  if (!ids.length || !amt) throw new HttpsError('invalid-argument', 'userIds/amount 필요.');
  const batch = db.batch();
  for (const id of ids) {
    batch.set(db.doc(`dpAccounts/${id}`), { userId: id, dp: FieldValue.increment(amt), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    batch.set(db.collection('ledger').doc(), { type: 'dp_grant', userId: id, amount: amt, memo: memo || '', ts: FieldValue.serverTimestamp() });
  }
  await batch.commit();
  return { count: ids.length, amount: amt };
});

// 상품 상장/수정(고정가·재고)
export const upsertGoods = onCall(async (req) => {
  assertAdmin(req);
  const { id, name, priceDP, stock, active, sort } = req.data || {};
  if (!id) throw new HttpsError('invalid-argument', 'id 필요.');
  const patch = {};
  if (name != null) patch.name = name;
  if (priceDP != null) patch.priceDP = Math.max(1, Math.floor(Number(priceDP)));
  if (stock != null) patch.stock = Math.max(0, Math.floor(Number(stock)));
  if (active != null) patch.active = !!active;
  if (sort != null) patch.sort = Math.floor(Number(sort));
  await db.doc(`dpGoods/${id}`).set(patch, { merge: true });
  return { id };
});

// 교환 승인(오프라인 지급 완료 표시)
export const fulfillRedemption = onCall(async (req) => {
  assertAdmin(req);
  const { id, status } = req.data || {};
  const st = ['fulfilled', 'cancelled'].includes(status) ? status : 'fulfilled';
  const ref = db.doc(`dpRedemptions/${id}`);
  if (st === 'cancelled') {                 // 취소면 DP·재고 복구
    await db.runTransaction(async (tx) => {
      const r = (await tx.get(ref)).data();
      if (!r || r.status !== 'pending') throw new HttpsError('failed-precondition', 'pending 건만 취소 가능.');
      tx.update(db.doc(`dpAccounts/${r.userId}`), { dp: FieldValue.increment(r.priceDP) });
      tx.update(db.doc(`dpGoods/${r.goodsId}`), { stock: FieldValue.increment(1) });
      tx.update(ref, { status: 'cancelled', fulfilledAt: FieldValue.serverTimestamp() });
    });
  } else {
    await ref.update({ status: 'fulfilled', fulfilledAt: FieldValue.serverTimestamp() });
  }
  return { id, status: st };
});

// 파라미터 조정(곡선·캡·on/off)
export const setDpParams = onCall(async (req) => {
  assertAdmin(req);
  const allow = ['R0', 'k', 'exp', 'sellEnabled', 'perWeekCap', 'perCourseCap', 'redeemEnabled', 'convertEnabled'];
  const patch = {};
  for (const key of allow) if (req.data?.[key] != null) patch[key] = req.data[key];
  await db.doc('meta/dpExchange').set(patch, { merge: true });
  return patch;
});
```

`functions/index.js`는 `dpcurve.js`와 `seoulWeekKey`를 import. `src/data/store.js`에 콜러블 래퍼 추가(프론트 미리보기는 dpcurve.js로 비용 미리 계산 — market.js↔domain 처럼 **바이트 동일 사본** 유지).

---

## 7. `firestore.rules` 추가 (통합본에 합침)

```
match /dpAccounts/{userId} { allow read: if true; allow write: if false; }   // 함수만 쓰기
match /dpGoods/{id}        { allow read: if true; allow write: if false; }
match /dpRedemptions/{id}  { allow read: if true; allow write: if false; }    // 학급 투명성(필요시 본인+운영자로 제한)
// meta/dpExchange 는 기존 meta 규칙(read 공개, write 운영자/함수)으로 커버됨.
```

---

## 8. 마이그레이션 — 기존 수기 DP 이식 (test-harness, 서비스계정 키)

시트(`기맞기획11기 DP 현황.xlsx`)의 **채색 칸 수 = DP**. 일회성 admin 스크립트로 `dpAccounts.dp` 세팅:

```
김제연15 정승운13 김규장9 김지수9 김영웅6 김채연6 박송호6 오승명6
김민성5 김현덕5 백승오5 이예성5 김재원4 이동현4 이정현4
이유진3 최혜원3 박도원2 박지수2 이기현2 이제희2 윤희성2 정유진1
```
- 이름→userId 매핑은 `users`에서 조회(getUserByName). `weekKey=현재주, weekCount=0, totalBought=0`.
- 상품 시드(`dpGoods`, 운영자가 재고 지정): 강사님의사랑2 · 아메리카노5 · 자유음료9 · 가챠일반25 · 치킨35 · 프리미엄가챠50 · 막강한권한60(인사권) · ???80. (밥한끼 제외)
- 부분 실패 대비(HANDBOOK §9.3): 트랜잭션·진행로그·재실행 안전(idempotent: dp를 set, increment 아님).

---

## 9. 별도 프론트엔드 (신규 Vite+React 리포, 예: `HK_DP`)

- **같은 Firebase 프로젝트**(`.env`의 VITE_FIREBASE_* 공유), `base=/HK_DP/`, 학생 인증=이름+PIN+익명(주식판 패턴 재사용).
- **학생 화면**
  - 잔액 카드: 내 포인트(`users.balance`) · 내 DP(`dpAccounts.dp`).
  - 교환소: 이번 주 매수 곡선(dpcurve로 다음 1개 가격 표시) · 수량 선택 · 예상 비용 · 매수(`convertToDP`).
  - 카탈로그: `dpGoods` 카드(가격·재고·교환 `redeemGoods`), DP 부족/품절 비활성.
  - 내 교환 내역: `dpRedemptions`(pending/fulfilled).
- **운영자 화면**: 이벤트 DP 지급(`grantDP` 일괄), 상품 관리(`upsertGoods`), 교환 승인(`fulfillRedemption`), 파라미터(`setDpParams`).
- 구독: `dpAccounts/{me}`, `dpGoods`, `dpRedemptions(where userId==me)`, `meta/dpExchange`, `users/{me}`.

---

## 10. 함수 추가 체크리스트 (HANDBOOK §9.6)

- [ ] `housePool` 변경은 increment (convertToDP). ✅
- [ ] `balance` 차감 = housePool 증가로 보존. ✅
- [ ] DP는 별도 통화(grant 발행/redeem 소각), ledger `dp_*` 기록. ✅
- [ ] 쓰기 경로마다 rules(read 공개·write false) 추가. ✅
- [ ] `dpcurve.js` 두 사본(functions ↔ src/domain) 바이트 동일. 
- [ ] region asia-northeast3, 운영자 이메일 3곳 일치.
- [ ] 매도(sell) OFF — 미구현/플래그 잠금.
- [ ] 마이그레이션 idempotent + 보존 점검.

---

## 11. 미해결 · 튜닝

- 자유음료/밥한끼 원화는 예산 참고용(시스템 무관). 자유음료 priceDP 9 확정, 밥한끼 제거.
- 백스톱 캡(`perWeekCap`/`perCourseCap`)은 기본 null(곡선이 이미 제한). 필요 시 `setDpParams`로 켬.
- 게임 종료(5개월 후) 시 잔여 포인트·DP 처리(소멸/일괄정산) 정책 — 운영 시점 결정.
- 예산 모니터: `ledger`의 `dp_redeem` 합 × 상품 원화 = 실예산 소진. 운영자 화면에 누적 표시 권장.
```
