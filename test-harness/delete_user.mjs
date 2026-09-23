// 퇴소 수강생 계정 삭제 — ★총량보존을 지키면서★ 지운다.
//   users 문서를 그냥 지우면 그 사람 잔고만큼 총 포인트가 증발해 보존식이 깨진다.
//   그래서 삭제 = 잔고 전액 housePool 회수(clawback_kami.mjs 와 같은 회계) + 문서 제거다.
//
//   ★지우는 것★  users/{id} · dpAccounts/{id} · stocks/*.members 에서 이름 제거
//   ★남기는 것★  ledger · submissions · solved · teamLedger — 사후 감사용 기록이라 건드리지 않는다.
//                (solved 를 지우면 동명이인 재가입 시 같은 문제로 보상이 다시 나간다.)
//
//   ★거부 조건★ (하나라도 걸리면 아무것도 안 하고 중단 — 지우면 복구가 안 되는 것들이다)
//     · 보유 주식이 있다(holdings.shares>0)  → reserve 가 그 주식을 받치고 있어 고아 reserve 가 된다
//     · 어느 팀의 대표다(stocks.ceoUserId)   → 금고를 움직일 사람이 사라진다. 대표 교체가 먼저다
//     · 카지노 칩·진행 중 라운드가 있다       → 칩은 포인트 예치금이라 같이 회수해야 한다
//     · 에스크로에 묶여 있다(gigs·recruits·holdemGames)
//
//   usage:
//     node delete_user.mjs "<serviceAccount.json>" --user "<이름 또는 문서ID>"             # DRY
//     node delete_user.mjs "<serviceAccount.json>" --user "<이름 또는 문서ID>" --execute
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const keyPath = process.argv[2];
const EXECUTE = process.argv.includes('--execute');
const uArg = process.argv[process.argv.indexOf('--user') + 1];
if (!keyPath || process.argv.indexOf('--user') < 0 || !uArg) {
  console.error('usage: node delete_user.mjs "<serviceAccount.json>" --user "<이름 또는 문서ID>" [--execute]');
  process.exit(1);
}
initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();
const fmt = (n) => Math.round(n || 0).toLocaleString();

// ── 대상 찾기 (문서 ID ≠ 이름 슬러그일 수 있다 — 불변식 #8: ID → name 폴백) ──
let snap = await db.doc(`users/${uArg}`).get();
if (!snap.exists) {
  const q = await db.collection('users').where('name', '==', uArg).get();
  if (q.empty) { console.error(`✗ '${uArg}' 계정을 찾을 수 없습니다.`); process.exit(1); }
  if (q.size > 1) { console.error(`✗ '${uArg}' 동명이인 ${q.size}명 — 문서 ID 로 지정하세요: ${q.docs.map((d) => d.id).join(', ')}`); process.exit(1); }
  snap = q.docs[0];
}
const uid = snap.id;
const balance = Math.round(snap.data().balance || 0);
console.log(`대상: ${snap.data().name || '(이름없음)'}  문서ID=${uid}  잔고=${fmt(balance)}P\n`);

// ── 안전 점검 ──
const blockers = [];
const notes = [];

const holds = await db.collection('holdings').get();
const mine = holds.docs.filter((d) => (d.data().userId || d.id.split('__')[0]) === uid);
const shareRows = mine.filter((d) => (d.data().shares || 0) > 0 || (d.data().offerShares || 0) > 0);
if (shareRows.length) blockers.push(`보유 주식 ${shareRows.length}종 — 먼저 전량 매도해야 합니다: ` + shareRows.map((d) => `${d.id}(${d.data().shares || 0}주)`).join(', '));
else if (mine.length) notes.push(`holdings ${mine.length}건(전부 0주) → 같이 삭제`);

const stocks = await db.collection('stocks').get();
const ceoOf = stocks.docs.filter((d) => d.data().ceoUserId === uid);
if (ceoOf.length) blockers.push(`팀 대표입니다(${ceoOf.map((d) => d.data().name || d.id).join(', ')}) — 대표를 교체한 뒤 다시 실행하세요.`);
const memberOf = stocks.docs.filter((d) => (d.data().members || []).includes(uid));
if (memberOf.length) notes.push(`팀 멤버 ${memberOf.length}곳(${memberOf.map((d) => d.data().name || d.id).join(', ')}) → members 에서 제거`);

