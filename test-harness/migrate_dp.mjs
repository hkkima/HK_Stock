// 기존 수기 DP 이식 + 상품 시드 + 교환소 파라미터 초기화.
//   서비스계정 키(리포 밖, C:\HK_Bot\*firebase-adminsdk*.json) 필요. ★출시 전 1회만 실행★
//   실행: node migrate_dp.mjs
//   (idempotent: dpAccounts.dp 를 set 으로 덮어쓰므로, 학생이 이미 매수/교환을 시작한 뒤엔 재실행 금지)
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const KEY_DIR = process.env.HK_KEY_DIR || 'C:\\HK_Bot';
const keyFile = readdirSync(KEY_DIR).find((f) => /firebase-adminsdk.*\.json$/i.test(f));
if (!keyFile) { console.error(`서비스계정 키(*firebase-adminsdk*.json)를 ${KEY_DIR} 에서 못 찾았습니다.`); process.exit(1); }
initializeApp({ credential: cert(join(KEY_DIR, keyFile)) });
const db = getFirestore();

// Asia/Seoul ISO 주 키 (index.js 와 동일 로직)
function seoulWeekKey(d = new Date()) {
  const s = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = (s.getDay() + 6) % 7;
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - day + 3);
  const firstThu = new Date(s.getFullYear(), 0, 4);
  const week = 1 + Math.round(((s - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return `${s.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

// 시트(기맞기획11기 DP 현황) 채색 칸 수 = 기존 보유 DP
const DP = {
  '김제연': 15, '정승운': 13, '김규장': 9, '김지수': 9, '김영웅': 6, '김채연': 6, '박송호': 6, '오승명': 6,
  '김민성': 5, '김현덕': 5, '백승오': 5, '이예성': 5, '김재원': 4, '이동현': 4, '이정현': 4,
  '이유진': 3, '최혜원': 3, '박도원': 2, '박지수': 2, '이기현': 2, '이제희': 2, '윤희성': 2, '정유진': 1,
};

// 현물 카탈로그(가격=DP, stock=재고는 운영자가 조정). 밥한끼는 메모라 제외.
const GOODS = [
  { id: 'love', name: '강사님의 사랑', priceDP: 2, stock: 99, sort: 1 },
  { id: 'americano', name: '아메리카노 한 잔', priceDP: 5, stock: 50, sort: 2 },
  { id: 'drink', name: '자유 음료 이용권', priceDP: 9, stock: 30, sort: 3 },
  { id: 'gacha', name: '게임 가챠 (일반)', priceDP: 25, stock: 20, sort: 4 },
  { id: 'chicken', name: '치킨 한 마리', priceDP: 35, stock: 20, sort: 5 },
  { id: 'gacha_premium', name: '게임 가챠 (프리미엄)', priceDP: 50, stock: 10, sort: 6 },
  { id: 'authority', name: '막강한 권한(인사권)', priceDP: 60, stock: 3, sort: 7 },
  { id: 'mystery', name: '???', priceDP: 80, stock: 1, sort: 8 },
];

const DP_PARAMS = { R0: 10000, k: 1000, exp: 2, sellEnabled: false, convertEnabled: true, redeemEnabled: true, perWeekCap: null, perCourseCap: null };

async function main() {
  const wk = seoulWeekKey();
  // 이름 → userId 매핑
  const usersSnap = await db.collection('users').get();
  const byName = {};
  usersSnap.forEach((d) => { const n = (d.data().name || '').trim(); if (n) byName[n] = d.id; });

  // 1) 기존 DP 이식
  let ok = 0; const miss = [];
  for (const [name, dp] of Object.entries(DP)) {
    const uid = byName[name];
    if (!uid) { miss.push(name); continue; }
    // eslint-disable-next-line no-await-in-loop
    await db.doc(`dpAccounts/${uid}`).set({ userId: uid, dp, weekKey: wk, weekCount: 0, totalBought: 0, updatedAt: new Date() }, { merge: false });
    ok += 1;
    console.log(`  dpAccounts/${uid} (${name}) ← dp ${dp}`);
  }
  if (miss.length) console.warn('⚠ users 에서 못 찾은 이름:', miss.join(', '));

  // 2) 상품 시드
  for (const g of GOODS) {
    // eslint-disable-next-line no-await-in-loop
    await db.doc(`dpGoods/${g.id}`).set({ ...g, active: true }, { merge: true });
  }
  console.log(`  dpGoods 시드 ${GOODS.length}개`);

  // 3) 교환소 파라미터
  await db.doc('meta/dpExchange').set(DP_PARAMS, { merge: true });
  console.log('  meta/dpExchange 초기화', DP_PARAMS);

  console.log(`\n완료: DP 이식 ${ok}명, 상품 ${GOODS.length}개, 주키 ${wk}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
