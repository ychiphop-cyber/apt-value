#!/bin/bash
# 소스(src/ + config/ + data/) → app.html(평문) → tools/gate.js 암호화 → index.html(배포본)
# 테스트 통과 없이는 빌드하지 않는다. 평문 app.html은 저장소에 올리지 않는다(.gitignore).
set -e
cd "$(dirname "$0")"
# §33 데이터 생성 순서 강제: Station·Line Value 생성 → 테스트 → 빌드
# (station/line intelligence는 같은 meta로 함께 생성되며, 버전 불일치는 테스트가 잡는다)
node pipeline/station_intel.js
npm test

node tools/build.js

# 비밀번호 게이트 — 비번은 저장소에 커밋하지 않는다.
# 우선순위: GATE_PASSWORD 환경변수 → .gate-password 파일(gitignored)
PW="${GATE_PASSWORD:-}"
if [ -z "$PW" ] && [ -f .gate-password ]; then PW="$(tr -d '\r\n' < .gate-password)"; fi
if [ -z "$PW" ]; then
  echo "ERROR: 게이트 비밀번호가 없습니다. .gate-password 파일을 만들거나 GATE_PASSWORD 환경변수를 설정하세요." >&2
  echo "  예: echo -n '설정한4자리' > .gate-password" >&2
  exit 1
fi
node tools/gate.js app.html index.html "$PW"
