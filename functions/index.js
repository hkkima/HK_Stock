// ─────────────────────────────────────────────────────────────
// 주식판 권위(authoritative) Cloud Functions — 고정발행 본드커브 모델.
//   모든 포인트·시세·보유 변동은 여기서만(Admin SDK → 규칙 우회). 클라는 읽기만.
//   배포: firebase deploy --only functions,firestore:rules  (베팅과 같은 프로젝트)
// ─────────────────────────────────────────────────────────────
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';
import { quoteBuy, quoteSell, nextAvgCost, priceAdjustDelta, sellFee, rangeSum } from './market.js';
import { generateNews, NEWS_TICK_PROB } from './news.js';
import { applyTick } from './tick.js';
import { findEventPreset, renderEventHeadline } from './events.js';
import { rangeCost, DP_DEFAULTS } from './dpcurve.js';
import {
  privatePayouts, tournamentPayouts, leaguePayouts, seatsFromRoom, standingsFromTournament,
} from './holdem.js';

// ★ 프론트 VITE_FUNCTIONS_REGION 과 일치(서울 리전) ★
setGlobalOptions({ region: 'asia-northeast3' });

initializeApp();
const db = getFirestore();

// 운영자 이메일 — ★ 프론트 VITE_ADMIN_EMAILS 및 firestore.rules 와 일치 ★
const ADMIN_EMAILS = ['jetsomk22@gmail.com'];

const boardRef = () => db.doc('meta/stockBoard');
const holdingId = (userId, stockId) => `${userId}__${stockId}`;

const HIST_CAP = 60;
function appendHist(hist, p) {
  const arr = Array.isArray(hist) ? hist : [];
  return [...arr, { p, t: Date.now() }].slice(-HIST_CAP);
}

function assertAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
}
function assertAdmin(req) {
  const t = req.auth?.token || {};
  // 커스텀 클레임 admin:true (Admin SDK 로만 부여 가능) 또는 화이트리스트 이메일.
  if (t.admin === true) return;
  const email = t.email;
  if (!email || !ADMIN_EMAILS.includes(String(email).toLowerCase())) {
    throw new HttpsError('permission-denied', '운영자만 가능합니다.');
  }
}
/** 던지지 않는 판정 — 운영자와 수강생이 같은 함수를 다르게 타야 할 때 쓴다. */
function isAdminReq(req) {
  try { assertAdmin(req); return true; } catch { return false; }
}

// ── 참가자: 매수/매도 (본드커브 권위 체결) ─────────────────
export const trade = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, stockId, side, qty } = req.data || {};
  const q = Math.floor(Number(qty));
  if (!userId || !stockId) throw new HttpsError('invalid-argument', 'userId/stockId 누락.');
  if (side !== 'buy' && side !== 'sell') throw new HttpsError('invalid-argument', 'side는 buy/sell.');
  if (!Number.isInteger(q) || q <= 0) throw new HttpsError('invalid-argument', '수량은 1 이상 정수.');

  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const sRef = db.doc(`stocks/${stockId}`);
    const hRef = db.doc(`holdings/${holdingId(userId, stockId)}`);
    const [uSnap, sSnap, hSnap] = await Promise.all([tx.get(uRef), tx.get(sRef), tx.get(hRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    const user = uSnap.data();
    if (user.pinHash && pinHash !== user.pinHash) throw new HttpsError('permission-denied', 'PIN이 일치하지 않습니다.');
    if (!sSnap.exists) throw new HttpsError('not-found', '종목을 찾을 수 없습니다.');
    const stock = { ...sSnap.data(), circulating: sSnap.data().circulating || 0, reserve: sSnap.data().reserve || 0 };
    if (stock.status !== 'open') throw new HttpsError('failed-precondition', '거래가 닫힌 종목입니다.');
    const holding = hSnap.exists ? hSnap.data() : { shares: 0, avgCost: 0 };
    const balance = user.balance || 0;

    const isMember = Array.isArray(stock.members) && stock.members.includes(userId);
    const locked = holding.locked || 0;

    // 유상증자 신주(offerShares): 대금이 reserve 가 아니라 팀 금고로 갔으므로 무담보.
    //   → 매도 시 곡선수령을 reserve 가 아니라 **금고(corpBalance)에서** 지급한다(환매책임). 부족하면 매도 불가.
    //   → 락업(offerUnlockAt) 전에는 매도 자체가 불가.
    const offerShares = holding.offerShares || 0;
    const offerLocked = offerShares > 0 && Date.now() < (holding.offerUnlockAt || 0) ? offerShares : 0;

    let cashDelta; let newShares; let newAvg; let fillPrice; let Q; let fee = 0;
    let normalProceeds = 0; let offerProceeds = 0; let nOffer = 0;
    if (side === 'buy') {
      if (isMember) throw new HttpsError('failed-precondition', '자사주는 매수할 수 없습니다(스톡옵션으로만 보유).');
      try { Q = quoteBuy(stock, q); } catch (e) { throw new HttpsError('failed-precondition', e.message); }
      if (Q.cost > balance) throw new HttpsError('failed-precondition', '잔액이 부족합니다.');
      cashDelta = -Q.cost; // 매수는 무료(진입 장려)
      fillPrice = Math.round(Q.cost / q);
      newShares = (holding.shares || 0) + q;
      newAvg = nextAvgCost(holding.shares || 0, holding.avgCost || 0, q, Q.cost / q);
    } else {
      // 스톡옵션(locked)·락업 중 신주(offerLocked)는 매도 불가 → 매도 가능 = 보유 − 잠금 − 락업신주.
      if ((holding.shares || 0) - locked - offerLocked < q) throw new HttpsError('failed-precondition', '매도 가능 수량이 부족합니다(스톡옵션·락업 신주 제외).');
      try { Q = quoteSell(stock, q); } catch (e) { throw new HttpsError('failed-precondition', e.message); }
      // 일반주를 먼저 소진하고(곡선 상단), 모자란 만큼만 신주에서 뺀다(곡선 하단) — 결정적 배분.
      const normalAvail = Math.max(0, (holding.shares || 0) - locked - offerShares);
      const nNormal = Math.min(q, normalAvail);
      nOffer = q - nNormal;
      const c = stock.circulating;
      normalProceeds = rangeSum(stock.base, stock.slope, c - nNormal, c - 1);
      offerProceeds = Q.proceeds - normalProceeds;
      if (nOffer > 0 && (stock.corpBalance || 0) < offerProceeds) {
        throw new HttpsError('failed-precondition', '팀 금고가 부족해 신주를 환매할 수 없습니다(금고 충전 후 매도 가능).');
      }
      // 매도 수수료(결정적) — 곡선수령(proceeds)은 reserve/금고에서 빠지고, 수수료만 housePool 로 귀속.
      fee = sellFee(Q.proceeds);
      cashDelta = Q.proceeds - fee; // 지갑엔 수수료 뺀 순수령
      fillPrice = Math.round(Q.proceeds / q);
      newShares = (holding.shares || 0) - q;
      newAvg = holding.avgCost || 0;
    }

    const stockPatch = {
      circulating: Q.newCirculating,
      // reserve 는 곡선적분 그대로(정합 유지). 단 신주 환매분(offerProceeds)은 금고가 부담하므로 reserve 에서 빼지 않는다.
      reserve: stock.reserve + (side === 'buy' ? Q.cost : -normalProceeds),
      price: Q.newPrice,
      priceHistory: appendHist(stock.priceHistory, Q.newPrice),
    };
    if (offerProceeds > 0) stockPatch.corpBalance = FieldValue.increment(-offerProceeds); // 회사 환매책임
    tx.update(sRef, stockPatch);
    tx.update(uRef, { balance: balance + cashDelta });
    const hPatch = { userId, stockId, shares: newShares, avgCost: newAvg, updatedAt: FieldValue.serverTimestamp() };
    if (nOffer > 0) hPatch.offerShares = Math.max(0, offerShares - nOffer);
    tx.set(hRef, hPatch, { merge: true });
    if (offerProceeds > 0) {
      tx.set(db.collection('teamLedger').doc(), { stockId, type: 'offer_buyback', userId, qty: nOffer, amount: offerProceeds, ts: FieldValue.serverTimestamp() });
    }
    // 수수료(매도만)는 지갑→housePool 이동 = 총량 보존. increment 로만(틱과 충돌 방지, boardRef read 안 함).
    if (fee > 0) tx.set(boardRef(), { housePool: FieldValue.increment(fee) }, { merge: true });
    tx.set(db.collection('trades').doc(), { userId, stockId, side, qty: q, price: fillPrice, cash: cashDelta, fee, ts: FieldValue.serverTimestamp() });
    tx.set(db.collection('ledger').doc(), { userId, stockId, type: side, delta: cashDelta, qty: q, price: fillPrice, fee, houseDelta: fee, ts: FieldValue.serverTimestamp() });
    return { side, qty: q, price: fillPrice, cash: cashDelta, fee, newBalance: balance + cashDelta, newPrice: Q.newPrice };
  });
});

// ── 운영자: 종목 상장/수정 ──────────────────────────────────
//   상장: 발행주식수(고정)·시작가(base)·변동성(slope) 지정. 시세는 이후 adjustPrice 로만.
export const upsertStock = onCall(async (req) => {
  assertAdmin(req);
  const { id, name, team, base, slope, totalShares, status, sector, traits, members, ceoUserId } = req.data || {};
  const sid = String(id || '').trim();
  if (!sid) throw new HttpsError('invalid-argument', 'id가 필요합니다.');
  const ref = db.doc(`stocks/${sid}`);
  const snap = await ref.get();

  // 특성(비공개·n개)은 운영자만 읽는 별도 컬렉션 stockTraits 에 저장.
  if (Array.isArray(traits)) {
    const clean = [...new Set(traits.map((t) => String(t).trim()).filter(Boolean))];
    await db.doc(`stockTraits/${sid}`).set({ traits: clean }, { merge: false });
  }

  if (!snap.exists) {
    const b = Math.floor(Number(base)); const sl = Math.floor(Number(slope)); const tot = Math.floor(Number(totalShares));
    if (!(b >= 1) || !(sl >= 1) || !(tot >= 1)) {
      throw new HttpsError('invalid-argument', '신규 종목은 시작가·변동성·발행주식수(각 1 이상)가 필요합니다.');
    }
    await ref.set({
      name: name || sid, team: team || '', sector: sector || '',
      ceoUserId: ceoUserId ? String(ceoUserId) : '', // 팀 대표 — 팀 경제(주급/상여/배당) 집행 권한
      corpBalance: 0,                                 // 팀 금고 — grantTeamPoints 로 충전
      base: b, centerBase: b, slope: sl, totalShares: tot, circulating: 0, reserve: 0,
      price: b, prevClose: b, dayOpen: b, refPrice: b,
      status: status || 'closed',
      priceHistory: [{ p: b, t: Date.now() }],
      createdAt: FieldValue.serverTimestamp(),
    });
    return { id: sid, created: true };
  }

  const cur = snap.data();
  const patch = {};
  if (name != null) patch.name = name;
  if (team != null) patch.team = team;
  if (sector != null) patch.sector = sector; // 업종(공개·1개)
  if (Array.isArray(members)) patch.members = [...new Set(members.map(String).filter(Boolean))]; // 소속 멤버(userId)
  if (ceoUserId != null) patch.ceoUserId = String(ceoUserId); // 팀 대표(CEO) — 팀 경제 집행 권한
  if (status != null) patch.status = status;
  if (slope != null) patch.slope = Math.max(1, Math.floor(Number(slope)));
  if (totalShares != null) {
    const tot = Math.floor(Number(totalShares));
    if (tot < (cur.circulating || 0)) throw new HttpsError('failed-precondition', '발행주식수는 유통주식수보다 작을 수 없습니다.');
    patch.totalShares = tot;
  }
  await ref.set(patch, { merge: true });
  return { id: sid, updated: true };
});

// ── 운영자: 배당 (하우스 풀 → 보유자) ──────────────────────
export const payDividend = onCall(async (req) => {
  assertAdmin(req);
  const { stockId, perShare } = req.data || {};
  const ps = Math.floor(Number(perShare));
  if (!stockId || !(ps > 0)) throw new HttpsError('invalid-argument', 'stockId/perShare(1+) 필요.');

  const hs = await db.collection('holdings').where('stockId', '==', stockId).get();
  const payouts = []; let total = 0;
  hs.forEach((d) => { const h = d.data(); if ((h.shares || 0) > 0) { const amt = ps * h.shares; total += amt; payouts.push({ userId: h.userId, amt }); } });
  if (payouts.length === 0) throw new HttpsError('failed-precondition', '보유자가 없습니다.');

  await db.runTransaction(async (tx) => {
    // board 는 읽지 않고 increment 로만 차감(시세 틱과 충돌 방지). 하우스 풀은 음수 허용.
    const uRefs = payouts.map((p) => db.doc(`users/${p.userId}`));
    const uSnaps = await Promise.all(uRefs.map((r) => tx.get(r)));
    uSnaps.forEach((s, i) => { if (s.exists) tx.update(uRefs[i], { balance: (s.data().balance || 0) + payouts[i].amt }); });
    tx.set(boardRef(), { housePool: FieldValue.increment(-total) }, { merge: true });
    tx.set(db.collection('ledger').doc(), { stockId, type: 'dividend', perShare: ps, total, count: payouts.length, ts: FieldValue.serverTimestamp() });
  });
  return { stockId, perShare: ps, total, count: payouts.length };
});

