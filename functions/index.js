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
import { quoteBuy, quoteSell, nextAvgCost, priceAdjustDelta } from './market.js';
import { generateNews, NEWS_TICK_PROB } from './news.js';
import { applyTick } from './tick.js';

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

    let cashDelta; let newShares; let newAvg; let fillPrice; let Q;
    if (side === 'buy') {
      try { Q = quoteBuy(stock, q); } catch (e) { throw new HttpsError('failed-precondition', e.message); }
      if (Q.cost > balance) throw new HttpsError('failed-precondition', '잔액이 부족합니다.');
      cashDelta = -Q.cost;
      fillPrice = Math.round(Q.cost / q);
      newShares = (holding.shares || 0) + q;
      newAvg = nextAvgCost(holding.shares || 0, holding.avgCost || 0, q, Q.cost / q);
    } else {
      if ((holding.shares || 0) < q) throw new HttpsError('failed-precondition', '보유 수량이 부족합니다.');
      try { Q = quoteSell(stock, q); } catch (e) { throw new HttpsError('failed-precondition', e.message); }
      cashDelta = Q.proceeds;
      fillPrice = Math.round(Q.proceeds / q);
      newShares = (holding.shares || 0) - q;
      newAvg = holding.avgCost || 0;
    }

    tx.update(sRef, {
      circulating: Q.newCirculating,
      reserve: stock.reserve + (side === 'buy' ? Q.cost : -Q.proceeds),
      price: Q.newPrice,
      priceHistory: appendHist(stock.priceHistory, Q.newPrice),
    });
    tx.update(uRef, { balance: balance + cashDelta });
    tx.set(hRef, { userId, stockId, shares: newShares, avgCost: newAvg, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(db.collection('trades').doc(), { userId, stockId, side, qty: q, price: fillPrice, cash: cashDelta, ts: FieldValue.serverTimestamp() });
    tx.set(db.collection('ledger').doc(), { userId, stockId, type: side, delta: cashDelta, qty: q, price: fillPrice, ts: FieldValue.serverTimestamp() });
    return { side, qty: q, price: fillPrice, cash: cashDelta, newBalance: balance + cashDelta, newPrice: Q.newPrice };
  });
});

// ── 운영자: 종목 상장/수정 ──────────────────────────────────
//   상장: 발행주식수(고정)·시작가(base)·변동성(slope) 지정. 시세는 이후 adjustPrice 로만.
export const upsertStock = onCall(async (req) => {
  assertAdmin(req);
  const { id, name, team, base, slope, totalShares, status, sector, traits } = req.data || {};
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
      base: b, centerBase: b, slope: sl, totalShares: tot, circulating: 0, reserve: 0,
      price: b, prevClose: b, dayOpen: b,
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

  return db.runTransaction(async (tx) => {
    const sRef = db.doc(`stocks/${stockId}`);
    const [sSnap, bSnap] = await Promise.all([tx.get(sRef), tx.get(boardRef())]);
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

    const house = bSnap.exists ? (bSnap.data().housePool || 0) : 0;
    const newHouse = house + (reserve - totalPayout);
    if (newHouse < 0) throw new HttpsError('failed-precondition', `상폐 정산에 하우스 풀 부족(부족분 ${-newHouse}). 먼저 발행하거나 정산가를 낮추세요.`);
    tx.set(boardRef(), { housePool: newHouse }, { merge: true });

    allHoldingRefs.forEach((r) => tx.delete(r));
    tx.delete(sRef);
    tx.delete(db.doc(`stockTraits/${stockId}`));
    tx.set(db.collection('ledger').doc(), { stockId, type: 'delist', settlePrice: price, totalPayout, reserveReturned: reserve - totalPayout, count: holders.length, ts: FieldValue.serverTimestamp() });
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
