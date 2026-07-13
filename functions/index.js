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
import { quoteBuy, quoteSell, nextAvgCost, priceAdjustDelta, sellFee } from './market.js';
import { generateNews, NEWS_TICK_PROB } from './news.js';
import { applyTick } from './tick.js';
import { findEventPreset, renderEventHeadline } from './events.js';

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

    let cashDelta; let newShares; let newAvg; let fillPrice; let Q; let fee = 0;
    if (side === 'buy') {
      if (isMember) throw new HttpsError('failed-precondition', '자사주는 매수할 수 없습니다(스톡옵션으로만 보유).');
      try { Q = quoteBuy(stock, q); } catch (e) { throw new HttpsError('failed-precondition', e.message); }
      if (Q.cost > balance) throw new HttpsError('failed-precondition', '잔액이 부족합니다.');
      cashDelta = -Q.cost; // 매수는 무료(진입 장려)
      fillPrice = Math.round(Q.cost / q);
      newShares = (holding.shares || 0) + q;
      newAvg = nextAvgCost(holding.shares || 0, holding.avgCost || 0, q, Q.cost / q);
    } else {
      // 스톡옵션(locked)은 매도 불가 → 매도 가능 수량 = 보유 − 잠금.
      if ((holding.shares || 0) - locked < q) throw new HttpsError('failed-precondition', '매도 가능 수량이 부족합니다(스톡옵션 제외).');
      try { Q = quoteSell(stock, q); } catch (e) { throw new HttpsError('failed-precondition', e.message); }
      // 매도 수수료(결정적) — 곡선수령(proceeds)은 그대로 reserve 에서 빠지고, 수수료만 housePool 로 귀속.
      fee = sellFee(Q.proceeds);
      cashDelta = Q.proceeds - fee; // 지갑엔 수수료 뺀 순수령
      fillPrice = Math.round(Q.proceeds / q);
      newShares = (holding.shares || 0) - q;
      newAvg = holding.avgCost || 0;
    }

    tx.update(sRef, {
      circulating: Q.newCirculating,
      reserve: stock.reserve + (side === 'buy' ? Q.cost : -Q.proceeds), // reserve 는 곡선적분 그대로(정합 유지)
      price: Q.newPrice,
      priceHistory: appendHist(stock.priceHistory, Q.newPrice),
    });
    tx.update(uRef, { balance: balance + cashDelta });
    tx.set(hRef, { userId, stockId, shares: newShares, avgCost: newAvg, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
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

    const delta = reserve - totalPayout; // 리저브 회수 − 정산 지급. 하우스 풀로 증감(총량 보존, 음수 허용).
    tx.set(boardRef(), { housePool: FieldValue.increment(delta) }, { merge: true });

    allHoldingRefs.forEach((r) => tx.delete(r));
    tx.delete(seriesRef);
    candleRefs.forEach((r) => tx.delete(r));
    tx.delete(sRef);
    tx.delete(db.doc(`stockTraits/${stockId}`));
    tx.set(db.collection('ledger').doc(), { stockId, type: 'delist', settlePrice: price, totalPayout, reserveReturned: delta, count: holders.length, ts: FieldValue.serverTimestamp() });
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
export const postGig = onCall(async (req) => {
  assertAuth(req);
  const { userId, pinHash, title, desc, deadline, reward } = req.data || {};
  const r = Math.floor(Number(reward));
  if (!userId) throw new HttpsError('invalid-argument', 'userId가 필요합니다.');
  if (!title || !String(title).trim()) throw new HttpsError('invalid-argument', '제목이 필요합니다.');
  if (!Number.isInteger(r) || r <= 0) throw new HttpsError('invalid-argument', '보상은 1 이상 정수여야 합니다.');

  return db.runTransaction(async (tx) => {
    const uRef = db.doc(`users/${userId}`);
    const uSnap = await tx.get(uRef);
    if (!uSnap.exists) throw new HttpsError('not-found', '계정을 찾을 수 없습니다.');
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
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(db.collection('ledger').doc(), { type: 'gig_post', gigId: gRef.id, userId, delta: -r, ts: FieldValue.serverTimestamp() });
    return { id: gRef.id, reward: r, newBalance: balance - r };
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
