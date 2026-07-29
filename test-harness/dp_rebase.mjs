// DP 곡선 리베이스 — meta/dpExchange 의 R0 / k 조정(현금 방파제).
//   곡선: i번째 DP 개당가 = R0 + k·i^exp.
//
//   ★두 다이얼의 성격이 다르다★
//     R0 = 무차별 다이얼. 1번째 DP 가격을 직접 올리므로 하위 잔고층까지 때린다(접근성 위험).
//     k  = 누진 다이얼. i=0 에서 k·0²=0 이라 1번째 DP 는 불변 → 볼륨(몰아사기)에만 걸린다.
//   → 접근성을 지키면서 상단만 조이려면 k 를 쓰는 게 맞다. R0 를 올릴 땐 반드시 차단 인원을 확인할 것.
//   R0·k 를 같은 배수로 올리면 곡선 전체가 정확히 그 배수만큼 이동한다(공지가 단순해짐).
//
//   usage:
//     node dp_rebase.mjs "<serviceAccount.json>" <newR0> [newK]            # DRY
//     node dp_rebase.mjs "<serviceAccount.json>" <newR0> [newK] --execute
//     (newK 생략 시 기존 k 유지)
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { maxBuyable, rangeCost } from '../functions/dpcurve.js';

const keyPath = process.argv[2];
const newR0 = Math.floor(Number(process.argv[3]));
const kArg = process.argv[4] && !process.argv[4].startsWith('--') ? Math.floor(Number(process.argv[4])) : null;
const EXECUTE = process.argv.includes('--execute');
if (!keyPath || !(newR0 > 0)) { console.error('usage: node dp_rebase.mjs <key.json> <newR0> [newK] [--execute]'); process.exit(1); }
initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();

const cfg = (await db.doc('meta/dpExchange').get()).data() || {};
const R0 = cfg.R0 ?? 10000; const k = cfg.k ?? 1000; const exp = cfg.exp ?? 2;
const newK = kArg ?? k;
console.log(`현재 곡선: R0=${R0} k=${k} exp=${exp}`);
console.log(`리베이스 : R0=${newR0} k=${newK} exp=${exp}\n`);
console.log('  순번   현재       리베이스 후   배수');
for (let i = 0; i < 6; i += 1) {
  const a = R0 + k * (i ** exp); const b = newR0 + newK * (i ** exp);
  console.log(`  ${i + 1}번째 ${String(a).padStart(8)} ${String(b).padStart(12)}   ×${(b / a).toFixed(2)}`);
}
console.log('');

// 영향 산출 — 실제 잔고 + 이번 주 이미 산 개수(weekCount) 기준.
const users = (await db.collection('users').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const accts = {};
(await db.collection('dpAccounts').get()).forEach((d) => { accts[d.id] = d.data(); });

let beforeTot = 0; let afterTot = 0; let lostAccess = 0;
const rows = [];
for (const u of users) {
  const bal = u.balance || 0;
  const wc = accts[u.id]?.weekCount || 0;
  const a = maxBuyable(wc, bal, R0, k, exp);
  const b = maxBuyable(wc, bal, newR0, newK, exp);
  beforeTot += a; afterTot += b;
  if (a > 0 && b === 0) lostAccess += 1;
  if (a !== b) rows.push({ name: u.name || u.id, bal, wc, a, b });
}
rows.sort((x, y) => y.bal - x.bal);
console.log('변동자 (잔고 / 이번주 구매수 / DP 전:후)');
for (const r of rows) console.log(`  ${String(r.name).padEnd(8)} ${String(r.bal).padStart(8)}  wc=${r.wc}  ${r.a} → ${r.b}`);

console.log(`\n총 DP: ${beforeTot} → ${afterTot}  |  주간 현금 상한: ${(beforeTot * 500).toLocaleString()}원 → ${(afterTot * 500).toLocaleString()}원`);
for (const n of [1, 3, 5, 7]) {
  const a = rangeCost(0, n, R0, k, exp); const b = rangeCost(0, n, newR0, newK, exp);
  console.log(`${n}개 확보 비용: ${a.toLocaleString()} → ${b.toLocaleString()}  (+${Math.round((b / a - 1) * 100)}%)`);
}
console.log(`★새로 DP를 못 사게 되는 인원: ${lostAccess}명${lostAccess ? ' ← 확인 필요' : ''}`);

if (EXECUTE) {
  await db.doc('meta/dpExchange').set({ R0: newR0, k: newK, rebasedAt: FieldValue.serverTimestamp(), prevR0: R0, prevK: k }, { merge: true });
  const after = (await db.doc('meta/dpExchange').get()).data();
  console.log(`\n✅ 리베이스 완료 — R0=${after.R0} k=${after.k} exp=${after.exp}`);
} else {
  console.log('\n(DRY RUN — 실제 반영하려면 --execute)');
}
process.exit(0);
