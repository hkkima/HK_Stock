# test-harness — 검증용 시드 유틸

서비스 계정 키로 라이브 Firestore에 **테스트 종목 + 펀딩된 계정**을 시드해, 브라우저에서 거래를 직접 검증하기 위한 도구.

```bash
npm install
# 시드 (거래 가능한 종목 zz_e2e_co + 계정 브라우저테스트/PIN 1234, 잔액 100만)
node seed.mjs "C:\path\to\serviceAccount.json"
# 정리 (종목·계정·보유·거래·원장 로그 제거)
node seed.mjs "C:\path\to\serviceAccount.json" --clean
```

검증 절차: 시드 → `npm run dev`(루트) → 브라우저에서 **브라우저테스트 / 1234** 로그인 → 매수·매도 →
잔액이 본전(±0)으로 돌아오는지, 시세 그래프·호가·태그 확인 → `--clean`.

> ⚠️ 서비스 계정 키는 절대 커밋하지 말 것(.gitignore 처리됨). 테스트 후 콘솔에서 키 로테이션 권장.
>
> Node에서 콜러블 함수를 직접 호출하는 자동 하니스는 Cloud Run + Node fetch의
> Authorization 처리 차이로 인증이 통과되지 않아, **브라우저 기반 검증**을 사용한다(실제 학생 경로와 동일).
