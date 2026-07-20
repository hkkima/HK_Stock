// 까미(운영 봇) 잔액 전액 회수 → housePool. 총량 보존(까미 balance −X / housePool +X, 같은 X).
//   까미는 2분 루프 봇이라 잔액이 실시간 변동 → 트랜잭션 안에서 현재 잔액을 읽어 그 전액을 이동(원자적).
//   housePool 은 read 하지 않고 increment 로만(매분 틱과 충돌 방지 — 불변식 #1).
//   usage: node clawback_kami.mjs "C:\path\to\serviceAccount.json" [--dry]
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const keyPath = process.argv[2];
const dry = process.argv.includes('--dry');
if (!keyPath) { console.error('서비스 계정 키 경로가 필요합니다.'); process.exit(1); }

initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();

const us = await db.collection('users').where('name', '==', '까미').get();
if (us.empty) { console.error('까미 계정을 찾을 수 없습니다.'); process.exit(1); }
const kamiId = us.docs[0].id;

if (dry) {
  const bal = (await db.doc(`users/${kamiId}`).get()).data()?.balance || 0;
  console.log(`(DRY) 까미(${kamiId}) 현재 잔액:`, Math.round(bal).toLocaleString(), '→ 회수 예정(변동 가능)');
  process.exit(0);
}

const reclaimed = await db.runTransaction(async (tx) => {
  const uRef = db.doc(`users/${kamiId}`);
  const uSnap = await tx.get(uRef);
  if (!uSnap.exists) throw new Error('까미 계정 없음');
  const bal = Math.round(uSnap.data().balance || 0);
  if (bal <= 0) return 0;
  tx.update(uRef, { balance: 0 });
  tx.set(db.doc('meta/stockBoard'), { housePool: FieldValue.increment(bal) }, { merge: true });
  tx.set(db.collection('ledger').doc(), {
    type: 'operator_clawback', userId: kamiId, delta: -bal, houseDelta: bal,
    memo: '까미 운영봇 옵션시드 잔액 전액 회수 → housePool', ts: FieldValue.serverTimestamp(),
  });
  return bal;
});

console.log(`✅ 까미(${kamiId}) 잔액 ${reclaimed.toLocaleString()} 회수 → housePool +${reclaimed.toLocaleString()} (balance→0)`);
