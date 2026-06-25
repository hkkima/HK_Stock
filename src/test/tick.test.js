import { describe, it, expect } from 'vitest';
import { tickDelta } from '../../functions/tick.js';

const stock = (o) => ({ base: 1000, centerBase: 1000, slope: 5, circulating: 0, ...o });

describe('tickDelta — 평균회귀(중앙 수렴)', () => {
  it('현재가가 중심보다 높으면 끌어내림', () => {
    const d = tickDelta(stock({ base: 2000, centerBase: 1000 }), () => 0.5); // noise 0
    expect(d).toBe(Math.round(0.08 * (1000 - 2000))); // -80
  });
  it('중심보다 낮으면 끌어올림', () => {
    const d = tickDelta(stock({ base: 500, centerBase: 1000 }), () => 0.5);
    expect(d).toBe(Math.round(0.08 * (1000 - 500))); // +40
  });
});

describe('tickDelta — σ가 변동성(slope)에 비례', () => {
  it('slope 두 배면 노이즈도 약 두 배', () => {
    const d5 = tickDelta(stock({ slope: 5 }), () => 1); // 중심=현재, 노이즈 최대(+)
    const d10 = tickDelta(stock({ slope: 10 }), () => 1);
    expect(d5).toBe(10); // 1000 × (0.01×5/5)
    expect(d10).toBe(20); // 1000 × (0.01×10/5)
  });
  it('σ 상한 3% 적용', () => {
    const d = tickDelta(stock({ slope: 100 }), () => 1); // 0.01×20=0.2 → cap 0.03
    expect(d).toBe(30); // 1000 × 0.03
  });
});

describe('tickDelta — 곡선 양수 유지', () => {
  it('base가 1 미만이 되지 않게 바닥 처리', () => {
    const d = tickDelta(stock({ base: 5, centerBase: 5, slope: 100 }), () => 0); // 큰 음수 노이즈
    expect(5 + d).toBeGreaterThanOrEqual(1);
  });
});
