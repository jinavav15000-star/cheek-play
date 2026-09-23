# 서체

- `jua.woff2`: [Jua](https://github.com/google/fonts/tree/main/ofl/jua) (우아한형제들, SIL Open Font License 1.1 — `OFL.txt`).
  **앱에서 실제로 쓰는 글자만** 남긴 서브셋(`used.txt` = index.html·app.js·privacy.html의 비ASCII 글자 + 숫자·기호). 외부 요청 없이 자체 호스팅한다.
- 화면 문구를 추가·수정했으면 서브셋을 다시 만든다(안 그러면 그 글자만 기본 서체로 나온다):
  1. `used.txt` 갱신: index.html·app.js·privacy.html의 비ASCII 글자를 모은다(아래 파이썬 한 줄).
  2. `uvx --from fonttools --with brotli pyftsubset Jua-Regular.ttf --text-file=fonts/used.txt --unicodes="U+0020-007E" --flavor=woff2 --no-hinting --desubroutinize --name-IDs+=13,14 --output-file=fonts/jua.woff2`
     (`Jua-Regular.ttf`는 위 google/fonts 저장소에서 받는다. `--name-IDs+=13,14`는 OFL 조건상 라이선스 이름 필드를 남기기 위함.)
  ```
  python3 -c "import sys;cs=set();[cs.update(ch for ch in open(f,encoding='utf-8').read() if ord(ch)>127) for f in ['index.html','app.js','privacy.html']];cs|=set('0123456789%~·…←→↑↓×+-');open('fonts/used.txt','w',encoding='utf-8').write(''.join(sorted(cs)))"
  ```
