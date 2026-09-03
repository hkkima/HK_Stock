// DP 주간 곡선 수동 초기화 — 운영자가 "지금 한 번" 곡선을 처음으로 되돌릴 때.
//
//   평소엔 초기화가 자동이다: convertToDP 가 `acc.weekKey !== seoulWeekKey()` 이면
//   weekCount 를 0 으로 보고 계산한다(월요일 00:00 KST 경계).
//   이 스크립트는 그 경계를 기다리지 않고 같은 효과를 즉시 만든다.
//
//   ★건드리는 것★ dpAccounts/{userId}.weekCount → 0, weekKey → 이번 주.
//   ★보존하는 것★ dp(보유량) · totalBought(과정 누적, perCourseCap 판정에 쓰임).
//     보유 DP 를 건드리지 않으므로 총량보존과 무관하다(DP 는 포인트가 아니다).
//     자동 초기화도 원장을 남기지 않으므로 여기서도 ledger 를 쓰지 않는다
//     (대신 meta/dpExchange.lastManualCurveReset 에 실행 시각만 적어 둔다).
//
//   usage:
//     node dp_week_reset.mjs "<serviceAccount.json>"            # DRY
//     node dp_week_reset.mjs "<serviceAccount.json>" --execute
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const keyPath = process.argv[2];
const EXECUTE = process.argv.includes('--execute');
if (!keyPath) { console.error('서비스 계정 키 경로가 필요합니다.'); process.exit(1); }
initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();

// functions/index.js 의 seoulWeekKey 와 동일 로직(월요일 경계, Asia/Seoul).
function seoulWeekKey(d = new Date()) {
  const s = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = (s.getDay() + 6) % 7;
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - day + 3);
  const firstThu = new Date(s.getFullYear(), 0, 4);
  const week = 1 + Math.round(((s - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return `${s.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

const wk = seoulWeekKey();
const cfg = (await db.doc('meta/dpExchange').get()).data() || {};
const R0 = cfg.R0 ?? 10000, k = cfg.k ?? 1000, exp = cfg.exp ?? 2;
const marginal = (i) => Math.round(R0 + k * (i ** exp));

const qs = await db.collection('dpAccounts').get();
const rows = [];
qs.forEach((d) => {
  const a = d.data();
  rows.push({ ref: d.ref, id: d.id, dp: a.dp || 0, weekKey: a.weekKey || '', weekCount: a.weekCount || 0 });
});
const targets = rows.filter((r) => r.weekKey === wk && r.weekCount > 0);

console.log(`주 키 ${wk} · 곡선 R0=${R0} k=${k} exp=${exp}`);
console.log(`dpAccounts ${rows.length}개 중 초기화 대상 ${targets.length}명\n`);
for (const r of targets.sort((a, b) => b.weekCount - a.weekCount)) {
  console.log(`  ${r.id.padEnd(14)} 이번주 ${String(r.weekCount).padStart(3)}DP`
    + ` · 다음 1DP 가격 ${marginal(r.weekCount).toLocaleString()} → ${marginal(0).toLocaleString()}`);
}
console.log(`\n합계 ${targets.reduce((a, r) => a + r.weekCount, 0)}DP 어치 카운터가 0 으로 돌아갑니다.`);
console.log('보유 DP·누적 구매량(totalBought)은 그대로 둡니다.');

if (!EXECUTE) { console.log('\n(DRY RUN — 실제 반영하려면 --execute)'); process.exit(0); }

let batch = db.batch(), n = 0;
for (const r of targets) {
  batch.set(r.ref, { weekKey: wk, weekCount: 0, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
}
batch.set(db.doc('meta/dpExchange'), {
  lastManualCurveReset: FieldValue.serverTimestamp(), lastManualCurveResetWeek: wk,
}, { merge: true });
await batch.commit();
console.log(`\n✅ ${targets.length}명 초기화 완료 — 이번 주 첫 구매가 다시 ${marginal(0).toLocaleString()}P 부터입니다.`);
process.exit(0);
