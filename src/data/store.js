// Firestore 데이터 계층 (주식판).
//   읽기: stocks / holdings / users / meta/stockBoard 를 실시간 구독.
//     23명 × 7종목이면 전체 구독해도 문서 수백 개 수준이라 충분히 가볍다.
//   쓰기(거래·펀더멘탈): 전부 Cloud Functions(callable) 경유 — store 에선 래퍼만 제공.
//   계정 생성/조회: users 는 베팅판과 공유. (가입 규칙은 firestore.rules 가 강제)

import {
  doc, collection, getDoc, getDocs, setDoc, onSnapshot, query, where, orderBy, limit,
} from 'firebase/firestore';
import { getFirebase, callable } from './firebase.js';

const userRef = (id) => doc(getFirebase().db, 'users', id);
const stockBoardRef = () => doc(getFirebase().db, 'meta', 'stockBoard');

// ── 구독 ────────────────────────────────────────────────
export function subscribeStocks(cb) {
  return onSnapshot(collection(getFirebase().db, 'stocks'), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
  );
}
export function subscribeHoldings(cb) {
  return onSnapshot(collection(getFirebase().db, 'holdings'), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
  );
}
export function subscribeUsers(cb) {
  return onSnapshot(collection(getFirebase().db, 'users'), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
  );
}
export function subscribeStockBoard(cb) {
  return onSnapshot(stockBoardRef(), (snap) => cb(snap.exists() ? snap.data() : null));
}
// 분봉(intraday) 실시간 구독 — 선택된 종목 하나만(대역폭 절약).
export function subscribeSeries(stockId, cb) {
  return onSnapshot(
    doc(getFirebase().db, 'stocks', stockId, 'series', 'intraday'),
    (snap) => cb(snap.exists() ? (snap.data().points || []) : []),
    () => cb([]),
  );
}
// 일봉(candles) 조회 — 1주/전체 차트용. 날짜 오름차순.
export async function getCandles(stockId, limitN = 90) {
  const q = query(collection(getFirebase().db, 'stocks', stockId, 'candles'), orderBy('date', 'desc'), limit(limitN));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data()).reverse();
}

// 종목 특성(비공개) — 운영자만 읽기 가능(규칙). 비운영자가 호출하면 권한 오류 → 호출 측에서 admin 일 때만.
export function subscribeStockTraits(cb) {
  return onSnapshot(
    collection(getFirebase().db, 'stockTraits'),
    (snap) => cb(Object.fromEntries(snap.docs.map((d) => [d.id, d.data().traits || []]))),
    () => cb({}),
  );
}

// ── 계정 (베팅판과 공유) ────────────────────────────────
export async function getUser(userId) {
  const snap = await getDoc(userRef(userId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
export async function getUserByName(name) {
  const { db } = getFirebase();
  const q = query(collection(db, 'users'), where('name', '==', String(name).trim()));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}
// 자체 가입: 시작 balance 0 (포인트는 운영자/배당으로만 증가). 규칙도 강제.
export async function createUser({ userId, name, pinHash, balance = 0 }) {
  await setDoc(userRef(userId), { name, pinHash, balance: Math.floor(balance) });
}

// ── 거래/펀더멘탈 호출 (Cloud Functions) ────────────────
export async function trade({ userId, pinHash, stockId, side, qty }) {
  const res = await callable('trade')({ userId, pinHash, stockId, side, qty });
  return res.data;
}
export async function upsertStock(payload) {
  return (await callable('upsertStock')(payload)).data;
}
export async function payDividend(stockId, perShare) {
  return (await callable('payDividend')({ stockId, perShare })).data;
}
export async function adjustPrice(stockId, newPrice, memo) {
  return (await callable('adjustPrice')({ stockId, newPrice, memo })).data;
}
export async function postNews(text, stockId) {
  return (await callable('postNews')({ text, stockId: stockId || null })).data;
}
export async function mintToHouse(amount, memo) {
  return (await callable('mintToHouse')({ amount, memo })).data;
}
export async function delistStock(stockId, settlePrice) {
  return (await callable('delistStock')({ stockId, settlePrice })).data;
}
export async function setAutoNews(enabled) {
  return (await callable('setAutoNews')({ enabled })).data;
}
export async function triggerNews() {
  return (await callable('triggerNews')({})).data;
}
export async function grantOption(stockId, userId, qty) {
  return (await callable('grantOption')({ stockId, userId, qty })).data;
}
export async function marketReprice(pct) {
  return (await callable('marketReprice')({ pct })).data;
}
export async function postImpactNews({ text, scope, target, pct }) {
  return (await callable('postImpactNews')({ text, scope, target, pct })).data;
}
