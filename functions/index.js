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

    const isMember = Array.isArray(stock.members) && stock.members.includes(userId);
    const locked = holding.locked || 0;

    let cashDelta; let newShares; let newAvg; let fillPrice; let Q;
    if (side === 'buy') {
      if (isMember) throw new HttpsError('failed-precondition', '자사주는 매수할 수 없습니다(스톡옵션으로만 보유).');
      try { Q = quoteBuy(stock, q); } catch (e) { throw new HttpsError('failed-precondition', e.message); }
      if (Q.cost > balance) throw new HttpsError('failed-precondition', '잔액이 부족합니다.');
      cashDelta = -Q.cost;
      fillPrice = Math.round(Q.cost / q);
      newShares = (holding.shares || 0) + q;
      newAvg = nextAvgCost(holding.shares || 0, holding.avgCost || 0, q, Q.cost / q);
    } else {
      // 스톡옵션(locked)은 매도 불가 → 매도 가능 수량 = 보유 − 잠금.
      if ((holding.shares || 0) - locked < q) throw new HttpsError('failed-precondition', '매도 가능 수량이 부족합니다(스톡옵션 제외).');
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
  const { id, name, team, base, slope, totalShares, status, sector, traits, members } = req.data || {};
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
//   ★콜러블(postImpactNews)과 예약 발행(publishScheduledNews)이 공용 — 동작 동일.★
//   text/scope/pct 는 호출 측에서 이미 검증된 값이어야 한다.
async function applyImpactNews({ text, scope, target, pct }) {
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
    tx.set(boardRef(), { news: [entry, ...news].slice(0, 50) }, { merge: true });
  });
  await db.collection('ledger').add({ type: 'impact_news', scope: sc, target: target || null, pct: p, count: stockIds.length, ts: FieldValue.serverTimestamp() });
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

// ── 운영자: 뉴스 예약 — 지정 시각(publishAt, epoch ms)에 자동 발행 ─
//   scope/pct 의미는 postImpactNews 와 동일(pct=0 이면 헤드라인만).
export const scheduleNews = onCall(async (req) => {
  assertAdmin(req);
  const { text, scope, target, pct, publishAt } = req.data || {};
  if (!text || !String(text).trim()) throw new HttpsError('invalid-argument', '내용이 필요합니다.');
  const sc = ['all', 'stock', 'sector', 'trait'].includes(scope) ? scope : 'all';
  const p = Number(pct) || 0;
  if (p <= -100) throw new HttpsError('invalid-argument', 'pct는 -100 초과.');
  if (sc !== 'all' && !String(target || '').trim()) throw new HttpsError('invalid-argument', '대상을 선택하세요.');
  const when = Math.floor(Number(publishAt));
  if (!Number.isFinite(when) || when <= 0) throw new HttpsError('invalid-argument', '게시 시각(publishAt)이 필요합니다.');
  const ref = await db.collection('scheduledNews').add({
    text: String(text).trim(), scope: sc, target: target || null, pct: p,
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
      const r = await applyImpactNews({ text: n.text, scope: n.scope, target: n.target, pct: n.pct });
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
