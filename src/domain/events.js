// ─────────────────────────────────────────────────────────────
// 강사 이벤트 카탈로그 — 출결·과제·프로젝트 등 "강사가 직접 제어하는" 펀더멘탈 이벤트.
//   자동 랜덤 뉴스(news.js)와 분리된 별도 레버: 강사가 특정 팀(종목)에 즉시
//   호재/악재 헤드라인 + 시세 효과를 원클릭으로 준다(동기부여·분위기 형성).
//   순수 데이터 + 렌더 헬퍼만 — 실제 적용(시세/총량 보존)은 index.js applyImpactNews.
//   ★ src/domain/events.js 와 바이트 동일(diff 점검). 한쪽만 고치지 말 것. ★
// ─────────────────────────────────────────────────────────────

// 카테고리(표시 순서 = 배열 순서). id 는 news 엔트리 category 로 저장된다.
export const EVENT_CATEGORIES = [
  { id: 'attendance', label: '출결', icon: '🕘' },
  { id: 'assignment', label: '과제', icon: '📝' },
  { id: 'project', label: '프로젝트', icon: '🚀' },
  { id: 'attitude', label: '태도·참여', icon: '🙋' },
  { id: 'teamwork', label: '팀워크', icon: '🤝' },
  { id: 'special', label: '특별·보너스', icon: '⭐' },
];

// 프리셋 — key(고유), cat(카테고리 id), label(버튼), pct(기본 시세%), tpl(헤드라인·{기업} 치환).
//   pct 는 UI 에서 수정 가능한 "기본값". 양수=호재(하우스풀 충당)·음수=악재·0=헤드라인만.
export const EVENT_PRESETS = [
  // 출결 —————————————————————————————————————
  { key: 'att_perfect', cat: 'attendance', label: '전원 출석', pct: 3, tpl: '{기업}, 오늘도 전원 출석 — 성실 프리미엄 부각' },
  { key: 'att_early', cat: 'attendance', label: '일찍 등원', pct: 2, tpl: '{기업}, 개장 전 일찍 자리 잡고 준비 완료' },
  { key: 'att_late', cat: 'attendance', label: '지각', pct: -3, tpl: '{기업} 지각 발생, 신뢰도 소폭 흔들' },
  { key: 'att_absent', cat: 'attendance', label: '결석', pct: -6, tpl: '{기업} 핵심 멤버 결석에 동력 상실 우려' },

  // 과제 —————————————————————————————————————
  { key: 'hw_excellent', cat: 'assignment', label: '우수 과제', pct: 6, tpl: '{기업} 과제 퀄리티 극찬, 매수세 유입' },
  { key: 'hw_ontime', cat: 'assignment', label: '기한 준수', pct: 3, tpl: '{기업}, 과제 마감 완벽 준수' },
  { key: 'hw_late', cat: 'assignment', label: '지연 제출', pct: -4, tpl: '{기업} 과제 지연 제출, 감점 우려에 약세' },
  { key: 'hw_miss', cat: 'assignment', label: '미제출', pct: -7, tpl: '{기업} 과제 펑크에 투자 경고등' },

  // 프로젝트 퀄리티 ————————————————————————————
  { key: 'pj_demo', cat: 'project', label: '데모 성공', pct: 8, tpl: '{기업} 프로젝트 데모 성공적, 기대감 고조' },
  { key: 'pj_praise', cat: 'project', label: '강사 극찬', pct: 7, tpl: '{기업} 결과물 강사 극찬에 시장 주목' },
  { key: 'pj_progress', cat: 'project', label: '진척 양호', pct: 4, tpl: '{기업} 개발 순항 소식에 강세' },
  { key: 'pj_bug', cat: 'project', label: '기능 미완성', pct: -5, tpl: '{기업} 핵심 기능 미완성 논란' },
  { key: 'pj_criticism', cat: 'project', label: '결과물 혹평', pct: -7, tpl: '{기업} 결과물 혹평에 매도 행렬' },

  // 태도·참여 —————————————————————————————————
  { key: 'at_active', cat: 'attitude', label: '적극 참여', pct: 4, tpl: '{기업}, 수업 적극 참여로 분위기 주도' },
  { key: 'at_question', cat: 'attitude', label: '좋은 질문', pct: 3, tpl: '{기업} 날카로운 질문으로 존재감 부각' },
  { key: 'at_passive', cat: 'attitude', label: '참여 저조', pct: -3, tpl: '{기업} 참여 저조에 우려 목소리' },
  { key: 'at_distract', cat: 'attitude', label: '집중 저하', pct: -4, tpl: '{기업} 집중력 저하 포착, 신뢰 하락' },

  // 팀워크 ————————————————————————————————————
  { key: 'tw_model', cat: 'teamwork', label: '협업 모범', pct: 5, tpl: '{기업} 팀워크 모범 사례로 회자' },
  { key: 'tw_help', cat: 'teamwork', label: '동료 지원', pct: 3, tpl: '{기업}, 동료 지원으로 훈훈한 분위기' },
  { key: 'tw_conflict', cat: 'teamwork', label: '내부 갈등', pct: -5, tpl: '{기업} 내부 갈등 표면화, 리스크 부각' },
  { key: 'tw_silent', cat: 'teamwork', label: '소통 부재', pct: -3, tpl: '{기업} 소통 부재에 협업 삐걱' },

  // 특별·보너스 ———————————————————————————————
  { key: 'sp_mvp', cat: 'special', label: '금주의 MVP', pct: 8, tpl: '{기업}, 금주의 MVP 선정 — 폭발적 매수세' },
  { key: 'sp_bonus', cat: 'special', label: '깜짝 보너스', pct: 5, tpl: '{기업}에 깜짝 호재 발생, 투자심리 개선' },
  { key: 'sp_comeback', cat: 'special', label: '반등 서사', pct: 4, tpl: '{기업} 저력 발휘하며 반등 기대감' },
  { key: 'sp_penalty', cat: 'special', label: '규칙 위반', pct: -8, tpl: '{기업} 규칙 위반 적발에 급락' },
];

// key → 프리셋. 없으면 null.
export function findEventPreset(key) {
  return EVENT_PRESETS.find((p) => p.key === key) || null;
}

// 프리셋 헤드라인 렌더 — {기업} 을 종목명으로 치환.
export function renderEventHeadline(preset, companyName) {
  if (!preset) return '';
  return String(preset.tpl).replace('{기업}', companyName || '');
}

// 카테고리 id → 표시 메타(라벨·아이콘). 없으면 fallback.
export function eventCategoryMeta(catId) {
  return EVENT_CATEGORIES.find((c) => c.id === catId) || { id: catId, label: catId || '이벤트', icon: '📣' };
}
