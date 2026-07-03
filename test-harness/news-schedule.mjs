// 뉴스 풀 예약 시드 — docs/news/pool.jsonl 의 항목을 scheduledNews 에 등록(라이브 쓰기).
//   ★승인 게이트: 기본은 --dry(미리보기). 실제 시드는 키 + 명시적 실행일 때만.★
//   사용:
//     node news-schedule.mjs --dry <plan.json>          미리보기(키 불필요)
//     node news-schedule.mjs "<key.json>" <plan.json>   실제 예약 등록(라이브)
//   plan.json = [{ "id": "chess-001", "publishAt": 1751596800000 }, ...]  (publishAt=epoch ms, KST 09~18시 권장)
//
// 배포된 publishScheduledNews(매분)가 만기분을 applyImpactNews 로 안전히 발행·정산한다.
// 시세·총량 보존은 절대 직접 건드리지 않는다(여기선 예약 문서만 추가).
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const POOL = resolve(HERE, '..', 'docs', 'news', 'pool.jsonl');
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const rest = args.filter((a) => a !== '--dry');
const KEY = DRY ? null : rest[0];
const PLAN_PATH = DRY ? rest[0] : rest[1];
if (!PLAN_PATH) { console.error('사용법: node news-schedule.mjs [--dry] ["<key.json>"] <plan.json>'); process.exit(1); }

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

if (DRY) { console.log('\n--dry: 미리보기만. 실제 등록하려면 키를 주고 다시 실행.'); process.exit(0); }

// ── 실제 시드 ──
const admin = (await import('firebase-admin')).default;
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(KEY, 'utf8'))) });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

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
