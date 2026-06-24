// ─────────────────────────────────────────────────────────────
// 주식판 권위(authoritative) Cloud Functions.
//   모든 포인트·시세·보유 변동은 여기서만 일어난다(Admin SDK → 규칙 우회).
//   클라이언트는 읽기만 가능하고, 거래/배당/시세조정은 전부 이 함수를 호출.
//   → 베팅판의 "포인트는 검증된 경로로만 증가" 불변식을 그대로 유지.
//
//   배포: 베팅판과 '같은' Firebase 프로젝트에 deploy.
//     firebase deploy --only functions,firestore:rules
// ─────────────────────────────────────────────────────────────
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { quoteBuy, quoteSell, nextAvgCost, priceAdjustDelta } from './market.js';

// ★ 프론트 VITE_FUNCTIONS_REGION 과 일치시킬 것 (서울 리전) ★
setGlobalOptions({ region: 'asia-northeast3' });

initializeApp();
const db = getFirestore();

// 운영자 이메일 — ★ 프론트 VITE_ADMIN_EMAILS 및 firestore.rules 와 일치시킬 것 ★
const ADMIN_EMAILS = ['jetsomk22@gmail.com'];

const boardRef = () => db.doc('meta/stockBoard');
const holdingId = (userId, stockId) => `${userId}__${stockId}`;

function assertAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
}
function assertAdmin(req) {
  const email = req.auth?.token?.email;
  if (!email || !ADMIN_EMAILS.includes(String(email).toLowerCase())) {
    throw new HttpsError('permission-denied', '운영자만 가능합니다.');
  }
}

// ── 참가자: 매수/매도 (권위 체결) ──────────────────────────
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
    // 경량 신원 확인: pinHash 일치 요구(있을 때).
    if (user.pinHash && pinHash !== user.pinHash) {
      throw new HttpsError('permission-denied', 'PIN이 일치하지 않습니다.');
    }
    if (!sSnap.exists) throw new HttpsError('not-found', '종목을 찾을 수 없습니다.');
    const stock = sSnap.data();
    if (stock.status !== 'open') throw new HttpsError('failed-precondition', '거래가 닫힌 종목입니다.');
    const holding = hSnap.exists ? hSnap.data() : { shares: 0, avgCost: 0 };
    const balance = user.balance || 0;

    let cashDelta; let newShares; let newAvg; let fillPrice; let newPrice;
    if (side === 'buy') {
      const Q = quoteBuy(stock, q);
      if (Q.cost > balance) throw new HttpsError('failed-precondition', '잔액이 부족합니다.');
      cashDelta = -Q.cost;
      newShares = (holding.shares || 0) + q;
      newAvg = nextAvgCost(holding.shares || 0, holding.avgCost || 0, q, Q.price);
      fillPrice = Q.price; newPrice = Q.newPrice;
      tx.update(sRef, {
        price: newPrice,
        reserve: (stock.reserve || 0) + Q.cost,
        sharesOut: (stock.sharesOut || 0) + q,
      });
    } else {
      if ((holding.shares || 0) < q) throw new HttpsError('failed-precondition', '보유 수량이 부족합니다.');
      const Q = quoteSell(stock, q);
      cashDelta = Q.proceeds;
      newShares = (holding.shares || 0) - q;
      newAvg = holding.avgCost || 0; // 매도는 평단 불변
      fillPrice = Q.price; newPrice = Q.newPrice;
      tx.update(sRef, {
        price: newPrice,
        reserve: (stock.reserve || 0) - Q.proceeds,
        sharesOut: (stock.sharesOut || 0) - q,
      });
    }

    tx.update(uRef, { balance: balance + cashDelta });
    tx.set(hRef, {
      userId, stockId, shares: newShares, avgCost: newAvg,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(db.collection('trades').doc(), {
      userId, stockId, side, qty: q, price: fillPrice, cash: cashDelta,
      ts: FieldValue.serverTimestamp(),
    });
    tx.set(db.collection('ledger').doc(), {
      userId, stockId, type: side, delta: cashDelta, qty: q, price: fillPrice,
      ts: FieldValue.serverTimestamp(),
    });
    return { side, qty: q, price: fillPrice, cash: cashDelta, newBalance: balance + cashDelta, newPrice };
  });
});

// ── 운영자: 종목 생성/수정(잔액 비관여) ────────────────────
//   시세(price)는 신규 생성 시에만 설정. 이후 변경은 adjustPrice 로만(총량 보존).
export const upsertStock = onCall(async (req) => {
  assertAdmin(req);
  const { id, name, team, price, liq, status } = req.data || {};
  const sid = String(id || '').trim();
  if (!sid) throw new HttpsError('invalid-argument', 'id가 필요합니다.');
  const ref = db.doc(`stocks/${sid}`);
  const snap = await ref.get();
  if (!snap.exists) {
    const p = Math.floor(Number(price)); const L = Math.floor(Number(liq));
    if (!(p >= 1) || !(L >= 1)) throw new HttpsError('invalid-argument', '신규 종목은 시작가/유동성(1+)이 필요합니다.');
    await ref.set({
      name: name || sid, team: team || '', price: p, liq: L,
      reserve: 0, sharesOut: 0, status: status || 'closed',
      createdAt: FieldValue.serverTimestamp(),
    });
    return { id: sid, created: true };
  }
  const patch = {};
  if (name != null) patch.name = name;
  if (team != null) patch.team = team;
  if (liq != null) patch.liq = Math.max(1, Math.floor(Number(liq)));
  if (status != null) patch.status = status;
  await ref.set(patch, { merge: true });
  return { id: sid, updated: true };
});

