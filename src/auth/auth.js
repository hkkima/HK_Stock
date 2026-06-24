// 참가자 이름 + 숫자 PIN 로그인. PIN은 평문 저장하지 않고 해시만 보관.
// ★ 베팅판(HK_Betting)과 동일한 해시 — 같은 users 문서를 공유하므로 반드시 일치해야 함 ★
// ⚠️ 경량 해시(djb2) — 캐주얼 수업용. 금전 가치가 큰 용도면 교체.

export function normalizeId(id) {
  return String(id || '').trim().toLowerCase();
}

// userId 는 이름을 정규화한 슬러그(공백→_). 충돌 시 운영자가 뒤에 숫자 부여.
export function nameToUserId(name) {
  return normalizeId(name).replace(/\s+/g, '_');
}

export function hashPin(pin) {
  const s = String(pin);
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return 'pin_' + (h >>> 0).toString(16);
}

export function verifyPin(pin, hash) {
  return hashPin(pin) === hash;
}
