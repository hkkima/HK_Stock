// DP 곡선 리베이스 — meta/dpExchange 의 R0 상향(현금 방파제).
//   곡선: i번째 DP 개당가 = R0 + k·i^exp.  ★R0 만 올린다★(k 유지 → 상단 곡률=몰아사기 징벌 보존).
//   근거: 학생 대부분이 1~5 DP 구간이라 R0 가 지배적이고 k 는 상위 몇 명에게만 작동한다.
//         k 까지 2배로 올리면 고액 전환자를 이중으로 때리게 된다.
//
//   usage:
//     node dp_rebase.mjs "<serviceAccount.json>" <newR0>            # DRY
//     node dp_rebase.mjs "<serviceAccount.json>" <newR0> --execute
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { maxBuyable, rangeCost } from '../functions/dpcurve.js';

const keyPath = process.argv[2];
const newR0 = Math.floor(Number(process.argv[3]));
const EXECUTE = process.argv.includes('--execute');
if (!keyPath || !(newR0 > 0)) { console.error('usage: node dp_rebase.mjs <key.json> <newR0> [--execute]'); process.exit(1); }
initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();

const cfg = (await db.doc('meta/dpExchange').get()).data() || {};
const R0 = cfg.R0 ?? 10000; const k = cfg.k ?? 1000; const exp = cfg.exp ?? 2;
console.log(`현재 곡선: R0=${R0} k=${k} exp=${exp}`);
console.log(`리베이스 : R0=${newR0} k=${k} exp=${exp}  (k·exp 불변)\n`);

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
  const b = maxBuyable(wc, bal, newR0, k, exp);
  beforeTot += a; afterTot += b;
  if (a > 0 && b === 0) lostAccess += 1;
  if (a !== b) rows.push({ name: u.name || u.id, bal, wc, a, b });
}
rows.sort((x, y) => y.bal - x.bal);
console.log('변동자 (잔고 / 이번주 구매수 / DP 전:후)');
for (const r of rows) console.log(`  ${String(r.name).padEnd(8)} ${String(r.bal).padStart(8)}  wc=${r.wc}  ${r.a} → ${r.b}`);

console.log(`\n총 DP: ${beforeTot} → ${afterTot}  |  주간 현금 상한: ${(beforeTot * 500).toLocaleString()}원 → ${(afterTot * 500).toLocaleString()}원`);
console.log(`1DP 도달 비용: ${rangeCost(0, 1, R0, k, exp).toLocaleString()} → ${rangeCost(0, 1, newR0, k, exp).toLocaleString()}`);
console.log(`★새로 DP를 못 사게 되는 인원: ${lostAccess}명${lostAccess ? ' ← 확인 필요' : ''}`);

if (EXECUTE) {
  await db.doc('meta/dpExchange').set({ R0: newR0, rebasedAt: FieldValue.serverTimestamp(), prevR0: R0 }, { merge: true });
  const after = (await db.doc('meta/dpExchange').get()).data();
  console.log(`\n✅ 리베이스 완료 — R0=${after.R0} k=${after.k} exp=${after.exp}`);
} else {
  console.log('\n(DRY RUN — 실제 반영하려면 --execute)');
}
process.exit(0);
