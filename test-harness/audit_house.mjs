// 하우스풀 적자 원인 분해 — 공개 read 규칙(meta/stocks/users/holdings/ledger)만 사용. 키 불필요.
//   ledger 를 type 별로 집계해 하우스풀에 미친 영향을 분해한다.
//   ★ delta 를 남기는 type(dividend/option_grant/price_adjust/news/mint/burn/delist)은 정확 집계.
//   ★ delta 를 안 남기는 type(impact_news/instructor_event/market_reprice)과 ledger 미기록(tick)은
//     '잔차(residual)'로 묶고, 대신 호재/악재 '건수·pct 편중'을 별도로 보여준다.
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, getDoc } from 'firebase/firestore';

const app = initializeApp({
  apiKey: 'AIzaSyDdYMFtR4jKdC6svQjEzzas-jDh_sO17DE',
  authDomain: 'hk-chess-betting.firebaseapp.com',
  projectId: 'hk-chess-betting',
});
const db = getFirestore(app);

const fmt = (n) => Math.round(n).toLocaleString();
const board = (await getDoc(doc(db, 'meta', 'stockBoard'))).data() || {};
const stocks = (await getDocs(collection(db, 'stocks'))).docs.map((d) => ({ id: d.id, ...d.data() }));
const led = (await getDocs(collection(db, 'ledger'))).docs.map((d) => d.data());

const housePool = Math.round(board.housePool || 0);
const reserveSum = Math.round(stocks.reduce((a, s) => a + (s.reserve || 0), 0));

// ── type 별 하우스 영향 집계 (부호: +면 하우스 충전, −면 드레인) ──
const known = {}; // type -> { houseDelta, count }
const bump = (t, hd) => { (known[t] ||= { houseDelta: 0, count: 0 }); known[t].houseDelta += hd; known[t].count += 1; };

let residualCount = 0;
const evtByCat = {};      // instructor_event: category -> {pos,neg,zero}
let newsPos = 0, newsNeg = 0, newsFlat = 0;      // impact_news pct 부호
let ievPos = 0, ievNeg = 0, ievZero = 0;          // instructor_event pct 부호
let repriceN = 0;
const unknownTypes = {};    // 예상 못 한 ledger type -> 건수 (숨은 항목 없게)

for (const e of led) {
  switch (e.type) {
    case 'dividend':      bump('dividend', -(e.total || 0)); break;
    case 'weekly_dividend': bump('weekly_dividend', -(e.total || 0)); break; // ③ 주간 펀더멘탈 배당(드레인)
    case 'option_grant':  bump('option_grant', -(e.cost || 0)); break;
    case 'price_adjust':  bump('price_adjust', -(e.delta || 0)); break;
    case 'news':          bump('news(auto)', -(e.totalDelta || 0)); break; // 미적용 건은 totalDelta=0
    case 'mint':          bump('mint', (e.delta || 0)); break;
    case 'burn':          bump('burn', (e.delta || 0)); break;
    case 'delist':        bump('delist', (e.reserveReturned || 0)); break;
    case 'operator_clawback': bump('operator_clawback', (e.houseDelta || 0)); break; // 운영봇 잔액 회수 → 하우스 충전
    case 'dp_convert':    bump('dp_convert', (e.cost || 0)); break; // 지갑→하우스풀(회수·충전)
    case 'help_grant':    bump('help_grant', -(e.amount ?? e.delta ?? 0)); break; // 하우스풀→봉사자(민팅·드레인)
    case 'quiz_reward':   bump('quiz_reward', -(e.delta || 0)); break; // HK_Judge 정답보상, 하우스풀→학생(배당과 동일 회계)
    case 'buy': case 'sell': if (e.houseDelta) bump('trade_fee', e.houseDelta); break; // 매도 수수료만 house 충전(지갑→house)
    case 'dp_redeem': case 'dp_grant': break;      // DP는 별개 통화 — housePool 무영향
    case 'option_unlock': break;                   // holdings.locked 만 변경 — housePool 무영향
    case 'operator_reseed': break;                 // 까미 재시드(통제 발행) — 지갑만 변경, housePool 무영향
    case 'gig_post': case 'gig_cancel': case 'gig_settle':
    case 'gig_resolve_release': case 'gig_resolve_refund': break; // 지갑↔에스크로 — housePool 무영향
    // ── delta 미기록: 잔차로 감. 대신 편중 집계 ──
    case 'impact_news': {
      residualCount += 1;
      const p = Number(e.pct) || 0; if (p > 0) newsPos += 1; else if (p < 0) newsNeg += 1; else newsFlat += 1;
      break;
    }
    case 'instructor_event': {
      residualCount += 1;
      const p = Number(e.pct) || 0; const cat = e.category || 'custom';
      (evtByCat[cat] ||= { pos: 0, neg: 0, zero: 0 });
      if (p > 0) { ievPos += 1; evtByCat[cat].pos += 1; }
      else if (p < 0) { ievNeg += 1; evtByCat[cat].neg += 1; }
      else { ievZero += 1; evtByCat[cat].zero += 1; }
      break;
    }
    case 'market_reprice': { residualCount += 1; repriceN += 1; break; }
    default: { (unknownTypes[e.type] = (unknownTypes[e.type] || 0) + 1); break; }
  }
}

