// 재상장 리셋 — 강제매도 + 상장폐지 (까미홀딩스 제외).
//   delistStock 콜러블 로직을 admin SDK로 재현: 보유자에게 현재가×주식수 지급(수수료·슬리피지 없음)
//   → reserve−지급액을 housePool 정산(increment, 총량보존, 음수허용) → 종목·보유·시세이력·traits 삭제.
//   잔고·housePool 은 FieldValue.increment 로만(까미 봇 동시성 안전, 불변식 #1).
//
//   usage:
//     node relisting_reset_delist.mjs "<serviceAccount.json>"            # DRY (쓰기 없음, 프리뷰)
//     node relisting_reset_delist.mjs "<serviceAccount.json>" --execute  # 실제 실행
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const keyPath = process.argv[2];
if (!keyPath) { console.error('서비스 계정 키 경로가 필요합니다.'); process.exit(1); }
const EXEC = process.argv.includes('--execute');
initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();
const fmt = (n) => Math.round(n).toLocaleString();
const KEEP = '까미홀딩스'; // 유지: 상폐·매도 모두 제외

const board0 = (await db.doc('meta/stockBoard').get()).data() || {};
const stocks = (await db.collection('stocks').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
console.log(EXEC ? '★ 실행 모드 ★' : '(DRY · 쓰기 없음)', '· housePool 시작', fmt(board0.housePool || 0), '· 종목', stocks.length, '\n');

let grandPayout = 0, grandDelta = 0, processed = 0;
for (const s of stocks) {
  if (s.name === KEEP) { console.log(`  ${s.name} [유지]`); continue; }
  const price = s.price || 0, reserve = s.reserve || 0;
  const hs = (await db.collection('holdings').where('stockId', '==', s.id).get()).docs
    .map((d) => ({ ref: d.ref, ...d.data() })).filter((h) => (h.shares || 0) > 0);
  let payout = 0; for (const h of hs) payout += price * h.shares;
  const delta = reserve - payout;
  grandPayout += payout; grandDelta += delta; processed++;

  if (!EXEC) { console.log(`  ${String(s.name).padEnd(12)} 지급 ${fmt(payout).padStart(9)} · house ${fmt(delta).padStart(9)} · 보유자 ${hs.length}`); continue; }

  const candleRefs = (await db.collection(`stocks/${s.id}/candles`).get()).docs.map((d) => d.ref);
  const batch = db.batch();
  for (const h of hs) {
    if (price * h.shares > 0) batch.update(db.doc(`users/${h.userId}`), { balance: FieldValue.increment(price * h.shares) });
    batch.delete(h.ref);
  }
  batch.set(db.doc('meta/stockBoard'), { housePool: FieldValue.increment(delta) }, { merge: true });
  batch.delete(db.doc(`stocks/${s.id}/series/intraday`));
  for (const r of candleRefs) batch.delete(r);
  batch.delete(db.doc(`stocks/${s.id}`));
  batch.delete(db.doc(`stockTraits/${s.id}`));
  batch.set(db.collection('ledger').doc(), { stockId: s.id, type: 'delist', settlePrice: price, totalPayout: payout, reserveReturned: delta, count: hs.length, note: 'relisting-reset', ts: FieldValue.serverTimestamp() });
  await batch.commit();
  console.log(`  ✓ ${String(s.name).padEnd(12)} 지급 ${fmt(payout).padStart(9)} · house ${fmt(delta).padStart(9)} · 보유자 ${hs.length} 삭제완료`);
}

console.log('\n  처리 종목', processed, '· 총 지급', fmt(grandPayout), '· housePool 예상', fmt((board0.housePool || 0) + grandDelta));
if (EXEC) {
  const after = (await db.doc('meta/stockBoard').get()).data() || {};
  const remain = (await db.collection('stocks').get()).docs.map((d) => d.data().name);
  console.log('  실제 housePool 후:', fmt(after.housePool || 0), '· 남은 종목:', remain.join(', ') || '(없음)');
}
