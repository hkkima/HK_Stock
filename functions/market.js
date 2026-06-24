// ─────────────────────────────────────────────────────────────
// 순수 AMM 시세 엔진 — Firebase 비의존, 단위 테스트 대상.
// ★ src/domain/market.js 와 functions/market.js 는 바이트 단위로 동일 유지(diff로 점검) ★
//   (프론트=미리보기/표시용, 함수=권위 실행. 둘이 어긋나면 견적과 체결이 달라짐)
//
// 모델: 정수 포인트 기반 단순 AMM.
//   - 매수/매도는 '현재가(price)'로 q주 즉시 체결 → 항상 유동성 보장.
//   - 체결 직후 시세가 거래량만큼 이동(매수=상승, 매도=하락).
//   - 시세 충격 = round(price × q / liq). liq(유동성계수)가 클수록 둔감.
// ─────────────────────────────────────────────────────────────

export const MIN_PRICE = 1;

export function isPosInt(n) {
  return Number.isInteger(n) && n > 0;
}

// 시세 충격: 거래량 q 가 유동성 liq 대비 얼마나 큰지에 비례해 가격을 민다.
export function priceImpact(price, qty, liq) {
  const L = Math.max(1, Math.floor(liq || 1));
  return Math.round((price * qty) / L);
}

// 매수 견적: q 주를 현재가로 체결. 체결 후 시세는 상승.
export function quoteBuy(stock, qty) {
  const q = Math.floor(qty);
  if (!isPosInt(q)) throw new Error('수량은 1 이상 정수여야 합니다.');
  const price = stock.price;
  const cost = price * q;
  const newPrice = price + priceImpact(price, q, stock.liq);
  return { side: 'buy', qty: q, price, cost, newPrice };
}

// 매도 견적: q 주를 현재가로 체결. 체결 후 시세는 하락(최저 MIN_PRICE).
export function quoteSell(stock, qty) {
  const q = Math.floor(qty);
  if (!isPosInt(q)) throw new Error('수량은 1 이상 정수여야 합니다.');
  const price = stock.price;
  const proceeds = price * q;
  const newPrice = Math.max(MIN_PRICE, price - priceImpact(price, q, stock.liq));
  return { side: 'sell', qty: q, price, proceeds, newPrice };
}

// 호가 사다리(AMM): 여러 수량에 대한 매수/매도 체결가·시세이동 미리보기.
//   진짜 주문매칭 호가창이 아니라, "이만큼 사면/팔면 얼마에 체결되고 시세가 어디로 가는지"의 사다리.
export function quoteLadder(stock, qtys) {
  return qtys.map((q) => {
    const b = quoteBuy(stock, q);
    const s = quoteSell(stock, q);
    return { qty: q, buyCost: b.cost, buyTo: b.newPrice, sellGet: s.proceeds, sellTo: s.newPrice };
  });
}

// 매수 후 평단가(가중평균). oldShares 0 이면 새 평단 = 체결가.
export function nextAvgCost(oldShares, oldAvg, addQty, fillPrice) {
  const total = oldShares + addQty;
  if (total <= 0) return fillPrice;
  return (oldShares * (oldAvg || 0) + addQty * fillPrice) / total;
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

// 펀더멘탈 시세 조정의 포인트 정산량.
//   newPrice 로 올리/내리면, 보유주식 평가차이만큼 reserve↔housePool 로 이동해 총량 보존.
//   delta>0 : 하우스 풀 → 리저브(보조금, 인플레). delta<0 : 리저브 → 하우스(흡수, 디플레).
export function priceAdjustDelta(oldPrice, newPrice, sharesOut) {
  return (newPrice - oldPrice) * sharesOut;
}