// ── 운영자: 스톡옵션 지급(자사주, 거래금지) ─────────────────
//   멤버에게 qty주를 곡선가로 정식 발행. 하우스 풀이 공급가 대납(총량 보존). holding.locked += qty(매도 불가).
export const grantOption = onCall(async (req) => {
  assertAdmin(req);
  const { stockId, userId, qty } = req.data || {};
  const q = Math.floor(Number(qty));
  if (!stockId || !userId || !(q > 0)) throw new HttpsError('invalid-argument', 'stockId/userId/qty(1+) 필요.');

  return db.runTransaction(async (tx) => {
    const sRef = db.doc(`stocks/${stockId}`);
    const hRef = db.doc(`holdings/${holdingId(userId, stockId)}`);
    const [sSnap, hSnap, uSnap] = await Promise.all([tx.get(sRef), tx.get(hRef), tx.get(db.doc(`users/${userId}`))]);
    if (!sSnap.exists) throw new HttpsError('not-found', '종목을 찾을 수 없습니다.');
    if (!uSnap.exists) throw new HttpsError('not-found', '학생 계정을 찾을 수 없습니다.');
    const stock = { ...sSnap.data(), circulating: sSnap.data().circulating || 0, reserve: sSnap.data().reserve || 0 };
    if (!(Array.isArray(stock.members) && stock.members.includes(userId))) {
      throw new HttpsError('failed-precondition', '해당 기업 소속 멤버에게만 스톡옵션을 줄 수 있습니다.');
    }
    let Q;
    try { Q = quoteBuy(stock, q); } catch (e) { throw new HttpsError('failed-precondition', e.message); }
    const holding = hSnap.exists ? hSnap.data() : { shares: 0, locked: 0, avgCost: 0 };

    tx.update(sRef, {
      circulating: Q.newCirculating,
      reserve: stock.reserve + Q.cost,
      price: Q.newPrice,
      priceHistory: appendHist(stock.priceHistory, Q.newPrice),
    });
    tx.set(hRef, {
      userId, stockId,
      shares: (holding.shares || 0) + q,
      locked: (holding.locked || 0) + q,
      avgCost: nextAvgCost(holding.shares || 0, holding.avgCost || 0, q, Q.cost / q),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(boardRef(), { housePool: FieldValue.increment(-Q.cost) }, { merge: true }); // 공급가 대납
    tx.set(db.collection('ledger').doc(), { stockId, userId, type: 'option_grant', qty: q, cost: Q.cost, ts: FieldValue.serverTimestamp() });
    return { stockId, userId, qty: q, cost: Q.cost, newPrice: Q.newPrice };
  });
});

// ── 운영자: 펀더멘탈 시세 조정(곡선 평행이동, 총량 보존) ────
export const adjustPrice = onCall(async (req) => {
  assertAdmin(req);
  const { stockId, newPrice, memo } = req.data || {};
  const np = Math.floor(Number(newPrice));
  if (!stockId || !(np >= 1)) throw new HttpsError('invalid-argument', 'stockId/newPrice(1+) 필요.');

  return db.runTransaction(async (tx) => {
    const sRef = db.doc(`stocks/${stockId}`);
    const sSnap = await tx.get(sRef); // board 는 안 읽음(틱과 충돌 방지)
    if (!sSnap.exists) throw new HttpsError('not-found', '종목을 찾을 수 없습니다.');
    const s = sSnap.data();
    const circ = s.circulating || 0;
    const curPrice = s.base + s.slope * circ;
    const shift = np - curPrice;
    const newBase = s.base + shift;
    if (newBase < 1) throw new HttpsError('failed-precondition', '시세를 그만큼 낮추면 곡선이 음수가 됩니다.');
    const delta = priceAdjustDelta(curPrice, np, circ);
    // 펀더멘탈 변경이므로 centerBase(평균회귀 중심)도 같이 이동 → 노이즈가 새 기준으로 수렴.
    tx.update(sRef, { base: newBase, centerBase: (s.centerBase ?? s.base) + shift, price: np, reserve: (s.reserve || 0) + delta, priceHistory: appendHist(s.priceHistory, np) });
    tx.set(boardRef(), { housePool: FieldValue.increment(-delta) }, { merge: true });
    tx.set(db.collection('ledger').doc(), { stockId, type: 'price_adjust', oldPrice: curPrice, newPrice: np, delta, memo: memo || '', ts: FieldValue.serverTimestamp() });
    return { stockId, oldPrice: curPrice, newPrice: np, delta };
  });
});

// ── 운영자: 시장 전체 일괄 조정(통합 인플레/디플레 레버) ────
//   모든 종목 시세를 ±pct% 일괄 이동(곡선 바닥에서 멈춤). 차액은 reserve↔housePool(총량 보존).
export const marketReprice = onCall(async (req) => {
  assertAdmin(req);
  const pct = Number(req.data?.pct);
  if (!Number.isFinite(pct) || pct === 0 || pct <= -100) throw new HttpsError('invalid-argument', 'pct(0 아님, >-100) 필요.');
  const f = 1 + pct / 100;
  const snap = await db.collection('stocks').get();
  let applied = 0;
  for (const d of snap.docs) {
    // eslint-disable-next-line no-await-in-loop
    await db.runTransaction(async (tx) => {
      const s = (await tx.get(d.ref)).data();
      if (!s || s.base == null) return;
      const circ = s.circulating || 0;
      const cur = s.base + s.slope * circ;
      let np = Math.max(1, Math.round(cur * f));
      let nb = np - s.slope * circ;
      if (nb < 1) { nb = 1; np = 1 + s.slope * circ; } // 곡선 바닥에서 멈춤
      const delta = (np - cur) * circ;
      tx.update(d.ref, { base: nb, centerBase: (s.centerBase ?? s.base) + (nb - s.base), price: np, reserve: (s.reserve || 0) + delta, priceHistory: appendHist(s.priceHistory, np) });
      tx.set(boardRef(), { housePool: FieldValue.increment(-delta) }, { merge: true });
    });
    applied += 1;
  }
  await db.collection('ledger').add({ type: 'market_reprice', pct, ts: FieldValue.serverTimestamp() });
  return { pct, count: applied };
});

// ── 운영자: 뉴스 피드 ───────────────────────────────────────
export const postNews = onCall(async (req) => {
  assertAdmin(req);
  const { text, stockId } = req.data || {};
  if (!text || !String(text).trim()) throw new HttpsError('invalid-argument', '내용이 필요합니다.');
  await db.runTransaction(async (tx) => {
    const bSnap = await tx.get(boardRef());
    const news = (bSnap.exists && Array.isArray(bSnap.data().news)) ? bSnap.data().news : [];
    const entry = { text: String(text).trim(), stockId: stockId || null, at: Date.now() };
    tx.set(boardRef(), { news: [entry, ...news].slice(0, 50) }, { merge: true });
  });
  return { ok: true };
});

// ── 영향 뉴스 코어 — 작성 + 대상(종목/업종/테마) 시세 동시 조작 ─
//   scope: all|stock|sector|trait, target: id/sector명/특성명, pct: 시세 ±%(0=효과없음).
//   ★콜러블(postImpactNews)·예약(publishScheduledNews)·강사이벤트(postInstructorEvent) 공용 — 동작 동일.★
//   text/scope/pct 는 호출 측에서 이미 검증된 값이어야 한다.
//   kind/category: 선택 태그(예: 강사 이벤트 kind:'instructor', category:'attendance') → 뉴스 피드 뱃지용.
async function applyImpactNews({ text, scope, target, pct, kind, category }) {
  const sc = ['all', 'stock', 'sector', 'trait'].includes(scope) ? scope : 'all';
  const p = Number(pct) || 0;

  const ss = await db.collection('stocks').get();
  let stocks = ss.docs.map((d) => ({ ref: d.ref, id: d.id, ...d.data() }));
  let badge = '시장';
  if (sc === 'stock') { stocks = stocks.filter((s) => s.id === target); badge = stocks[0]?.name || String(target); }
  else if (sc === 'sector') { stocks = stocks.filter((s) => s.sector === target); badge = String(target); }
  else if (sc === 'trait') {
    const tr = await db.collection('stockTraits').get();
    const tmap = Object.fromEntries(tr.docs.map((d) => [d.id, d.data().traits || []]));
    stocks = stocks.filter((s) => (tmap[s.id] || []).includes(target)); badge = '테마'; // 특성명은 숨김
  }
  const f = 1 + p / 100;
  for (const s of stocks) {
    if (p === 0 || s.base == null) continue;
    // eslint-disable-next-line no-await-in-loop
    await db.runTransaction(async (tx) => {
      const fr = (await tx.get(s.ref)).data();
      if (!fr || fr.base == null) return;
      const circ = fr.circulating || 0;
      const cur = fr.base + fr.slope * circ;
      let np = Math.max(1, Math.round(cur * f));
      let nb = np - fr.slope * circ;
      if (nb < 1) { nb = 1; np = 1 + fr.slope * circ; }
      const delta = (np - cur) * circ;
      tx.update(s.ref, { base: nb, centerBase: (fr.centerBase ?? fr.base) + (nb - fr.base), price: np, reserve: (fr.reserve || 0) + delta, priceHistory: appendHist(fr.priceHistory, np) });
      tx.set(boardRef(), { housePool: FieldValue.increment(-delta) }, { merge: true });
    });
  }
  const polarity = p > 0 ? 'good' : p < 0 ? 'bad' : 'flat';
  const stockIds = stocks.map((s) => s.id);
  await db.runTransaction(async (tx) => {
    const bSnap = await tx.get(boardRef());
    const news = (bSnap.exists && Array.isArray(bSnap.data().news)) ? bSnap.data().news : [];
    const entry = { text: String(text).trim(), polarity, scope: sc, badge, stockIds, at: Date.now() };
    if (kind) entry.kind = String(kind); // 예: 'instructor'
    if (category) entry.category = String(category); // 예: 'attendance'
    tx.set(boardRef(), { news: [entry, ...news].slice(0, 50) }, { merge: true });
  });
  await db.collection('ledger').add({ type: kind === 'instructor' ? 'instructor_event' : 'impact_news', scope: sc, target: target || null, pct: p, category: category || null, count: stockIds.length, ts: FieldValue.serverTimestamp() });
  return { scope: sc, badge, pct: p, count: stockIds.length };
}

// ── 운영자: 영향 뉴스(즉시 게시) ────────────────────────────
export const postImpactNews = onCall(async (req) => {
  assertAdmin(req);
  const { text, scope, target, pct } = req.data || {};
  if (!text || !String(text).trim()) throw new HttpsError('invalid-argument', '내용이 필요합니다.');
  const p = Number(pct) || 0;
  if (p <= -100) throw new HttpsError('invalid-argument', 'pct는 -100 초과.');
  return applyImpactNews({ text, scope, target, pct });
});

// 강사 이벤트 1건 해석·적용(콜러블·일괄 공용). 프리셋(events.js)으로 헤드라인·기본 시세%를 채우거나
//   text/pct 로 직접 지정. 항상 scope:'stock', kind:'instructor' 로 태깅. 잘못된 입력은 HttpsError.
async function runInstructorEvent({ stockId, presetKey, pct, text }) {
  if (!stockId) throw new HttpsError('invalid-argument', 'stockId가 필요합니다.');
  const preset = presetKey ? findEventPreset(presetKey) : null;
  if (presetKey && !preset) throw new HttpsError('invalid-argument', '알 수 없는 이벤트입니다.');

  const sSnap = await db.doc(`stocks/${stockId}`).get();
  if (!sSnap.exists) throw new HttpsError('not-found', '종목을 찾을 수 없습니다.');
  const name = sSnap.data().name || stockId;

  const body = (text && String(text).trim()) ? String(text).trim() : renderEventHeadline(preset, name);
  if (!body) throw new HttpsError('invalid-argument', '프리셋 또는 내용이 필요합니다.');

  const p = pct != null && pct !== '' ? Number(pct) : (preset ? preset.pct : 0);
  if (!Number.isFinite(p) || p <= -100) throw new HttpsError('invalid-argument', 'pct는 -100 초과 숫자.');

  const r = await applyImpactNews({ text: body, scope: 'stock', target: stockId, pct: p, kind: 'instructor', category: preset?.cat || 'custom' });
  return { ...r, stockId, name };
}

// ── 운영자: 강사 이벤트(출결·과제·프로젝트 등) — 특정 종목에 즉시 게시 ─
//   자동 랜덤 뉴스와 분리된 별도 레버.
export const postInstructorEvent = onCall(async (req) => {
  assertAdmin(req);
  return runInstructorEvent(req.data || {});
});

// ── 운영자: 강사 이벤트 일괄 발행(주간 출결/평가 등) ─────────
//   items: [{ stockId, presetKey?, pct?, text? }]. 항목별 best-effort — 실패는 건너뛰고 요약 반환.
export const postInstructorEventsBatch = onCall(async (req) => {
  assertAdmin(req);
  const items = Array.isArray(req.data?.items) ? req.data.items : [];
  if (items.length === 0) throw new HttpsError('invalid-argument', '발행할 항목이 없습니다.');
  if (items.length > 100) throw new HttpsError('invalid-argument', '한 번에 최대 100건.');
  const ok = []; const failed = [];
  for (const it of items) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await runInstructorEvent(it || {});
      ok.push({ stockId: r.stockId, name: r.name, pct: r.pct });
    } catch (e) {
      failed.push({ stockId: it?.stockId || null, error: String(e?.message || e) });
    }
  }
  return { count: ok.length, failed: failed.length, ok, failedItems: failed };
});

// ── 운영자: 뉴스 예약 — 지정 시각(publishAt, epoch ms)에 자동 발행 ─
//   scope/pct 의미는 postImpactNews 와 동일(pct=0 이면 헤드라인만).
export const scheduleNews = onCall(async (req) => {
  assertAdmin(req);
  const { text, scope, target, pct, publishAt, kind, category } = req.data || {};
  if (!text || !String(text).trim()) throw new HttpsError('invalid-argument', '내용이 필요합니다.');
  const sc = ['all', 'stock', 'sector', 'trait'].includes(scope) ? scope : 'all';
  const p = Number(pct) || 0;
  if (p <= -100) throw new HttpsError('invalid-argument', 'pct는 -100 초과.');
  if (sc !== 'all' && !String(target || '').trim()) throw new HttpsError('invalid-argument', '대상을 선택하세요.');
  const when = Math.floor(Number(publishAt));
  if (!Number.isFinite(when) || when <= 0) throw new HttpsError('invalid-argument', '게시 시각(publishAt)이 필요합니다.');
  const ref = await db.collection('scheduledNews').add({
    text: String(text).trim(), scope: sc, target: target || null, pct: p,
    kind: kind ? String(kind) : null, category: category ? String(category) : null,
    publishAt: when, status: 'pending',
    createdBy: req.auth?.token?.email || null, createdAt: FieldValue.serverTimestamp(),
  });
  return { id: ref.id, publishAt: when };
});