// ── 운영자: 배당 (하우스 풀 → 보유자, perShare × 보유주) ────
export const payDividend = onCall(async (req) => {
  assertAdmin(req);
  const { stockId, perShare } = req.data || {};
  const ps = Math.floor(Number(perShare));
  if (!stockId || !(ps > 0)) throw new HttpsError('invalid-argument', 'stockId/perShare(1+) 필요.');

  const hs = await db.collection('holdings').where('stockId', '==', stockId).get();
  const payouts = [];
  let total = 0;
  hs.forEach((d) => {
    const h = d.data();
    if ((h.shares || 0) > 0) { const amt = ps * h.shares; total += amt; payouts.push({ userId: h.userId, amt }); }
  });
  if (payouts.length === 0) throw new HttpsError('failed-precondition', '보유자가 없습니다.');

  await db.runTransaction(async (tx) => {
    const bSnap = await tx.get(boardRef());
    const house = bSnap.exists ? (bSnap.data().housePool || 0) : 0;
    if (total > house) throw new HttpsError('failed-precondition', `하우스 풀 부족(필요 ${total}, 보유 ${house}). 먼저 발행하세요.`);
    const uRefs = payouts.map((p) => db.doc(`users/${p.userId}`));
    const uSnaps = await Promise.all(uRefs.map((r) => tx.get(r)));
    uSnaps.forEach((s, i) => {
      if (s.exists) tx.update(uRefs[i], { balance: (s.data().balance || 0) + payouts[i].amt });
    });
    tx.set(boardRef(), { housePool: house - total }, { merge: true });
    tx.set(db.collection('ledger').doc(), {
      stockId, type: 'dividend', perShare: ps, total, count: payouts.length,
      ts: FieldValue.serverTimestamp(),
    });
  });
  return { stockId, perShare: ps, total, count: payouts.length };
});

// ── 운영자: 펀더멘탈 시세 조정 (하우스 풀 ↔ 리저브, 총량 보존) ─
//   상향=하우스→리저브(인플레), 하향=리저브→하우스(디플레, '소프트 패널티').
export const adjustPrice = onCall(async (req) => {
  assertAdmin(req);
  const { stockId, newPrice, memo } = req.data || {};
  const np = Math.floor(Number(newPrice));
  if (!stockId || !(np >= 1)) throw new HttpsError('invalid-argument', 'stockId/newPrice(1+) 필요.');

  return db.runTransaction(async (tx) => {
    const sRef = db.doc(`stocks/${stockId}`);
    const [sSnap, bSnap] = await Promise.all([tx.get(sRef), tx.get(boardRef())]);
    if (!sSnap.exists) throw new HttpsError('not-found', '종목을 찾을 수 없습니다.');
    const s = sSnap.data();
    const delta = priceAdjustDelta(s.price, np, s.sharesOut || 0);
    const house = bSnap.exists ? (bSnap.data().housePool || 0) : 0;
    if (delta > house) throw new HttpsError('failed-precondition', `상향 보조에 하우스 풀 부족(필요 ${delta}, 보유 ${house}).`);
    tx.update(sRef, { price: np, reserve: (s.reserve || 0) + delta });
    tx.set(boardRef(), { housePool: house - delta }, { merge: true });
    tx.set(db.collection('ledger').doc(), {
      stockId, type: 'price_adjust', oldPrice: s.price, newPrice: np, delta, memo: memo || '',
      ts: FieldValue.serverTimestamp(),
    });
    return { stockId, oldPrice: s.price, newPrice: np, delta };
  });
});

// ── 운영자: 뉴스 피드(재미 요소). 시세 효과가 필요하면 adjustPrice 별도 호출 ─
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

// ── 운영자: 하우스 풀 발행/소각 (유일한 총량 변동 경로) ─────
export const mintToHouse = onCall(async (req) => {
  assertAdmin(req);
  const { amount, memo } = req.data || {};
  const amt = Math.floor(Number(amount));
  if (Number.isNaN(amt) || amt === 0) throw new HttpsError('invalid-argument', 'amount(0 아님)가 필요합니다.');
  await db.runTransaction(async (tx) => {
    const bSnap = await tx.get(boardRef());
    const house = bSnap.exists ? (bSnap.data().housePool || 0) : 0;
    if (house + amt < 0) throw new HttpsError('failed-precondition', '하우스 풀이 음수가 됩니다.');
    tx.set(boardRef(), { housePool: house + amt }, { merge: true });
    tx.set(db.collection('ledger').doc(), {
      type: amt >= 0 ? 'mint' : 'burn', delta: amt, memo: memo || '',
      ts: FieldValue.serverTimestamp(),
    });
  });
  return { ok: true, amount: amt };
});