const chipSnap = await db.doc(`casinoChips/${uid}`).get();
const chips = Math.round(chipSnap.exists ? chipSnap.data().chips || 0 : 0);
if (chips > 0) blockers.push(`카지노 칩 ${fmt(chips)}개 보유 — 먼저 환전(퇴장)해야 합니다.`);
const roundSnap = await db.doc(`casinoRounds/${uid}`).get();
if (roundSnap.exists) blockers.push(`진행 중인 카지노 라운드가 있습니다(에스크로 ${fmt(roundSnap.data().escrow)}) — casinoSweepStale 정리 후 재시도.`);

for (const [col, field] of [['gigs', 'escrow'], ['recruits', 'escrow'], ['holdemGames', 'escrow']]) {
  const all = await db.collection(col).get();
  const tied = all.docs.filter((d) => {
    const x = d.data();
    if ((x[field] || 0) <= 0) return false;
    return JSON.stringify(x).includes(uid);
  });
  if (tied.length) blockers.push(`${col} 에스크로에 묶여 있습니다(${tied.length}건) — 정산·환불 후 재시도.`);
}

const dpSnap = await db.doc(`dpAccounts/${uid}`).get();
const dp = dpSnap.exists ? dpSnap.data().dp || 0 : 0;
if (dpSnap.exists) notes.push(`dpAccounts(DP ${dp}) → 삭제 (DP는 별개 통화라 housePool 무영향)`);

console.log('── 처리 예정 ──');
console.log(`  users/${uid} 삭제 · 잔고 ${fmt(balance)}P → housePool 회수 (총량보존)`);
for (const n of notes) console.log(`  ${n}`);
console.log('  ledger · submissions · solved · teamLedger 는 보존(감사 기록)');

if (blockers.length) {
  console.log('\n✗ 중단 — 아래를 먼저 해결하세요:');
  for (const b of blockers) console.log(`  · ${b}`);
  process.exit(1);
}

if (!EXECUTE) { console.log('\n(DRY RUN — 실제 삭제하려면 --execute)'); process.exit(0); }

// ── 집행: 잔고 회수와 문서 삭제를 한 트랜잭션으로 (중간에 끊기면 포인트가 증발한다) ──
await db.runTransaction(async (tx) => {
  const uRef = db.doc(`users/${uid}`);
  const cur = await tx.get(uRef);
  if (!cur.exists) throw new Error('대상이 이미 삭제되었습니다.');
  const bal = Math.round(cur.data().balance || 0);   // DRY 이후 바뀌었을 수 있어 트랜잭션 안에서 다시 읽는다
  // housePool 은 read 하지 않고 increment 로만 — 매분 틱과 충돌 방지(불변식 #1)
  tx.set(db.doc('meta/stockBoard'), { housePool: FieldValue.increment(bal) }, { merge: true });
  tx.set(db.collection('ledger').doc(), {
    type: 'user_delete', userId: uid, name: cur.data().name || '', delta: -bal, houseDelta: bal,
    dp, memo: '퇴소 수강생 계정 삭제 — 잔고 전액 housePool 회수', ts: FieldValue.serverTimestamp(),
  });
  tx.delete(uRef);
  if (dpSnap.exists) tx.delete(db.doc(`dpAccounts/${uid}`));
  for (const d of mine) tx.delete(d.ref);
  for (const s of memberOf) tx.update(s.ref, { members: FieldValue.arrayRemove(uid) });
  console.log(`  (tx) 잔고 ${fmt(bal)}P 회수`);
});

console.log(`\n✅ ${uid} 삭제 완료 — housePool +${fmt(balance)} · 총량보존 유지`);
console.log('   검산: node audit_house.mjs   (user_delete 항목으로 잡힙니다)');
process.exit(0);
