// 주급 1주 1회 제한 도입 백필 — 기존 teamLedger.salary 기록에서 팀별 마지막 지급 주를
//   stocks/{id}.lastSalaryWeek 에 심는다. 이걸 안 하면 이미 이번 주에 지급한 팀이 한 번 더 지급할 수 있다.
//   급여 주 경계 = 월요일 09:00(KST) — functions/index.js payWeekKey 와 동일 로직.
//
//   usage:
//     node backfill_salary_week.mjs "<serviceAccount.json>"            # DRY
//     node backfill_salary_week.mjs "<serviceAccount.json>" --execute
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const keyPath = process.argv[2];
const EXECUTE = process.argv.includes('--execute');
if (!keyPath) { console.error('서비스 계정 키 경로가 필요합니다.'); process.exit(1); }
initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();

function seoulWeekKey(d = new Date()) {
  const s = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = (s.getDay() + 6) % 7;
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - day + 3);
  const firstThu = new Date(s.getFullYear(), 0, 4);
  const week = 1 + Math.round(((s - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return `${s.getFullYear()}-W${String(week).padStart(2, '0')}`;
}
const PAY_WEEK_OFFSET_MS = 9 * 60 * 60 * 1000;
const payWeekKey = (d = new Date()) => seoulWeekKey(new Date(d.getTime() - PAY_WEEK_OFFSET_MS));

const now = payWeekKey();
console.log(`현재 급여 주: ${now}\n`);

const snap = await db.collection('teamLedger').where('type', '==', 'salary').get();
const lastByStock = {};
snap.forEach((d) => {
  const t = d.data();
  const at = t.ts?.toDate?.();
  if (!at || !t.stockId) return;
  const wk = payWeekKey(at);
  const prev = lastByStock[t.stockId];
  if (!prev || at > prev.at) lastByStock[t.stockId] = { at, wk, gross: t.totalGross };
});

const entries = Object.entries(lastByStock);
if (!entries.length) { console.log('salary 기록 없음 — 백필할 것이 없습니다.'); process.exit(0); }

for (const [stockId, v] of entries) {
  const cur = v.wk === now ? ' ← 이번 주 소진(다음 월 09:00까지 지급 차단)' : '';
  console.log(`${stockId}  마지막 지급 ${v.at.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}  주=${v.wk}  gross=${v.gross}${cur}`);
  if (EXECUTE) await db.doc(`stocks/${stockId}`).set({ lastSalaryWeek: v.wk }, { merge: true });
}
console.log(EXECUTE ? '\n✅ 백필 완료' : '\n(DRY RUN — 실제 반영하려면 --execute)');
process.exit(0);