// ── 운영자: 예약 뉴스 취소(대기 중인 것만) ───────────────────
export const cancelScheduledNews = onCall(async (req) => {
  assertAdmin(req);
  const { id } = req.data || {};
  if (!id) throw new HttpsError('invalid-argument', 'id가 필요합니다.');
  const ref = db.doc(`scheduledNews/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', '예약을 찾을 수 없습니다.');
  if (snap.data().status !== 'pending') throw new HttpsError('failed-precondition', '이미 처리된 예약입니다.');
  await ref.update({ status: 'cancelled', cancelledAt: FieldValue.serverTimestamp() });
  return { id, cancelled: true };
});

// ── 자동: 매분 만기된 예약 뉴스 발행 ────────────────────────
//   pending 만 단일 등가 쿼리(복합 인덱스 불필요)로 가져와 publishAt 을 코드에서 비교.
export const publishScheduledNews = onSchedule({ schedule: '* * * * *', timeZone: 'Asia/Seoul' }, async () => {
  const now = Date.now();
  const due = await db.collection('scheduledNews').where('status', '==', 'pending').get();
  for (const d of due.docs) {
    const n = d.data();
    if (!(Number(n.publishAt) <= now)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await applyImpactNews({ text: n.text, scope: n.scope, target: n.target, pct: n.pct, kind: n.kind, category: n.category });
      // eslint-disable-next-line no-await-in-loop
      await d.ref.update({ status: 'published', publishedAt: FieldValue.serverTimestamp(), result: r });
    } catch (e) {
      // eslint-disable-next-line no-await-in-loop
      await d.ref.update({ status: 'failed', error: String(e?.message || e), failedAt: FieldValue.serverTimestamp() });
    }
  }
});

// ── 운영자: 하우스 풀 발행/소각 (유일한 총량 변동) ─────────
export const mintToHouse = onCall(async (req) => {
  assertAdmin(req);
  const { amount, memo } = req.data || {};
  const amt = Math.floor(Number(amount));
  if (Number.isNaN(amt) || amt === 0) throw new HttpsError('invalid-argument', 'amount(0 아님)가 필요합니다.');
  // ★ 원자 increment — 매분 시세 틱이 같은 문서를 갱신하므로 read-modify-write 트랜잭션은 충돌함.
  await boardRef().set({ housePool: FieldValue.increment(amt) }, { merge: true });
  await db.collection('ledger').add({ type: amt >= 0 ? 'mint' : 'burn', delta: amt, memo: memo || '', ts: FieldValue.serverTimestamp() });
  return { ok: true, amount: amt };
});

// ── 운영자: 상장폐지(회사 삭제) ─────────────────────────────
export const delistStock = onCall(async (req) => {
  assertAdmin(req);
  const { stockId, settlePrice } = req.data || {};
  if (!stockId) throw new HttpsError('invalid-argument', 'stockId가 필요합니다.');
  const sp = settlePrice == null ? null : Math.floor(Number(settlePrice));
  if (sp != null && !(sp >= 0)) throw new HttpsError('invalid-argument', '정산가는 0 이상이어야 합니다.');

  const hs = await db.collection('holdings').where('stockId', '==', stockId).get();
  const holders = [];
  hs.forEach((d) => { const h = d.data(); if ((h.shares || 0) > 0) holders.push({ userId: h.userId, shares: h.shares }); });
  const allHoldingRefs = hs.docs.map((d) => d.ref);
  // 서브컬렉션은 부모 문서 delete 로 안 지워짐 → 고아 방지 위해 ref 사전 수집(트랜잭션 밖, 비원자적 읽기).
  const candleRefs = (await db.collection(`stocks/${stockId}/candles`).get()).docs.map((d) => d.ref);
  const seriesRef = db.doc(`stocks/${stockId}/series/intraday`);
  // housePool 은 틱이 매분 increment 로 갱신 → 트랜잭션에서 read-modify-write 하면 충돌(internal)로 상폐가 롤백된다(불변식 #1).
  //   정산은 increment 로만 쓴다(boardRef 를 트랜잭션 읽기 집합에서 제외). ★housePool 음수 허용(하우스 '빚')이라
  //   '부족분' 가드는 두지 않는다 — 두면 하우스가 음수인 동안 어떤 종목도 상폐 불가(틱·배당·DP와 동일 정책).
  return db.runTransaction(async (tx) => {
    const sRef = db.doc(`stocks/${stockId}`);
    const sSnap = await tx.get(sRef);
    if (!sSnap.exists) throw new HttpsError('not-found', '종목을 찾을 수 없습니다.');
    const s = sSnap.data();
    if (s.status === 'open') throw new HttpsError('failed-precondition', '거래를 먼저 닫은 뒤 상장폐지하세요.');
    const price = sp == null ? (s.price || 0) : sp;
    const reserve = s.reserve || 0;

    const uRefs = holders.map((h) => db.doc(`users/${h.userId}`));
    const uSnaps = await Promise.all(uRefs.map((r) => tx.get(r)));
    let totalPayout = 0;
    uSnaps.forEach((snap, i) => {
      if (!snap.exists) return;
      const pay = price * holders[i].shares;
      totalPayout += pay;
      if (pay > 0) tx.update(uRefs[i], { balance: (snap.data().balance || 0) + pay });
    });

    // 상장폐지 = 팀 해산 → 잔여 팀 금고(corpBalance)도 housePool 로 회수해야 총량이 보존된다
    //   (금고를 그냥 두면 문서 삭제와 함께 포인트가 증발한다).
    const corpReturned = s.corpBalance || 0;
    const delta = reserve + corpReturned - totalPayout; // 리저브+금고 회수 − 정산 지급. 하우스 풀 증감(음수 허용).
    tx.set(boardRef(), { housePool: FieldValue.increment(delta) }, { merge: true });

    allHoldingRefs.forEach((r) => tx.delete(r));
    tx.delete(seriesRef);
    candleRefs.forEach((r) => tx.delete(r));
    tx.delete(sRef);
    tx.delete(db.doc(`stockTraits/${stockId}`));
    tx.set(db.collection('ledger').doc(), { stockId, type: 'delist', settlePrice: price, totalPayout, reserveReturned: delta, corpReturned, count: holders.length, ts: FieldValue.serverTimestamp() });
    return { stockId, settlePrice: price, totalPayout, count: holders.length };
  });
});

// ── 자동 장운영: 매일 09:00 개장, 18:00 마감 (Asia/Seoul) ───
async function setAllStocks(patchFromStock) {
  const snap = await db.collection('stocks').get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.forEach((d) => batch.update(d.ref, patchFromStock(d.data())));
  await batch.commit();
  return snap.size;
}

export const openMarket = onSchedule({ schedule: '0 9 * * *', timeZone: 'Asia/Seoul' }, async () => {
  const snap = await db.collection('stocks').get();
  const batch = db.batch();
  snap.forEach((d) => {
    const s = d.data();
    batch.update(d.ref, { status: 'open', dayOpen: s.price ?? null });
    // 당일 분봉 초기화(오늘 차트 새로 시작)
    batch.set(d.ref.collection('series').doc('intraday'), { points: [{ p: s.price ?? 0, t: Date.now() }] });
  });
  await batch.commit();
});

export const closeMarket = onSchedule({ schedule: '0 18 * * *', timeZone: 'Asia/Seoul' }, async () => {
  const snap = await db.collection('stocks').get();
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD
  for (const d of snap.docs) {
    const s = d.data();
    // 당일 분봉으로 일봉(OHLC) 집계 → candles/{date}
    const ser = await d.ref.collection('series').doc('intraday').get();
    const pts = (ser.exists && Array.isArray(ser.data().points)) ? ser.data().points.map((x) => x.p) : [s.price];
    const candle = { date, o: pts[0], h: Math.max(...pts), l: Math.min(...pts), c: s.price ?? pts[pts.length - 1] };
    await d.ref.collection('candles').doc(date).set(candle);
    await d.ref.update({ status: 'closed', prevClose: s.price ?? null });
  }
});

// ── 실시간 시세 틱 — 장중 매 1분, 랜덤 평균회귀 노이즈(엔진은 tick.js) ───
export const marketTick = onSchedule({ schedule: '* 9-17 * * *', timeZone: 'Asia/Seoul' }, async () => {
  await applyTick(db, FieldValue);
});

// ── 자동 뉴스(테마주) — 엔진은 news.js(배포·하니스 공용) ────
// 장중 30분 슬롯마다 확률적으로 1건(토글 ON일 때만).
export const autoNews = onSchedule({ schedule: '*/30 9-17 * * *', timeZone: 'Asia/Seoul' }, async () => {
  const bd = (await boardRef().get()).data() || {};
  if (!bd.autoNewsEnabled) return;
  if (Math.random() > NEWS_TICK_PROB) return;
  await generateNews(db, FieldValue);
});

// 운영자: 자동뉴스 on/off
export const setAutoNews = onCall(async (req) => {
  assertAdmin(req);
  const enabled = !!req.data?.enabled;
  await boardRef().set({ autoNewsEnabled: enabled }, { merge: true });
  return { autoNewsEnabled: enabled };
});

// 운영자: 지금 랜덤 뉴스 1건(연출·테스트)
export const triggerNews = onCall(async (req) => {
  assertAdmin(req);
  return generateNews(db, FieldValue);
});

// ═══════════════════════════════════════════════════════════════
//  외주 게시판(HK_Board) — 수강생 간 포인트 외주/봉사.
//   ★불변식★: 에스크로는 gigs/{id}.escrow 필드에 보관한다. 등록 시 요청자 지갑에서
//   escrow 로 옮기고, 정산/취소 시 지갑으로 되돌린다 → 지갑↔gig문서 이동뿐이라
//   housePool 을 건드리지 않고 총량이 자동 보존된다(총량 = Σ지갑+Σ리저브+housePool+Σescrow).
//   봉사 지급(approveHelp)만 예외로 housePool → 봉사자 지갑 민팅(increment, 배당과 동일).
//   상태기계(gig): open → contracted → reported → done   (취소: cancelled, 중재: disputed→done/refunded)
// ═══════════════════════════════════════════════════════════════

function requirePin(user, pinHash) {
  if (user.pinHash && pinHash !== user.pinHash) {
    throw new HttpsError('permission-denied', 'PIN이 일치하지 않습니다.');
  }
}

// ── 외주 등록: 요청자 지갑 → 에스크로 예치(등록 즉시) ──────────
//   targetId 지정 시 = 지정 의뢰(특정 수강생만 수락/거절 가능, 공개 지원 불가).
export const postGig = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, title, desc, deadline, reward, targetId } = req.data || {};
  const r = Math.floor(Number(reward));
  if (!userId) throw new HttpsError('invalid-argument', 'userId가 필요합니다.');
  if (!title || !String(title).trim()) throw new HttpsError('invalid-argument', '제목이 필요합니다.');
  if (!Number.isInteger(r) || r <= 0) throw new HttpsError('invalid-argument', '보상은 1 이상 정수여야 합니다.');
  const tgt = targetId ? String(targetId).trim() : null;
  if (tgt && tgt === userId) throw new HttpsError('invalid-argument', '자기 자신에게는 지정 의뢰할 수 없습니다.');

  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const tRef = tgt ? db.doc(`users/${tgt}`) : null;
    const [uSnap, tSnap] = await Promise.all([tx.get(uRef), tRef ? tx.get(tRef) : Promise.resolve(null)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    if (tgt && !(tSnap && tSnap.exists)) throw new HttpsError('not-found', '지정한 수강생을 찾을 수 없습니다.');
    const user = uSnap.data();
    requirePin(user, pinHash);
    const balance = user.balance || 0;
    if (balance < r) throw new HttpsError('failed-precondition', '잔액이 부족합니다(보상만큼 예치 필요).');

    const gRef = db.collection('gigs').doc();
    tx.update(uRef, { balance: balance - r });
    tx.set(gRef, {
      requesterId: userId, requesterName: user.name || userId,
      title: String(title).trim(), desc: String(desc || '').trim(),
      deadline: deadline ? String(deadline).trim() : null,
      reward: r, escrow: r, status: 'open',
      applicants: [], workerId: null, workerName: null,
      targetId: tgt, targetName: tgt ? (tSnap.data().name || tgt) : null,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(db.collection('ledger').doc(), { type: 'gig_post', gigId: gRef.id, userId, delta: -r, ts: FieldValue.serverTimestamp() });
    return { id: gRef.id, reward: r, newBalance: balance - r };
  });
});

// ── 지정 의뢰: 지목된 수강생이 수락 → 바로 계약 성립 ─────────
export const acceptGig = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, gigId } = req.data || {};
  if (!userId || !gigId) throw new HttpsError('invalid-argument', 'userId/gigId 누락.');
  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const gRef = db.doc(`gigs/${gigId}`);
    const [uSnap, gSnap] = await Promise.all([tx.get(uRef), tx.get(gRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(uSnap.data(), pinHash);
    if (!gSnap.exists) throw new HttpsError('not-found', '외주를 찾을 수 없습니다.');
    const g = gSnap.data();
    if (g.targetId !== userId) throw new HttpsError('permission-denied', '지정된 수강생만 수락할 수 있습니다.');
    if (g.status !== 'open') throw new HttpsError('failed-precondition', '수락할 수 있는 상태가 아닙니다.');
    tx.update(gRef, { workerId: userId, workerName: uSnap.data().name || userId, status: 'contracted', awardedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  });
});

// ── 지정 의뢰: 지목된 수강생이 거절 → 요청자에게 에스크로 환불 ─
export const declineGig = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, gigId } = req.data || {};
  if (!userId || !gigId) throw new HttpsError('invalid-argument', 'userId/gigId 누락.');
  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const gRef = db.doc(`gigs/${gigId}`);
    const [uSnap, gSnap] = await Promise.all([tx.get(uRef), tx.get(gRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(uSnap.data(), pinHash);
    if (!gSnap.exists) throw new HttpsError('not-found', '외주를 찾을 수 없습니다.');
    const g = gSnap.data();
    if (g.targetId !== userId) throw new HttpsError('permission-denied', '지정된 수강생만 거절할 수 있습니다.');
    if (g.status !== 'open') throw new HttpsError('failed-precondition', '거절할 수 있는 상태가 아닙니다.');
    const refund = g.escrow || 0;
    const rRef = db.doc(`users/${g.requesterId}`);
    const rSnap = await tx.get(rRef);
    if (rSnap.exists) tx.update(rRef, { balance: (rSnap.data().balance || 0) + refund });
    tx.update(gRef, { escrow: 0, status: 'declined', closedAt: FieldValue.serverTimestamp() });
    tx.set(db.collection('ledger').doc(), { type: 'gig_declined', gigId, userId: g.requesterId, delta: refund, ts: FieldValue.serverTimestamp() });
    return { ok: true, refund };
  });
});

// ── 외주 지원(대기): 다른 수강생이 지원 표시 ─────────────────
export const applyGig = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, gigId } = req.data || {};
  if (!userId || !gigId) throw new HttpsError('invalid-argument', 'userId/gigId 누락.');
  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const gRef = db.doc(`gigs/${gigId}`);
    const [uSnap, gSnap] = await Promise.all([tx.get(uRef), tx.get(gRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(uSnap.data(), pinHash);
    if (!gSnap.exists) throw new HttpsError('not-found', '외주를 찾을 수 없습니다.');
    const g = gSnap.data();
    if (g.targetId) throw new HttpsError('failed-precondition', '지정 의뢰는 지목된 수강생만 수락할 수 있습니다.');
    if (g.status !== 'open') throw new HttpsError('failed-precondition', '지원할 수 없는 상태입니다.');
    if (g.requesterId === userId) throw new HttpsError('failed-precondition', '본인 외주에는 지원할 수 없습니다.');
    if (Array.isArray(g.applicants) && g.applicants.includes(userId)) throw new HttpsError('failed-precondition', '이미 지원했습니다.');
    tx.update(gRef, { applicants: FieldValue.arrayUnion(userId) });
    return { ok: true };
  });
});

// ── 외주 지원 철회(계약 전) ──────────────────────────────────
export const cancelApplication = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, gigId } = req.data || {};
  if (!userId || !gigId) throw new HttpsError('invalid-argument', 'userId/gigId 누락.');
  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const gRef = db.doc(`gigs/${gigId}`);
    const [uSnap, gSnap] = await Promise.all([tx.get(uRef), tx.get(gRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(uSnap.data(), pinHash);
    if (!gSnap.exists) throw new HttpsError('not-found', '외주를 찾을 수 없습니다.');
    if (gSnap.data().status !== 'open') throw new HttpsError('failed-precondition', '이미 계약이 진행된 외주입니다.');
    tx.update(gRef, { applicants: FieldValue.arrayRemove(userId) });
    return { ok: true };
  });
});

// ── 외주 계약 성립: 요청자가 지원자 1명 승인 ─────────────────
export const awardGig = onCall(async (req) => {
  assertAuth(req);
  const { requesterId, pinHash, gigId, workerId } = req.data || {};
  if (!requesterId || !gigId || !workerId) throw new HttpsError('invalid-argument', 'requesterId/gigId/workerId 누락.');
  return db.runTransaction(async (tx) => {
    const rRef = db.doc(`users/${requesterId}`);
    const wRef = db.doc(`users/${workerId}`);
    const gRef = db.doc(`gigs/${gigId}`);
    const [rSnap, wSnap, gSnap] = await Promise.all([tx.get(rRef), tx.get(wRef), tx.get(gRef)]);
    if (!rSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(rSnap.data(), pinHash);
    if (!gSnap.exists) throw new HttpsError('not-found', '외주를 찾을 수 없습니다.');
    const g = gSnap.data();
    if (g.requesterId !== requesterId) throw new HttpsError('permission-denied', '본인 외주만 계약할 수 있습니다.');
    if (g.status !== 'open') throw new HttpsError('failed-precondition', '이미 계약된 외주입니다.');
    if (!(Array.isArray(g.applicants) && g.applicants.includes(workerId))) throw new HttpsError('failed-precondition', '지원자 중에서만 선택할 수 있습니다.');
    tx.update(gRef, {
      workerId, workerName: (wSnap.exists ? wSnap.data().name : null) || workerId,
      status: 'contracted', awardedAt: FieldValue.serverTimestamp(),
    });
    return { ok: true, workerId };
  });
});

// ── 외주 취소(계약 전만): 에스크로 요청자에게 환불 ───────────
export const cancelGig = onCall(async (req) => {
  assertAuth(req);
  const { requesterId, pinHash, gigId } = req.data || {};
  if (!requesterId || !gigId) throw new HttpsError('invalid-argument', 'requesterId/gigId 누락.');
  return db.runTransaction(async (tx) => {
    const rRef = db.doc(`users/${requesterId}`);
    const gRef = db.doc(`gigs/${gigId}`);
    const [rSnap, gSnap] = await Promise.all([tx.get(rRef), tx.get(gRef)]);
    if (!rSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(rSnap.data(), pinHash);
    if (!gSnap.exists) throw new HttpsError('not-found', '외주를 찾을 수 없습니다.');
    const g = gSnap.data();
    if (g.requesterId !== requesterId) throw new HttpsError('permission-denied', '본인 외주만 취소할 수 있습니다.');
    if (g.status !== 'open') throw new HttpsError('failed-precondition', '계약 후에는 취소할 수 없습니다(완료 승인 또는 분쟁 중재로 진행).');
    const refund = g.escrow || 0;
    tx.update(rRef, { balance: (rSnap.data().balance || 0) + refund });
    tx.update(gRef, { escrow: 0, status: 'cancelled', closedAt: FieldValue.serverTimestamp() });
    tx.set(db.collection('ledger').doc(), { type: 'gig_cancel', gigId, userId: requesterId, delta: refund, ts: FieldValue.serverTimestamp() });
    return { ok: true, refund };
  });
});

// ── 작업자: 완료 보고(요청자 승인 대기) ──────────────────────
export const reportGig = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, gigId } = req.data || {};
  if (!userId || !gigId) throw new HttpsError('invalid-argument', 'userId/gigId 누락.');
  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const gRef = db.doc(`gigs/${gigId}`);
    const [uSnap, gSnap] = await Promise.all([tx.get(uRef), tx.get(gRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(uSnap.data(), pinHash);
    if (!gSnap.exists) throw new HttpsError('not-found', '외주를 찾을 수 없습니다.');
    const g = gSnap.data();
    if (g.workerId !== userId) throw new HttpsError('permission-denied', '계약한 작업자만 보고할 수 있습니다.');
    if (g.status !== 'contracted') throw new HttpsError('failed-precondition', '진행 중인 계약이 아닙니다.');
    tx.update(gRef, { status: 'reported', reportedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  });
});

// ── 요청자: 완료 승인 → 에스크로를 작업자에게 방출 ───────────
export const confirmGig = onCall(async (req) => {
  assertAuth(req);
  const { requesterId, pinHash, gigId } = req.data || {};
  if (!requesterId || !gigId) throw new HttpsError('invalid-argument', 'requesterId/gigId 누락.');
  return db.runTransaction(async (tx) => {
    const rRef = db.doc(`users/${requesterId}`);
    const gRef = db.doc(`gigs/${gigId}`);
    const [rSnap, gSnap] = await Promise.all([tx.get(rRef), tx.get(gRef)]);
    if (!rSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(rSnap.data(), pinHash);
    if (!gSnap.exists) throw new HttpsError('not-found', '외주를 찾을 수 없습니다.');
    const g = gSnap.data();
    if (g.requesterId !== requesterId) throw new HttpsError('permission-denied', '본인 외주만 승인할 수 있습니다.');
    if (g.status !== 'reported' && g.status !== 'contracted') throw new HttpsError('failed-precondition', '승인할 수 있는 상태가 아닙니다.');
    if (!g.workerId) throw new HttpsError('failed-precondition', '작업자가 없습니다.');
    const wRef = db.doc(`users/${g.workerId}`);
    const wSnap = await tx.get(wRef);
    const pay = g.escrow || 0;
    if (wSnap.exists) tx.update(wRef, { balance: (wSnap.data().balance || 0) + pay });
    tx.update(gRef, { escrow: 0, status: 'done', doneAt: FieldValue.serverTimestamp() });
    tx.set(db.collection('ledger').doc(), { type: 'gig_settle', gigId, userId: g.workerId, delta: pay, ts: FieldValue.serverTimestamp() });
    return { ok: true, pay, workerId: g.workerId };
  });
});

// ── 분쟁 신청(요청자·작업자 누구나) → 강사 중재 대기 ─────────
export const disputeGig = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, gigId, reason } = req.data || {};
  if (!userId || !gigId) throw new HttpsError('invalid-argument', 'userId/gigId 누락.');
  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const gRef = db.doc(`gigs/${gigId}`);
    const [uSnap, gSnap] = await Promise.all([tx.get(uRef), tx.get(gRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(uSnap.data(), pinHash);
    if (!gSnap.exists) throw new HttpsError('not-found', '외주를 찾을 수 없습니다.');
    const g = gSnap.data();
    if (g.requesterId !== userId && g.workerId !== userId) throw new HttpsError('permission-denied', '해당 외주의 당사자만 분쟁을 신청할 수 있습니다.');
    if (!['contracted', 'reported'].includes(g.status)) throw new HttpsError('failed-precondition', '분쟁을 신청할 수 있는 상태가 아닙니다.');
    tx.update(gRef, { status: 'disputed', disputeReason: String(reason || '').trim(), disputedBy: userId, disputedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  });
});

// ── 강사 중재: 에스크로를 작업자에게 방출(release) 또는 요청자에게 환불(refund) ─
export const resolveGig = onCall(async (req) => {
  assertAdmin(req);
  const { gigId, outcome, memo } = req.data || {};
  if (!gigId) throw new HttpsError('invalid-argument', 'gigId가 필요합니다.');
  if (outcome !== 'release' && outcome !== 'refund') throw new HttpsError('invalid-argument', "outcome은 'release' 또는 'refund'.");
  return db.runTransaction(async (tx) => {
    const gRef = db.doc(`gigs/${gigId}`);
    const gSnap = await tx.get(gRef);
    if (!gSnap.exists) throw new HttpsError('not-found', '외주를 찾을 수 없습니다.');
    const g = gSnap.data();
    if ((g.escrow || 0) <= 0) throw new HttpsError('failed-precondition', '정산할 에스크로가 없습니다.');
    const amt = g.escrow || 0;
    if (outcome === 'release') {
      if (!g.workerId) throw new HttpsError('failed-precondition', '작업자가 없습니다.');
      const wRef = db.doc(`users/${g.workerId}`);
      const wSnap = await tx.get(wRef);
      if (wSnap.exists) tx.update(wRef, { balance: (wSnap.data().balance || 0) + amt });
      tx.update(gRef, { escrow: 0, status: 'done', doneAt: FieldValue.serverTimestamp(), resolveMemo: String(memo || '').trim() });
      tx.set(db.collection('ledger').doc(), { type: 'gig_resolve_release', gigId, userId: g.workerId, delta: amt, ts: FieldValue.serverTimestamp() });
    } else {
      const rRef = db.doc(`users/${g.requesterId}`);
      const rSnap = await tx.get(rRef);
      if (rSnap.exists) tx.update(rRef, { balance: (rSnap.data().balance || 0) + amt });
      tx.update(gRef, { escrow: 0, status: 'refunded', closedAt: FieldValue.serverTimestamp(), resolveMemo: String(memo || '').trim() });
      tx.set(db.collection('ledger').doc(), { type: 'gig_resolve_refund', gigId, userId: g.requesterId, delta: amt, ts: FieldValue.serverTimestamp() });
    }
    return { ok: true, outcome, amount: amt };
  });
});

// ── 운영자: 종료된 외주 삭제(에스크로 0인 것만) ──────────────
export const deleteGig = onCall(async (req) => {
  assertAdmin(req);
  const { gigId } = req.data || {};
  if (!gigId) throw new HttpsError('invalid-argument', 'gigId가 필요합니다.');
  const gRef = db.doc(`gigs/${gigId}`);
  const gSnap = await gRef.get();
  if (!gSnap.exists) throw new HttpsError('not-found', '외주를 찾을 수 없습니다.');
  if ((gSnap.data().escrow || 0) > 0) throw new HttpsError('failed-precondition', '에스크로가 남아 있어 삭제할 수 없습니다(먼저 중재/정산).');
  await gRef.delete();
  return { ok: true };
});

// ═══════════════════════════════════════════════════════════════
//  봉사 요청(허가제) — 무점자가 도움을 요청, 강사 승인 시 봉사자에게 포인트 증정.
//   보상 출처 = housePool(민팅). 요청자 지갑은 건드리지 않음(에스크로 없음).
// ═══════════════════════════════════════════════════════════════

// ── 봉사 요청 등록 ───────────────────────────────────────────
export const postHelp = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, title, desc, deadline } = req.data || {};
  if (!userId) throw new HttpsError('invalid-argument', 'userId가 필요합니다.');
  if (!title || !String(title).trim()) throw new HttpsError('invalid-argument', '제목이 필요합니다.');
  const uSnap = await db.doc(`users/${userId}`).get();
  if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
  requirePin(uSnap.data(), pinHash);
  const ref = await db.collection('helpRequests').add({
    requesterId: userId, requesterName: uSnap.data().name || userId,
    title: String(title).trim(), desc: String(desc || '').trim(),
    deadline: deadline ? String(deadline).trim() : null,
    status: 'open', volunteers: [], helperId: null, helperName: null,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { id: ref.id };
});

// ── 봉사 지원(도와주겠다고 표시) ─────────────────────────────
export const volunteerHelp = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, helpId } = req.data || {};
  if (!userId || !helpId) throw new HttpsError('invalid-argument', 'userId/helpId 누락.');
  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const hRef = db.doc(`helpRequests/${helpId}`);
    const [uSnap, hSnap] = await Promise.all([tx.get(uRef), tx.get(hRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(uSnap.data(), pinHash);
    if (!hSnap.exists) throw new HttpsError('not-found', '봉사 요청을 찾을 수 없습니다.');
    const h = hSnap.data();
    if (h.status !== 'open') throw new HttpsError('failed-precondition', '지원할 수 없는 상태입니다.');
    if (h.requesterId === userId) throw new HttpsError('failed-precondition', '본인 요청에는 지원할 수 없습니다.');
    if (Array.isArray(h.volunteers) && h.volunteers.includes(userId)) throw new HttpsError('failed-precondition', '이미 지원했습니다.');
    tx.update(hRef, { volunteers: FieldValue.arrayUnion(userId) });
    return { ok: true };
  });
});

// ── 봉사 요청 취소(요청자, 승인 전만) ────────────────────────
export const cancelHelp = onCall(async (req) => {
  assertAuth(req);
  const { requesterId, pinHash, helpId } = req.data || {};
  if (!requesterId || !helpId) throw new HttpsError('invalid-argument', 'requesterId/helpId 누락.');
  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${requesterId}`);
    const hRef = db.doc(`helpRequests/${helpId}`);
    const [uSnap, hSnap] = await Promise.all([tx.get(uRef), tx.get(hRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(uSnap.data(), pinHash);
    if (!hSnap.exists) throw new HttpsError('not-found', '봉사 요청을 찾을 수 없습니다.');
    const h = hSnap.data();
    if (h.requesterId !== requesterId) throw new HttpsError('permission-denied', '본인 요청만 취소할 수 있습니다.');
    if (h.status !== 'open') throw new HttpsError('failed-precondition', '이미 처리된 요청입니다.');
    tx.update(hRef, { status: 'cancelled', closedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  });
});

// ── 강사 승인: 봉사자에게 housePool 에서 포인트 증정(민팅) ────
export const approveHelp = onCall(async (req) => {
  assertAdmin(req);
  const { helpId, helperId, amount, memo } = req.data || {};
  const amt = Math.floor(Number(amount));
  if (!helpId || !helperId) throw new HttpsError('invalid-argument', 'helpId/helperId 누락.');
  if (!Number.isInteger(amt) || amt <= 0) throw new HttpsError('invalid-argument', '지급 포인트는 1 이상 정수여야 합니다.');
  return db.runTransaction(async (tx) => {
    const hRef = db.doc(`helpRequests/${helpId}`);
    const wRef = db.doc(`users/${helperId}`);
    const [hSnap, wSnap] = await Promise.all([tx.get(hRef), tx.get(wRef)]);
    if (!hSnap.exists) throw new HttpsError('not-found', '봉사 요청을 찾을 수 없습니다.');
    if (!wSnap.exists) throw new HttpsError('not-found', '봉사자 계정을 찾을 수 없습니다.');
    const h = hSnap.data();
    if (h.status !== 'open') throw new HttpsError('failed-precondition', '이미 처리된 요청입니다.');
    // housePool 은 읽지 않고 increment 로만(시세 틱 충돌 방지). 하우스 음수 허용.
    tx.update(wRef, { balance: (wSnap.data().balance || 0) + amt });
    tx.set(boardRef(), { housePool: FieldValue.increment(-amt) }, { merge: true });
    tx.update(hRef, {
      status: 'granted', helperId, helperName: wSnap.data().name || helperId,
      grantedAmount: amt, memo: String(memo || '').trim(), grantedAt: FieldValue.serverTimestamp(),
    });
    tx.set(db.collection('ledger').doc(), { type: 'help_grant', helpId, userId: helperId, delta: amt, memo: String(memo || '').trim(), ts: FieldValue.serverTimestamp() });
    return { ok: true, amount: amt, helperId };
  });
});

// ── 강사: 봉사 요청 반려/종료 ────────────────────────────────
export const rejectHelp = onCall(async (req) => {
  assertAdmin(req);
  const { helpId } = req.data || {};
  if (!helpId) throw new HttpsError('invalid-argument', 'helpId가 필요합니다.');
  const hRef = db.doc(`helpRequests/${helpId}`);
  const hSnap = await hRef.get();
  if (!hSnap.exists) throw new HttpsError('not-found', '봉사 요청을 찾을 수 없습니다.');
  if (hSnap.data().status !== 'open') throw new HttpsError('failed-precondition', '이미 처리된 요청입니다.');
  await hRef.update({ status: 'rejected', closedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

// ── 작업자 프로필: 자기소개·스킬(본인 작성) ──────────────────
//   users 문서는 쓰기 제한이라 별도 profiles/{userId} 에 함수 경유로 저장(PIN 검증).
//   실적(완료 외주 수·받은 P 등)은 gigs 공개 컬렉션에서 클라가 직접 집계 → 저장 불필요.
export const setProfile = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, bio, skills } = req.data || {};
  if (!userId) throw new HttpsError('invalid-argument', 'userId가 필요합니다.');
  const uSnap = await db.doc(`users/${userId}`).get();
  if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
  requirePin(uSnap.data(), pinHash);
  await db.doc(`profiles/${userId}`).set({
    bio: String(bio || '').trim().slice(0, 500),
    skills: String(skills || '').trim().slice(0, 200),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true };
});

// ═══════════════════════════════════════════════════════════════
//  테스터 모집(recruit) — 한 의뢰가 여러 명을 모집(게임 테스트·피드백 등).
//   인당 보상 rewardEach × 정원 slots 만큼 등록 즉시 에스크로 예치.
//   흐름: 지원(applyRecruit) → 요청자 선발(selectTester) → 테스터 제출(submitRecruit)
//        → 요청자 승인 시 인당 지급(approveTester) / 반려(rejectTester).
//        마감(closeRecruit) 시 미지급 에스크로는 요청자에게 환불.
//   에스크로는 recruits/{id}.escrow 에 보관 → 지갑↔문서 이동뿐이라 총량 보존.
// ═══════════════════════════════════════════════════════════════

// 정원 차지 중인 테스터 수(반려 제외).
function filledSlots(testers) {
  return (Array.isArray(testers) ? testers : []).filter((t) => t.status !== 'rejected').length;
}

// 남은 에스크로를 후원자(sponsors)에게 낸 비율대로 환불(트랜잭션 내). ★모든 읽기는 쓰기 전에★.
//   반환값은 ledger 기록용 요약. 나머지(반올림 잔액)는 첫 후원자(등록자)에게 몰아줘 총량 정확 보존.
async function refundSponsorsInTx(tx, rc) {
  const sponsors = Array.isArray(rc.sponsors) && rc.sponsors.length
    ? rc.sponsors
    : [{ userId: rc.requesterId, name: rc.requesterName, contributed: rc.escrow || 0 }];
  const remaining = rc.escrow || 0;
  if (remaining <= 0) return [];
  const totalContrib = sponsors.reduce((s, x) => s + (x.contributed || 0), 0) || 1;
  const refs = sponsors.map((s) => db.doc(`users/${s.userId}`));
  const snaps = await Promise.all(refs.map((r) => tx.get(r)));
  let allocated = 0;
  const shares = sponsors.map((s) => { const v = Math.floor(remaining * (s.contributed || 0) / totalContrib); allocated += v; return v; });
  shares[0] += remaining - allocated; // 반올림 잔액은 등록자에게
  const out = [];
  snaps.forEach((snap, i) => {
    if (snap.exists && shares[i] > 0) {
      tx.update(refs[i], { balance: (snap.data().balance || 0) + shares[i] });
      out.push({ userId: sponsors[i].userId, amount: shares[i] });
    }
  });
  return out;
}

// 공동 의뢰(포인트 나눠 내기): 등록자는 자기 부담금(contribution)만 넣고, 나머지는 coFundRecruit 로 모금.
export const postRecruit = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, title, desc, deadline, rewardEach, slots, contribution } = req.data || {};
  const re = Math.floor(Number(rewardEach));
  const sl = Math.floor(Number(slots));
  if (!userId) throw new HttpsError('invalid-argument', 'userId가 필요합니다.');
  if (!title || !String(title).trim()) throw new HttpsError('invalid-argument', '제목이 필요합니다.');
  if (!Number.isInteger(re) || re <= 0) throw new HttpsError('invalid-argument', '인당 보상은 1 이상 정수여야 합니다.');
  if (!Number.isInteger(sl) || sl <= 0 || sl > 100) throw new HttpsError('invalid-argument', '모집 정원은 1~100명이어야 합니다.');
  const total = re * sl;
  // 부담금 미지정이면 등록자가 전액 부담(단독 의뢰). 지정 시 1 ~ 총액 범위.
  const contrib = contribution == null || contribution === '' ? total : Math.floor(Number(contribution));
  if (!Number.isInteger(contrib) || contrib <= 0 || contrib > total) {
    throw new HttpsError('invalid-argument', `내 부담금은 1 ~ 총액(${total.toLocaleString()}P) 범위여야 합니다.`);
  }

  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const uSnap = await tx.get(uRef);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    const user = uSnap.data();
    requirePin(user, pinHash);
    const balance = user.balance || 0;
    if (balance < contrib) throw new HttpsError('failed-precondition', `잔액이 부족합니다(${contrib.toLocaleString()}P 부담).`);

    const rRef = db.collection('recruits').doc();
    tx.update(uRef, { balance: balance - contrib });
    tx.set(rRef, {
      requesterId: userId, requesterName: user.name || userId,
      title: String(title).trim(), desc: String(desc || '').trim(),
      deadline: deadline ? String(deadline).trim() : null,
      rewardEach: re, slots: sl, fundTarget: total, escrow: contrib, status: 'open',
      sponsors: [{ userId, name: user.name || userId, contributed: contrib }],
      applicants: [], testers: [],
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(db.collection('ledger').doc(), { type: 'recruit_post', recruitId: rRef.id, userId, delta: -contrib, ts: FieldValue.serverTimestamp() });
    return { id: rRef.id, total, contributed: contrib, newBalance: balance - contrib };
  });
});

// 공동 부담 참여: 다른 수강생이 에스크로 풀에 포인트를 보탠다(목표 초과 불가).
export const coFundRecruit = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, recruitId, amount } = req.data || {};
  const amt = Math.floor(Number(amount));
  if (!userId || !recruitId) throw new HttpsError('invalid-argument', 'userId/recruitId 누락.');
  if (!Number.isInteger(amt) || amt <= 0) throw new HttpsError('invalid-argument', '부담금은 1 이상 정수여야 합니다.');
  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const rRef = db.doc(`recruits/${recruitId}`);
    const [uSnap, rSnap] = await Promise.all([tx.get(uRef), tx.get(rRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(uSnap.data(), pinHash);
    if (!rSnap.exists) throw new HttpsError('not-found', '모집을 찾을 수 없습니다.');
    const rc = rSnap.data();
    if (rc.status !== 'open') throw new HttpsError('failed-precondition', '마감된 모집입니다.');
    const target = rc.fundTarget || (rc.rewardEach * rc.slots);
    const cur = rc.escrow || 0;
    if (cur >= target) throw new HttpsError('failed-precondition', '이미 목표 금액이 다 모였습니다.');
    if (cur + amt > target) throw new HttpsError('failed-precondition', `남은 모금액은 ${(target - cur).toLocaleString()}P 입니다.`);
    const balance = uSnap.data().balance || 0;
    if (balance < amt) throw new HttpsError('failed-precondition', '잔액이 부족합니다.');

    const sponsors = [...(rc.sponsors || [])];
    const i = sponsors.findIndex((s) => s.userId === userId);
    if (i >= 0) sponsors[i] = { ...sponsors[i], contributed: (sponsors[i].contributed || 0) + amt };
    else sponsors.push({ userId, name: uSnap.data().name || userId, contributed: amt });

    tx.update(uRef, { balance: balance - amt });
    tx.update(rRef, { escrow: cur + amt, sponsors });
    tx.set(db.collection('ledger').doc(), { type: 'recruit_cofund', recruitId, userId, delta: -amt, ts: FieldValue.serverTimestamp() });
    return { ok: true, amount: amt, escrow: cur + amt, target };
  });
});

