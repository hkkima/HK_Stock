// 홀덤 정산 산술. 지키는 것은 단 하나 — 나가는 합계 == 들어온 에스크로.
// (CONVENTIONS 불변식 7. 여기가 깨지면 포인트가 생기거나 증발한다.)
import { describe, it, expect } from 'vitest';
import {
  privatePayouts, tournamentPayouts, seatsFromRoom, standingsFromTournament,
} from '../../functions/holdem.js';

const sum = (rows) => rows.reduce((s, r) => s + r.payout, 0);

describe('privatePayouts — 칩 비율 정산', () => {
  it('칩 비율대로 나누고 합계가 에스크로와 정확히 같다', () => {
    const rows = privatePayouts([
      { userId: 'a', name: 'A', chips: 6000 },
      { userId: 'b', name: 'B', chips: 3000 },
      { userId: 'c', name: 'C', chips: 1000 },
    ], 1000);
    expect(sum(rows)).toBe(1000);
    expect(rows.find((r) => r.userId === 'a').payout).toBe(600);
    expect(rows.find((r) => r.userId === 'b').payout).toBe(300);
    expect(rows.find((r) => r.userId === 'c').payout).toBe(100);
  });

  it('나누어떨어지지 않아도 잔돈까지 전액 나간다 (칩 리더가 받음)', () => {
    const rows = privatePayouts([
      { userId: 'a', name: 'A', chips: 100 },
      { userId: 'b', name: 'B', chips: 100 },
      { userId: 'c', name: 'C', chips: 100 },
    ], 100);
    expect(sum(rows)).toBe(100);
    // 33/33/33 + 잔돈 1 → 동률이면 userId 사전순으로 결정적
    expect(rows.find((r) => r.userId === 'a').payout).toBe(34);
  });

  it('칩이 0인 사람은 못 받고, 총액은 여전히 보존된다', () => {
    const rows = privatePayouts([
      { userId: 'a', name: 'A', chips: 500 },
      { userId: 'b', name: 'B', chips: 0 },
    ], 777);
    expect(sum(rows)).toBe(777);
    expect(rows.find((r) => r.userId === 'b').payout).toBe(0);
  });

  it('무료 방(에스크로 0)은 아무도 못 받는다', () => {
    const rows = privatePayouts([{ userId: 'a', name: 'A', chips: 5000 }], 0);
    expect(sum(rows)).toBe(0);
  });

  it('전원 칩 0 이면 지급하지 않는다 (에스크로가 남아 운영자 처리 대상)', () => {
    const rows = privatePayouts([{ userId: 'a', name: 'A', chips: 0 }], 500);
    expect(sum(rows)).toBe(0);
  });
});

describe('tournamentPayouts — 순위별 상금', () => {
  it('배분표대로 주고 잔돈은 1위에게', () => {
    const rows = tournamentPayouts([
      { userId: 'a', name: 'A', rank: 1 },
      { userId: 'b', name: 'B', rank: 2 },
      { userId: 'c', name: 'C', rank: 3 },
    ], 1000, [50, 30, 20]);
    expect(sum(rows)).toBe(1000);
    expect(rows[0].payout).toBe(500);
    expect(rows[1].payout).toBe(300);
    expect(rows[2].payout).toBe(200);
  });

  it('내림 잔돈이 생겨도 전액 나간다', () => {
    const rows = tournamentPayouts([
      { userId: 'a', name: 'A', rank: 1 },
      { userId: 'b', name: 'B', rank: 2 },
      { userId: 'c', name: 'C', rank: 3 },
    ], 1000, [33, 33, 34]);
    expect(sum(rows)).toBe(1000);
    expect(rows[0].payout).toBe(330 + 0); // 330+330+340=1000, 잔돈 없음
  });

  it('입상자가 배분표보다 적으면 남는 비율도 1위에게 (증발 없음)', () => {
    const rows = tournamentPayouts([
      { userId: 'a', name: 'A', rank: 1 },
      { userId: 'b', name: 'B', rank: 2 },
    ], 900, [50, 30, 20]);
    expect(sum(rows)).toBe(900);
    expect(rows[0].payout).toBe(450 + 180); // 자기 몫 + 미지급 3위분
    expect(rows[1].payout).toBe(270);
  });

  it('상금풀이 인원보다 작아도(1P) 합계가 맞는다', () => {
    const rows = tournamentPayouts([
      { userId: 'a', name: 'A', rank: 1 },
      { userId: 'b', name: 'B', rank: 2 },
    ], 1, [50, 50]);
    expect(sum(rows)).toBe(1);
  });

  it('입상자가 없으면 지급하지 않는다', () => {
    expect(sum(tournamentPayouts([], 1000, [100]))).toBe(0);
  });
});

describe('정산 대상 추출 — 바이인을 낸 사람만', () => {
  it('사설 방: 낸 적 없는 uid 가 좌석에 있어도 제외된다', () => {
    const room = {
      players: {
        0: { id: 'a', name: 'A', chips: 1000 },
        1: { id: 'ghost', name: '유령', chips: 9999 },
      },
    };
    const seats = seatsFromRoom(room, ['a']);
    expect(seats).toHaveLength(1);
    expect(seats[0].userId).toBe('a');
  });

  it('토너먼트: 낸 사람만 남기고 순위를 1..n 으로 다시 조인다', () => {
    const tour = {
      standings: {
        x: { uid: 'a', name: 'A', rank: 1 },
        y: { uid: 'ghost', name: '유령', rank: 2 },
        z: { uid: 'b', name: 'B', rank: 3 },
      },
    };
    const st = standingsFromTournament(tour, ['a', 'b']);
    expect(st).toEqual([
      { userId: 'a', name: 'A', rank: 1 },
      { userId: 'b', name: 'B', rank: 2 },
    ]);
  });

  it('순위가 중복돼도 배분표가 어긋나지 않게 재정렬된다', () => {
    const tour = {
      standings: {
        x: { uid: 'a', name: 'A', rank: 1 },
        y: { uid: 'b', name: 'B', rank: 1 },
      },
    };
    const st = standingsFromTournament(tour, ['a', 'b']);
    expect(st.map((s) => s.rank)).toEqual([1, 2]);
  });

  it('유령을 걸러낸 뒤에도 에스크로는 전액 배분된다', () => {
    const tour = { standings: { x: { uid: 'a', name: 'A', rank: 1 }, y: { uid: 'ghost', rank: 2 } } };
    const rows = tournamentPayouts(standingsFromTournament(tour, ['a']), 500, [70, 30]);
    expect(sum(rows)).toBe(500);
  });
});
