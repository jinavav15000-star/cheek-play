// 볼 꼬집기 시제품
// 사진을 WebGL 격자 메시에 입히고, 정점마다 스프링-댐퍼 물리를 돌린다.
// 좌표계: 이미지 공간. 가로 = 1, 세로 = A(세로/가로 비율). 원본 사진은 절대 수정하지 않는다.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const stage = $('#stage');
  const canvas = $('#gl');
  const regionsEl = $('#regions');
  const hintEl = $('#hint');
  const toastEl = $('#toast');

  // ---------- 설정 ----------
  // 의견 보내기 버튼이 여는 주소(구글 폼 등). 비어 있으면 "준비 중" 안내만 뜬다.
  const FEEDBACK_URL = '';
  const NUDGE_AFTER = 30; // 이만큼 당기고 놓으면 한 번 의견을 부탁한다

  const DEFAULTS = { freq: 4, wobble: 0.75, stretch: 0.6, grab: 1.0, mask: true, show: false, haptic: true };
  const settings = { ...DEFAULTS, ...loadJSON('cheek.settings') };

  function loadJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
  }
  function saveJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 사생활 보호 모드 등 */ }
  }
  function flag(key) { try { return localStorage.getItem(key) === '1'; } catch { return false; } }
  function setFlag(key) { try { localStorage.setItem(key, '1'); } catch { /* 무시 */ } }

  // ---------- WebGL ----------
  const gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: false });
  if (!gl) {
    hintEl.textContent = '이 브라우저는 WebGL을 지원하지 않습니다';
    return;
  }

  const VS = `
    attribute vec2 aPos; attribute vec2 aUV;
    uniform vec2 uO; uniform vec2 uS;
    varying vec2 vUV;
    void main() {
      vUV = aUV;
      gl_Position = vec4(uO.x + aPos.x * uS.x, uO.y - aPos.y * uS.y, 0.0, 1.0);
    }`;
  const FS = `
    precision mediump float;
    varying vec2 vUV; uniform sampler2D uTex;
    void main() { gl_FragColor = texture2D(uTex, vUV); }`;

  let prog, locPos, locUV, locO, locS, posBuf, uvBuf, idxBuf, tex;

  function initGL() {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    locPos = gl.getAttribLocation(prog, 'aPos');
    locUV = gl.getAttribLocation(prog, 'aUV');
    locO = gl.getUniformLocation(prog, 'uO');
    locS = gl.getUniformLocation(prog, 'uS');
    posBuf = gl.createBuffer(); uvBuf = gl.createBuffer(); idxBuf = gl.createBuffer();
    tex = gl.createTexture();
    gl.clearColor(0x17 / 255, 0x12 / 255, 0x0f / 255, 1);
  }

  // ---------- 메시 + 물리 상태 ----------
  const GRID_LONG = 96; // 긴 변 기준 격자 칸 수
  let A = 1;            // 이미지 세로/가로 비율
  let cols, rows, n, stride, indexCount;
  let restX, restY, dx, dy, vx, vy, tgtX, tgtY, held, free, pos;
  let srcCanvas = null; // 텍스처 원본(컨텍스트 복구용)

  function buildMesh() {
    if (A >= 1) { rows = GRID_LONG; cols = Math.max(8, Math.round(GRID_LONG / A)); }
    else { cols = GRID_LONG; rows = Math.max(8, Math.round(GRID_LONG * A)); }
    stride = cols + 1;
    n = stride * (rows + 1);
    restX = new Float32Array(n); restY = new Float32Array(n);
    dx = new Float32Array(n); dy = new Float32Array(n);
    vx = new Float32Array(n); vy = new Float32Array(n);
    tgtX = new Float32Array(n); tgtY = new Float32Array(n); held = new Float32Array(n);
    free = new Uint8Array(n);
    pos = new Float32Array(n * 2);
    const uv = new Float32Array(n * 2);
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
      const k = j * stride + i;
      restX[k] = i / cols; restY[k] = (j / rows) * A;
      uv[k * 2] = i / cols; uv[k * 2 + 1] = j / rows;
    }
    const idx = new Uint16Array(cols * rows * 6);
    let p = 0;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const a = j * stride + i, b = a + 1, c = a + stride, d = c + 1;
      idx[p++] = a; idx[p++] = c; idx[p++] = b;
      idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
    indexCount = idx.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pos.byteLength, gl.DYNAMIC_DRAW);
    updateFree();
  }

  // ---------- 볼 영역 ----------
  // cx, cy, r 모두 이미지 가로 = 1 기준
  let regions = [];
  function defaultRegions() {
    return [
      { cx: 0.33, cy: 0.55 * A, r: 0.12 },
      { cx: 0.67, cy: 0.55 * A, r: 0.12 },
    ];
  }

  // 영역 반지름 대비 비율. 원 안쪽은 100% 움직이고, 원 밖 주변 피부는 점점 줄어 MASK_OUTER에서 완전히 고정된다.
  const MASK_INNER = 0.7, MASK_OUTER = 1.5;
  const GRAB_HIT = 1.1;  // 원의 이 배율 안을 눌러야 잡힌다
  const MIN_HIT_PX = 28; // 단, 화면에서 손가락 크기만큼은 항상 잡힌다
  const GRAB_BASE = 1.3; // 잡는 범위(반지름) = 원 반지름 × 이 값 × 설정값
  function smoothstep(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }
  function regionMask(reg, x, y) {
    const d = Math.hypot(x - reg.cx, y - reg.cy);
    return 1 - smoothstep(reg.r * MASK_INNER, reg.r * MASK_OUTER, d);
  }

  // 움직일 수 있는 정점 표시. 테두리는 항상 고정, 마스크 모드에서는 볼 영역 밖도 고정.
  function updateFree() {
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
      const k = j * stride + i;
      let f = i > 0 && i < cols && j > 0 && j < rows;
      if (f && settings.mask) {
        f = false;
        for (const reg of regions) if (regionMask(reg, restX[k], restY[k]) > 0) { f = true; break; }
      }
      free[k] = f ? 1 : 0;
      if (!f) { dx[k] = dy[k] = vx[k] = vy[k] = 0; }
    }
  }

  // ---------- 잡기 (손가락마다 독립) ----------
  // pointerId -> { sx, sy, Dx, Dy, limit, w }. w는 그 손가락이 각 정점을 끌고 가는 비율(0~1).
  const grabs = new Map();
  const MAX_GRABS = 4;

  function beginGrab(id, x, y) {
    if (grabs.size >= MAX_GRABS || grabs.has(id)) return false;
    let reg = null, Rg;
    if (settings.mask) {
      let best = Infinity;
      for (const r of regions) {
        const d = Math.hypot(x - r.cx, y - r.cy);
        if (d < Math.max(r.r * GRAB_HIT, MIN_HIT_PX / imgRect.w) && d < best) { best = d; reg = r; }
      }
      if (!reg) return false;
      Rg = reg.r * GRAB_BASE * settings.grab;
    } else {
      const avg = regions.reduce((s, r) => s + r.r, 0) / (regions.length || 1) || 0.12;
      Rg = avg * GRAB_BASE * settings.grab;
    }
    const w = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      if (!free[k]) continue;
      const q = Math.hypot(restX[k] - x, restY[k] - y) / Rg;
      let g = q < 1 ? (1 - q * q) * (1 - q * q) : 0;
      if (reg) g *= regionMask(reg, restX[k], restY[k]);
      w[k] = g;
    }
    grabs.set(id, { sx: x, sy: y, Dx: 0, Dy: 0, limit: Rg * settings.stretch, w });
    updateTargets();
    wake();
    return true;
  }

  function moveGrab(id, x, y) {
    const g = grabs.get(id);
    if (!g) return;
    // 당긴 거리에 부드러운 한계를 둔다(tanh). 한계를 넘기면 메시가 접혀 사진이 찢어져 보인다.
    const mx = x - g.sx, my = y - g.sy;
    const len = Math.hypot(mx, my);
    if (len < 1e-6) { g.Dx = g.Dy = 0; }
    else {
      const s = (g.limit * Math.tanh(len / g.limit)) / len;
      g.Dx = mx * s; g.Dy = my * s;
    }
    updateTargets();
    wake();
  }

  function endGrab(id) {
    if (!grabs.delete(id)) return false;
    updateTargets();
    wake();
    return true;
  }

  function clearGrabs() {
    grabs.clear();
    updateTargets();
  }

  // 모든 손가락의 당김을 합쳐 정점별 목표 변위(tgtX, tgtY)와 "잡혀 있는 정도"(held)를 만든다.
  function updateTargets() {
    tgtX.fill(0); tgtY.fill(0); held.fill(0);
    for (const g of grabs.values()) {
      const w = g.w;
      for (let k = 0; k < n; k++) {
        const wk = w[k];
        if (wk === 0) continue;
        tgtX[k] += wk * g.Dx; tgtY[k] += wk * g.Dy; held[k] += wk;
      }
    }
  }

  // ---------- 물리 ----------
  const DT = 1 / 180;
  const K_HOLD = 1600, ZETA_HOLD = 0.7; // 잡고 있을 때: 손가락을 빠르게 따라오되 살짝 끌려오는 느낌

  function step() {
    const om = 2 * Math.PI * settings.freq;
    const kRel = om * om;
    const kc = kRel * 1.5; // 이웃 정점끼리의 결합. 가운데와 가장자리가 어긋나게 흔들려 젤리처럼 보인다.
    const zetaRel = 0.6 - 0.52 * settings.wobble;
    const cRel = 2 * zetaRel * om, cHold = 2 * ZETA_HOLD * Math.sqrt(K_HOLD);
    let energy = 0;
    for (let j = 1; j < rows; j++) {
      for (let i = 1, k0 = j * stride + 1; i < cols; i++, k0++) {
        if (!free[k0]) continue;
        // 잡힌 정점만 단단한 스프링으로 손가락을 따라가고, 나머지는 놓임 상태로 출렁인다
        const isHeld = held[k0] > 0.002;
        const k = isHeld ? K_HOLD : kRel, c = isHeld ? cHold : cRel;
        const tx = tgtX[k0], ty = tgtY[k0];
        const lx = dx[k0 - 1] + dx[k0 + 1] + dx[k0 - stride] + dx[k0 + stride] - 4 * dx[k0];
        const ly = dy[k0 - 1] + dy[k0 + 1] + dy[k0 - stride] + dy[k0 + stride] - 4 * dy[k0];
        vx[k0] += (-k * (dx[k0] - tx) - c * vx[k0] + kc * lx) * DT;
        vy[k0] += (-k * (dy[k0] - ty) - c * vy[k0] + kc * ly) * DT;
      }
    }
    // 위치는 속도를 전부 구한 뒤에 옮긴다. 한 루프에서 같이 옮기면 이웃 결합이 비대칭이 되어 진동이 커진다.
    for (let k0 = 0; k0 < n; k0++) {
      if (!free[k0]) continue;
      dx[k0] += vx[k0] * DT;
      dy[k0] += vy[k0] * DT;
      const e = Math.abs(dx[k0]) + Math.abs(dy[k0]) + (Math.abs(vx[k0]) + Math.abs(vy[k0])) * 0.02;
      if (e > energy) energy = e;
    }
    return energy;
  }

  function settle() {
    dx.fill(0); dy.fill(0); vx.fill(0); vy.fill(0);
  }

  // ---------- 루프 ----------
  let running = false, lastT = 0, acc = 0;
  function wake() {
    if (running) return;
    running = true; lastT = performance.now(); acc = 0;
    requestAnimationFrame(frame);
  }
  function frame(t) {
    acc += Math.min(0.05, (t - lastT) / 1000); lastT = t;
    let energy = 1;
    while (acc >= DT) { energy = step(); acc -= DT; }
    if (grabs.size === 0 && energy < 2e-5) { settle(); running = false; }
    render();
    if (running) requestAnimationFrame(frame);
  }

  // ---------- 그리기 ----------
  let imgRect = { x: 0, y: 0, w: 1, h: 1 }; // 스테이지 안에서 사진이 차지하는 CSS 픽셀 영역

  function layout() {
    const r = stage.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    let iw, ih;
    if (A > r.height / r.width) { ih = r.height; iw = ih / A; } else { iw = r.width; ih = iw * A; }
    imgRect = { x: (r.width - iw) / 2, y: (r.height - ih) / 2, w: iw, h: ih };
    gl.uniform2f(locO, -1 + (2 * imgRect.x) / r.width, 1 - (2 * imgRect.y) / r.height);
    gl.uniform2f(locS, (2 * imgRect.w) / r.width, (2 * imgRect.h) / r.height / A);
    placeRegions();
    render();
  }

  function render() {
    if (!n) return;
    for (let k = 0; k < n; k++) { pos[k * 2] = restX[k] + dx[k]; pos[k * 2 + 1] = restY[k] + dy[k]; }
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.enableVertexAttribArray(locUV);
    gl.vertexAttribPointer(locUV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
  }

  function uploadTexture() {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
    // 2의 거듭제곱이 아닌 크기의 텍스처는 WebGL1에서 CLAMP + 밉맵 없음이어야 한다
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  // drawable: HTMLImageElement | ImageBitmap | HTMLCanvasElement
  function setImage(drawable, sw, sh, newRegions) {
    const maxSide = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const s = Math.min(1, maxSide / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * s)); c.height = Math.max(1, Math.round(sh * s));
    c.getContext('2d').drawImage(drawable, 0, 0, c.width, c.height);
    srcCanvas = c;
    A = c.height / c.width;
    regions = newRegions || defaultRegions();
    grabs.clear();
    uploadTexture();
    buildMesh();
    buildRegionEls();
    layout();
  }

  // ---------- 사진 불러오기 (기기 안에서만 처리) ----------
  async function loadFile(file) {
    try {
      let drawable, sw, sh;
      if ('createImageBitmap' in window) {
        try { drawable = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* 아래 대체 경로 */ }
      }
      if (drawable) { sw = drawable.width; sh = drawable.height; }
      else {
        const url = URL.createObjectURL(file);
        try {
          drawable = await new Promise((res, rej) => {
            const im = new Image();
            im.onload = () => res(im); im.onerror = rej; im.src = url;
          });
        } finally { URL.revokeObjectURL(url); }
        sw = drawable.naturalWidth; sh = drawable.naturalHeight;
      }
      setImage(drawable, sw, sh, null);
      if (drawable.close) drawable.close();
    } catch (e) {
      console.error(e);
      const kind = (file.type || file.name.split('.').pop() || '알 수 없음').replace('image/', '').toUpperCase();
      toast(`이 사진(${kind}, ${Math.round(file.size / 1024)}KB)은 열 수 없어요. JPG로 다시 시도해 보세요`);
      return;
    }
    await autoPlaceCheeks();
  }

  // ---------- 자동 볼 인식 (MediaPipe Face Landmarker, 기기 안에서만 실행) ----------
  // 모델과 wasm은 vendor/mediapipe에 자체 호스팅한다. 외부 CDN이나 서버로 사진이 나가지 않는다.
  const MP = './vendor/mediapipe/';
  let landmarkerP = null;
  function getLandmarker() {
    if (!landmarkerP) {
      landmarkerP = (async () => {
        const { FaceLandmarker } = await import(MP + 'vision_bundle.mjs');
        return FaceLandmarker.createFromOptions(
          { wasmLoaderPath: MP + 'vision_wasm_internal.js', wasmBinaryPath: MP + 'vision_wasm_internal.wasm' },
          {
            baseOptions: { modelAssetPath: MP + 'face_landmarker.task', delegate: 'CPU' },
            runningMode: 'IMAGE',
            numFaces: 4,
          },
        );
      })();
      landmarkerP.catch(() => { landmarkerP = null; }); // 실패하면 다음에 다시 시도
    }
    return landmarkerP;
  }

  // 얼굴 메시 468점 중 볼 가운데를 둘러싼 점들. 평균을 볼 중심으로 쓴다. (사진 기준 왼쪽 / 오른쪽)
  const CHEEK_SETS = [[50, 187, 205], [280, 411, 425]];
  const FACE_EDGE = [234, 454];   // 얼굴 좌우 끝. 이 폭으로 볼 크기를 정한다.
  const CHEEK_R_RATIO = 0.19;     // 볼 원 반지름 = 얼굴 폭 × 이 값
  const MIN_FACE = 0.05;          // 사진 가로 대비 이보다 작은 얼굴(배경 속 행인 등)은 무시

  // 얼굴마다 { W: 얼굴 폭, box: 얼굴 경계 상자, cheeks: [볼 두 개] }. 큰 얼굴부터.
  // 인식기는 가까이서 찍은 큰 얼굴용이라 단체 사진의 작은 얼굴을 놓친다.
  // 그래서 전체에서 찾은 얼굴이 작거나 없으면, 사진을 겹치는 3×3 조각으로 나눠 한 번 더 찾는다.
  const TILE_IF_FACE_UNDER = 0.35;
  async function detectFaces(source) {
    const lm = await getLandmarker();
    let faces = facesFrom(lm.detect(source), 0, 0, 1, A);
    if (!faces.length || faces[0].W < TILE_IF_FACE_UNDER) {
      const px = source.width, tw = 0.5, th = 0.5 * A;
      const c = document.createElement('canvas');
      c.width = Math.round(tw * px); c.height = Math.round(th * px);
      const g = c.getContext('2d');
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
        const x0 = i * 0.25, y0 = j * 0.25 * A;
        g.drawImage(source, x0 * px, y0 * px, c.width, c.height, 0, 0, c.width, c.height);
        for (const f of facesFrom(lm.detect(c), x0, y0, tw, th)) {
          // 이미 찾은 얼굴과 겹치면 버린다
          const cx = (f.box.x0 + f.box.x1) / 2, cy = (f.box.y0 + f.box.y1) / 2;
          const dup = faces.some((e) => Math.hypot((e.box.x0 + e.box.x1) / 2 - cx, (e.box.y0 + e.box.y1) / 2 - cy) < Math.max(e.W, f.W) * 0.5);
          if (!dup) faces.push(f);
        }
      }
      faces.sort((p, q) => q.W - p.W);
    }
    return faces.slice(0, 6);
  }

  // 인식 결과(조각 기준 정규화 좌표)를 이미지 공간으로 옮긴다. 조각은 (x0, y0)에서 가로 tw, 세로 th.
  function facesFrom(res, x0, y0, tw, th) {
    const faces = [];
    for (const f of res.faceLandmarks || []) {
      const P = (i) => ({ x: x0 + f[i].x * tw, y: y0 + f[i].y * th });
      const a = P(FACE_EDGE[0]), b = P(FACE_EDGE[1]);
      const W = Math.hypot(a.x - b.x, a.y - b.y);
      if (W < MIN_FACE) continue;
      const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (let i = 0; i < f.length; i++) {
        const p = P(i);
        box.x0 = Math.min(box.x0, p.x); box.x1 = Math.max(box.x1, p.x);
        box.y0 = Math.min(box.y0, p.y); box.y1 = Math.max(box.y1, p.y);
      }
      const r = Math.min(0.45, Math.max(0.02, W * CHEEK_R_RATIO));
      const cheeks = CHEEK_SETS.map((set) => {
        let x = 0, y = 0;
        for (const i of set) { const p = P(i); x += p.x; y += p.y; }
        return { cx: x / set.length, cy: y / set.length, r };
      });
      faces.push({ W, box, cheeks });
    }
    return faces.sort((p, q) => q.W - p.W);
  }

  // 얼굴이 작게 찍힌 사진은 볼이 손가락보다 작아 잡기 어렵다. 얼굴 쪽을 잘라 크게 보여준다.
  // 원본 파일은 건드리지 않고, 화면에 쓰는 텍스처만 다시 만든다.
  const TARGET_FACE = 0.5;  // 확대 후 얼굴 폭이 화면 사진 가로의 이 비율이 되게
  function cropToFaces(faces) {
    const u = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const f of faces) {
      u.x0 = Math.min(u.x0, f.box.x0); u.y0 = Math.min(u.y0, f.box.y0);
      u.x1 = Math.max(u.x1, f.box.x1); u.y1 = Math.max(u.y1, f.box.y1);
    }
    let w = Math.max((u.x1 - u.x0) * 1.35, faces[0].W / TARGET_FACE);
    let h = w * 1.25; // 세로로 약간 긴 화면에 맞춘 4:5
    if (w >= 0.9 || (w >= 1 && h >= A)) return null; // 거의 안 잘리면 그대로
    w = Math.min(1, w); h = Math.min(A, h);
    const cx = (u.x0 + u.x1) / 2, cy = (u.y0 + u.y1) / 2;
    const x0 = Math.min(1 - w, Math.max(0, cx - w / 2));
    const y0 = Math.min(A - h, Math.max(0, cy - h / 2));
    const px = srcCanvas.width; // 이미지 공간 1 = 가로 픽셀 수
    const c = document.createElement('canvas');
    c.width = Math.round(w * px); c.height = Math.round(h * px);
    c.getContext('2d').drawImage(srcCanvas, x0 * px, y0 * px, c.width, c.height, 0, 0, c.width, c.height);
    const regs = faces.flatMap((f) => f.cheeks).map((g) => ({ cx: (g.cx - x0) / w, cy: (g.cy - y0) / w, r: g.r / w }));
    return { canvas: c, regions: regs };
  }

  let detecting = false, detectToken = 0;
  async function autoPlaceCheeks() {
    const token = ++detectToken;
    detecting = true;
    $('#busy').hidden = false;
    hintEl.textContent = '볼 찾는 중…';
    let faces = null;
    try { faces = await detectFaces(srcCanvas); } catch (e) { console.error(e); }
    if (token !== detectToken) return; // 그 사이 다른 사진을 불러왔다
    detecting = false;
    $('#busy').hidden = true;
    if (faces && faces.length) {
      const crop = cropToFaces(faces);
      if (crop) setImage(crop.canvas, crop.canvas.width, crop.canvas.height, crop.regions);
      else { regions = faces.flatMap((f) => f.cheeks); settle(); updateFree(); buildRegionEls(); }
      setEditing(false);
      toast(faces.length > 1 ? `얼굴 ${faces.length}개를 찾았어요! 볼을 잡고 당겨보세요` : '볼을 찾았어요! 잡고 당겨보세요');
    } else {
      setEditing(true);
      toast(faces ? '얼굴을 못 찾았어요. 원을 볼 위로 옮겨주세요' : '자동 인식을 못 했어요. 원을 볼 위로 옮겨주세요');
    }
  }

  // 사진이 없을 때 바로 만져볼 수 있는 연습용 얼굴. 배경 격자는 "배경이 같이 늘어나는지" 확인용.
  function makeSample() {
    const W = 900, H = 1200;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#cfe3ea'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#a9c6d1'; g.lineWidth = 3;
    for (let x = 0; x <= W; x += 60) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (let y = 0; y <= H; y += 60) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    g.fillStyle = '#5b7fa6'; g.beginPath(); g.ellipse(450, 1230, 380, 260, 0, 0, 7); g.fill(); // 어깨
    g.fillStyle = '#f2c6a5'; g.fillRect(385, 840, 130, 160);                                   // 목
    g.fillStyle = '#3a2a22'; g.beginPath(); g.ellipse(450, 520, 335, 360, 0, 0, 7); g.fill(); // 머리카락
    g.fillStyle = '#f7d2b4'; g.beginPath(); g.ellipse(450, 600, 290, 330, 0, 0, 7); g.fill(); // 얼굴
    g.fillStyle = '#3a2a22'; g.beginPath(); g.ellipse(450, 330, 290, 130, 0, Math.PI, 0); g.fill(); // 앞머리
    g.fillStyle = 'rgba(255,120,120,.45)';
    g.beginPath(); g.ellipse(290, 700, 78, 60, 0, 0, 7); g.fill();
    g.beginPath(); g.ellipse(610, 700, 78, 60, 0, 0, 7); g.fill();
    g.fillStyle = '#2a1d18';
    g.beginPath(); g.ellipse(340, 560, 26, 34, 0, 0, 7); g.fill();
    g.beginPath(); g.ellipse(560, 560, 26, 34, 0, 0, 7); g.fill();
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(349, 548, 9, 0, 7); g.fill();
    g.beginPath(); g.arc(569, 548, 9, 0, 7); g.fill();
    g.strokeStyle = '#2a1d18'; g.lineWidth = 9; g.lineCap = 'round';
    g.beginPath(); g.moveTo(300, 490); g.quadraticCurveTo(340, 465, 385, 488); g.stroke();
    g.beginPath(); g.moveTo(515, 488); g.quadraticCurveTo(560, 465, 600, 490); g.stroke();
    g.strokeStyle = '#d9a583'; g.lineWidth = 7;
    g.beginPath(); g.moveTo(450, 610); g.quadraticCurveTo(432, 680, 458, 690); g.stroke();
    g.strokeStyle = '#b5443f'; g.lineWidth = 10;
    g.beginPath(); g.moveTo(385, 770); g.quadraticCurveTo(450, 830, 515, 770); g.stroke();
    return c;
  }

  // ---------- 좌표 변환 ----------
  function toImg(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    return {
      x: (clientX - r.left - imgRect.x) / imgRect.w,
      y: (clientY - r.top - imgRect.y) / imgRect.w, // 세로도 "가로 = 1" 단위
    };
  }

  // ---------- 잡아당기기 입력 (여러 손가락 동시) ----------
  canvas.addEventListener('pointerdown', (e) => {
    if (editing || detecting) return;
    stopDemo();
    const p = toImg(e.clientX, e.clientY);
    if (!beginGrab(e.pointerId, p.x, p.y)) {
      if (grabs.size === 0) toast('볼 부분을 잡아보세요 (위치는 "볼 위치"에서 조정)');
      return;
    }
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 합성 이벤트 */ }
    buzz(12);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!grabs.has(e.pointerId)) return;
    const p = toImg(e.clientX, e.clientY);
    moveGrab(e.pointerId, p.x, p.y);
  });
  let releases = 0;
  const release = (e) => {
    if (!endGrab(e.pointerId)) return;
    buzz(8);
    releases++;
    onUserRelease();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // 안드로이드: navigator.vibrate. iOS 사파리는 vibrate가 없으므로 switch 체크박스 토글로 시스템 햅틱을 빌린다(iOS 18+, 강도 조절 불가).
  const iosHaptic = $('#iosHaptic');
  function buzz(ms) {
    if (!settings.haptic) return;
    if (navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* 무시 */ } return; }
    if (iosHaptic) { try { iosHaptic.click(); } catch { /* 무시 */ } }
  }

  // ---------- 볼 영역 편집 ----------
  let editing = false;

  let selected = 0; // 편집 중인 볼 번호
  function buildRegionEls() {
    regionsEl.innerHTML = '';
    selected = Math.min(selected, Math.max(0, regions.length - 1));
    regions.forEach((reg, i) => {
      const el = document.createElement('div');
      el.className = 'region' + (i === selected ? ' selected' : '');
      el.innerHTML = `<span class="tag">볼 ${i + 1}</span><i class="handle"></i>`;
      regionsEl.appendChild(el);

      let mode = null, offX = 0, offY = 0;
      el.addEventListener('pointerdown', (e) => {
        if (!editing) return;
        selectRegion(i);
        mode = e.target.classList.contains('handle') ? 'resize' : 'move';
        const p = toImg(e.clientX, e.clientY);
        offX = p.x - reg.cx; offY = p.y - reg.cy;
        el.setPointerCapture(e.pointerId);
        e.preventDefault(); e.stopPropagation();
      });
      el.addEventListener('pointermove', (e) => {
        if (!mode) return;
        const p = toImg(e.clientX, e.clientY);
        if (mode === 'move') {
          reg.cx = Math.min(1, Math.max(0, p.x - offX));
          reg.cy = Math.min(A, Math.max(0, p.y - offY));
        } else {
          reg.r = Math.min(0.45, Math.max(0.03, Math.hypot(p.x - reg.cx, p.y - reg.cy)));
        }
        placeRegions(); syncEditPanel();
      });
      const up = () => { mode = null; };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    placeRegions();
  }

  function placeRegions() {
    const els = regionsEl.children;
    regions.forEach((reg, i) => {
      const el = els[i]; if (!el) return;
      const rp = reg.r * imgRect.w;
      el.style.left = imgRect.x + reg.cx * imgRect.w - rp + 'px';
      el.style.top = imgRect.y + reg.cy * imgRect.w - rp + 'px';
      el.style.width = el.style.height = rp * 2 + 'px';
    });
  }

  // ---------- 볼 위치 편집 패널 (탭 · 방향 버튼 · 크기 슬라이더) ----------
  const NUDGE = 0.01; // 한 번 누를 때 이동량 (사진 가로의 1%)
  function selectRegion(i) {
    selected = i;
    [...regionsEl.children].forEach((el, k) => el.classList.toggle('selected', k === i));
    syncEditPanel();
  }
  function syncEditPanel() {
    const tabs = $('#regionTabs');
    if (tabs.children.length !== regions.length) {
      tabs.innerHTML = '';
      regions.forEach((_, i) => {
        const b = document.createElement('button');
        b.className = 'chip'; b.textContent = `볼 ${i + 1}`;
        b.addEventListener('click', () => selectRegion(i));
        tabs.appendChild(b);
      });
    }
    [...tabs.children].forEach((b, i) => b.classList.toggle('on', i === selected));
    const reg = regions[selected];
    if (!reg) return;
    $('#sSize').value = reg.r;
    $('#oSize').textContent = Math.round(reg.r * imgRect.w) + 'px';
  }
  function nudge(dx, dy) {
    const reg = regions[selected]; if (!reg) return;
    reg.cx = Math.min(1, Math.max(0, reg.cx + dx * NUDGE));
    reg.cy = Math.min(A, Math.max(0, reg.cy + dy * NUDGE));
    placeRegions();
  }
  function setSize(r) {
    const reg = regions[selected]; if (!reg) return;
    reg.r = Math.min(0.45, Math.max(0.03, r));
    placeRegions(); syncEditPanel();
  }
  // 방향 버튼: 누르면 한 칸, 길게 누르면 계속
  for (const b of document.querySelectorAll('.dbtn')) {
    const dx = +b.dataset.dx, dy = +b.dataset.dy;
    let hold = 0, rep = 0;
    const stop = () => { clearTimeout(hold); clearInterval(rep); hold = rep = 0; };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      nudge(dx, dy);
      hold = setTimeout(() => { rep = setInterval(() => nudge(dx, dy), 60); }, 350);
    });
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(t, stop);
  }
  $('#sSize').addEventListener('input', (e) => setSize(parseFloat(e.target.value)));
  $('#sizeDown').addEventListener('click', () => setSize(regions[selected].r * 0.92));
  $('#sizeUp').addEventListener('click', () => setSize(regions[selected].r * 1.08));

  function setEditing(on) {
    editing = on;
    if (on) { finishOnboarding(); clearGrabs(); settle(); render(); $('#sheet').hidden = true; $('#pick').hidden = true; }
    else { updateFree(); }
    $('#editPanel').hidden = !on;
    if (on) { selectRegion(Math.min(selected, regions.length - 1)); }
    regionsEl.classList.toggle('editing', on);
    regionsEl.classList.toggle('ghost', !on && settings.show);
    hintEl.textContent = on ? '볼 위치를 맞추는 중' : '볼을 누른 채로 당겼다가 놓아보세요';
    layout(); // 패널이 열리고 닫히면 사진 크기가 바뀐다
  }

  // ---------- UI ----------
  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1800);
  }

  // 사진 가져오기: 갤러리(사진 앱)와 카메라를 명확한 선택지로 보여준다.
  // 갤럭시는 갤러리·내 파일·카메라 중 고르는 창이, 아이폰은 사진 보관함·촬영·파일 선택 창이 뜬다.
  function pickPhoto() {
    getLandmarker().catch(() => { /* 사진 고르는 동안 모델을 미리 받는다. 실패는 인식 단계에서 처리 */ });
    $('#sheet').hidden = true;
    $('#pick').hidden = false;
  }
  function openInput(id) {
    $('#pick').hidden = true;
    const inp = $(id);
    inp.value = '';
    try { inp.showPicker ? inp.showPicker() : inp.click(); } catch { inp.click(); }
  }
  $('#pickGallery').addEventListener('click', () => openInput('#file'));
  $('#pickCamera').addEventListener('click', () => openInput('#fileCam'));
  $('#pickClose').addEventListener('click', () => { $('#pick').hidden = true; });
  $('#btnPhoto').addEventListener('click', () => { finishOnboarding(); pickPhoto(); });
  $('#btnHelp').addEventListener('click', () => {
    if (editing) setEditing(false);
    $('#sheet').hidden = true;
    startOnboarding();
  });
  $('#btnFeedback').addEventListener('click', () => { hideCoach(); openFeedback(); });

  function openFeedback() {
    if (!FEEDBACK_URL) { toast('의견 링크가 아직 준비되지 않았어요'); return; }
    window.open(FEEDBACK_URL, '_blank', 'noopener');
  }

  // ---------- 안내 카드 ----------
  const coachEl = $('#coach');
  function showCoach(text, buttons) {
    $('#coachText').textContent = text;
    const box = $('#coachBtns');
    box.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = 'btn' + (b.primary ? ' primary' : '');
      el.textContent = b.label;
      el.addEventListener('click', b.onClick);
      box.appendChild(el);
    }
    coachEl.hidden = false;
  }
  function hideCoach() { coachEl.hidden = true; }

  // ---------- 첫 사용 안내 ----------
  // 1단계: 시범 손가락이 볼을 당겼다 놓는 걸 반복해서 보여준다 → 사용자가 직접 한 번 당겼다 놓으면
  // 2단계: 양볼 동시 당기기와 내 사진 넣기를 알려준다.
  let coachStep = 0;
  function startOnboarding() {
    coachStep = 1;
    showCoach('볼을 꾹 잡고 당겼다가 놓아보세요', []);
    startDemo();
  }
  function finishOnboarding() {
    if (!coachStep) return;
    coachStep = 0;
    hideCoach(); stopDemo();
    setFlag('cheek.onboarded');
  }
  function onUserRelease() {
    if (coachStep === 1) {
      coachStep = 2;
      hideCoach();
      setTimeout(() => {
        if (coachStep !== 2) return;
        showCoach('좋아요! 두 손가락으로 양볼을 동시에 당길 수도 있어요', [
          { label: '내 사진으로 해보기', primary: true, onClick: () => { finishOnboarding(); pickPhoto(); } },
          { label: '계속 만지기', onClick: finishOnboarding },
        ]);
      }, 900);
      return;
    }
    if (!coachStep && FEEDBACK_URL && releases >= NUDGE_AFTER && !flag('cheek.nudged')) {
      setFlag('cheek.nudged');
      showCoach('재밌게 만지셨나요? 1분이면 끝나는 의견을 남겨주시면 큰 도움이 돼요', [
        { label: '의견 보내기', primary: true, onClick: () => { hideCoach(); openFeedback(); } },
        { label: '나중에', onClick: hideCoach },
      ]);
    }
  }

  // 시범 손가락: 가짜 포인터(id -1)로 실제 물리를 그대로 돌린다
  const fingerEl = $('#finger');
  const DEMO_ID = -1;
  let demo = null;
  function showFinger(x, y, down) {
    fingerEl.hidden = false;
    fingerEl.style.left = imgRect.x + x * imgRect.w + 'px';
    fingerEl.style.top = imgRect.y + y * imgRect.w + 'px';
    fingerEl.classList.toggle('down', down);
    fingerEl.classList.toggle('up', !down);
  }
  function startDemo() {
    stopDemo();
    const reg = regions[0];
    if (!reg) return;
    const d = { alive: true, timer: 0 };
    demo = d;
    const cycle = () => {
      if (!d.alive) return;
      const sx = reg.cx, sy = reg.cy;
      const tx = sx - reg.r * 0.9, ty = sy + reg.r * 0.35;
      showFinger(sx, sy, false);
      d.timer = setTimeout(() => {
        if (!d.alive || !beginGrab(DEMO_ID, sx, sy)) return;
        showFinger(sx, sy, true);
        const t0 = performance.now();
        const pull = (t) => {
          if (!d.alive) return;
          const u = Math.min(1, (t - t0) / 650);
          const ease = 1 - Math.pow(1 - u, 3);
          const x = sx + (tx - sx) * ease, y = sy + (ty - sy) * ease;
          moveGrab(DEMO_ID, x, y);
          showFinger(x, y, true);
          if (u < 1) { requestAnimationFrame(pull); return; }
          d.timer = setTimeout(() => {
            if (!d.alive) return;
            endGrab(DEMO_ID);
            showFinger(x, y, false);
            d.timer = setTimeout(cycle, 1700);
          }, 350);
        };
        requestAnimationFrame(pull);
      }, 350);
    };
    d.timer = setTimeout(cycle, 500);
  }
  function stopDemo() {
    if (!demo) return;
    demo.alive = false;
    clearTimeout(demo.timer);
    demo = null;
    endGrab(DEMO_ID);
    fingerEl.hidden = true;
  }
  for (const id of ['#file', '#fileCam']) {
    $(id).addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) { stopDemo(); loadFile(f); }
      e.target.value = '';
    });
  }
  $('#btnEdit').addEventListener('click', () => setEditing(!editing));
  $('#editDone').addEventListener('click', () => setEditing(false));
  $('#btnFeel').addEventListener('click', () => { $('#pick').hidden = true; if (editing) setEditing(false); $('#sheet').hidden = !$('#sheet').hidden; });
  $('#sheetClose').addEventListener('click', () => { $('#sheet').hidden = true; });

  const sliders = [
    ['#sFreq', '#oFreq', 'freq', (v) => v.toFixed(1) + ' Hz'],
    ['#sWobble', '#oWobble', 'wobble', (v) => Math.round(v * 100) + '%'],
    ['#sStretch', '#oStretch', 'stretch', (v) => Math.round(v * 100) + '%' + (v > 0.7 ? ' (접힐 수 있음)' : '')],
    ['#sGrab', '#oGrab', 'grab', (v) => Math.round(v * 100) + '%'],
  ];
  const checks = [['#cMask', 'mask'], ['#cShow', 'show'], ['#cHaptic', 'haptic']];

  function syncUI() {
    for (const [s, o, key, fmt] of sliders) { $(s).value = settings[key]; $(o).textContent = fmt(settings[key]); }
    for (const [s, key] of checks) $(s).checked = settings[key];
  }
  for (const [s, o, key, fmt] of sliders) {
    $(s).addEventListener('input', (e) => {
      settings[key] = parseFloat(e.target.value);
      $(o).textContent = fmt(settings[key]);
      saveJSON('cheek.settings', settings);
    });
  }
  for (const [s, key] of checks) {
    $(s).addEventListener('change', (e) => {
      settings[key] = e.target.checked;
      saveJSON('cheek.settings', settings);
      if (key === 'mask') { settle(); updateFree(); render(); }
      if (key === 'show') regionsEl.classList.toggle('ghost', !editing && settings.show);
    });
  }
  $('#btnReset').addEventListener('click', () => {
    Object.assign(settings, DEFAULTS);
    saveJSON('cheek.settings', settings);
    syncUI(); settle(); updateFree(); render();
    regionsEl.classList.toggle('ghost', !editing && settings.show);
  });

  // ---------- 시작 ----------
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); running = false; });
  canvas.addEventListener('webglcontextrestored', () => {
    initGL(); uploadTexture(); buildMesh(); layout();
  });

  initGL();
  syncUI();
  const sample = makeSample();
  // 연습용 얼굴의 볼터치 위치에 맞춘 기본 영역
  setImage(sample, sample.width, sample.height, [
    { cx: 290 / 900, cy: 700 / 900, r: 0.115 },
    { cx: 610 / 900, cy: 700 / 900, r: 0.115 },
  ]);
  setEditing(false);
  new ResizeObserver(layout).observe(stage);
  if (!flag('cheek.onboarded')) startOnboarding();

  // 디버그/자동 검증용
  window.__cheek = {
    settings, grabs, detectFaces, beginGrab, moveGrab, endGrab, step, render, toImg,
    get state() { return { n, cols, rows, A, dx, dy, vx, vy, free, regions, imgRect, running, detecting, coachStep, editing, selected }; },
  };
})();
