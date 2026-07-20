// 유상증자(subscribeShares) 회계 시뮬레이션 — Firestore 없이 순수 계산.
//   검증 1: 총량보존 Σ지갑 + reserve + corpBalance + housePool = 불변
//   검증 2: 신주 매도가 housePool 을 드레인하지 않는다(=회사 환매책임이 작동)
//   실행: node test-harness/offer_conservation.mjs
import { quoteBuy, quoteSell, rangeSum, sellFee } from '../functions/market.js';

const S = { base: 1000, slope: 1, totalShares: 1000, circulating: 0, reserve: 0, corpBalance: 200000 };
const W = { alice: 500000, bob: 500000 }; // alice=팀원, bob=외부
let house = 0;

const total = () => W.alice + W.bob + S.reserve + S.corpBalance + house;
const T0 = total();
const check = (tag) => {
  const d = total() - T0;
  console.log(`${tag.padEnd(22)} c=${String(S.circulating).padStart(4)} reserve=${String(S.reserve).padStart(7)} 금고=${String(S.corpBalance).padStart(7)} house=${String(house).padStart(6)} | 총량차 ${d}`);
  if (d !== 0) { console.error('❌ 총량보존 위반'); process.exit(1); }
};

// 1) 팀원 alice 유상증자 100주 — 대금 전액 금고, reserve 불변
function subscribe(q) {
  const Q = quoteBuy(S, q);
  W.alice -= Q.cost; S.corpBalance += Q.cost;
  S.circulating = Q.newCirculating;
  return q;
}
// 2) 외부 bob 일반 매수
function buy(q) {
  const Q = quoteBuy(S, q);
  W.bob -= Q.cost; S.reserve += Q.cost; S.circulating = Q.newCirculating;
}
// 3) 매도 — 일반주는 reserve, 신주는 금고에서 지급
function sell(who, q, offerHeld) {
  const c = S.circulating;
  const Q = quoteSell(S, q);
  const nNormal = Math.min(q, Math.max(0, q - offerHeld));
  const nOffer = q - nNormal;
  const normalProceeds = rangeSum(S.base, S.slope, c - nNormal, c - 1);
  const offerProceeds = Q.proceeds - normalProceeds;
  if (nOffer > 0 && S.corpBalance < offerProceeds) { console.log(`   ↳ 매도 거부(금고 ${S.corpBalance} < 환매 ${offerProceeds})`); return 0; }
  const fee = sellFee(Q.proceeds);
  W[who] += Q.proceeds - fee;
  S.reserve -= normalProceeds; S.corpBalance -= offerProceeds; house += fee;
  S.circulating = Q.newCirculating;
  return nOffer;
}

check('초기');
let aliceOffer = subscribe(100);
check('alice 유상증자 100');
buy(100);
check('bob 일반매수 100');

// 사이클 10회: alice 신주 매도 → 재청약. 예전 설계라면 housePool 이 매 사이클 −139K 드레인됐음.
const houseBefore = house;
for (let i = 0; i < 10; i++) {
  const sold = sell('alice', 100, aliceOffer);
  aliceOffer -= sold;
  if (sold > 0) aliceOffer += subscribe(100);
}
check('사이클 10회 후');
console.log(`\nhousePool 변화: ${house - houseBefore} (수수료 수입만, 드레인 없음 ✅)`);
console.log(`금고 변화: ${S.corpBalance - 200000} (환매 손익을 회사가 부담)`);
if (house < houseBefore) { console.error('❌ housePool 드레인 발생'); process.exit(1); }
console.log('\n✅ 총량보존 + housePool 무드레인 확인');
