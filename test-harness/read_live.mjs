// 라이브 잔액/보유 분포 읽기 — 공개 read 규칙(users/holdings/stocks/meta)만 사용. 키 불필요.
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, getDoc } from 'firebase/firestore';

const app = initializeApp({
  apiKey: 'AIzaSyDdYMFtR4jKdC6svQjEzzas-jDh_sO17DE',
  authDomain: 'hk-chess-betting.firebaseapp.com',
  projectId: 'hk-chess-betting',
});
const db = getFirestore(app);

const users = (await getDocs(collection(db, 'users'))).docs.map((d) => ({ id: d.id, ...d.data() }));
const holdings = (await getDocs(collection(db, 'holdings'))).docs.map((d) => d.data());
const stocks = (await getDocs(collection(db, 'stocks'))).docs.map((d) => ({ id: d.id, ...d.data() }));
const board = (await getDoc(doc(db, 'meta', 'stockBoard'))).data() || {};

const priceById = Object.fromEntries(stocks.map((s) => [s.id, s.price || 0]));
const sharesByUser = {};
for (const h of holdings) {
  const v = (h.shares || 0) * (priceById[h.stockId] || 0);
  sharesByUser[h.userId] = (sharesByUser[h.userId] || 0) + v;
}

const rows = users.map((u) => ({
  name: u.name, id: u.id,
  cash: Math.round(u.balance || 0),
  stockVal: Math.round(sharesByUser[u.id] || 0),
  net: Math.round((u.balance || 0) + (sharesByUser[u.id] || 0)),
}));
rows.sort((a, b) => b.net - a.net);

const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
const cashArr = rows.map((r) => r.cash).sort((a, b) => a - b);
const median = cashArr.length % 2 ? cashArr[(cashArr.length - 1) / 2]
  : Math.round((cashArr[cashArr.length / 2 - 1] + cashArr[cashArr.length / 2]) / 2);

console.log('=== 계정 (순자산 내림차순) ===');
console.log('name'.padEnd(10), 'cash'.padStart(10), 'stockVal'.padStart(10), 'net'.padStart(10));
for (const r of rows) {
  console.log(String(r.name).padEnd(10), String(r.cash).padStart(10), String(r.stockVal).padStart(10), String(r.net).padStart(10));
}
console.log('\n=== 집계 ===');
console.log('계정수:', rows.length);
console.log('현금 합계:', sum('cash').toLocaleString(), '| 평균:', Math.round(sum('cash') / rows.length).toLocaleString(), '| 중앙값:', median.toLocaleString());
console.log('주식평가 합계:', sum('stockVal').toLocaleString());
console.log('순자산 합계:', sum('net').toLocaleString());
console.log('하우스풀:', Math.round(board.housePool || 0).toLocaleString());
console.log('종목수:', stocks.length, '| 리저브 합계:', Math.round(stocks.reduce((a, s) => a + (s.reserve || 0), 0)).toLocaleString());
const kami = rows.find((r) => r.name === '까미');
console.log('\n=== 까미 ===', kami ? JSON.stringify(kami) : '(없음)');
console.log('현금 상위 5:', cashArr.slice(-5).reverse().map((x) => x.toLocaleString()).join(', '));
