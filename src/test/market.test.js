import { describe, it, expect } from 'vitest';
import {
  marginalPrice, rangeSum, quoteBuy, quoteSell, quoteLadder, nextAvgCost,
  holdingValue, netWorth, priceAdjustDelta,
} from '../domain/market.js';

// base=1000, slope=2, 발행 1000주, 유통 c
const stock = (circulating, totalShares = 1000) => ({ base: 1000, slope: 2, totalShares, circulating });

describe('marginalPrice', () => {
  it('base + slope×유통', () => {
    expect(marginalPrice(stock(0))).toBe(1000);
    expect(marginalPrice(stock(50))).toBe(1100); // 1000 + 2×50
  });
});

describe('rangeSum (정수)', () => {
  it('곡선 적분이 항상 정수', () => {
    // Σ_{i=0}^{2} (1000+2i) = 1000+1002+1004 = 3006
    expect(rangeSum(1000, 2, 0, 2)).toBe(3006);
    expect(Number.isInteger(rangeSum(1000, 3, 0, 4))).toBe(true);
    expect(Number.isInteger(rangeSum(999, 7, 5, 11))).toBe(true);
  });
});

describe('quoteBuy', () => {
  it('곡선 적분으로 체결, 유통·시세 증가', () => {
    const q = quoteBuy(stock(0), 3);
    expect(q.cost).toBe(3006); // 1000+1002+1004
    expect(q.newCirculating).toBe(3);
    expect(q.newPrice).toBe(1006);
  });
  it('발행주식수 초과 매수는 거부', () => {
    expect(() => quoteBuy(stock(999), 2)).toThrow(); // 999+2 > 1000
    expect(() => quoteBuy(stock(1000), 1)).toThrow();
  });
});

describe('quoteSell', () => {
  it('같은 구간 적분으로 체결', () => {
    const q = quoteSell(stock(3), 3);
    expect(q.proceeds).toBe(3006);
    expect(q.newCirculating).toBe(0);
    expect(q.newPrice).toBe(1000);
  });
  it('유통 초과 매도는 거부', () => {
    expect(() => quoteSell(stock(2), 5)).toThrow();
  });
});

describe('★ 사고 곧바로 팔면 본전 (포인트 복사 차단)', () => {
  it('어떤 유통/수량에서도 매수비용 == 직후 매도수령', () => {
    for (const c of [0, 1, 7, 50, 500]) {
      for (const q of [1, 3, 10]) {
        if (c + q > 1000) continue;
        const buy = quoteBuy(stock(c), q);
        const afterBuy = stock(c + q);
        const sell = quoteSell(afterBuy, q);
        expect(sell.proceeds).toBe(buy.cost); // 차익 0
      }
    }
  });
});

describe('quoteLadder', () => {
  it('수량별 매수/매도, 불가 수량 제외', () => {
    const rows = quoteLadder(stock(0), [1, 5]);
    expect(rows[0]).toMatchObject({ qty: 1, buy: { cost: 1000, to: 1002 }, sell: null });
    expect(rows[1].buy.cost).toBe(rangeSum(1000, 2, 0, 4));
  });
});

describe('nextAvgCost', () => {
  it('첫 매수 평단 = 체결 평균가', () => {
    expect(nextAvgCost(0, 0, 3, 1002)).toBe(1002);
  });
});

describe('netWorth', () => {
  it('현금 + 보유 평가액', () => {
    const holdings = [{ stockId: 'a', shares: 3 }];
    expect(holdingValue(3, 1100)).toBe(3300);
    expect(netWorth(1000, holdings, () => 1100)).toBe(4300);
  });
});

describe('priceAdjustDelta (총량 보존)', () => {
  it('(새가−현재가)×유통', () => {
    expect(priceAdjustDelta(1000, 1200, 50)).toBe(10000);
    expect(priceAdjustDelta(1200, 1000, 50)).toBe(-10000);
  });
});
