import { describe, it, expect } from 'vitest';
import { EVENT_CATEGORIES, EVENT_PRESETS, findEventPreset, renderEventHeadline, eventCategoryMeta } from '../domain/events.js';

describe('강사 이벤트 카탈로그 정합성', () => {
  it('프리셋 key 는 모두 고유', () => {
    const keys = EVENT_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('모든 프리셋의 cat 은 정의된 카테고리', () => {
    const ids = new Set(EVENT_CATEGORIES.map((c) => c.id));
    for (const p of EVENT_PRESETS) expect(ids.has(p.cat)).toBe(true);
  });
  it('모든 프리셋은 {기업} 플레이스홀더와 유한한 pct(>-100) 를 가진다', () => {
    for (const p of EVENT_PRESETS) {
      expect(p.tpl).toContain('{기업}');
      expect(Number.isFinite(p.pct)).toBe(true);
      expect(p.pct).toBeGreaterThan(-100);
    }
  });
});

describe('renderEventHeadline / findEventPreset', () => {
  it('{기업} 을 종목명으로 치환', () => {
    const p = findEventPreset('att_late');
    expect(p).not.toBeNull();
    expect(renderEventHeadline(p, 'A팀')).toBe('A팀 지각 발생, 신뢰도 소폭 흔들');
  });
  it('없는 key 는 null, 렌더는 빈 문자열', () => {
    expect(findEventPreset('nope')).toBeNull();
    expect(renderEventHeadline(null, 'A팀')).toBe('');
  });
});

describe('eventCategoryMeta', () => {
  it('정의된 카테고리는 라벨 반환', () => {
    expect(eventCategoryMeta('attendance').label).toBe('출결');
  });
  it('모르는 카테고리는 fallback', () => {
    expect(eventCategoryMeta('custom').label).toBe('custom');
  });
});
