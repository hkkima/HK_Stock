// 팀 포인트 교환소 가격표 시딩 — meta/corpServices.
//   7주 프로젝트(2주 사전기획 · 3주 개발 · 1주 QA/폴리싱 · 1주 출시) 기준으로 티어를 짰다.
//   ★소각(sink)★ — 구매 대금은 corpBalance 에서 사라진다(총량 감소). 거부 시 rejectCorpOrder 로 환원.
//   ★T3 홍보 계약★ — 호재는 구매 팀이 아니라 공급사 까미 비전스(T00)에 붙는다.
//     자기 팀 호재면 금고→주가→팀원 매도 로 이어지는 세탁 경로가 열리므로 target 을 분리한다.
//
//   usage:
//     node seed_corp_services.mjs "<serviceAccount.json>"            # DRY
//     node seed_corp_services.mjs "<serviceAccount.json>" --execute
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const keyPath = process.argv[2];
const EXECUTE = process.argv.includes('--execute');
if (!keyPath) { console.error('서비스 계정 키 경로가 필요합니다.'); process.exit(1); }
initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();

const services = {
  // ── T1 까미 노동 (공급 무제한 — 접수 후 까미 작업 큐에 pending 으로 쌓인다) ──
  //   ★납품이 필요한 상품은 전부 pending★ — 즉시 fulfilled 로 두면 미납품 시 환불 경로가 없다.
  //   2026-08-06 T1·T2 인상: 기존가 ×1.3~1.7 범위에서 1.5배에 가장 가까운 5,000P 배수로 재책정.
  doc_schedule_feedback: { name: '문서 및 일정 피드백', tier: 'T1', price: 30000, needsApproval: true, phase: '사전기획', desc: '기획서·일정표를 읽고 구조와 리스크를 짚어 드립니다.' },
  play_feedback: { name: '플레이 피드백', tier: 'T1', price: 45000, needsApproval: true, phase: 'QA·폴리싱', desc: '빌드를 직접 플레이하고 체감 문제를 정리해 드립니다.' },
  research: { name: '까미 리서치 대행', tier: 'T1', price: 55000, needsApproval: true, phase: '사전기획', desc: '레퍼런스·시장·경쟁작 조사를 대행합니다.' },
  asset_set: { name: '에셋 제작 1세트', tier: 'T1', price: 75000, needsApproval: true, phase: '개발', desc: '요청 사양에 맞춘 에셋 한 세트를 제작합니다.' },

  // ── T2 강사 직접 (희소 · 일정 협의 필요 → 승인제) ──
  consult_20: { name: '컨설팅 20분', tier: 'T2', price: 90000, needsApproval: true, phase: '전 국면', desc: '강사와 20분 1:1. 주제를 미리 적어 주세요.' },
  design_review: { name: '기획 심층 리뷰', tier: 'T2', price: 120000, needsApproval: true, phase: '사전기획', desc: '기획 문서를 정독하고 첨삭·구조 제안을 드립니다.' },
  sprint_review: { name: '스프린트 단위 심층 점검', tier: 'T2', price: 135000, needsApproval: true, phase: '개발', desc: '스프린트 산출물 전반을 점검하고 다음 스프린트 방향을 잡아 드립니다.' },

  // ── T3 까미 비전스 계약 (팀 전용 — 개인 최대 잔고 151,629 를 넘도록 책정) ──
  promo_contract: {
    name: '까미 비전스 홍보 계약', tier: 'T3', price: 180000, needsApproval: false, phase: '출시',
    desc: '까미 비전스가 귀사 소식을 뉴스 헤드라인으로 다룹니다. (즉시 체결 · 환불 불가)',
    effect: {
      type: 'news', target: 'T00', supplierName: '까미 비전스', pct: 3,
      headline: '{supplier}, {team} 와 홍보 계약 체결 — 광고 수주 확대에 투자자 관심',
    },
  },
  ip_license: {
    name: '까미 IP 라이센싱', tier: 'T3', price: 250000, needsApproval: true, phase: '개발~출시',
    desc: '까미 관련 IP 사용 라이센스 + 리소스 외주 제작.',
  },
};

const rows = Object.entries(services);
console.log('교환소 가격표 (총 ' + rows.length + '종)\n');
for (const tier of ['T1', 'T2', 'T3']) {
  console.log(`[${tier}]`);
  for (const [k, s] of rows.filter(([, s]) => s.tier === tier)) {
    const flags = [s.needsApproval ? '승인제' : '즉시', s.effect ? '즉시효과·환불불가' : '환불가능'].join('·');
    console.log(`  ${k.padEnd(22)} ${String(s.price).padStart(7)}  ${s.name.padEnd(18)} ${s.phase.padEnd(10)} (${flags})`);
  }
}
const total = rows.reduce((a, [, s]) => a + s.price, 0);
console.log(`\n전 상품 1회씩 구매 시 합계: ${total.toLocaleString()}`);

if (EXECUTE) {
  await db.doc('meta/corpServices').set({ services, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  console.log('\n✅ meta/corpServices 반영 완료');
} else {
  console.log('\n(DRY RUN — 실제 반영하려면 --execute)');
}
process.exit(0);
