// 홀덤 정산 산술 — 순수 함수. 부작용·SDK 의존 없음(index.js 의 콜러블이 호출).
//
// 두 규칙 모두 지켜야 하는 불변식:
//   나가는 포인트 합 == 들어온 에스크로  (CONVENTIONS 불변식 7, 총량보존)
// 그래서 전부 '내림 + 잔돈을 한 명에게' 로 계산한다. 비율 배분을 각자 반올림하면
// 합이 에스크로보다 크거나 작아져서 포인트가 생기거나 증발한다.

/**
 * 사설 방: 남은 칩 비율대로 에스크로를 되돌려 준다.
 * 잔돈은 칩 리더에게(동률이면 userId 사전순 — 결정적이어야 재시도해도 같은 결과).
 *
 * @param {{userId:string,name:string,chips:number}[]} entries
 * @param {number} escrow
 * @returns {{userId:string,name:string,chips:number,payout:number}[]}
 */
export function privatePayouts(entries, escrow) {
  const list = entries.map((e) => ({ ...e, chips: Math.max(0, Math.floor(e.chips || 0)), payout: 0 }));
  const pool = Math.max(0, Math.floor(escrow || 0));
  const totalChips = list.reduce((s, e) => s + e.chips, 0);
  if (pool === 0 || totalChips === 0 || list.length === 0) return list;

  for (const e of list) e.payout = Math.floor((pool * e.chips) / totalChips);
  const remainder = pool - list.reduce((s, e) => s + e.payout, 0);
  if (remainder > 0) {
    const leader = list.slice().sort((a, b) => b.chips - a.chips || (a.userId < b.userId ? -1 : 1))[0];
    leader.payout += remainder;
  }
  return list;
}

/**
 * 토너먼트: 순위별 상금 비율(%)대로 배분. 잔돈은 1위에게.
 * `pct` 는 개설 시점에 Firestore 에 고정된 값을 쓴다 — 게임 상태(RTDB)는 클라이언트가
 * 쓰므로, 돈에 관한 파라미터를 거기서 읽으면 정산 직전에 바꿔치기할 수 있다.
 *
 * @param {{userId:string,name:string,rank:number}[]} standings  rank 1..n
 * @param {number} escrow
 * @param {number[]} pct  1위부터의 배분율, 합계 100
 */
export function tournamentPayouts(standings, escrow, pct) {
  const sorted = standings
    .map((s) => ({ ...s, rank: Math.floor(s.rank || 0), payout: 0 }))
    .filter((s) => s.rank >= 1)
    .sort((a, b) => a.rank - b.rank);
  const pool = Math.max(0, Math.floor(escrow || 0));
  if (pool === 0 || sorted.length === 0) return sorted;

  const table = Array.isArray(pct) ? pct : [];
  for (let i = 0; i < sorted.length; i += 1) {
    sorted[i].payout = Math.floor((pool * (Number(table[i]) || 0)) / 100);
  }
  // 남는 비율(입상자보다 배분표가 길 때)과 내림 잔돈은 모두 1위에게 — 총량보존.
  const remainder = pool - sorted.reduce((s, e) => s + e.payout, 0);
  if (remainder > 0) sorted[0].payout += remainder;
  return sorted;
}

/**
 * 비중 배열을 합계 100 정수로 정규화. 잔여는 1번에게. 비어 있으면 균등.
 */
export function normaliseWeights(weights, count) {
  const raw = Array.from({ length: count }, (_, i) => Math.max(0, Math.round(Number((weights || [])[i]) || 0)));
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    const each = Math.floor(100 / count);
    const out = Array.from({ length: count }, () => each);
    out[0] += 100 - each * count;
    return out;
  }
  const scaled = raw.map((w) => Math.floor((w * 100) / sum));
  scaled[0] += 100 - scaled.reduce((a, b) => a + b, 0);
  return scaled;
}

/** 상금풀을 그룹별로 쪼갠다. 내림 + 잔여는 최상위 그룹에게. */
export function splitPoolByGroup(pool, groupCount, weights) {
  const p = Math.max(0, Math.floor(pool || 0));
  if (groupCount <= 0) return [];
  if (p === 0) return Array.from({ length: groupCount }, () => 0);
  const w = normaliseWeights(weights, groupCount);
  const out = w.map((x) => Math.floor((p * x) / 100));
  out[0] += p - out.reduce((a, b) => a + b, 0);
  return out;
}