export const applyRecruit = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, recruitId } = req.data || {};
  if (!userId || !recruitId) throw new HttpsError('invalid-argument', 'userId/recruitId 누락.');
  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const rRef = db.doc(`recruits/${recruitId}`);
    const [uSnap, rSnap] = await Promise.all([tx.get(uRef), tx.get(rRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(uSnap.data(), pinHash);
    if (!rSnap.exists) throw new HttpsError('not-found', '모집을 찾을 수 없습니다.');
    const rc = rSnap.data();
    if (rc.status !== 'open') throw new HttpsError('failed-precondition', '지원할 수 없는 상태입니다.');
    if (rc.requesterId === userId) throw new HttpsError('failed-precondition', '본인 모집에는 지원할 수 없습니다.');
    if ((rc.applicants || []).includes(userId)) throw new HttpsError('failed-precondition', '이미 지원했습니다.');
    if ((rc.testers || []).some((t) => t.userId === userId && t.status !== 'rejected')) throw new HttpsError('failed-precondition', '이미 선발된 테스터입니다.');
    tx.update(rRef, { applicants: FieldValue.arrayUnion(userId) });
    return { ok: true };
  });
});

export const cancelRecruitApplication = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, recruitId } = req.data || {};
  if (!userId || !recruitId) throw new HttpsError('invalid-argument', 'userId/recruitId 누락.');
  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const rRef = db.doc(`recruits/${recruitId}`);
    const [uSnap, rSnap] = await Promise.all([tx.get(uRef), tx.get(rRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(uSnap.data(), pinHash);
    if (!rSnap.exists) throw new HttpsError('not-found', '모집을 찾을 수 없습니다.');
    tx.update(rRef, { applicants: FieldValue.arrayRemove(userId) });
    return { ok: true };
  });
});

