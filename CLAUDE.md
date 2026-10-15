# photo-retouch-pwa

아이폰 사파리용 사진 보정 PWA. 아이폰 "보정" 값을 프리셋으로 저장해 사진에 적용·저장. GitHub Pages 배포.

## 스택
- 바닐라 HTML/CSS/JS (ES 모듈), 빌드 도구 없음. 파이썬 venv 불필요 (`tools/make_icons.py` 만 Pillow 사용)
- WebGL 1/2 공용 GLSL ES 1.00 셰이더
- 테스트: `npm test` (node:test, 의존성 0), 셰이더는 `test/shader-test.html` 을 로컬 서버로

## 원칙
- 서버·외부 API·CDN 없음. 모든 처리는 기기 안에서
- 보정 근사 계수/커브는 **`adjustments.js` 한 파일**에만 둔다 (사용자가 직접 튜닝)
- 셰이더 구조는 iOS 사진 앱 역공학 분석을 따른다. 분석 문서는 `notes/apple-adjust-spec.md` (**git 제외** —
  Apple 디컴파일 기반이라 공개 저장소에 올리지 않는다. Apple 코드를 그대로 복사해 넣지 말고 수식만 다시 쓴다)
- 셰이더 자동 검사(`test/shader-test.html`)는 UI_SCALE 을 1.0 으로 고정하고 커널 자체를 검사한다
- 블랙 포인트: **+ 가 블랙을 더 진하게** (아이폰 기준). 파서는 설명 문구 무시, 숫자만 믿음
- 경로는 전부 상대경로 (Pages 하위 경로에서 동작해야 함)
- 사용자 사진(원본·아이폰 결과물)은 `test/pictures/` (git 제외)에만 둔다. `test/calibration/` 은 공개(Pages) 폴더
- 캘리브레이션은 SDR 차트와 HDR(게인맵) 카메라 사진을 분리해서 본다 — 아이폰은 HDR 사진을 다른 경로로 처리한다
- 앱 파일 수정 후 배포할 때 `sw.js` 의 `VERSION` 올리기
- iOS 제약(캔버스 면적 ~16.7MP, 메모리, 공유 시트 제스처)을 깨는 변경 금지 — README "아이폰 사파리 대응" 참고
