// ─────────────────────────────────────────────────────────────
// 순수 시세 엔진 — 고정발행 본드커브(bonding curve). Firebase 비의존, 테스트 대상.
// ★ src/domain/market.js 와 functions/market.js 는 바이트 단위로 동일 유지(diff로 점검) ★
//
// 모델: 각 기업은 발행주식수 totalShares 를 고정 발행, 전량 트레저리(금고)에서 출발.
//   학생은 트레저리에서 매수/매도. 가격은 '유통주식수 circulating'의 1차 함수:
//       price(c) = base + slope·c            (c = 유통주식수 = 학생 보유 합)
//   매수 q주(c→c+q): 비용 = 곡선 적분(각 주를 그 위치 가격에 체결) = Σ price(i).
//   매도 q주(c→c-q): 수령 = 같은 구간 적분.
//   → 사고 곧바로 팔면 '정확히 본전'(자기 거래 차익 0) → 포인트 복사 차단.
//   → c+q ≤ totalShares 라 발행량을 초과해 살 수 없음(무한 발행 차단).
// ─────────────────────────────────────────────────────────────

export const MIN_PRICE = 1;

export function isPosInt(n) {
  return Number.isInteger(n) && n > 0;
}

// 현재가(한계가격) = base + slope × 유통주식수
export function marginalPrice(stock) {
  return stock.base + stock.slope * (stock.circulating || 0);
}

// Σ_{i=a}^{b} (base + slope·i). a..b 포함. a>b 이면 0. 항상 정수.
export function rangeSum(base, slope, a, b) {
  if (b < a) return 0;
  const n = b - a + 1;
  return base * n + (slope * ((a + b) * n)) / 2; // (a+b)*n 은 항상 짝수
}

// 매수 q주: 유통 c → c+q. 발행주식수 초과 불가. 비용 = 곡선 적분.
export function quoteBuy(stock, qty) {
  const q = Math.floor(qty);
  if (!isPosInt(q)) throw new Error('수량은 1 이상 정수여야 합니다.');
  const c = stock.circulating || 0;
  if (c + q > stock.totalShares) throw new Error('발행주식수를 초과할 수 없습니다(트레저리 잔여 부족).');
  const cost = rangeSum(stock.base, stock.slope, c, c + q - 1);
  const newCirculating = c + q;
  const newPrice = stock.base + stock.slope * newCirculating;
  return { side: 'buy', qty: q, cost, newCirculating, newPrice };
}

// 매도 q주: 유통 c → c-q. 수령 = 같은 구간 적분.
export function quoteSell(stock, qty) {
  const q = Math.floor(qty);
  if (!isPosInt(q)) throw new Error('수량은 1 이상 정수여야 합니다.');
  const c = stock.circulating || 0;
  if (q > c) throw new Error('유통주식수보다 많이 팔 수 없습니다.');
  const proceeds = rangeSum(stock.base, stock.slope, c - q, c - 1);
  const newCirculating = c - q;
  const newPrice = stock.base + stock.slope * newCirculating;
  return { side: 'sell', qty: q, proceeds, newCirculating, newPrice };
}

// 호가 사다리: 수량별 매수/매도 체결액·체결 후 시세. 불가한 수량은 제외.
export function quoteLadder(stock, qtys) {
  const out = [];
  for (const q of qtys) {
    let buy = null; let sell = null;
    try { const b = quoteBuy(stock, q); buy = { cost: b.cost, to: b.newPrice }; } catch { buy = null; }
    try { const s = quoteSell(stock, q); sell = { get: s.proceeds, to: s.newPrice }; } catch { sell = null; }
    if (buy || sell) out.push({ qty: q, buy, sell });
  }
  return out;
}

// 매수 후 평단가(가중평균). oldShares 0 이면 새 평단 = 체결 평균가.
export function nextAvgCost(oldShares, oldAvg, addQty, fillAvgPrice) {
  const total = oldShares + addQty;
  if (total <= 0) return fillAvgPrice;
  return (oldShares * (oldAvg || 0) + addQty * fillAvgPrice) / total;
}

// 평가: 보유 지분 가치 = shares × 현재가
export function holdingValue(shares, price) {
  return Math.floor(shares) * price;
}

// 순자산 = 현금 + Σ 보유가치. holdings: [{stockId, shares}], priceOf(stockId)->price
export function netWorth(balance, holdings, priceOf) {
  let v = balance;
  for (const h of holdings) v += holdingValue(h.shares, priceOf(h.stockId) ?? 0);
  return v;
}

// 펀더멘탈 시세 조정의 포인트 정산량 = (새 현재가 − 현재가) × 유통주식수.
//   곡선 전체를 평행이동(base 시프트)하므로 유통주식 평가차이만큼 reserve↔housePool 이동(총량 보존).
export function priceAdjustDelta(oldPrice, newPrice, circulating) {
  return (newPrice - oldPrice) * circulating;
}
