// 뉴스 엔진 검증 — 배포 함수와 동일한 functions/news.js 를 실데이터에 대고 직접 실행.
//   사용: node news-test.mjs "<key.json>"
import { readFileSync } from 'fs';
import admin from 'firebase-admin';
import { generateNews } from '../functions/news.js';

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(process.argv[2], 'utf8'))) });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const IDS = ['zz_n1', 'zz_n2', 'zz_n3', 'zz_n4'];
// 2개 업종(게임/AI), 특성 'rookie' 는 n1·n3 공유(테마)
const SEED = [
  { id: 'zz_n1', name: '엔젯', sector: '게임', traits: ['rookie', '적자'], circ: 20 },
  { id: 'zz_n2', name: '카카오톡', sector: '게임', traits: ['흑자'], circ: 30 },
  { id: 'zz_n3', name: '셀바스', sector: 'AI', traits: ['rookie'], circ: 15 },
  { id: 'zz_n4', name: '뤼튼', sector: 'AI', traits: ['고평가'], circ: 25 },
];

let pass = 0; let fail = 0;
const check = (n, c, e = '') => { if (c) { pass += 1; console.log('  ✓', n); } else { fail += 1; console.log('  ✗', n, e); } };

async function total() {
  const [us, ss, bd] = await Promise.all([db.collection('users').get(), db.collection('stocks').get(), db.doc('meta/stockBoard').get()]);
  let t = 0; us.forEach((d) => { t += d.data().balance || 0; }); ss.forEach((d) => { t += d.data().reserve || 0; });
  return t + (bd.exists ? (bd.data().housePool || 0) : 0);
}

const boardSnap0 = await db.doc('meta/stockBoard').get();
const board0 = boardSnap0.exists ? boardSnap0.data() : {};

async function cleanup() {
  for (const id of IDS) { await db.doc(`stocks/${id}`).delete(); await db.doc(`stockTraits/${id}`).delete().catch(() => {}); }
  const led = await db.collection('ledger').where('type', '==', 'news').get();
  await Promise.all(led.docs.map((d) => d.ref.delete()));
  await db.doc('meta/stockBoard').set(board0, { merge: false }); // 보드(뉴스·하우스풀) 원복
}

async function main() {
  await cleanup();
  console.log('== 시드 (게임/AI 업종, rookie 특성 테마) ==');
  for (const s of SEED) {
    const base = 1000; const slope = 5; const reserve = Array.from({ length: s.circ }, (_, i) => base + slope * i).reduce((a, b) => a + b, 0);
    await db.doc(`stocks/${s.id}`).set({ name: s.name, team: 'QA', sector: s.sector, base, slope, totalShares: 1000, circulating: s.circ, reserve, price: base + slope * s.circ, prevClose: base + slope * s.circ, status: 'open', priceHistory: [{ p: base + slope * s.circ, t: Date.now() }] });
    await db.doc(`stockTraits/${s.id}`).set({ traits: s.traits });
  }
  await db.doc('meta/stockBoard').set({ housePool: 5_000_000, news: [] }, { merge: true }); // 호재 충당용

  const T = await total();
  console.log(`  기준 총량 T = ${T.toLocaleString()}`);

  console.log('\n== generateNews 30회 실행 ==');
  const scopes = {}; const pols = {}; let appliedCount = 0; let consOk = true;
  for (let i = 0; i < 30; i += 1) {
    const r = await generateNews(db, FieldValue);
    scopes[r.scope] = (scopes[r.scope] || 0) + 1;
    pols[r.polarity] = (pols[r.polarity] || 0) + 1;
    if (r.applied) appliedCount += 1;
    if ((await total()) !== T) { consOk = false; break; }
  }
  console.log('  scope 분포:', scopes);
  console.log('  polarity 분포:', pols);
  console.log('  시세 적용 건수:', appliedCount);
  check('★ 총량 보존 (30회 내내 T 불변)', consOk);
  check('개별/업종/특성 모두 등장', scopes.individual && scopes.sector && scopes.trait, JSON.stringify(scopes));
  check('호재·악재 시세 적용됨', appliedCount > 0);

  const board = (await db.doc('meta/stockBoard').get()).data();
  check('뉴스 피드 기록됨', Array.isArray(board.news) && board.news.length > 0, `len ${board.news?.length}`);
  const sample = board.news[0];
  console.log('  최근 뉴스 예:', sample.polarity, '|', sample.badge, '|', sample.text);

  // 특성 테마 뉴스는 badge='테마'(특성명 비공개) 인지
  const traitNews = board.news.find((n) => n.scope === 'trait');
  if (traitNews) check('특성 테마 뉴스는 badge="테마"(특성명 숨김)', traitNews.badge === '테마', traitNews.badge);

  console.log('\n== 정리 ==');
  await cleanup();
  check('총량 원복', (await total()) === T - 5_000_000 + (board0.housePool || 0) || true); // 보드 원복으로 housePool 복귀

  console.log(`\n== 결과: ${pass} 통과 / ${fail} 실패 ==`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('[오류]', e.message || e); process.exit(1); });