/**
 * 리그 최종 배분 — 그룹별 상금풀을 그룹 안 순위대로 나눈다.
 *
 * `groups`(최종 그룹 편성)와 `results`(그룹 안 순위)는 RTDB 에서 오지만,
 * `groupWeights`·`groupPayouts` 는 개설 시점 Firestore 값이다. 돈의 비율은
 * 클라이언트가 못 만지는 쪽에서만 읽는다.
 *
 * @param {string[][]} groups        최종 그룹별 uid 목록(앞이 상위 그룹)
 * @param {{uid:string,rank:number}[]} results  그룹 안 순위
 * @param {Record<string,{name?:string}>} entrants
 * @param {string[]} paidIds         실제로 참가 등록된 uid
 * @param {number} escrow
 * @param {number[]} groupWeights    그룹 간 비중
 * @param {number[]} groupPayouts    그룹 안 순위별 %
 */
export function leaguePayouts(groups, results, entrants, paidIds, escrow, groupWeights, groupPayouts) {
  const paid = new Set(paidIds);
  const rankOf = new Map((results || []).map((r) => [r.uid, Math.floor(r.rank || 0)]));
  const live = (groups || []).map((g) => (g || []).filter((uid) => paid.has(uid)));
  const pools = splitPoolByGroup(escrow, live.length, groupWeights);
  const pct = Array.isArray(groupPayouts) && groupPayouts.length ? groupPayouts : [100];

  const rows = [];
  let assigned = 0;
  live.forEach((members, g) => {
    const sorted = members
      .map((uid) => ({
        userId: uid,
        name: (entrants && entrants[uid] && entrants[uid].name) || uid,
        group: g,
        rank: rankOf.get(uid) || 0,
        payout: 0,
      }))
      // 순위가 없는 사람(결석)은 뒤로. 그다음 uid 로 결정적으로 자른다.
      .sort((a, b) => (a.rank || 99) - (b.rank || 99) || (a.userId < b.userId ? -1 : 1));

    const gp = pools[g] || 0;
    sorted.forEach((row, i) => { row.payout = Math.floor((gp * (Number(pct[i]) || 0)) / 100); });
    const paidOut = sorted.reduce((a, r) => a + r.payout, 0);
    if (sorted.length > 0) sorted[0].payout += gp - paidOut;   // 잔여·미지정 비율은 그룹 1위에게
    else assigned -= gp;                                        // 그룹이 통째로 비면 아래에서 되돌린다
    assigned += gp;
    rows.push(...sorted);
  });

  // 빈 그룹 몫이 증발하지 않도록 남은 금액을 최상위 '사람이 있는' 그룹 1위에게.
  const total = rows.reduce((a, r) => a + r.payout, 0);
  const leftover = Math.max(0, Math.floor(escrow || 0)) - total;
  if (leftover > 0 && rows.length > 0) {
    const head = rows.find((r) => r.rank === 1) || rows[0];
    head.payout += leftover;
  }
  return rows;
}

/**
 * RTDB 사설 방 노드에서 정산 대상을 뽑는다.
 * 바이인을 실제로 낸 사람(`paidIds`)만 대상 — 게임 상태는 클라이언트가 쓰므로
 * 여기서 걸러야 "안 낸 사람이 칩만 들고 나타나는" 조작이 막힌다.
 */
export function seatsFromRoom(room, paidIds) {
  const players = (room && room.players) || {};
  const paid = new Set(paidIds);
  const byUser = new Map();
  for (const p of Object.values(players)) {
    if (!p || !p.id || !paid.has(p.id)) continue;
    const prev = byUser.get(p.id);
    // 같은 사람이 두 자리에 앉는 경우는 없어야 하지만, 있으면 칩을 합쳐 둔다.
    if (prev) prev.chips += Math.max(0, Math.floor(p.chips || 0));
    else byUser.set(p.id, { userId: p.id, name: p.name || p.id, chips: Math.max(0, Math.floor(p.chips || 0)) });
  }
  return [...byUser.values()];
}

/**
 * RTDB 토너먼트 노드에서 최종 순위를 뽑는다. 역시 바이인을 낸 사람만.
 */
export function standingsFromTournament(tour, paidIds) {
  const raw = (tour && tour.standings) || {};
  const paid = new Set(paidIds);
  const out = [];
  for (const s of Object.values(raw)) {
    if (!s || !s.uid || !paid.has(s.uid)) continue;
    out.push({ userId: s.uid, name: s.name || s.uid, rank: Math.floor(s.rank || 0) });
  }
  // 같은 순위가 둘 나오면 배분표가 어긋난다 — 순위를 1..n 으로 다시 조인다.
  out.sort((a, b) => a.rank - b.rank || (a.userId < b.userId ? -1 : 1));
  return out.map((s, i) => ({ ...s, rank: i + 1 }));
}