// 요청자: 지원자 중 테스터 선발(정원 내).
export const selectTester = onCall(async (req) => {
  assertAuth(req);
  const { requesterId, pinHash, recruitId, testerId } = req.data || {};
  if (!requesterId || !recruitId || !testerId) throw new HttpsError('invalid-argument', 'requesterId/recruitId/testerId 누락.');
  return db.runTransaction(async (tx) => {
    const rqRef = db.doc(`users/${requesterId}`);
    const tRef = db.doc(`users/${testerId}`);
    const rRef = db.doc(`recruits/${recruitId}`);
    const [rqSnap, tSnap, rSnap] = await Promise.all([tx.get(rqRef), tx.get(tRef), tx.get(rRef)]);
    if (!rqSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(rqSnap.data(), pinHash);
    if (!rSnap.exists) throw new HttpsError('not-found', '모집을 찾을 수 없습니다.');
    const rc = rSnap.data();
    if (rc.requesterId !== requesterId) throw new HttpsError('permission-denied', '본인 모집만 선발할 수 있습니다.');
    if (rc.status !== 'open') throw new HttpsError('failed-precondition', '모집이 닫혀 있습니다.');
    if (!(rc.applicants || []).includes(testerId)) throw new HttpsError('failed-precondition', '지원자 중에서만 선발할 수 있습니다.');
    if (filledSlots(rc.testers) >= rc.slots) throw new HttpsError('failed-precondition', '모집 정원이 찼습니다.');
    const testers = [...(rc.testers || []), { userId: testerId, name: (tSnap.exists ? tSnap.data().name : null) || testerId, status: 'selected', note: '' }];
    const applicants = (rc.applicants || []).filter((a) => a !== testerId);
    tx.update(rRef, { testers, applicants });
    return { ok: true };
  });
});

// 테스터: 피드백 제출(선발된 사람만).
export const submitRecruit = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, recruitId, note } = req.data || {};
  if (!userId || !recruitId) throw new HttpsError('invalid-argument', 'userId/recruitId 누락.');
  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const rRef = db.doc(`recruits/${recruitId}`);
    const [uSnap, rSnap] = await Promise.all([tx.get(uRef), tx.get(rRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(uSnap.data(), pinHash);
    if (!rSnap.exists) throw new HttpsError('not-found', '모집을 찾을 수 없습니다.');
    const rc = rSnap.data();
    const testers = [...(rc.testers || [])];
    const i = testers.findIndex((t) => t.userId === userId);
    if (i < 0) throw new HttpsError('failed-precondition', '선발된 테스터가 아닙니다.');
    if (testers[i].status !== 'selected') throw new HttpsError('failed-precondition', '제출할 수 있는 상태가 아닙니다.');
    testers[i] = { ...testers[i], status: 'submitted', note: String(note || '').trim().slice(0, 1000), submittedAt: Date.now() };
    tx.update(rRef, { testers });
    return { ok: true };
  });
});

