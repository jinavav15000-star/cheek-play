#!/bin/zsh
# 같은 와이파이의 갤럭시에서 접속할 수 있게 로컬 서버를 띄운다.
PORT=${1:-8417}
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
echo "맥에서:     http://localhost:$PORT"
echo "갤럭시에서: http://${IP:-<맥 IP 확인 실패>}:$PORT  (같은 와이파이)"
cd "$(dirname "$0")" && python3 -m http.server "$PORT" --bind 0.0.0.0
