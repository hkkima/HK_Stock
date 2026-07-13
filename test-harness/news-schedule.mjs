// 뉴스 자동 편성 하니스 — 주간 계획(docs/news/plan-*.json)을 라이브 scheduledNews 큐에 시드한다.
//   배포된 publishScheduledNews(매분) 스케줄러가 만기분을 applyImpactNews 로 안전히 적용·정산한다.
//   → 이 하니스는 큐에 "예약"만 넣는다. 시세·하우스풀·총량은 절대 직접 건드리지 않는다(불변식 1·2).
//
// 모드:
//   --check                              공개 read 로 라이브 연결 확인 + 시장/풀 스냅샷 (키 불필요)
//   --status [outfile]                   공개 read 스냅샷을 docs/news/pool-status.json 으로 기록 (키 불필요)
//   --plan [YYYY-MM-DD] [outfile]        라이브 종목을 반영한 주간 계획 스켈레톤 생성 (키 불필요)
//   --seed <plan.json> <serviceKey.json> [--dry]   계획을 scheduledNews 에 시드 (Admin SDK, 키 필요)
//
//   ★쓰기(시드)는 firestore.rules 가 클라를 막으므로 서비스 계정 키(Admin SDK)로만 가능★
//   키는 리포 밖·.gitignore. 없으면 --dry 로 무엇이 올라갈지 미리보기만 한다.

import { readFileSync, writeFileSync } from 'fs';

const PROJECT = 'hk-chess-betting';
const API_KEY = 'AIzaSyDdYMFtR4jKdC6svQjEzzas-jDh_sO17DE'; // 공개 read 전용 웹 apiKey (read_live.mjs 와 동일)
const REST = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// ── Firestore REST(공개 read) 헬퍼 ──────────────────────────
const fv = (v) => {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fv);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fv(x)]));
  if ('nullValue' in v) return null;
  return undefined;
};
const docFields = (d) => Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fv(v)]));

async function restGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${REST}/${path}${sep}key=${API_KEY}`);
  if (!r.ok) throw new Error(`REST ${path} → ${r.status} ${r.statusText}`);
  return r.json();
}
async function listStocks() {
  const j = await restGet('stocks?pageSize=200');
  return (j.documents || []).map((d) => ({ id: d.name.split('/').pop(), ...docFields(d) }));
}
async function getBoard() {
  const j = await restGet('meta/stockBoard');
  return docFields(j);
}

// ── 스냅샷(공개 read) ────────────────────────────────────────
async function snapshot() {
  const [stocks, board] = await Promise.all([listStocks(), getBoard()]);
  const sectors = [...new Set(stocks.map((s) => s.sector).filter(Boolean))].sort();
  return {
    at: new Date().toISOString(),
    project: PROJECT,
    housePool: Math.round(board.housePool || 0),
    autoNewsEnabled: !!board.autoNewsEnabled,
    newsFeedLen: Array.isArray(board.news) ? board.news.length : 0,
    stockCount: stocks.length,
    sectors,
    stocks: stocks.map((s) => ({ id: s.id, name: s.name, sector: s.sector, price: Math.round(s.price || 0), status: s.status })),
  };
}

// ── --check : 연결 확인 ──────────────────────────────────────
async function check() {
  console.log('== 뉴스 자동화 연결 확인 (공개 read) ==');
  const snap = await snapshot();
  console.log(`  프로젝트        : ${snap.project}`);
  console.log(`  하우스풀        : ${snap.housePool.toLocaleString()}`);
  console.log(`  자동 뉴스 엔진  : ${snap.autoNewsEnabled ? 'ON' : 'OFF'}`);
  console.log(`  뉴스 피드 길이  : ${snap.newsFeedLen}`);
  console.log(`  상장 종목 수    : ${snap.stockCount}`);
  console.log(`  업종            : ${snap.sectors.join(', ')}`);
  console.log('  종목:');
  for (const s of snap.stocks) console.log(`    ${s.id.padEnd(11)} ${String(s.name).padEnd(10)} [${String(s.sector).padEnd(4)}] ${String(s.price).padStart(6)} ${s.status}`);
  console.log('\n  참고: scheduledNews(예약 큐)와 stockTraits(특성)는 운영자 read 전용 → 키 없이는 미조회.');
  console.log('  참고: 시드(쓰기)는 firestore.rules 가 클라를 차단 → --seed 는 서비스 계정 키 필요.');
  console.log('\n✅ OK — 라이브 Firestore 연결·읽기 정상.');
  return snap;
}

// ── --status : 풀 상태 파일로 기록 ──────────────────────────
async function writeStatus(outfile) {
  const out = outfile || 'docs/news/pool-status.json';
  const snap = await snapshot();
  writeFileSync(out, `${JSON.stringify(snap, null, 2)}\n`);
  console.log(`풀 상태 기록: ${out} (housePool ${snap.housePool.toLocaleString()}, 자동엔진 ${snap.autoNewsEnabled ? 'ON' : 'OFF'})`);
  return snap;
}

// ── --plan : 라이브 반영 주간 계획 스켈레톤 ─────────────────
async function makePlan(dateStr, outfile) {
  const week = dateStr || new Date().toISOString().slice(0, 10);
  const snap = await snapshot();
  const out = outfile || `docs/news/plan-${week}.json`;
  const plan = {
    planId: week, timezone: 'Asia/Seoul', generatedAt: snap.at,
    note: '주간 뉴스 편성. 각 item 은 scheduledNews 큐에 예약 → publishScheduledNews 가 applyImpactNews 로 적용. 특성(trait) 스코프 금지(비공개), 실명 비방 금지, 헤드라인 12~24자.',
    kind: 'auto-routine',
    items: snap.stocks.slice(0, 3).map((s, i) => ({
      date: week, time: ['10:30', '13:30', '15:00'][i] || '11:00',
      scope: 'stock', target: s.id, pct: 0,
      text: `${s.name} 관련 헤드라인(예시) — 편집 요망`,
    })),
  };
  writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`계획 스켈레톤 생성: ${out} (item ${plan.items.length}건 — 편집 후 --seed)`);
}

// ── 계획 검증(시드 전 공통 게이트) ──────────────────────────
function validatePlan(plan) {
  const errs = [];
  if (!plan.planId) errs.push('planId 없음');
  if (!Array.isArray(plan.items) || !plan.items.length) errs.push('items 비어있음');
  (plan.items || []).forEach((it, i) => {
    const at = Date.parse(`${it.date}T${it.time}:00+09:00`);
    if (!Number.isFinite(at)) errs.push(`#${i} date/time 파싱 실패: ${it.date} ${it.time}`);
    if (!['all', 'stock', 'sector'].includes(it.scope)) errs.push(`#${i} scope 는 all|stock|sector 만 (trait 비공개): ${it.scope}`);
    if (it.scope !== 'all' && !String(it.target || '').trim()) errs.push(`#${i} target 필요 (${it.scope})`);
    if (typeof it.pct !== 'number' || it.pct <= -100) errs.push(`#${i} pct 숫자·>-100: ${it.pct}`);
    if (!String(it.text || '').trim()) errs.push(`#${i} text 없음`);
  });
  return errs;
}

