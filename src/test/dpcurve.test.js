import { describe, it, expect } from 'vitest';
import { marginal, rangeCost, maxBuyable, DP_DEFAULTS } from '../domain/dpcurve.js';

const { R0, k, exp } = DP_DEFAULTS; // 10000, 1000, 2

describe('marginal (2차곡선 개당 가격)', () => {
  it('R0 + k·i²', () => {
    expect(marginal(0, R0, k, exp)).toBe(10000);
    expect(marginal(1, R0, k, exp)).toBe(11000);
    expect(marginal(2, R0, k, exp)).toBe(14000);
    expect(marginal(3, R0, k, exp)).toBe(19000);
    expect(marginal(4, R0, k, exp)).toBe(26000);
  });
  it('항상 정수', () => {
    expect(Number.isInteger(marginal(7, R0, k, exp))).toBe(true);
  });
});

describe('rangeCost (누적 비용)', () => {
  it('weekCount 0 부터', () => {
    expect(rangeCost(0, 1, R0, k, exp)).toBe(10000);
    expect(rangeCost(0, 2, R0, k, exp)).toBe(21000);
    expect(rangeCost(0, 5, R0, k, exp)).toBe(80000); // 10000+11000+14000+19000+26000
  });
  it('weekCount 오프셋(이번 주 이미 산 만큼 비싸게)', () => {
    expect(rangeCost(2, 2, R0, k, exp)).toBe(14000 + 19000);
  });
  it('qty<=0 이면 0', () => {
    expect(rangeCost(0, 0, R0, k, exp)).toBe(0);
  });
});

describe('maxBuyable (예산 한도)', () => {
  it('주 가용 = R0 이면 1개', () => {
    expect(maxBuyable(0, 10000, R0, k, exp)).toBe(1);
    expect(maxBuyable(0, 9999, R0, k, exp)).toBe(0);
    expect(maxBuyable(0, 21000, R0, k, exp)).toBe(2);
  });
  it('★확정 운영(일UBI 2000×5=10000) → 주 1개', () => {
    expect(maxBuyable(0, 2000 * 5, R0, k, exp)).toBe(1);
  });
  it('저축 몰아사기는 2차라 효율 급감(50000 → 3개)', () => {
    // 누적 10000,21000,35000,54000 → 54000>50000 이라 3개
    expect(maxBuyable(0, 50000, R0, k, exp)).toBe(3);
  });
});
