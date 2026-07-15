// 외주 게시판(HK_Board) E2E 검증 보조 — 테스트 계정 시드 / 총량 스냅샷 / 정리.
//   서비스계정 키 필요. 사용:
//     node gig_e2e.mjs seed     → zzGigBuyer(5000P)/zzGigWorker(0P) 생성(PIN 1111/2222)
//     node gig_e2e.mjs total    → 총량(Σ지갑+Σreserve+housePool+Σescrow) 출력
//     node gig_e2e.mjs cleanup  → 테스트 계정·외주·봉사·관련 ledger 삭제
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const KEY_DIR = process.env.HK_KEY_DIR || 'C:\\HK_Bot';
const keyFile = readdirSync(KEY_DIR).find((f) => /firebase-adminsdk.*\.json$/i.test(f));
if (!keyFile) { console.error('서비스계정 키 없음'); process.exit(1); }
initializeApp({ credential: cert(join(KEY_DIR, keyFile)) });
const db = getFirestore();

// 주식/베팅판과 동일한 djb2 해시(auth.js).
function hashPin(pin) {
  const s = String(pin); let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = (h * 33) ^ s.charCodeAt(i);
  return 'pin_' + (h >>> 0).toString(16);
}

const cmd = process.argv[2] || 'total';

if (cmd === 'seed') {
  await db.doc('users/zz_gig_buyer').set({ name: 'zzGigBuyer', pinHash: hashPin('1111'), balance: 5000 });
  await db.doc('users/zz_gig_worker').set({ name: 'zzGigWorker', pinHash: hashPin('2222'), balance: 0 });
  await db.doc('users/zz_gig_co').set({ name: 'zzGigCo', pinHash: hashPin('3333'), balance: 3000 });
  console.log('seeded zzGigBuyer(5000P, 1111) / zzGigWorker(0P, 2222) / zzGigCo(3000P, 3333)');
} else if (cmd === 'total') {
  const users = await db.collection('users').get();
  let wallets = 0; users.forEach((d) => { wallets += d.data().balance || 0; });
  const stocks = await db.collection('stocks').get();
  let reserve = 0; stocks.forEach((d) => { reserve += d.data().reserve || 0; });
  const board = (await db.doc('meta/stockBoard').get()).data() || {};
  const house = board.housePool || 0;
  const gigs = await db.collection('gigs').get();
  let escrow = 0; gigs.forEach((d) => { escrow += d.data().escrow || 0; });
  const total = wallets + reserve + house + escrow;
  console.log(JSON.stringify({ wallets, reserve, house, escrow, total }, null, 0));
} else if (cmd === 'bal') {
  const b = await db.doc('users/zz_gig_buyer').get();
  const w = await db.doc('users/zz_gig_worker').get();
  console.log('buyer:', b.data()?.balance, '| worker:', w.data()?.balance);
  const g = await db.collection('gigs').where('requesterId', '==', 'zz_gig_buyer').get();
  g.forEach((d) => console.log('gig:', d.data().status, '| escrow:', d.data().escrow, '| worker:', d.data().workerName));
  const pr = await db.doc('profiles/zz_gig_worker').get();
  console.log('worker profile:', pr.exists ? JSON.stringify({ skills: pr.data().skills, bio: pr.data().bio }) : '(none)');
} else if (cmd === 'cleanup') {
  for (const id of ['zz_gig_buyer', 'zz_gig_worker', 'zz_gig_co']) await db.doc(`users/${id}`).delete().catch(() => {});
  for (const id of ['zz_gig_buyer', 'zz_gig_worker', 'zz_gig_co']) await db.doc(`profiles/${id}`).delete().catch(() => {});
  const gigs = await db.collection('gigs').where('requesterId', 'in', ['zz_gig_buyer', 'zz_gig_worker', 'zz_gig_co']).get();
  for (const d of gigs.docs) await d.ref.delete();
  const help = await db.collection('helpRequests').where('requesterId', 'in', ['zz_gig_buyer', 'zz_gig_worker', 'zz_gig_co']).get();
  for (const d of help.docs) await d.ref.delete();
  const rec = await db.collection('recruits').where('requesterId', 'in', ['zz_gig_buyer', 'zz_gig_worker', 'zz_gig_co']).get();
  for (const d of rec.docs) await d.ref.delete();
  const led = await db.collection('ledger').where('userId', 'in', ['zz_gig_buyer', 'zz_gig_worker', 'zz_gig_co']).get();
  for (const d of led.docs) await d.ref.delete();
  console.log(`cleanup done (gigs ${gigs.size}, help ${help.size}, ledger ${led.size})`);
}
process.exit(0);