// ── 알려진 버킷 합 & 잔차 ──
const knownSum = Object.values(known).reduce((a, k) => a + k.houseDelta, 0);
// housePool = knownSum + residual(=impact_news+instructor_event+market_reprice+tick 의 하우스영향)
const residual = housePool - knownSum;

console.log('════════ 하우스풀 적자 원인 분해 ════════\n');
console.log('현재 하우스풀 :', fmt(housePool));
console.log('리저브 합계   :', fmt(reserveSum));
console.log('ledger 항목수 :', led.length, '\n');

console.log('── ledger 로 정확 집계되는 경로 (부호=하우스 방향) ──');
const order = ['mint', 'burn', 'delist', 'operator_clawback', 'trade_fee', 'dp_convert', 'news(auto)', 'dividend', 'weekly_dividend', 'help_grant', 'quiz_reward', 'option_grant', 'price_adjust'];
for (const t of order) {
  const k = known[t]; if (!k) continue;
  const sign = k.houseDelta >= 0 ? '＋충전' : '－드레인';
  console.log(`  ${t.padEnd(14)} ${fmt(k.houseDelta).padStart(14)}  (${k.count}건, ${sign})`);
}
console.log(`  ${'[알려진 합]'.padEnd(14)} ${fmt(knownSum).padStart(14)}`);

console.log('\n── delta 미기록 경로 = 잔차 (impact_news + instructor_event + market_reprice + tick) ──');
console.log(`  잔차(하우스영향): ${fmt(residual)}   ← 이 값이 크게 음수면 강사이벤트/영향뉴스가 주범`);
console.log(`  구성 건수: impact_news ${newsPos + newsNeg + newsFlat} / instructor_event ${ievPos + ievNeg + ievZero} / market_reprice ${repriceN}`);

console.log('\n── 호재/악재 편중 (드레인 vs 충전 방향) ──');
console.log(`  영향뉴스(impact_news):  호재 ${newsPos} / 악재 ${newsNeg} / 중립 ${newsFlat}`);
console.log(`  강사이벤트(instructor): 호재 ${ievPos} / 악재 ${ievNeg} / 중립 ${ievZero}`);
if (Object.keys(evtByCat).length) {
  console.log('  강사이벤트 카테고리별 (호재/악재/중립):');
  for (const [c, v] of Object.entries(evtByCat)) console.log(`    ${c.padEnd(12)} ${v.pos} / ${v.neg} / ${v.zero}`);
}

if (Object.keys(unknownTypes).length) {
  console.log('\n⚠ 처리 안 된 ledger type (residual에 숨어 있음 — 확인 필요):');
  for (const [t, n] of Object.entries(unknownTypes)) console.log(`    ${t.padEnd(20)} ${n}건`);
}

console.log('\n── 검산 ──');
console.log(`  알려진 합 ${fmt(knownSum)} + 잔차 ${fmt(residual)} = 하우스풀 ${fmt(housePool)}  ✓`);
