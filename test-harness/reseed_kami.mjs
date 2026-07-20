// 까미(가치앵커) 재시드 — 통제된 발행(총량 +AMOUNT)을 까미 지갑에 직접 지급.
//   housePool 은 건드리지 않는다(이전 clawback 으로 고친 적자를 되돌리지 않기 위함).
//   → 총량 = Σ지갑+Σ리저브+housePool 에서 Σ지갑만 +AMOUNT → 계획적 발행(유일 총량변동 경로).
//   ledger type 'operator_reseed', houseDelta:0 (housePool 무영향 → 감사 정합 유지).
//   usage: node reseed_kami.mjs "C:\path\to\serviceAccount.json" [--dry]
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const AMOUNT = 200_000;
const keyPath = process.argv[2];
const dry = process.argv.includes('--dry');
if (!keyPath) { console.error('서비스 계정 키 경로가 필요합니다.'); process.exit(1); }

initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();

const us = await db.collection('users').where('name', '==', '까미').get();
if (us.empty) { console.error('까미 계정을 찾을 수 없습니다.'); process.exit(1); }
const kamiId = us.docs[0].id;
const before = Math.round(us.docs[0].data().balance || 0);
console.log(`까미(${kamiId}) 현재 잔액:`, before.toLocaleString(), dry ? '(DRY)' : '');
if (dry) { console.log(`→ +${AMOUNT.toLocaleString()} 지급 예정 (총량 발행)`); process.exit(0); }

const after = await db.runTransaction(async (tx) => {
  const uRef = db.doc(`users/${kamiId}`);
  const uSnap = await tx.get(uRef);
  const bal = Math.round(uSnap.data().balance || 0);
  tx.update(uRef, { balance: bal + AMOUNT });
  tx.set(db.collection('ledger').doc(), {
    type: 'operator_reseed', userId: kamiId, delta: AMOUNT, houseDelta: 0,
    memo: '까미 가치앵커 재시드(통제 발행, housePool 무영향)', ts: FieldValue.serverTimestamp(),
  });
  return bal + AMOUNT;
});
console.log(`✅ 재시드 완료. 까미 잔액 ${before.toLocaleString()} → ${after.toLocaleString()} (+${AMOUNT.toLocaleString()})`);
