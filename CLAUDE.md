# HK_Stock — 에이전트/개발자 우선 컨텍스트

수강생 가상 주식판. Vite+React+Firebase(Cloud Functions, 서울 `asia-northeast3`), GitHub Pages.
백엔드 프로젝트 `hk-chess-betting`(★베팅판과 `users`/포인트 공유★). 라이브: `hkkima.github.io/HK_Stock`.

**먼저 `docs/HANDBOOK.md`(특히 §9 인수인계)를 읽어라.** 라이브 시스템(실수강생 24명·실포인트)이다.

## 절대 깨면 안 되는 불변식
1. **총량 보존**: `meta/stockBoard.housePool`은 `FieldValue.increment`로만 변경. read-modify-write 금지(틱이 매분 갱신 → 충돌·`internal`). 포인트 이동은 반대편을 같은 increment로 정산.
2. **체결은 결정적**: 매매 가격에 랜덤 넣지 마라(본전보장 깨짐 → 포인트 복사 재발). 무작위는 `tick.js` 노이즈만.
3. **`src/domain/market.js` ≡ `functions/market.js`** (바이트 동일, `diff` 점검).
4. **`base ≥ 1`** (곡선 양수). 시세 하한 = `slope × circulating`.
5. **포인트·시세·보유 변경은 Cloud Functions(Admin SDK)만**. 클라 읽기 전용, `firestore.rules`가 차단.
6. **`firestore.rules`는 베팅+주식 통합본**(이 리포가 진실원천). 베팅 규칙 깨지 마라.

## 운영/검증 방식
- ★Node에서 콜러블 직접 호출 불가(Cloud Run 인증)★ → 시드·마이그레이션·일괄작업·검증은 **서비스 계정 키 + firebase-admin**으로 Firestore 직접 조작(`test-harness/` 참고). 키는 리포 밖·`.gitignore`.
- 배포: 함수 `firebase deploy --only functions --project hk-chess-betting` / 프론트 `main` 푸시→Actions. 셸 PowerShell(`&&`✕, 커밋 `-m` 여러 개).
- 일치: 리전·운영자이메일(3곳)·market.js 두 사본.

## 코드 지도
`functions/`: index.js(콜러블·스케줄 17), market.js(곡선), news.js, tick.js.
`src/`: data/firebase.js·store.js, state/AppContext.jsx, domain/market.js, pages/(Market·Portfolio·News·Leaderboard·Admin·Login).

기능 추가/위험지역/의사결정 로그는 `docs/HANDBOOK.md` §6, §9 참고.
