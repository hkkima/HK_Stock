// Asia/Seoul ISO 주 키(예 "2026-W28"). functions/index.js seoulWeekKey 와 동일 로직(주간 배당 정합).
export function seoulWeekKey(d = new Date()) {
  const s = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = (s.getDay() + 6) % 7; // 월=0
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - day + 3); // 해당 주 목요일
  const firstThu = new Date(s.getFullYear(), 0, 4);
  const week = 1 + Math.round(((s - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return `${s.getFullYear()}-W${String(week).padStart(2, '0')}`;
}
