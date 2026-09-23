# 서체

- `jua.woff2`: [Jua](https://github.com/google/fonts/tree/main/ofl/jua) (우아한형제들, SIL Open Font License 1.1).
  한글 완성형(가~힣)·자모·기본 라틴·화살표만 남긴 서브셋. 외부 요청 없이 자체 호스팅한다.
  재생성: `uvx --from fonttools --with brotli pyftsubset Jua-Regular.ttf --unicodes="U+0020-007E,U+00A0-00FF,U+2010-2027,U+3131-318E,U+AC00-D7A3,U+2190-2193,U+00D7" --flavor=woff2 --output-file=jua.woff2`
