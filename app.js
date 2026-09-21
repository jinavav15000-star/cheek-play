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
  const DEFAULTS = { freq: 4, wobble: 0.75, stretch: 0.6, grab: 1.0, mask: true, show: false, haptic: true };
  const settings = { ...DEFAULTS, ...loadJSON('cheek.settings') };

  function loadJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
  }
  function saveJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 사생활 보호 모드 등 */ }
  }

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
        if (d < r.r * GRAB_HIT && d < best) { best = d; reg = r; }
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
      setEditing(true);
    } catch (e) {
      console.error(e);
      toast('이 사진 형식은 열 수 없어요 (JPG/PNG로 시도해 보세요)');
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
    if (editing) return;
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
  const release = (e) => { if (endGrab(e.pointerId)) buzz(8); };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function buzz(ms) {
    if (settings.haptic && navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* 무시 */ } }
  }

  // ---------- 볼 영역 편집 ----------
  let editing = false;

  function buildRegionEls() {
    regionsEl.innerHTML = '';
    regions.forEach((reg, i) => {
      const el = document.createElement('div');
      el.className = 'region';
      el.innerHTML = `<span class="tag">볼 ${i + 1}</span><i class="handle"></i>`;
      regionsEl.appendChild(el);

      let mode = null, offX = 0, offY = 0;
      el.addEventListener('pointerdown', (e) => {
        if (!editing) return;
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
          reg.r = Math.min(0.45, Math.max(0.04, Math.hypot(p.x - reg.cx, p.y - reg.cy)));
        }
        placeRegions();
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

  function setEditing(on) {
    editing = on;
    if (on) { clearGrabs(); settle(); render(); }
    else { updateFree(); }
    $('#editBar').hidden = !on;
    regionsEl.classList.toggle('editing', on);
    regionsEl.classList.toggle('ghost', !on && settings.show);
    hintEl.textContent = on ? '볼 위치를 맞추는 중' : '볼을 누른 채로 당겼다가 놓아보세요';
  }

  // ---------- UI ----------
  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1800);
  }

  $('#btnPhoto').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadFile(f);
    e.target.value = '';
  });
  $('#btnEdit').addEventListener('click', () => setEditing(!editing));
  $('#editDone').addEventListener('click', () => setEditing(false));
  $('#btnFeel').addEventListener('click', () => { $('#sheet').hidden = !$('#sheet').hidden; });
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

  // 디버그/자동 검증용
  window.__cheek = {
    settings, grabs, beginGrab, moveGrab, endGrab, step, render, toImg,
    get state() { return { n, cols, rows, A, dx, dy, vx, vy, free, regions, imgRect, running }; },
  };
})();