// 요청자: 테스터 제출 승인 → 인당 보상 지급.
export const approveTester = onCall(async (req) => {
  assertAuth(req);
  const { requesterId, pinHash, recruitId, testerId } = req.data || {};
  if (!requesterId || !recruitId || !testerId) throw new HttpsError('invalid-argument', 'requesterId/recruitId/testerId 누락.');
  return db.runTransaction(async (tx) => {
    const rqRef = db.doc(`users/${requesterId}`);
    const tRef = db.doc(`users/${testerId}`);
    const rRef = db.doc(`recruits/${recruitId}`);
    const [rqSnap, tSnap, rSnap] = await Promise.all([tx.get(rqRef), tx.get(tRef), tx.get(rRef)]);
    if (!rqSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(rqSnap.data(), pinHash);
    if (!rSnap.exists) throw new HttpsError('not-found', '모집을 찾을 수 없습니다.');
    const rc = rSnap.data();
    if (rc.requesterId !== requesterId) throw new HttpsError('permission-denied', '본인 모집만 승인할 수 있습니다.');
    const testers = [...(rc.testers || [])];
    const i = testers.findIndex((t) => t.userId === testerId);
    if (i < 0) throw new HttpsError('not-found', '테스터를 찾을 수 없습니다.');
    if (testers[i].status !== 'submitted') throw new HttpsError('failed-precondition', '제출 완료된 테스터만 승인할 수 있습니다.');
    const pay = rc.rewardEach || 0;
    if ((rc.escrow || 0) < pay) throw new HttpsError('failed-precondition', '에스크로 잔액이 부족합니다.');
    if (tSnap.exists) tx.update(tRef, { balance: (tSnap.data().balance || 0) + pay });
    testers[i] = { ...testers[i], status: 'approved' };
    tx.update(rRef, { testers, escrow: (rc.escrow || 0) - pay });
    tx.set(db.collection('ledger').doc(), { type: 'recruit_pay', recruitId, userId: testerId, delta: pay, ts: FieldValue.serverTimestamp() });
    return { ok: true, pay };
  });
});

// 요청자: 테스터 반려(지급 없음, 슬롯 반환).
export const rejectTester = onCall(async (req) => {
  assertAuth(req);
  const { requesterId, pinHash, recruitId, testerId } = req.data || {};
  if (!requesterId || !recruitId || !testerId) throw new HttpsError('invalid-argument', 'requesterId/recruitId/testerId 누락.');
  return db.runTransaction(async (tx) => {
    const rqRef = db.doc(`users/${requesterId}`);
    const rRef = db.doc(`recruits/${recruitId}`);
    const [rqSnap, rSnap] = await Promise.all([tx.get(rqRef), tx.get(rRef)]);
    if (!rqSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(rqSnap.data(), pinHash);
    if (!rSnap.exists) throw new HttpsError('not-found', '모집을 찾을 수 없습니다.');
    const rc = rSnap.data();
    if (rc.requesterId !== requesterId) throw new HttpsError('permission-denied', '본인 모집만 반려할 수 있습니다.');
    const testers = [...(rc.testers || [])];
    const i = testers.findIndex((t) => t.userId === testerId);
    if (i < 0) throw new HttpsError('not-found', '테스터를 찾을 수 없습니다.');
    if (!['selected', 'submitted'].includes(testers[i].status)) throw new HttpsError('failed-precondition', '반려할 수 있는 상태가 아닙니다.');
    testers[i] = { ...testers[i], status: 'rejected' };
    tx.update(rRef, { testers });
    return { ok: true };
  });
});

// 요청자: 모집 마감 → 미지급 에스크로 환불.
export const closeRecruit = onCall(async (req) => {
  assertAuth(req);
  const { requesterId, pinHash, recruitId } = req.data || {};
  if (!requesterId || !recruitId) throw new HttpsError('invalid-argument', 'requesterId/recruitId 누락.');
  return db.runTransaction(async (tx) => {
    const rqRef = db.doc(`users/${requesterId}`);
    const rRef = db.doc(`recruits/${recruitId}`);
    const [rqSnap, rSnap] = await Promise.all([tx.get(rqRef), tx.get(rRef)]);
    if (!rqSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(rqSnap.data(), pinHash);
    if (!rSnap.exists) throw new HttpsError('not-found', '모집을 찾을 수 없습니다.');
    const rc = rSnap.data();
    if (rc.requesterId !== requesterId) throw new HttpsError('permission-denied', '본인 모집만 마감할 수 있습니다.');
    if (rc.status !== 'open') throw new HttpsError('failed-precondition', '이미 마감된 모집입니다.');
    const refund = rc.escrow || 0;
    const refunds = await refundSponsorsInTx(tx, rc); // 후원자에게 비율 환불(공동 의뢰)
    tx.update(rRef, { escrow: 0, status: 'closed', closedAt: FieldValue.serverTimestamp() });
    if (refund > 0) tx.set(db.collection('ledger').doc(), { type: 'recruit_close', recruitId, userId: requesterId, delta: refund, refunds, ts: FieldValue.serverTimestamp() });
    return { ok: true, refund, refunds };
  });
});

// 강사 중재: 특정 테스터 강제 지급(pay) 또는 남은 에스크로 요청자 환불 후 마감(refund).
export const resolveRecruit = onCall(async (req) => {
  assertAdmin(req);
  const { recruitId, testerId, outcome } = req.data || {};
  if (!recruitId) throw new HttpsError('invalid-argument', 'recruitId가 필요합니다.');
  if (outcome !== 'pay' && outcome !== 'refund') throw new HttpsError('invalid-argument', "outcome은 'pay' 또는 'refund'.");
  return db.runTransaction(async (tx) => {
    const rRef = db.doc(`recruits/${recruitId}`);
    const rSnap = await tx.get(rRef);
    if (!rSnap.exists) throw new HttpsError('not-found', '모집을 찾을 수 없습니다.');
    const rc = rSnap.data();
    if (outcome === 'pay') {
      if (!testerId) throw new HttpsError('invalid-argument', 'testerId가 필요합니다.');
      const testers = [...(rc.testers || [])];
      const i = testers.findIndex((t) => t.userId === testerId);
      if (i < 0) throw new HttpsError('not-found', '테스터를 찾을 수 없습니다.');
      if (testers[i].status === 'approved') throw new HttpsError('failed-precondition', '이미 지급된 테스터입니다.');
      const pay = rc.rewardEach || 0;
      if ((rc.escrow || 0) < pay) throw new HttpsError('failed-precondition', '에스크로 잔액이 부족합니다.');
      const tRef = db.doc(`users/${testerId}`);
      const tSnap = await tx.get(tRef);
      if (tSnap.exists) tx.update(tRef, { balance: (tSnap.data().balance || 0) + pay });
      testers[i] = { ...testers[i], status: 'approved' };
      tx.update(rRef, { testers, escrow: (rc.escrow || 0) - pay });
      tx.set(db.collection('ledger').doc(), { type: 'recruit_resolve_pay', recruitId, userId: testerId, delta: pay, ts: FieldValue.serverTimestamp() });
      return { ok: true, outcome, pay };
    }
    const refund = rc.escrow || 0;
    const refunds = await refundSponsorsInTx(tx, rc); // 후원자에게 비율 환불(공동 의뢰)
    tx.update(rRef, { escrow: 0, status: 'closed', closedAt: FieldValue.serverTimestamp() });
    if (refund > 0) tx.set(db.collection('ledger').doc(), { type: 'recruit_resolve_refund', recruitId, delta: refund, refunds, ts: FieldValue.serverTimestamp() });
    return { ok: true, outcome, refund, refunds };
  });
});

// ═══════════════════════════════════════════════════════════════
//  ③ 주간 펀더멘탈 배당 — "태도/행동 기반 장기투자" 유도 레버.
//   매주 월 09:00(KST) '지난주' 팀 행동점수로 보유자에게 배당(housePool 지급, payDividend 와 동일 회계).
//   행동점수 = 지난주 Σ(instructor_event.pct, 팀별) + 운영자 수동 오버라이드(meta/behaviorScores[weekKey]).
//   ★기본 OFF(meta/stockBoard.dividendEnabled)★ — 켜기 전엔 월요일이 와도 지급 0(배포해도 이번 회차 미지급).
//   perShare = round(score × rate), score>0 팀만. 멱등: 이미 지급한 주(meta/dividendPaid)는 재지급 안 함.
// ═══════════════════════════════════════════════════════════════

// Asia/Seoul ISO 주 키(예 "2026-W28"). HK_DP src/util/week.js·교환소와 동일 로직.
function seoulWeekKey(d = new Date()) {
  const s = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = (s.getDay() + 6) % 7; // 월=0
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - day + 3); // 해당 주 목요일
  const firstThu = new Date(s.getFullYear(), 0, 4);
  const week = 1 + Math.round(((s - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return `${s.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

// 급여 주 키 — 경계가 **월요일 09:00(KST)**. 09:00 이전은 아직 지난 주급 주로 친다.
//   9시간을 뒤로 민 뒤 ISO 주 키를 구하면 월 09:00 이 정확히 월 00:00 으로 정렬된다.
//   (월 08:59 → 전주 / 월 09:00 → 신주). 주급 1주 1회 제한(paySalary)의 기준.
const PAY_WEEK_OFFSET_MS = 9 * 60 * 60 * 1000;
function payWeekKey(d = new Date()) {
  return seoulWeekKey(new Date(d.getTime() - PAY_WEEK_OFFSET_MS));
}

// 운영자: 배당 on/off + 배율(rate) 런타임 조정(재배포 불필요). 기본 rate=10.
export const setDividendConfig = onCall(async (req) => {
  assertAdmin(req);
  const patch = {};
  if (req.data?.enabled != null) patch.dividendEnabled = !!req.data.enabled;
  if (req.data?.rate != null) {
    const r = Number(req.data.rate);
    if (!Number.isFinite(r) || r < 0) throw new HttpsError('invalid-argument', 'rate는 0 이상 숫자.');
    patch.dividendRate = r;
  }
  if (Object.keys(patch).length === 0) throw new HttpsError('invalid-argument', 'enabled 또는 rate가 필요합니다.');
  await boardRef().set(patch, { merge: true });
  return { ok: true, ...patch };
});

// 운영자: 주(weekKey) 팀 행동점수 수동 오버라이드 저장(주중 여유있게 작성 → 차주 월 적용).
//   scores: { [stockId]: number }. weekKey 미지정 시 '이번 주'. 자동집계와 합산된다.
export const setBehaviorScores = onCall(async (req) => {
  assertAdmin(req);
  const wk = String(req.data?.weekKey || seoulWeekKey()).trim();
  const scores = req.data?.scores;
  if (!scores || typeof scores !== 'object') throw new HttpsError('invalid-argument', 'scores 객체가 필요합니다.');
  const clean = {};
  for (const [k, v] of Object.entries(scores)) { const n = Number(v); if (Number.isFinite(n)) clean[k] = n; }
  await db.doc('meta/behaviorScores').set({ [wk]: clean }, { merge: true });
  return { ok: true, weekKey: wk, count: Object.keys(clean).length };
});

// 자동: 매주 월 09:00(KST) 지난주 행동점수로 보유자에게 배당.
export const payWeeklyDividend = onSchedule({ schedule: '0 9 * * 1', timeZone: 'Asia/Seoul' }, async () => {
  const board = (await boardRef().get()).data() || {};
  if (!board.dividendEnabled) return; // ★게이트: 꺼져 있으면 지급 안 함★
  const rate = Number.isFinite(board.dividendRate) ? board.dividendRate : 10;

  const lastWeek = seoulWeekKey(new Date(Date.now() - 3 * 86400000)); // 월요일−3일 = 지난주
  const paidRef = db.doc('meta/dividendPaid');
  if (((await paidRef.get()).data() || {})[lastWeek]) return; // 멱등: 이미 지급한 주면 스킵

  // 지난주 강사이벤트 자동집계(pct 합, 팀별). 단일 등가쿼리 후 weekKey 코드필터(복합인덱스 불필요).
  const weekAgo = Date.now() - 9 * 86400000;
  const evSnap = await db.collection('ledger').where('type', '==', 'instructor_event').get();
  const scoreByStock = {};
  evSnap.forEach((d) => {
    const e = d.data();
    const t = e.ts?.toMillis ? e.ts.toMillis() : 0;
    if (t < weekAgo) return;
    if (seoulWeekKey(new Date(t)) !== lastWeek) return;
    if (e.scope === 'stock' && e.target) scoreByStock[e.target] = (scoreByStock[e.target] || 0) + (Number(e.pct) || 0);
  });
  // 수동 오버라이드 합산
  const override = ((await db.doc('meta/behaviorScores').get()).data() || {})[lastWeek] || {};
  for (const [sid, v] of Object.entries(override)) scoreByStock[sid] = (scoreByStock[sid] || 0) + (Number(v) || 0);

  const results = []; let grandTotal = 0;
  for (const [stockId, score] of Object.entries(scoreByStock)) {
    if (!(score > 0)) continue;
    const perShare = Math.round(score * rate);
    if (perShare <= 0) continue;
    // eslint-disable-next-line no-await-in-loop
    const hs = await db.collection('holdings').where('stockId', '==', stockId).get();
    const payouts = []; let total = 0;
    hs.forEach((d) => { const h = d.data(); if ((h.shares || 0) > 0) { total += perShare * h.shares; payouts.push({ userId: h.userId, amt: perShare * h.shares }); } });
    if (payouts.length === 0) continue;
    // eslint-disable-next-line no-await-in-loop
    await db.runTransaction(async (tx) => {
      const uRefs = payouts.map((p) => db.doc(`users/${p.userId}`));
      const uSnaps = await Promise.all(uRefs.map((r) => tx.get(r)));
      uSnaps.forEach((s, i) => { if (s.exists) tx.update(uRefs[i], { balance: (s.data().balance || 0) + payouts[i].amt }); });
      tx.set(boardRef(), { housePool: FieldValue.increment(-total) }, { merge: true });
      tx.set(db.collection('ledger').doc(), { type: 'weekly_dividend', stockId, weekKey: lastWeek, score, perShare, total, count: payouts.length, ts: FieldValue.serverTimestamp() });
    });
    grandTotal += total; results.push({ stockId, perShare, total });
  }
  await paidRef.set({ [lastWeek]: { at: Date.now(), grandTotal, teams: results.length } }, { merge: true });
});

// ═══════════════════════════════════════════════════════════════
//  팀 경제(팀 포인트) — ★팀 = 주식★. 팀 금고는 stocks/{id}.corpBalance 에 둔다.
//   상장(upsertStock)이 곧 팀 생성, 상장폐지가 곧 팀 해산 → 별도 companies 컬렉션을 두지 않는다.
//   stocks 문서가 이미 name·team·members 를 갖고 있으므로 여기에 ceoUserId·corpBalance 만 더한다.
//   ★거버넌스★: 지출은 CEO만(stocks.ceoUserId + CEO PIN 검증). 전 지출은 teamLedger(공개)에 기록.
//   ★단위★: 팀 포인트 = 개인 포인트와 같은 단위지만 금고에 '동결'(DP 전환 불가).
//     유입 grantTeamPoints(housePool→금고, 총량보존) · 환류 salary/bonus/dividend(금고→개인) · 소각 redeem.
//   ★소득세★: 주급의 10%는 housePool 로 원천징수 → 하우스 적자 자연 회수.
//   총량보존: Σ개인 + Σ금고(corpBalance) + housePool + Σreserve + Σescrow = 불변.
//     → 상장폐지(팀 해산) 시 잔여 금고는 housePool 로 회수한다(delistStock 참고).
// ═══════════════════════════════════════════════════════════════

const SALARY_TAX_BPS = 1000; // 주급 소득세 10%
const BONUS_TAX_BPS = 1500; // 상여 소득세 15% (주급보다 높게 — 정기급여 우대)

// CEO 권한 검증(트랜잭션 내): 종목(팀) 존재 + ceoUserId 일치 + CEO PIN 일치. reads-before-writes 유지.
async function loadCeoTeam(tx, stockId, ceoUserId, pinHash) {
  const sRef = db.doc(`stocks/${stockId}`);
  const sSnap = await tx.get(sRef);
  if (!sSnap.exists) throw new HttpsError('not-found', '팀(종목)을 찾을 수 없습니다.');
  const team = sSnap.data();
  if (!team.ceoUserId || team.ceoUserId !== ceoUserId) throw new HttpsError('permission-denied', '대표(CEO)만 집행할 수 있습니다.');
  const ceoSnap = await tx.get(db.doc(`users/${ceoUserId}`));
  if (!ceoSnap.exists) throw new HttpsError('not-found', 'CEO 계정을 찾을 수 없습니다.');
  requirePin(ceoSnap.data(), pinHash);
  return { sRef, team };
}

// ── 운영자: 팀 금고 충전(순위 배당·초기자본) — housePool→금고(총량보존) 또는 mint ──
export const grantTeamPoints = onCall(async (req) => {
  assertAdmin(req);
  const { stockId, amount, memo, source } = req.data || {};
  const amt = Math.floor(Number(amount));
  if (!stockId || !Number.isInteger(amt) || amt === 0) throw new HttpsError('invalid-argument', 'stockId/amount 필요.');
  const src = source === 'mint' ? 'mint' : 'house';
  await db.runTransaction(async (tx) => {
    const sRef = db.doc(`stocks/${stockId}`);
    const sSnap = await tx.get(sRef);
    if (!sSnap.exists) throw new HttpsError('not-found', '팀(종목)을 찾을 수 없습니다.');
    tx.update(sRef, { corpBalance: FieldValue.increment(amt) });
    if (src === 'house') tx.set(boardRef(), { housePool: FieldValue.increment(-amt) }, { merge: true }); // 금고↑ = housePool↓
    tx.set(db.collection('teamLedger').doc(), { stockId, type: 'grant', amount: amt, source: src, memo: memo || '', ts: FieldValue.serverTimestamp() });
  });
  return { stockId, amount: amt, source: src };
});

// ── CEO: 주급 (금고→팀원, 소득세 10% → housePool) ──────────
export const paySalary = onCall(async (req) => {
  assertAuth(req);
  const { stockId, ceoUserId, pinHash, payments } = req.data || {};
  if (!stockId || !ceoUserId || !Array.isArray(payments) || !payments.length) throw new HttpsError('invalid-argument', 'stockId/ceoUserId/payments 필요.');
  const clean = payments.map((p) => ({ userId: String(p.userId), gross: Math.floor(Number(p.gross)) })).filter((p) => p.userId && p.gross > 0);
  if (!clean.length) throw new HttpsError('invalid-argument', '유효한 지급 항목이 없습니다.');
  const wk = payWeekKey();
  const res = await db.runTransaction(async (tx) => {
    const { sRef, team } = await loadCeoTeam(tx, stockId, ceoUserId, pinHash);
    // ★주급은 1주 1회★ — 경계는 월요일 09:00(KST). 쪼개 지급으로 한도를 우회하지 못하게 막는다.
    if (team.lastSalaryWeek === wk) {
      throw new HttpsError('failed-precondition', '주급은 한 주에 한 번만 지급할 수 있습니다(다음 월요일 09:00 이후 가능).');
    }
    const totalGross = clean.reduce((a, p) => a + p.gross, 0);
    if ((team.corpBalance || 0) < totalGross) throw new HttpsError('failed-precondition', '팀 금고 잔액이 부족합니다(체불).');
    const memRefs = clean.map((p) => db.doc(`users/${p.userId}`));
    const memSnaps = await Promise.all(memRefs.map((r) => tx.get(r)));
    let totalTax = 0; let totalNet = 0; const lines = [];
    memSnaps.forEach((s, i) => {
      if (!s.exists) throw new HttpsError('not-found', `팀원(${clean[i].userId}) 계정을 찾을 수 없습니다.`);
      const gross = clean[i].gross;
      const tax = Math.round((gross * SALARY_TAX_BPS) / 10000);
      const net = gross - tax;
      totalTax += tax; totalNet += net;
      tx.update(memRefs[i], { balance: FieldValue.increment(net) });
      lines.push({ userId: clean[i].userId, gross, tax, net });
    });
    tx.update(sRef, { corpBalance: FieldValue.increment(-totalGross), lastSalaryWeek: wk });
    tx.set(boardRef(), { housePool: FieldValue.increment(totalTax) }, { merge: true }); // 소득세 → housePool
    tx.set(db.collection('teamLedger').doc(), { stockId, type: 'salary', weekKey: wk, totalGross, totalTax, totalNet, count: clean.length, lines, ceoUserId, ts: FieldValue.serverTimestamp() });
    return { totalGross, totalTax, totalNet, count: clean.length };
  });
  return { stockId, weekKey: wk, ...res };
});

// ── CEO: 상여 (금고→팀원 1인, 소득세 15% → housePool) ─────
export const payBonus = onCall(async (req) => {
  assertAuth(req);
  const { stockId, ceoUserId, pinHash, userId, amount, memo } = req.data || {};
  const amt = Math.floor(Number(amount)); // amt = 세전(gross)
  if (!stockId || !ceoUserId || !userId || !(amt > 0)) throw new HttpsError('invalid-argument', 'stockId/ceoUserId/userId/amount 필요.');
  const tax = Math.round((amt * BONUS_TAX_BPS) / 10000);
  const net = amt - tax;
  await db.runTransaction(async (tx) => {
    const { sRef, team } = await loadCeoTeam(tx, stockId, ceoUserId, pinHash);
    if ((team.corpBalance || 0) < amt) throw new HttpsError('failed-precondition', '팀 금고 잔액이 부족합니다.');
    const mRef = db.doc(`users/${userId}`);
    const mSnap = await tx.get(mRef);
    if (!mSnap.exists) throw new HttpsError('not-found', '대상 계정을 찾을 수 없습니다.');
    tx.update(mRef, { balance: FieldValue.increment(net) });
    tx.update(sRef, { corpBalance: FieldValue.increment(-amt) });
    tx.set(boardRef(), { housePool: FieldValue.increment(tax) }, { merge: true }); // 상여 소득세 → housePool
    tx.set(db.collection('teamLedger').doc(), { stockId, type: 'bonus', userId: String(userId), amount: amt, tax, net, memo: memo || '', ceoUserId, ts: FieldValue.serverTimestamp() });
  });
  return { stockId, userId, amount: amt, tax, net };
});

// ── CEO: 자체 배당 (금고→자사주 보유자, perShare×shares) ───
export const payTeamDividend = onCall(async (req) => {
  assertAuth(req);
  const { stockId, ceoUserId, pinHash, perShare } = req.data || {};
  const ps = Math.floor(Number(perShare));
  if (!stockId || !ceoUserId || !(ps > 0)) throw new HttpsError('invalid-argument', 'stockId/ceoUserId/perShare 필요.');
  const hs = await db.collection('holdings').where('stockId', '==', stockId).get();
  const payouts = []; let total = 0;
  hs.forEach((d) => { const h = d.data(); if ((h.shares || 0) > 0) { const amt = ps * h.shares; total += amt; payouts.push({ userId: h.userId, amt }); } });
  if (!payouts.length) throw new HttpsError('failed-precondition', '자사주 보유자가 없습니다.');
  await db.runTransaction(async (tx) => {
    const { sRef, team } = await loadCeoTeam(tx, stockId, ceoUserId, pinHash);
    if ((team.corpBalance || 0) < total) throw new HttpsError('failed-precondition', '팀 금고 잔액이 부족합니다.');
    const uRefs = payouts.map((p) => db.doc(`users/${p.userId}`));
    const uSnaps = await Promise.all(uRefs.map((r) => tx.get(r)));
    uSnaps.forEach((s, i) => { if (s.exists) tx.update(uRefs[i], { balance: FieldValue.increment(payouts[i].amt) }); });
    tx.update(sRef, { corpBalance: FieldValue.increment(-total) });
    tx.set(db.collection('teamLedger').doc(), { stockId, type: 'team_dividend', perShare: ps, total, count: payouts.length, ceoUserId, ts: FieldValue.serverTimestamp() });
  });
  return { stockId, perShare: ps, total, count: payouts.length };
});

// ── 팀원: 유상증자 청약 (개인→팀 금고, 신주 3일 락업) ──────
//   일반 매수는 멤버가 차단되므로 이것이 자사주 획득의 유일한 경로.
//   ★대금 전액이 reserve 가 아니라 팀 금고로 간다★ → 신주는 무담보.
//   그래서 매도 시 곡선수령을 금고에서 지급(=회사 환매책임, trade 매도 분기). 금고가 없으면 매도 불가.
//   이 설계가 없으면 housePool 이 대납해 드레인 루프(100주 사이클당 약 −139K)가 생긴다.
const OFFER_LOCK_MS = 3 * 24 * 60 * 60 * 1000; // 신주 락업 3일

export const subscribeShares = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, stockId, qty } = req.data || {};
  const q = Math.floor(Number(qty));
  if (!userId || !stockId) throw new HttpsError('invalid-argument', 'userId/stockId 누락.');
  if (!Number.isInteger(q) || q <= 0) throw new HttpsError('invalid-argument', '수량은 1 이상 정수.');

  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const sRef = db.doc(`stocks/${stockId}`);
    const hRef = db.doc(`holdings/${holdingId(userId, stockId)}`);
    const [uSnap, sSnap, hSnap] = await Promise.all([tx.get(uRef), tx.get(sRef), tx.get(hRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    const user = uSnap.data();
    requirePin(user, pinHash);
    if (!sSnap.exists) throw new HttpsError('not-found', '종목(팀)을 찾을 수 없습니다.');
    const stock = { ...sSnap.data(), circulating: sSnap.data().circulating || 0 };
    if (stock.status !== 'open') throw new HttpsError('failed-precondition', '거래가 닫힌 종목입니다.');
    if (!(Array.isArray(stock.members) && stock.members.includes(userId))) {
      throw new HttpsError('permission-denied', '해당 팀 소속만 청약할 수 있습니다.');
    }
    const holding = hSnap.exists ? hSnap.data() : { shares: 0, avgCost: 0, offerShares: 0 };
    const balance = user.balance || 0;

    let Q;
    try { Q = quoteBuy(stock, q); } catch (e) { throw new HttpsError('failed-precondition', e.message); }
    if (Q.cost > balance) throw new HttpsError('failed-precondition', '잔액이 부족합니다.');

    const fillPrice = Math.round(Q.cost / q);
    const unlockAt = Math.max(holding.offerUnlockAt || 0, Date.now() + OFFER_LOCK_MS);

    tx.update(sRef, {
      circulating: Q.newCirculating,
      corpBalance: FieldValue.increment(Q.cost), // ★대금 전액 금고★ (reserve 는 그대로 = 무담보 신주)
      price: Q.newPrice,
      priceHistory: appendHist(stock.priceHistory, Q.newPrice),
    });
    tx.update(uRef, { balance: balance - Q.cost });
    tx.set(hRef, {
      userId, stockId,
      shares: (holding.shares || 0) + q,
      avgCost: nextAvgCost(holding.shares || 0, holding.avgCost || 0, q, Q.cost / q),
      offerShares: (holding.offerShares || 0) + q,
      offerUnlockAt: unlockAt,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(db.collection('trades').doc(), { userId, stockId, side: 'subscribe', qty: q, price: fillPrice, cash: -Q.cost, fee: 0, ts: FieldValue.serverTimestamp() });
    tx.set(db.collection('ledger').doc(), { userId, stockId, type: 'subscribe', delta: -Q.cost, qty: q, price: fillPrice, houseDelta: 0, ts: FieldValue.serverTimestamp() });
    tx.set(db.collection('teamLedger').doc(), { stockId, type: 'offer_subscribe', userId, qty: q, amount: Q.cost, price: fillPrice, unlockAt, ts: FieldValue.serverTimestamp() });
    return { stockId, qty: q, price: fillPrice, cost: Q.cost, unlockAt, newBalance: balance - Q.cost, newPrice: Q.newPrice };
  });
});

// ── CEO: 팀 포인트 교환소 (금고 소각 → 서비스 주문) ────────
//   가격·승인여부는 meta/corpServices(운영자 설정) 우선. 미설정 서비스는 승인 필요(status:'pending').
//   ★소각★: corpBalance 만 줄이고 반대편이 없다 = 총량 감소. 거부 시 rejectCorpOrder 로 되돌린다.
//   ★즉시효과 서비스(svc.effect)★: 승인 없이 바로 체결(fulfilled) → 환불 불가. 예 = 홍보 계약(뉴스 호재).
export const redeemCorpService = onCall(async (req) => {
  assertAuth(req);
  const { stockId, ceoUserId, pinHash, service, params } = req.data || {};
  if (!stockId || !ceoUserId || !service) throw new HttpsError('invalid-argument', 'stockId/ceoUserId/service 필요.');
  const cfg = (await db.doc('meta/corpServices').get()).data() || {};
  const svc = (cfg.services && cfg.services[service]) || null;
  const price = svc ? Math.floor(Number(svc.price)) : Math.floor(Number(req.data?.cost));
  if (!(price > 0)) throw new HttpsError('failed-precondition', '서비스 가격이 설정되지 않았습니다.');
  const effect = svc?.effect || null;
  // 즉시효과가 있으면 되돌릴 수 없으므로 승인 대기를 두지 않는다.
  const needsApproval = effect ? false : (svc ? !!svc.needsApproval : true);
  const res = await db.runTransaction(async (tx) => {
    const { sRef, team } = await loadCeoTeam(tx, stockId, ceoUserId, pinHash);
    if ((team.corpBalance || 0) < price) throw new HttpsError('failed-precondition', '팀 금고 잔액이 부족합니다.');
    tx.update(sRef, { corpBalance: FieldValue.increment(-price) });
    const orderRef = db.collection('corpOrders').doc();
    const status = needsApproval ? 'pending' : 'fulfilled';
    tx.set(orderRef, {
      stockId, service: String(service), serviceName: svc?.name || String(service),
      cost: price, params: params || {}, status, refundable: !effect, ceoUserId,
      ts: FieldValue.serverTimestamp(),
    });
    tx.set(db.collection('teamLedger').doc(), { stockId, type: 'redeem', service: String(service), serviceName: svc?.name || String(service), cost: price, orderId: orderRef.id, status, ceoUserId, ts: FieldValue.serverTimestamp() });
    return { orderId: orderRef.id, status, teamName: team.name || stockId };
  });

  // 즉시효과 적용 — 트랜잭션 밖에서(applyImpactNews 가 자체 트랜잭션을 쓴다).
  //   ★호재는 구매 팀이 아니라 공급사(까미 비전스)에 붙는다★
  //   자기 팀 호재였다면 금고→주가→팀원 매도 로 이어지는 세탁 경로가 열린다. 그래서 target 을 분리한다.
  let applied = null;
  if (effect?.type === 'news') {
    const headline = String(effect.headline || '{team}, {supplier} 와 계약 체결')
      .replaceAll('{team}', res.teamName)
      .replaceAll('{supplier}', effect.supplierName || '까미 비전스');
    try {
      applied = await applyImpactNews({
        text: headline, scope: 'stock', target: effect.target, pct: Number(effect.pct) || 0,
        kind: 'corp_promo', category: 'promo',
      });
    } catch (e) {
      console.error('홍보 계약 호재 적용 실패:', e); // 주문은 이미 체결됨 — 운영자가 수동 보정
    }
  }
  return { stockId, service, cost: price, ...res, effect: applied };
});

// ── 운영자: 주문 거부 → 금고 환원(소각 되돌리기) ────────────
//   승인제 서비스(강사 슬롯 등)를 못 들어줄 때. pending 만 대상이고, 즉시효과 주문은 애초에 pending 이 아니다.
export const rejectCorpOrder = onCall(async (req) => {
  assertAdmin(req);
  const { orderId, reason } = req.data || {};
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId 필요.');
  return db.runTransaction(async (tx) => {
    const oRef = db.doc(`corpOrders/${orderId}`);
    const oSnap = await tx.get(oRef);
    if (!oSnap.exists) throw new HttpsError('not-found', '주문을 찾을 수 없습니다.');
    const o = oSnap.data();
    if (o.status !== 'pending') throw new HttpsError('failed-precondition', `대기 중인 주문만 거부할 수 있습니다(현재: ${o.status}).`);
    const sRef = db.doc(`stocks/${o.stockId}`);
    const sSnap = await tx.get(sRef);
    if (!sSnap.exists) throw new HttpsError('not-found', '팀(종목)을 찾을 수 없습니다.');
    const refund = Math.floor(Number(o.cost) || 0);
    tx.update(sRef, { corpBalance: FieldValue.increment(refund) }); // 소각 되돌리기
    tx.update(oRef, { status: 'rejected', reason: String(reason || ''), resolvedAt: FieldValue.serverTimestamp() });
    tx.set(db.collection('teamLedger').doc(), { stockId: o.stockId, type: 'redeem_refund', service: o.service, serviceName: o.serviceName || o.service, amount: refund, orderId, reason: String(reason || ''), ts: FieldValue.serverTimestamp() });
    return { orderId, stockId: o.stockId, refund };
  });
});

// ── 운영자: 주문 이행 완료 처리 (포인트 이동 없음, 상태만) ──
export const fulfillCorpOrder = onCall(async (req) => {
  assertAdmin(req);
  const { orderId, memo } = req.data || {};
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId 필요.');
  return db.runTransaction(async (tx) => {
    const oRef = db.doc(`corpOrders/${orderId}`);
    const oSnap = await tx.get(oRef);
    if (!oSnap.exists) throw new HttpsError('not-found', '주문을 찾을 수 없습니다.');
    const o = oSnap.data();
    if (o.status !== 'pending') throw new HttpsError('failed-precondition', `대기 중인 주문만 승인할 수 있습니다(현재: ${o.status}).`);
    tx.update(oRef, { status: 'fulfilled', memo: String(memo || ''), resolvedAt: FieldValue.serverTimestamp() });
    tx.set(db.collection('teamLedger').doc(), { stockId: o.stockId, type: 'redeem_fulfilled', service: o.service, serviceName: o.serviceName || o.service, cost: o.cost || 0, orderId, ts: FieldValue.serverTimestamp() });
    return { orderId, stockId: o.stockId };
  });
});

// ── 운영자: 교환소 가격표 설정 ──────────────────────────────
export const setCorpServices = onCall(async (req) => {
  assertAdmin(req);
  const { services } = req.data || {};
  if (!services || typeof services !== 'object') throw new HttpsError('invalid-argument', 'services 객체 필요.');
  await db.doc('meta/corpServices').set({ services, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { count: Object.keys(services).length };
});

// ═════════════════════════════════════════════════════════════
// DP 교환소 (HK_DP 프론트가 호출) — docs/DP-EXCHANGE-DESIGN.md §6.
//
//   ★배포본-리포 드리프트 복구(2026-08-06)★ — 커밋 23ea177 이 이 함수들을 추가했다고
//   주장했지만 실제로는 리포에 들어온 적이 없고, 라이브에만 배포돼 돌고 있었다.
//   설계문서 §6 전문과 HK_DP 클라이언트 계약(store.js)을 기준으로 재편입.
//   ※ 이 블록이 리포에 없는 채로 `--only functions` 배포를 하면 라이브 DP 교환소가
//     삭제된다 — 절대 이 블록을 들어내지 마라.
// ═════════════════════════════════════════════════════════════

// 학생: 포인트 → DP (개인별 2차곡선 · 주간 리셋). 대금은 housePool 로 회수(총량보존).
export const convertToDP = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, qty } = req.data || {};
  const q = Math.floor(Number(qty));
  if (!userId || !Number.isInteger(q) || q <= 0) throw new HttpsError('invalid-argument', 'userId/qty(1+) 필요.');

  const cfg = (await db.doc('meta/dpExchange').get()).data() || {};
  if (cfg.convertEnabled === false) throw new HttpsError('failed-precondition', '교환이 일시 중지되었습니다.');
  const R0 = cfg.R0 ?? DP_DEFAULTS.R0, k = cfg.k ?? DP_DEFAULTS.k, exp = cfg.exp ?? DP_DEFAULTS.exp;
  const wk = seoulWeekKey();

  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const aRef = db.doc(`dpAccounts/${userId}`);
    const [uSnap, aSnap] = await Promise.all([tx.get(uRef), tx.get(aRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    const user = uSnap.data();
    if (user.pinHash && pinHash !== user.pinHash) throw new HttpsError('permission-denied', 'PIN 불일치.');

    const acc = aSnap.exists ? aSnap.data() : { dp: 0, weekKey: wk, weekCount: 0, totalBought: 0 };
    const weekCount = acc.weekKey === wk ? (acc.weekCount || 0) : 0;       // 주 바뀌면 리셋
    if (cfg.perWeekCap && weekCount + q > cfg.perWeekCap) throw new HttpsError('failed-precondition', `주간 한도 초과(${cfg.perWeekCap}).`);
    if (cfg.perCourseCap && (acc.totalBought || 0) + q > cfg.perCourseCap) throw new HttpsError('failed-precondition', '과정 한도 초과.');

    const cost = rangeCost(weekCount, q, R0, k, exp);
    const balance = user.balance || 0;
    if (cost > balance) throw new HttpsError('failed-precondition', `포인트가 부족합니다(필요 ${cost}).`);

    tx.update(uRef, { balance: balance - cost });
    tx.set(aRef, {
      userId, dp: (acc.dp || 0) + q, weekKey: wk, weekCount: weekCount + q,
      totalBought: (acc.totalBought || 0) + q, updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(boardRef(), { housePool: FieldValue.increment(cost) }, { merge: true }); // 포인트 회수(보존)
    tx.set(db.collection('ledger').doc(), { type: 'dp_convert', userId, qty: q, cost, weekKey: wk, ts: FieldValue.serverTimestamp() });
    return { qty: q, cost, newDp: (acc.dp || 0) + q, newBalance: balance - cost, weekCount: weekCount + q };
  });
});

// 학생: DP → 현물(고정가·재고 차감). 지급은 오프라인 → dpRedemptions pending 큐.
export const redeemGoods = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, goodsId } = req.data || {};
  if (!userId || !goodsId) throw new HttpsError('invalid-argument', 'userId/goodsId 필요.');

  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const aRef = db.doc(`dpAccounts/${userId}`);
    const gRef = db.doc(`dpGoods/${goodsId}`);
    const [uSnap, aSnap, gSnap] = await Promise.all([tx.get(uRef), tx.get(aRef), tx.get(gRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    if (uSnap.data().pinHash && pinHash !== uSnap.data().pinHash) throw new HttpsError('permission-denied', 'PIN 불일치.');
    if (!gSnap.exists) throw new HttpsError('not-found', '상품을 찾을 수 없습니다.');
    const g = gSnap.data();
    if (g.active === false) throw new HttpsError('failed-precondition', '교환 불가 상품입니다.');
    if ((g.stock || 0) <= 0) throw new HttpsError('failed-precondition', '재고가 없습니다.');
    const acc = aSnap.exists ? aSnap.data() : { dp: 0 };
    if ((acc.dp || 0) < g.priceDP) throw new HttpsError('failed-precondition', 'DP가 부족합니다.');

    tx.update(aRef, { dp: (acc.dp || 0) - g.priceDP, updatedAt: FieldValue.serverTimestamp() });
    tx.update(gRef, { stock: g.stock - 1 });
    tx.set(db.collection('dpRedemptions').doc(), {
      userId, name: uSnap.data().name || userId, goodsId, goodsName: g.name, priceDP: g.priceDP,
      status: 'pending', ts: FieldValue.serverTimestamp(),
    });
    tx.set(db.collection('ledger').doc(), { type: 'dp_redeem', userId, goodsId, priceDP: g.priceDP, ts: FieldValue.serverTimestamp() });
    return { goodsId, priceDP: g.priceDP, newDp: (acc.dp || 0) - g.priceDP };
  });
});

// 운영자: 이벤트 DP 지급(개별/일괄). amount<0이면 회수. Hub 관리자 화면이 주 창구.
export const grantDP = onCall(async (req) => {
  assertAdmin(req);
  const { userIds, amount, memo } = req.data || {};
  const amt = Math.floor(Number(amount));
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  if (!ids.length || !amt) throw new HttpsError('invalid-argument', 'userIds/amount 필요.');
  const batch = db.batch();
  for (const id of ids) {
    batch.set(db.doc(`dpAccounts/${id}`), { userId: id, dp: FieldValue.increment(amt), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    batch.set(db.collection('ledger').doc(), { type: 'dp_grant', userId: id, amount: amt, memo: memo || '', ts: FieldValue.serverTimestamp() });
  }
  await batch.commit();
  return { count: ids.length, amount: amt };
});

// 운영자: 상품 상장/수정(고정가·재고)
export const upsertGoods = onCall(async (req) => {
  assertAdmin(req);
  const { id, name, priceDP, stock, active, sort } = req.data || {};
  if (!id) throw new HttpsError('invalid-argument', 'id 필요.');
  const patch = {};
  if (name != null) patch.name = name;
  if (priceDP != null) patch.priceDP = Math.max(1, Math.floor(Number(priceDP)));
  if (stock != null) patch.stock = Math.max(0, Math.floor(Number(stock)));
  if (active != null) patch.active = !!active;
  if (sort != null) patch.sort = Math.floor(Number(sort));
  await db.doc(`dpGoods/${id}`).set(patch, { merge: true });
  return { id };
});

// 운영자: 교환 승인(오프라인 지급 완료 표시). 취소면 DP·재고 복구.
export const fulfillRedemption = onCall(async (req) => {
  assertAdmin(req);
  const { id, status } = req.data || {};
  const st = ['fulfilled', 'cancelled'].includes(status) ? status : 'fulfilled';
  const ref = db.doc(`dpRedemptions/${id}`);
  if (st === 'cancelled') {
    await db.runTransaction(async (tx) => {
      const r = (await tx.get(ref)).data();
      if (!r || r.status !== 'pending') throw new HttpsError('failed-precondition', 'pending 건만 취소 가능.');
      tx.update(db.doc(`dpAccounts/${r.userId}`), { dp: FieldValue.increment(r.priceDP) });
      tx.update(db.doc(`dpGoods/${r.goodsId}`), { stock: FieldValue.increment(1) });
      tx.update(ref, { status: 'cancelled', fulfilledAt: FieldValue.serverTimestamp() });
    });
  } else {
    await ref.update({ status: 'fulfilled', fulfilledAt: FieldValue.serverTimestamp() });
  }
  return { id, status: st };
});

// 운영자: DP 파라미터 조정(곡선·캡·on/off) — meta/dpExchange, 재배포 불필요.
export const setDpParams = onCall(async (req) => {
  assertAdmin(req);
  const allow = ['R0', 'k', 'exp', 'sellEnabled', 'perWeekCap', 'perCourseCap', 'redeemEnabled', 'convertEnabled'];
  const patch = {};
  for (const key of allow) if (req.data?.[key] != null) patch[key] = req.data[key];
  await db.doc('meta/dpExchange').set(patch, { merge: true });
  return patch;
});

// ═════════════════════════════════════════════════════════════
// 운영자 P 지급/조정 — Hub 통합 창구 (PLAN-GRANT-CONSOLIDATION.md 1단계)
//
//   HK_Betting 관리자 화면의 클라이언트 직접 쓰기(updateDoc increment — 원장 없음,
//   housePool 상계 없음)를 대체하는 서버 권위 경로. 지급분은 housePool 에서 나가고
//   회수분은 housePool 로 돌아온다(총량보존 집합 안의 이동 — 발행이 아니다).
//   순발행이 필요하면 mintToHouse 로 하우스를 먼저 채우고 지급하라.
// ═════════════════════════════════════════════════════════════
export const grantPoints = onCall(async (req) => {
  assertAdmin(req);
  const { userIds, all, delta, memo } = req.data || {};
  const d = Math.floor(Number(delta));
  if (!Number.isInteger(d) || d === 0) throw new HttpsError('invalid-argument', 'delta(0 제외 정수) 필요.');

  let ids;
  if (all === true) {
    ids = (await db.collection('users').get()).docs.map((x) => x.id);
  } else {
    ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
    if (!ids.length) throw new HttpsError('invalid-argument', 'userIds 또는 all:true 필요.');
    const snaps = await db.getAll(...ids.map((id) => db.doc(`users/${id}`)));
    const missing = snaps.filter((s) => !s.exists).map((s) => s.id);
    if (missing.length) throw new HttpsError('not-found', `없는 계정: ${missing.join(', ')}`);
  }

  // 배치마다 housePool 상계를 같은 배치에 넣는다 — 뒤 배치가 실패해도 적용된 만큼만 상계돼
  // 총량보존이 깨지지 않는다. (200명 × [balance, ledger] + housePool = 401 ops < 500 한도)
  const CHUNK = 200;
  let applied = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const batch = db.batch();
    for (const id of part) {
      batch.update(db.doc(`users/${id}`), { balance: FieldValue.increment(d) });
      batch.set(db.collection('ledger').doc(), {
        type: 'admin_grant', userId: id, amount: d, memo: memo || '', all: all === true,
        ts: FieldValue.serverTimestamp(),
      });
    }
    batch.set(boardRef(), { housePool: FieldValue.increment(-d * part.length) }, { merge: true });
    await batch.commit();
    applied += part.length;
  }
  return { count: applied, delta: d };
});

// ═════════════════════════════════════════════════════════════
// 홀덤 리그 — 바이인 에스크로 · 정산
//
//   게임 상태(좌석·핸드·베팅)는 RTDB(같은 프로젝트), 지갑은 여기 Firestore.
//   포인트가 움직이는 지점은 전부 이 함수들뿐이다(불변식 1).
//
//   총량보존(불변식 7): 바이인은 지갑 → holdemGames/{gid}.escrow 로 이동하고,
//   정산은 escrow 를 '전액' 참가자에게 되돌린다. 배분 산술은 holdem.js.
//   Σescrow 가 보존식에 들어가므로 진행 중에도 총량이 맞는다.
//
//   ⚠️ 신뢰 경계: 게임 상태는 클라이언트가 쓴다. 그래서 정산 함수는
//   (a) 돈 파라미터(buyIn·payouts)를 개설 시점 Firestore 값으로만 쓰고,
//   (b) 바이인을 실제로 낸 uid 에게만 지급하며,
//   (c) 지급 합계를 escrow 로 강제한다.
//   → 참가자끼리 순위를 조작할 여지는 남지만 포인트를 '만들' 수는 없다.
// ═════════════════════════════════════════════════════════════

const holdemRef = (gid) => db.doc(`holdemGames/${gid}`);

const HOLDEM_KINDS = ['private', 'tournament', 'league'];
function assertHoldemKind(kind) {
  if (!HOLDEM_KINDS.includes(kind)) {
    throw new HttpsError('invalid-argument', `kind 는 ${HOLDEM_KINDS.join(' / ')} 중 하나여야 합니다.`);
  }
}

// ── 개설: 에스크로 그릇을 만든다(포인트 이동 없음) ────────────
export const holdemCreate = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, kind, rtdbPath, name, buyIn, payouts, groupWeights, maxEntries } = req.data || {};
  assertHoldemKind(kind);
  if (!userId) throw new HttpsError('invalid-argument', 'userId가 필요합니다.');
  if (!rtdbPath || !/^holdem\/(rooms|tournaments|leagues)\/[A-Za-z0-9_-]+$/.test(String(rtdbPath))) {
    throw new HttpsError('invalid-argument', 'rtdbPath 형식이 올바르지 않습니다.');
  }
  const bi = Math.floor(Number(buyIn));
  if (!Number.isInteger(bi) || bi < 0) throw new HttpsError('invalid-argument', '바이인은 0 이상 정수여야 합니다.');

  // 참가 횟수 상한. ★비용과 완전히 분리된 값이다★ — 무료 대회(바이인 0P)는
  // 잔액이 제동을 걸어 주지 않으므로, 이 값이 없으면 무한 리엔트리가 된다.
  //   null = 무제한 · 0 = 참가 불가 · n = n회까지
  // '0 = 무제한' 같은 센티넬을 쓰면 "리바인 금지"를 표현할 방법이 사라진다.
  let cap = null;
  if (maxEntries !== null && maxEntries !== undefined) {
    cap = Math.floor(Number(maxEntries));
    if (!Number.isInteger(cap) || cap < 0) {
      throw new HttpsError('invalid-argument', '참가 횟수 상한은 0 이상 정수이거나 null(무제한)이어야 합니다.');
    }
  }

  let pct = [];
  if (kind === 'tournament' || kind === 'league') {
    pct = (Array.isArray(payouts) ? payouts : []).map((n) => Math.floor(Number(n) || 0));
    if (!pct.length) throw new HttpsError('invalid-argument', '상금 배분표가 필요합니다.');
    if (pct.some((n) => n < 0)) throw new HttpsError('invalid-argument', '배분율은 음수일 수 없습니다.');
    if (pct.reduce((s, n) => s + n, 0) !== 100) {
      throw new HttpsError('invalid-argument', '상금 배분표 합계가 100이어야 합니다.');
    }
  }
  // 리그는 그룹 '간' 비중도 개설 시점에 못 박는다 — 게임 상태(RTDB)에 두면
  // 최종 그룹이 정해진 뒤 비중을 바꿔 자기 그룹 몫을 키울 수 있다.
  let gw = [];
  if (kind === 'league') {
    gw = (Array.isArray(groupWeights) ? groupWeights : []).map((n) => Math.floor(Number(n) || 0));
    if (gw.some((n) => n < 0)) throw new HttpsError('invalid-argument', '그룹 비중은 음수일 수 없습니다.');
  }

  // 개설자는 둘 중 하나다.
  //   · 수강생 — `users/{id}` + PIN 으로 본인 확인 (사설 방)
  //   · 운영자 — Google 로그인. ★`users/` 문서가 없다★ (공식 대회·리그)
  // 운영자에게 참가자 계정을 요구하면 공식 대회를 아무도 못 연다.
  let hostName;
  if (isAdminReq(req)) {
    hostName = String(req.auth?.token?.email || '운영자');
  } else {
    const uSnap = await db.doc(`users/${userId}`).get();
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(uSnap.data(), pinHash);
    hostName = uSnap.data().name || userId;
  }

  const gRef = db.collection('holdemGames').doc();
  await gRef.set({
    kind,
    rtdbPath: String(rtdbPath),
    name: String(name || '').trim() || (kind === 'tournament' ? '토너먼트' : '사설 방'),
    hostId: userId,
    hostName,
    buyIn: bi,
    payouts: pct,
    groupWeights: gw,
    maxEntries: cap,
    escrow: 0,
    entries: {},
    status: 'open',
    createdAt: FieldValue.serverTimestamp(),
  });
  return { gid: gRef.id };
});

// ── 참가: 지갑 → 에스크로 ─────────────────────────────────────
//   리엔트리도 같은 경로. entries[userId] 가 낸 횟수.
export const holdemJoin = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, gid } = req.data || {};
  if (!userId || !gid) throw new HttpsError('invalid-argument', 'userId/gid 누락.');

  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const gRef = holdemRef(gid);
    const [uSnap, gSnap] = await Promise.all([tx.get(uRef), tx.get(gRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    const user = uSnap.data();
    requirePin(user, pinHash);
    if (!gSnap.exists) throw new HttpsError('not-found', '게임을 찾을 수 없습니다.');
    const g = gSnap.data();
    if (g.status !== 'open' && g.status !== 'running') {
      throw new HttpsError('failed-precondition', `참가할 수 있는 상태가 아닙니다(현재: ${g.status}).`);
    }

    // ① 횟수 제동. 비용보다 먼저 본다 — 무료 대회는 잔액이 막아 주지 않는다.
    const cap = g.maxEntries;
    const already = (g.entries || {})[userId] || 0;
    if (cap !== null && cap !== undefined) {
      if (cap === 0) throw new HttpsError('failed-precondition', '참가가 허용되지 않는 게임입니다.');
      if (already >= cap) {
        throw new HttpsError('failed-precondition', `참가 횟수를 모두 썼습니다. (${cap}회 제한)`);
      }
    }

    // ② 잔액 제동. 바이인이 있을 때만 걸린다.
    const bi = g.buyIn || 0;
    const balance = user.balance || 0;
    if (bi > 0 && balance < bi) {
      throw new HttpsError('failed-precondition', `포인트가 부족합니다. (보유 ${balance}P, 필요 ${bi}P)`);
    }

    if (bi > 0) {
      tx.update(uRef, { balance: FieldValue.increment(-bi) });
      tx.update(gRef, {
        escrow: FieldValue.increment(bi),
        [`entries.${userId}`]: FieldValue.increment(1),
      });
      tx.set(db.collection('ledger').doc(), {
        type: 'holdem_buyin', holdemGameId: gid, userId, delta: -bi, ts: FieldValue.serverTimestamp(),
      });
    } else {
      // 무료 방도 참가 명단에는 올려야 정산 대상 필터가 동작한다.
      tx.update(gRef, { [`entries.${userId}`]: FieldValue.increment(1) });
    }
    return { gid, buyIn: bi, newBalance: balance - bi };
  });
});

// ── 참가 취소: 첫 핸드 전이면 낸 만큼 전액 환불 ────────────────
export const holdemRefund = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, gid } = req.data || {};
  if (!userId || !gid) throw new HttpsError('invalid-argument', 'userId/gid 누락.');

  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const gRef = holdemRef(gid);
    const [uSnap, gSnap] = await Promise.all([tx.get(uRef), tx.get(gRef)]);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
    requirePin(uSnap.data(), pinHash);
    if (!gSnap.exists) throw new HttpsError('not-found', '게임을 찾을 수 없습니다.');
    const g = gSnap.data();
    if (g.status !== 'open') {
      throw new HttpsError('failed-precondition', '이미 시작된 게임은 개별 환불할 수 없습니다.');
    }
    const count = (g.entries || {})[userId] || 0;
    if (count <= 0) throw new HttpsError('failed-precondition', '참가 기록이 없습니다.');

    const refund = (g.buyIn || 0) * count;
    if (refund > 0) {
      tx.update(uRef, { balance: FieldValue.increment(refund) });
      tx.set(db.collection('ledger').doc(), {
        type: 'holdem_refund', holdemGameId: gid, userId, delta: refund, ts: FieldValue.serverTimestamp(),
      });
    }
    tx.update(gRef, {
      escrow: FieldValue.increment(-refund),
      [`entries.${userId}`]: FieldValue.delete(),
    });
    return { gid, refund };
  });
});

// ── 운영자: 상금풀 충전 (하우스풀 → 에스크로) ─────────────────
//   무료 대회(바이인 0P)는 참가비가 안 모이니 상금 재원이 따로 필요하다.
//   하우스풀에서 옮기므로 Σbalance + housePool + Σescrow 는 그대로다.
export const holdemFund = onCall(async (req) => {
  assertAdmin(req);
  const { gid, amount, memo } = req.data || {};
  const amt = Math.floor(Number(amount));
  if (!gid) throw new HttpsError('invalid-argument', 'gid 누락.');
  if (!Number.isInteger(amt) || amt === 0) {
    throw new HttpsError('invalid-argument', '충전 포인트는 0이 아닌 정수여야 합니다.');
  }

  return db.runTransaction(async (tx) => {
    const gRef = holdemRef(gid);
    const [gSnap, bSnap] = await Promise.all([tx.get(gRef), tx.get(boardRef())]);
    if (!gSnap.exists) throw new HttpsError('not-found', '게임을 찾을 수 없습니다.');
    const g = gSnap.data();
    if (g.status === 'settled' || g.status === 'canceled') {
      throw new HttpsError('failed-precondition', '이미 끝난 게임에는 충전할 수 없습니다.');
    }
    const pool = (bSnap.data() || {}).housePool || 0;
    if (amt > 0 && pool < amt) {
      throw new HttpsError('failed-precondition', `하우스풀이 부족합니다. (보유 ${pool}P, 필요 ${amt}P)`);
    }
    // 회수(음수)는 이미 들어온 에스크로보다 많이 빼낼 수 없다.
    if (amt < 0 && (g.escrow || 0) + amt < 0) {
      throw new HttpsError('failed-precondition', `에스크로가 부족합니다. (보유 ${g.escrow || 0}P)`);
    }

    tx.set(boardRef(), { housePool: FieldValue.increment(-amt) }, { merge: true });
    tx.update(gRef, { escrow: FieldValue.increment(amt) });
    tx.set(db.collection('ledger').doc(), {
      type: 'holdem_fund', holdemGameId: gid, houseDelta: -amt,
      memo: String(memo || ''), ts: FieldValue.serverTimestamp(),
    });
    return { gid, funded: amt, escrow: (g.escrow || 0) + amt };
  });
});

// ── 정산: RTDB 최종 상태를 함수가 직접 읽어 에스크로를 배분 ─────
//   멱등 — 이미 settled 면 아무 일도 하지 않는다(어느 클라이언트가 호출해도 안전).
export const holdemSettle = onCall(async (req) => {
  assertAuth(req);
  const { gid } = req.data || {};
  if (!gid) throw new HttpsError('invalid-argument', 'gid 누락.');

  const gSnap = await holdemRef(gid).get();
  if (!gSnap.exists) throw new HttpsError('not-found', '게임을 찾을 수 없습니다.');
  const g = gSnap.data();
  if (g.status === 'settled') return { gid, alreadySettled: true, settlement: g.settlement || [] };
  if (g.status === 'canceled') throw new HttpsError('failed-precondition', '취소된 게임입니다.');

  // 게임 상태는 트랜잭션 밖에서 읽는다(RTDB 는 Firestore 트랜잭션에 못 들어감).
  // 아래 트랜잭션이 status 를 다시 검사하므로 두 번 정산되지는 않는다.
  const node = await getDatabase().ref(g.rtdbPath).get();
  if (!node.exists()) throw new HttpsError('not-found', '게임 상태를 찾을 수 없습니다.');
  const state = node.val();
  const paidIds = Object.keys(g.entries || {});

  let rows;
  if (g.kind === 'private') {
    rows = privatePayouts(seatsFromRoom(state, paidIds), g.escrow || 0);
  } else if (g.kind === 'league') {
    if (state.phase !== 'finished') {
      throw new HttpsError('failed-precondition', '아직 끝나지 않은 리그입니다.');
    }
    if (!Array.isArray(state.groups) || state.groups.length === 0) {
      throw new HttpsError('failed-precondition', '최종 그룹이 정해지지 않았습니다.');
    }
    rows = leaguePayouts(
      state.groups, state.finalResults || [], state.entrants || {},
      paidIds, g.escrow || 0, g.groupWeights || [], g.payouts || [],
    );
  } else {
    if (state.status !== 'finished') {
      throw new HttpsError('failed-precondition', '아직 끝나지 않은 토너먼트입니다.');
    }
    rows = tournamentPayouts(standingsFromTournament(state, paidIds), g.escrow || 0, g.payouts || []);
  }

  const total = rows.reduce((s, r) => s + r.payout, 0);
  if (total !== (g.escrow || 0)) {
    // 여기서 걸리면 배분 산술이 깨진 것 — 지급하지 않고 멈춘다. 포인트가 새는 것보다 낫다.
    throw new HttpsError('internal', `배분 합계(${total})가 에스크로(${g.escrow || 0})와 다릅니다.`);
  }

  await db.runTransaction(async (tx) => {
    const cur = await tx.get(holdemRef(gid));
    if (cur.data().status === 'settled') return;      // 경합에서 진 호출 — 무해하게 종료
    for (const r of rows) {
      if (r.payout <= 0) continue;
      tx.update(db.doc(`users/${r.userId}`), { balance: FieldValue.increment(r.payout) });
      tx.set(db.collection('ledger').doc(), {
        type: 'holdem_payout', holdemGameId: gid, userId: r.userId, delta: r.payout, ts: FieldValue.serverTimestamp(),
      });
    }
    tx.update(holdemRef(gid), {
      status: 'settled',
      escrow: 0,
      settlement: rows,
      settledAt: FieldValue.serverTimestamp(),
    });
  });
  return { gid, settlement: rows };
});

// ── 운영자: 정산 되돌리기 ─────────────────────────────────────
//   지급분을 회수해 에스크로로 되돌린다. 잔액이 모자라면 있는 만큼만 회수하고
//   부족분은 housePool 이 메운다 — 총량은 어떤 경우에도 보존된다.
export const holdemRevert = onCall(async (req) => {
  assertAdmin(req);
  const { gid, memo } = req.data || {};
  if (!gid) throw new HttpsError('invalid-argument', 'gid 누락.');

  return db.runTransaction(async (tx) => {
    const gRef = holdemRef(gid);
    const gSnap = await tx.get(gRef);
    if (!gSnap.exists) throw new HttpsError('not-found', '게임을 찾을 수 없습니다.');
    const g = gSnap.data();
    if (g.status !== 'settled') throw new HttpsError('failed-precondition', '정산된 게임만 되돌릴 수 있습니다.');
    const rows = (g.settlement || []).filter((r) => r.payout > 0);

    const snaps = await Promise.all(rows.map((r) => tx.get(db.doc(`users/${r.userId}`))));
    let shortfall = 0;
    let recovered = 0;
    rows.forEach((r, i) => {
      const s = snaps[i];
      const bal = s.exists ? (s.data().balance || 0) : 0;
      const take = Math.min(bal, r.payout);
      shortfall += r.payout - take;
      recovered += take;
      if (take > 0) {
        tx.update(db.doc(`users/${r.userId}`), { balance: FieldValue.increment(-take) });
        tx.set(db.collection('ledger').doc(), {
          type: 'holdem_revert', holdemGameId: gid, userId: r.userId, delta: -take,
          memo: String(memo || ''), ts: FieldValue.serverTimestamp(),
        });
      }
    });
    // 다 못 걷은 만큼은 하우스풀이 부담 → Σbalance + housePool + Σescrow 불변.
    // houseDelta 를 원장에 남겨야 audit_house 가 이 드레인을 잔차가 아니라
    // 이름 있는 항목으로 집계한다(안 그러면 원인 불명 적자로 보인다).
    if (shortfall > 0) {
      tx.set(boardRef(), { housePool: FieldValue.increment(-shortfall) }, { merge: true });
      tx.set(db.collection('ledger').doc(), {
        type: 'holdem_shortfall', holdemGameId: gid, houseDelta: -shortfall,
        memo: String(memo || ''), ts: FieldValue.serverTimestamp(),
      });
    }

    tx.update(gRef, {
      status: 'running',
      escrow: recovered + shortfall,
      settlement: FieldValue.delete(),
      settledAt: FieldValue.delete(),
      revertedAt: FieldValue.serverTimestamp(),
    });
    return { gid, reverted: rows.length, shortfall };
  });
});

// ── 운영자: 게임 취소 → 낸 사람에게 전액 환불 ──────────────────
export const holdemCancel = onCall(async (req) => {
  assertAdmin(req);
  const { gid } = req.data || {};
  if (!gid) throw new HttpsError('invalid-argument', 'gid 누락.');

  return db.runTransaction(async (tx) => {
    const gRef = holdemRef(gid);
    const gSnap = await tx.get(gRef);
    if (!gSnap.exists) throw new HttpsError('not-found', '게임을 찾을 수 없습니다.');
    const g = gSnap.data();
    if (g.status === 'settled') throw new HttpsError('failed-precondition', '이미 정산된 게임입니다.');
    if (g.status === 'canceled') return { gid, alreadyCanceled: true };

    const bi = g.buyIn || 0;
    let refunded = 0;
    for (const [userId, count] of Object.entries(g.entries || {})) {
      const amount = bi * (count || 0);
      if (amount <= 0) continue;
      refunded += amount;
      tx.update(db.doc(`users/${userId}`), { balance: FieldValue.increment(amount) });
      tx.set(db.collection('ledger').doc(), {
        type: 'holdem_refund', holdemGameId: gid, userId, delta: amount, ts: FieldValue.serverTimestamp(),
      });
    }
    tx.update(gRef, { status: 'canceled', escrow: 0, canceledAt: FieldValue.serverTimestamp() });
    return { gid, refunded };
  });
});
