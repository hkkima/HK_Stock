import { describe, it, expect } from 'vitest';
import {
  priceImpact, quoteBuy, quoteSell, quoteLadder, nextAvgCost, holdingValue,
  netWorth, priceAdjustDelta, MIN_PRICE,
} from '../domain/market.js';

const stock = (price, liq) => ({ price, liq });

describe('priceImpact', () => {
  it('거래량/유동성에 비례', () => {
    expect(priceImpact(100, 10, 100)).toBe(10); // 100*10/100
    expect(priceImpact(100, 1, 100)).toBe(1);
  });
  it('liq가 크면 둔감', () => {
    expect(priceImpact(100, 10, 1000)).toBe(1);
  });
});

describe('quoteBuy', () => {
  it('현재가로 체결, 시세 상승', () => {
    const q = quoteBuy(stock(100, 50), 5);
    expect(q.cost).toBe(500);
    expect(q.price).toBe(100);
    expect(q.newPrice).toBe(100 + Math.round((100 * 5) / 50)); // +10 → 110
    expect(q.newPrice).toBe(110);
  });
  it('수량 0/음수/소수는 거부', () => {
    expect(() => quoteBuy(stock(100, 50), 0)).toThrow();
    expect(() => quoteBuy(stock(100, 50), -3)).toThrow();
  });
});

describe('quoteSell', () => {
  it('현재가로 체결, 시세 하락', () => {
    const q = quoteSell(stock(100, 50), 5);
    expect(q.proceeds).toBe(500);
    expect(q.newPrice).toBe(90);
  });
  it('시세는 MIN_PRICE 아래로 안 내려감', () => {
    const q = quoteSell(stock(2, 1), 100); // 충격 거대
    expect(q.newPrice).toBe(MIN_PRICE);
  });
});

describe('quoteLadder', () => {
  it('수량별 매수/매도 체결가·시세이동', () => {
    const rows = quoteLadder(stock(100, 50), [1, 5]);
    expect(rows[0]).toMatchObject({ qty: 1, buyCost: 100, buyTo: 102, sellGet: 100, sellTo: 98 });
    expect(rows[1]).toMatchObject({ qty: 5, buyCost: 500, buyTo: 110, sellGet: 500, sellTo: 90 });
  });
});

describe('nextAvgCost', () => {
  it('첫 매수 평단 = 체결가', () => {
    expect(nextAvgCost(0, 0, 10, 100)).toBe(100);
  });
  it('가중평균', () => {
    // 10주 @100 보유 후 10주 @200 매수 → 평단 150
    expect(nextAvgCost(10, 100, 10, 200)).toBe(150);
  });
});

describe('netWorth', () => {
  it('현금 + 보유 평가액', () => {
    const holdings = [{ stockId: 'a', shares: 3 }, { stockId: 'b', shares: 2 }];
    const priceOf = (id) => ({ a: 100, b: 50 }[id]);
    expect(holdingValue(3, 100)).toBe(300);
    expect(netWorth(1000, holdings, priceOf)).toBe(1000 + 300 + 100); // 1400
  });
  it('가격 없는 종목은 0으로', () => {
    expect(netWorth(500, [{ stockId: 'x', shares: 9 }], () => undefined)).toBe(500);
  });
});

describe('priceAdjustDelta (총량 보존)', () => {
  it('상향=하우스→리저브(양수), 하향=리저브→하우스(음수)', () => {
    expect(priceAdjustDelta(100, 120, 50)).toBe(1000);  // +20 × 50주
    expect(priceAdjustDelta(100, 80, 50)).toBe(-1000);
    expect(priceAdjustDelta(100, 100, 50)).toBe(0);
  });
});
