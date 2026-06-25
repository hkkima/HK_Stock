// ─────────────────────────────────────────────────────────────
// 실시간 시세 틱 — 랜덤 평균회귀(OU) 노이즈. index.js(배포)·test-harness(검증) 공용.
//   매 1분(장중) 각 '열린' 종목 base 를 흔든다:
//     Δbase = θ·(centerBase − base)  +  σ·random(−1~+1)
//       · centerBase = 펀더멘탈 기준(시작가, 강사 평가·뉴스로 이동) → 중앙 수렴
//       · σ ∝ 종목 변동성(slope). slope 5 ≈ ±1%/틱(기준), 상한 3%.
//   거래는 결정적 본드커브 유지(본전 보장 불변) — 불확실성은 이 노이즈 레이어가 담당.
//   시세 변동분(Δbase×유통)은 reserve↔housePool 로 총량 보존. 노이즈는 평균0이라
//   하우스 풀이 0 근처 진동해도 무방(음수 허용) → 상승/하락 대칭 작동.
//   분봉 점은 stocks/{id}/series/intraday(롤링 600)에 누적(메인 문서 비대화·대역폭 방지).
// ─────────────────────────────────────────────────────────────
const THETA = 0.08;       // 회귀강도(중앙으로 당기는 비율)
const BASE_SIGMA = 0.01;  // 기준 변동폭(slope=REF 일 때)
const REF_SLOPE = 5;
const SIGMA_CAP = 0.03;
const SERIES_CAP = 600;   // 분봉 보관(장중 ~10시간)

export function tickDelta(stock, rnd = Math.random) {
  const circ = stock.circulating || 0;
  const center = stock.centerBase ?? stock.base;
  const cur = stock.base + stock.slope * circ;
  const sigmaPct = Math.min(SIGMA_CAP, BASE_SIGMA * ((stock.slope || REF_SLOPE) / REF_SLOPE));
  const noise = (rnd() * 2 - 1) * cur * sigmaPct;
  const revert = THETA * (center - stock.base);
  let dBase = Math.round(revert + noise);
  if (stock.base + dBase < 1) dBase = 1 - stock.base; // 곡선 양수 유지
  return dBase;
}

// 1 틱: 열린 종목 각각 독립 트랜잭션(거래와의 충돌 최소화, housePool 은 increment).
export async function applyTick(db, FieldValue) {
  const ss = await db.collection('stocks').get();
  const open = ss.docs.filter((d) => d.data().status === 'open' && d.data().base != null);
  if (open.length === 0) return { ticked: 0 };
  let ticked = 0;
  for (const doc of open) {
    const sRef = doc.ref;
    const serRef = sRef.collection('series').doc('intraday');
    try {
      // eslint-disable-next-line no-await-in-loop
      await db.runTransaction(async (tx) => {
        const [sSnap, serSnap] = await Promise.all([tx.get(sRef), tx.get(serRef)]);
        if (!sSnap.exists) return;
        const s = sSnap.data();
        if (s.status !== 'open' || s.base == null) return;
        const circ = s.circulating || 0;
        const center = s.centerBase ?? s.base;
        const dBase = tickDelta(s);
        const newBase = s.base + dBase;
        const newPrice = newBase + s.slope * circ;
        const cost = dBase * circ; // >0 이면 하우스가 충당(음수 허용)
        tx.update(sRef, { base: newBase, centerBase: center, price: newPrice, reserve: (s.reserve || 0) + cost });
        const pts = (serSnap.exists && Array.isArray(serSnap.data().points)) ? serSnap.data().points : [];
        tx.set(serRef, { points: [...pts, { p: newPrice, t: Date.now() }].slice(-SERIES_CAP) }, { merge: true });
        tx.set(db.doc('meta/stockBoard'), { housePool: FieldValue.increment(-cost) }, { merge: true });
      });
      ticked += 1;
    } catch (e) { /* 충돌/일시오류는 다음 틱에 복구 */ }
  }
  return { ticked };
}

export { SERIES_CAP };