// ── --seed : scheduledNews 큐에 시드 (Admin SDK) ────────────
// 서비스 계정 자격 로드: 인자로 준 키 파일 우선, 없으면 환경변수 FIREBASE_SA_KEY_B64(base64) 사용.
//   → 키 파일 경로(로컬 운영자)와 프로비저닝된 환경(정기 트리거) 양쪽에서 동작.
function loadServiceAccount(keyPath) {
  if (keyPath && keyPath !== '--dry') return JSON.parse(readFileSync(keyPath, 'utf8'));
  if (process.env.FIREBASE_SA_KEY_B64) return JSON.parse(Buffer.from(process.env.FIREBASE_SA_KEY_B64, 'base64').toString('utf8'));
  return null;
}

async function seed(planPath, keyPath, dry) {
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const errs = validatePlan(plan);
  if (errs.length) { console.error('계획 검증 실패:\n  - ' + errs.join('\n  - ')); process.exit(1); }
  const sa = dry ? null : loadServiceAccount(keyPath);

  const rows = plan.items.map((it, i) => ({
    id: `plan_${plan.planId}_${String(i).padStart(2, '0')}`,
    text: String(it.text).trim(),
    scope: it.scope,
    target: it.scope === 'all' ? null : String(it.target),
    pct: Number(it.pct) || 0,
    kind: plan.kind || 'auto-routine',
    category: null,
    publishAt: Date.parse(`${it.date}T${it.time}:00+09:00`),
    status: 'pending',
  }));

  console.log(`== 시드 미리보기 (planId ${plan.planId}, ${rows.length}건) ==`);
  for (const r of rows) {
    const when = new Date(r.publishAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    console.log(`  ${when}  [${r.scope}${r.target ? '/' + r.target : ''} ${r.pct > 0 ? '+' : ''}${r.pct}%] ${r.text}`);
  }

  if (dry || !sa) {
    const why = dry ? '--dry' : '키 미제공(인자 없음·FIREBASE_SA_KEY_B64 미설정)';
    console.log(`\n(dry-run: ${why}) 실제 시드 안 함. 실행: node test-harness/news-schedule.mjs --seed ${planPath} "<serviceAccount.json>"  또는  FIREBASE_SA_KEY_B64 설정 후 --seed ${planPath}`);
    return;
  }

  const { default: admin } = await import('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;

  let wrote = 0;
  for (const r of rows) {
    // 결정적 doc id → 재실행해도 중복 안 됨(멱등). 이미 처리(published/failed)된 건은 건드리지 않음.
    const ref = db.doc(`scheduledNews/${r.id}`);
    // eslint-disable-next-line no-await-in-loop
    const cur = await ref.get();
    if (cur.exists && cur.data().status !== 'pending') { console.log(`  skip(${cur.data().status}) ${r.id}`); continue; }
    // eslint-disable-next-line no-await-in-loop
    await ref.set({ ...r, planId: plan.planId, createdBy: 'news-schedule', createdAt: FieldValue.serverTimestamp() }, { merge: true });
    wrote += 1;
  }
  console.log(`\n✅ 시드 완료: ${wrote}건 예약(scheduledNews). publishScheduledNews 가 만기분을 자동 게시한다.`);
  process.exit(0);
}

// ── 엔트리 ───────────────────────────────────────────────────
const argv = process.argv.slice(2);
const mode = argv[0];
try {
  if (mode === '--check') await check();
  else if (mode === '--status') await writeStatus(argv[1]);
  else if (mode === '--plan') await makePlan(argv[1], argv[2]);
  else if (mode === '--seed') await seed(argv[1], argv[2], argv.includes('--dry'));
  else {
    console.log('사용법:\n  --check\n  --status [outfile]\n  --plan [YYYY-MM-DD] [outfile]\n  --seed <plan.json> <serviceKey.json> [--dry]');
    process.exit(argv.length ? 1 : 0);
  }
} catch (e) {
  console.error('[오류]', e?.message || e);
  process.exit(1);
}
