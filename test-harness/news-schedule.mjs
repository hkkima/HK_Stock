// 뉴스 풀 예약 시드 — docs/news/pool.jsonl 의 항목을 scheduledNews 에 등록(라이브 쓰기).
//   ★승인 게이트: 기본은 --dry(미리보기). 실제 시드는 자격증명 + 명시적 실행일 때만.★
//
// 자격증명(우선순위): 1) env FIREBASE_SA_KEY_B64(키 JSON의 base64)  2) env FIREBASE_SA_KEY(키 JSON 원문)
//                    3) env GOOGLE_APPLICATION_CREDENTIALS(키 파일 경로)  4) 인자로 준 키 파일 경로
//   → 무인 자동화(클라우드 환경)는 1) 권장: .env 는 한 줄만 되므로 JSON을 base64 한 줄로.
//
//   사용:
//     node news-schedule.mjs --check                     자격증명·연결만 확인(쓰기 없음)
//     node news-schedule.mjs --dry <plan.json>           예약 미리보기(자격증명 불필요)
//     FIREBASE_SA_KEY_B64=... node news-schedule.mjs <plan.json>   env 자격증명으로 실제 등록
//     node news-schedule.mjs "<key.json>" <plan.json>    키 파일로 실제 등록
//   plan.json = [{ "id": "chess-001", "publishAt": 1751596800000 }, ...]  (publishAt=epoch ms, KST 09~18시 권장)
//
// 배포된 publishScheduledNews(매분)가 만기분을 applyImpactNews 로 안전히 발행·정산한다.
// 시세·총량 보존은 절대 직접 건드리지 않는다(여기선 예약 문서만 추가).
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const POOL = resolve(HERE, '..', 'docs', 'news', 'pool.jsonl');

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const pos = argv.filter((a) => !a.startsWith('--'));
const DRY = flags.includes('--dry');
const CHECK = flags.includes('--check');

// 자격증명 JSON 확보(--dry 는 불필요). 인자에 키파일이 있으면 pos 의 마지막 앞자리로 본다.
function loadCredential(keyFileArg) {
  if (process.env.FIREBASE_SA_KEY_B64) return JSON.parse(Buffer.from(process.env.FIREBASE_SA_KEY_B64, 'base64').toString('utf8'));
  if (process.env.FIREBASE_SA_KEY) return JSON.parse(process.env.FIREBASE_SA_KEY);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
  if (keyFileArg) return JSON.parse(readFileSync(resolve(process.cwd(), keyFileArg), 'utf8'));
  return null;
}

async function initDb(cred) {
  const admin = (await import('firebase-admin')).default;
  admin.initializeApp({ credential: admin.credential.cert(cred) });
  return { db: admin.firestore(), FieldValue: admin.firestore.FieldValue };
}

// ── --check: 자격증명/연결만 확인 ──
if (CHECK) {
  const cred = loadCredential(pos[0]);
  if (!cred) { console.error('[check] 자격증명 없음: FIREBASE_SA_KEY_B64 / FIREBASE_SA_KEY / GOOGLE_APPLICATION_CREDENTIALS / 키파일 인자 중 하나 필요.'); process.exit(1); }
  try {
    const { db } = await initDb(cred);
    const n = (await db.collection('stocks').limit(1).get()).size;
    console.log(`[check] OK — 프로젝트 '${cred.project_id}' 연결 성공(stocks 읽기 ${n}건). 예약 시드 준비 완료.`);
    process.exit(0);
  } catch (e) { console.error('[check] 연결 실패:', e.message || e); process.exit(1); }
}

// ── 이하 예약: plan 필요 ──
const PLAN_PATH = DRY ? pos[0] : (pos.length >= 2 ? pos[1] : pos[0]);
const KEY_FILE = (!DRY && pos.length >= 2) ? pos[0] : null;
if (!PLAN_PATH) { console.error('사용법: node news-schedule.mjs [--check] [--dry] ["<key.json>"] <plan.json>'); process.exit(1); }

const pool = readFileSync(POOL, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
const byId = Object.fromEntries(pool.map((r) => [r.id, r]));
const plan = JSON.parse(readFileSync(resolve(process.cwd(), PLAN_PATH), 'utf8'));

// 검증
const errs = [];
for (const p of plan) {
  const r = byId[p.id];
  if (!r) { errs.push(`알 수 없는 id: ${p.id}`); continue; }
  if (r.status !== 'draft') errs.push(`${p.id}: status=${r.status}(draft 아님) — 재예약 방지`);
  if (!Number.isFinite(Number(p.publishAt)) || Number(p.publishAt) <= 0) errs.push(`${p.id}: publishAt 부적절`);
  if (!['all', 'stock', 'sector', 'trait'].includes(r.scope)) errs.push(`${p.id}: scope 부적절(${r.scope})`);
  if (r.scope !== 'all' && !String(r.target || '').trim()) errs.push(`${p.id}: target 필요(scope=${r.scope})`);
  if (Number(r.pct) <= -100) errs.push(`${p.id}: pct는 -100 초과`);
}
if (errs.length) { console.error('[검증 실패]\n - ' + errs.join('\n - ')); process.exit(1); }

const fmt = (ms) => new Date(ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
console.log(`== 예약 계획 (${plan.length}건) ==`);
for (const p of plan) {
  const r = byId[p.id];
  console.log(` ${fmt(Number(p.publishAt))}  [${r.scope}/${r.target ?? ''} · ${r.pct > 0 ? '+' : ''}${r.pct}%]  ${r.text}`);
}

if (DRY) { console.log('\n--dry: 미리보기만. 실제 등록하려면 자격증명을 주고 다시 실행.'); process.exit(0); }

// ── 실제 시드 ──
const cred = loadCredential(KEY_FILE);
if (!cred) { console.error('[오류] 자격증명 없음: FIREBASE_SA_KEY_B64 / FIREBASE_SA_KEY / GOOGLE_APPLICATION_CREDENTIALS / 키파일 인자 중 하나 필요.'); process.exit(1); }
const { db, FieldValue } = await initDb(cred);

for (const p of plan) {
  const r = byId[p.id];
  const when = Math.floor(Number(p.publishAt));
  // eslint-disable-next-line no-await-in-loop
  const ref = await db.collection('scheduledNews').add({
    text: String(r.text).trim(), scope: r.scope, target: r.target || null, pct: Number(r.pct) || 0,
    publishAt: when, status: 'pending', kind: 'auto-routine', category: null,
    createdBy: 'news-pipeline', createdAt: FieldValue.serverTimestamp(),
  });
  r.status = 'scheduled'; r.scheduledAt = when; r.scheduledId = ref.id;
  console.log(` 등록 ✓ ${p.id} → scheduledNews/${ref.id}  (${fmt(when)})`);
}

// 풀 상태 반영(scheduled)
writeFileSync(POOL, pool.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
console.log(`\npool.jsonl 갱신: ${plan.length}건 status→scheduled. 배포 스케줄러가 만기 시 자동 발행.`);
process.exit(0);
