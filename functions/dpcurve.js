// ─────────────────────────────────────────────────────────────
// 순수 DP 교환 곡선 — 개인별 누적 2차곡선(per-person quadratic). Firebase 비의존, 테스트 대상.
// ★ src/domain/dpcurve.js 와 functions/dpcurve.js 는 바이트 단위로 동일 유지(diff로 점검) ★
//
// 모델: 학생이 이번 주(weekCount) 이미 산 DP 수 i(0-index)에 대해
//   i번째 DP의 개당 가격 = R0 + k·i^exp        (확정: R0=10000, k=1000, exp=2)
//   weekCount 에서 qty개 매수 비용 = Σ_{i=weekCount}^{weekCount+qty-1} (R0 + k·i^exp)
//   곡선 카운터는 매주(Asia/Seoul) 리셋 → 정기 소액 매수 유도, 저축 몰아사기는 2차로 징벌.
//   매도(DP→포인트)는 미지원(게임 포인트 인플레 방지). 모든 값 정수·결정적.
// ─────────────────────────────────────────────────────────────

export const DP_DEFAULTS = { R0: 10000, k: 1000, exp: 2 };

// i번째(0-index) DP의 개당 가격(포인트). 정수.
export function marginal(i, R0, k, exp) {
  return Math.round(R0 + k * Math.pow(i, exp));
}

// weekCount 에서 qty개 매수 총비용(포인트). 정수.
export function rangeCost(weekCount, qty, R0, k, exp) {
  const c = Math.floor(weekCount); const q = Math.floor(qty);
  if (!(q > 0)) return 0;
  let s = 0;
  for (let i = c; i < c + q; i += 1) s += marginal(i, R0, k, exp);
  return s;
}

// 예산(포인트)으로 weekCount 에서 살 수 있는 최대 수량.
export function maxBuyable(weekCount, budget, R0, k, exp) {
  const c = Math.floor(weekCount);
  let n = 0; let cost = 0;
  for (;;) {
    const next = marginal(c + n, R0, k, exp);
    if (cost + next > budget) break;
    cost += next; n += 1;
    if (n > 100000) break;
  }
  return n;
}
