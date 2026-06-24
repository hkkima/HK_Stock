// 브라우저 E2E용 시드 — Admin SDK 로 거래 가능한 종목 + 펀딩된 테스트 계정 생성.
//   사용: node seed.mjs "<key.json>"   /   정리: node seed.mjs "<key.json>" --clean
import { readFileSync } from 'fs';
import admin from 'firebase-admin';

const KEY = process.argv[2];
const CLEAN = process.argv.includes('--clean');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(KEY, 'utf8'))) });
const db = admin.firestore();

function hashPin(pin) { const s = String(pin); let h = 5381; for (let i = 0; i < s.length; i += 1) h = (h * 33) ^ s.charCodeAt(i); return 'pin_' + (h >>> 0).toString(16); }

const STOCK = 'zz_e2e_co';
const USER = 'zz_browser_test';

async function clean() {
  await db.doc(`stocks/${STOCK}`).delete();
  await db.doc(`stockTraits/${STOCK}`).delete();
  await db.doc(`users/${USER}`).delete();
  await db.doc(`holdings/${USER}__${STOCK}`).delete();
  for (const col of ['trades', 'ledger']) {
    for (const field of ['userId', 'stockId']) {
      const val = field === 'userId' ? USER : STOCK;
      const q = await db.collection(col).where(field, '==', val).get();
      await Promise.all(q.docs.map((d) => d.ref.delete()));
    }
  }
  console.log('정리 완료 (종목·계정·보유·거래·원장 로그)');
}

async function seed() {
  await db.doc(`users/${USER}`).set({ name: '브라우저테스트', pinHash: hashPin('1234'), balance: 1_000_000 });
  await db.doc(`stocks/${STOCK}`).set({
    name: '이투이테스트', team: 'QA', sector: '테스트',
    base: 1000, slope: 5, totalShares: 1000, circulating: 0, reserve: 0,
    price: 1000, prevClose: 1000, dayOpen: 1000, status: 'open',
    priceHistory: [{ p: 1000, t: Date.now() }], createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.doc(`stockTraits/${STOCK}`).set({ traits: ['해리스', '비공개특성'] });
  console.log('시드 완료: 종목', STOCK, '/ 계정 브라우저테스트(PIN 1234) 잔액 1,000,000');
}

await (CLEAN ? clean() : seed());
process.exit(0);
