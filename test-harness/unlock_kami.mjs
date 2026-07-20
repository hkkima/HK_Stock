// 까미(운영 계정) 스톡옵션 잠금 해제 — holdings.locked 만 0으로. 포인트/housePool/reserve 무영향.
//   까미는 운영 계정이라 옵션 매도 금지가 걸리면 안 됨 → locked 제거해 매도 허용.
//   usage: node unlock_kami.mjs "C:\path\to\serviceAccount.json" [--dry]
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const keyPath = process.argv[2];
const dry = process.argv.includes('--dry');
if (!keyPath) { console.error('서비스 계정 키 경로가 필요합니다.'); process.exit(1); }

initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();

// 까미 userId 확인
const us = await db.collection('users').where('name', '==', '까미').get();
if (us.empty) { console.error('까미 계정을 찾을 수 없습니다.'); process.exit(1); }
const kamiId = us.docs[0].id;
console.log('까미 userId:', kamiId, dry ? '(DRY RUN)' : '');

// 까미의 locked>0 보유분
const hs = await db.collection('holdings').where('userId', '==', kamiId).get();
const targets = hs.docs.filter((d) => (d.data().locked || 0) > 0);
console.log('잠금 해제 대상:', targets.length, '건\n');
if (targets.length === 0) process.exit(0);

for (const d of targets) {
  const h = d.data();
  console.log(`  ${d.id.padEnd(28)} shares=${h.shares || 0}  locked ${h.locked} → 0`);
  if (dry) continue;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(d.ref);
    if (!snap.exists) return;
    const prev = snap.data().locked || 0;
    if (prev <= 0) return;
    tx.update(d.ref, { locked: 0, updatedAt: FieldValue.serverTimestamp() });
    tx.set(db.collection('ledger').doc(), {
      type: 'option_unlock', userId: kamiId, stockId: h.stockId, unlocked: prev,
      memo: '까미 운영계정 — 옵션 매도금지 해제', ts: FieldValue.serverTimestamp(),
    });
  });
}
console.log(dry ? '\n(변경 없음 — dry run)' : '\n✅ 완료. 까미 옵션 매도 가능.');
