'use strict';

/* =====================================================
 * 점프! 점프! — 두들 점프 스타일 무한 점프 게임
 *
 * 캐릭터 교체 방법:
 *   assets/character/ 폴더에 아래 파일을 넣으면 자동 적용됩니다.
 *     - jump-left.png  : 왼쪽을 보는 기본 모습 (필수)
 *     - jump-right.png : 오른쪽을 보는 모습 (없으면 좌우반전 사용)
 *     - shoot.png      : 위로 발사할 때 모습 (선택)
 *   파일이 없으면 내장 임시 캐릭터가 그려집니다.
 * ===================================================== */

// ---------- 기준 좌표계 (논리 해상도) ----------
const W = 360;           // 논리 폭
const H = 640;           // 논리 높이

// ---------- 물리 상수 ----------
const GRAVITY = 0.35;
const JUMP_VY = -11.5;      // 기본 점프 속도
const SPRING_VY = -19;      // 스프링
const JETPACK_VY = -14;     // 제트팩 지속 상승 속도
const JETPACK_TIME = 150;   // 제트팩 지속 프레임
const MOVE_ACC = 0.55;      // 좌우 가속
const MOVE_MAX = 6;         // 좌우 최대 속도
const MOVE_FRICTION = 0.90; // 좌우 감쇠
const BULLET_VY = -12;

// ---------- 발판 ----------
const PLAT_W = 62;
const PLAT_H = 14;

const PlatType = {
  NORMAL: 'normal',     // 초록: 일반
  MOVING: 'moving',     // 파랑: 좌우 이동
  BREAKING: 'breaking', // 갈색: 밟으면 부서짐 (점프 불가)
  ONESHOT: 'oneshot',   // 흰색: 한 번 밟으면 사라짐
};

// ---------- 유틸 ----------
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- 캔버스 ----------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let scale = 1;

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  scale = canvas.width / W;
}
window.addEventListener('resize', resize);
resize();

// ---------- 캐릭터 이미지 로딩 (없으면 내장 그림) ----------
const charImgs = { left: null, right: null, shoot: null };
function tryLoadImage(src) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
  });
}
(async () => {
  charImgs.left = await tryLoadImage('assets/character/jump-left.png');
  charImgs.right = await tryLoadImage('assets/character/jump-right.png');
  charImgs.shoot = await tryLoadImage('assets/character/shoot.png');
})();

// ---------- 사운드 (Web Audio 간단 효과음) ----------
let audioCtx = null;
function beep(freq, dur = 0.08, type = 'square', vol = 0.15) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch (e) { /* 사운드 실패는 무시 */ }
}
const sfx = {
  jump: () => beep(500, 0.07, 'square', 0.12),
  spring: () => beep(760, 0.15, 'square', 0.15),
  jetpack: () => beep(220, 0.4, 'sawtooth', 0.1),
  break: () => beep(160, 0.12, 'triangle', 0.15),
  shoot: () => beep(880, 0.05, 'square', 0.08),
  hit: () => beep(320, 0.1, 'sawtooth', 0.12),
  die: () => beep(120, 0.5, 'sawtooth', 0.2),
};

// ---------- 게임 상태 ----------
const State = { MENU: 0, PLAYING: 1, PAUSED: 2, OVER: 3 };
let state = State.MENU;

let player, platforms, monsters, bullets, particles, items;
let cameraY;          // 월드 기준 카메라 상단 y
let score, best;
let jetpackTimer;     // 남은 제트팩 프레임
let shootPose;        // 발사 포즈 표시 프레임
let highestPlatY;     // 지금까지 생성한 가장 높은(작은 y) 발판
let frame = 0;

best = Number(localStorage.getItem('jump-best') || 0);

// ---------- 입력 ----------
const input = { left: false, right: false, tilt: 0 };

window.addEventListener('keydown', (e) => {
  if (e.code === 'ArrowLeft') input.left = true;
  if (e.code === 'ArrowRight') input.right = true;
  if (e.code === 'Space') {
    e.preventDefault();
    if (state === State.PLAYING) shoot();
  }
  if (e.code === 'Escape' && state === State.PLAYING) pauseGame();
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowLeft') input.left = false;
  if (e.code === 'ArrowRight') input.right = false;
});

// 터치: 화면 좌/우 절반 누르면 이동, 위쪽 짧은 탭은 발사
let touchSide = null;
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (state !== State.PLAYING) return;
  const rect = canvas.getBoundingClientRect();
  const t = e.changedTouches[0];
  const x = t.clientX - rect.left;
  const y = t.clientY - rect.top;
  if (y < rect.height * 0.25) {
    shoot();
    return;
  }
  touchSide = x < rect.width / 2 ? 'left' : 'right';
  input.left = touchSide === 'left';
  input.right = touchSide === 'right';
}, { passive: false });
canvas.addEventListener('touchend', (e) => {
  e.preventDefault();
  touchSide = null;
  input.left = false;
  input.right = false;
}, { passive: false });

// 기울기 (모바일)
window.addEventListener('deviceorientation', (e) => {
  if (e.gamma != null) input.tilt = clamp(e.gamma / 15, -1, 1);
});

// iOS 13+ 은 사용자 제스처에서 권한 요청 필요
function requestTilt() {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().catch(() => {});
  }
}

// ---------- 게임 초기화 ----------
function newGame() {
  player = {
    x: W / 2, y: H - 120,
    vx: 0, vy: JUMP_VY,
    w: 46, h: 46,
    facing: 'left',
    dead: false,
  };
  platforms = [];
  monsters = [];
  bullets = [];
  particles = [];
  items = [];
  cameraY = 0;
  score = 0;
  jetpackTimer = 0;
  shootPose = 0;
  frame = 0;

  // 시작 발판: 바닥 근처에 촘촘히
  platforms.push(makePlatform(W / 2 - PLAT_W / 2, H - 60, PlatType.NORMAL));
  highestPlatY = H - 60;
  while (highestPlatY > -H) spawnPlatformRow();
}

function makePlatform(x, y, type) {
  return {
    x, y, w: PLAT_W, h: PLAT_H, type,
    vx: type === PlatType.MOVING ? rand(1, 2.2) * (Math.random() < 0.5 ? -1 : 1) : 0,
    broken: false,
    breakAnim: 0,
    spring: false,
    jetpack: false,
  };
}

// 난이도: 높이(점수)에 따라 발판 간격/특수발판 비율 증가
function difficulty() {
  return clamp(score / 4000, 0, 1); // 0 → 1
}

function spawnPlatformRow() {
  const d = difficulty();
  const gap = rand(45 + d * 30, 70 + d * 45); // 간격 점점 벌어짐
  const y = highestPlatY - gap;
  const x = rand(0, W - PLAT_W);

  let type = PlatType.NORMAL;
  const r = Math.random();
  if (r < 0.12 + d * 0.13) type = PlatType.MOVING;
  else if (r < 0.24 + d * 0.2) type = PlatType.ONESHOT;

  const p = makePlatform(x, y, type);

  // 아이템: 일반 발판 위에만
  if (type === PlatType.NORMAL) {
    const ir = Math.random();
    if (ir < 0.06) p.spring = true;
    else if (ir < 0.075) p.jetpack = true;
  }
  platforms.push(p);

  // 부서지는 발판은 근처에 보너스로 추가 (단독 경로가 되지 않게)
  if (Math.random() < 0.10 + d * 0.15) {
    const bx = rand(0, W - PLAT_W);
    const by = y - rand(15, 35);
    if (Math.abs(bx - x) > PLAT_W * 0.8) {
      platforms.push(makePlatform(bx, by, PlatType.BREAKING));
    }
  }

  // 몬스터: 난이도 오르면 등장
  if (score > 800 && Math.random() < 0.035 + d * 0.05) {
    monsters.push({
      x: rand(30, W - 30), y: y - 40,
      w: 40, h: 34,
      vx: rand(0.5, 1.5) * (Math.random() < 0.5 ? -1 : 1),
      dead: false,
      wobble: Math.random() * Math.PI * 2,
    });
  }

  highestPlatY = y;
}

// ---------- 발사 ----------
function shoot() {
  bullets.push({ x: player.x, y: player.y - player.h / 2, vy: BULLET_VY });
  shootPose = 20;
  sfx.shoot();
}

// ---------- 업데이트 ----------
function update() {
  frame++;

  // --- 좌우 이동 ---
  let ax = 0;
  if (input.left) ax -= MOVE_ACC;
  if (input.right) ax += MOVE_ACC;
  ax += input.tilt * MOVE_ACC * 1.6;
  player.vx = clamp((player.vx + ax) * (ax === 0 ? MOVE_FRICTION : 1), -MOVE_MAX, MOVE_MAX);
  player.x += player.vx;
  if (Math.abs(player.vx) > 0.3) player.facing = player.vx < 0 ? 'left' : 'right';

  // 화면 좌우 랩어라운드
  if (player.x < -player.w / 2) player.x = W + player.w / 2;
  if (player.x > W + player.w / 2) player.x = -player.w / 2;

  // --- 중력/제트팩 ---
  if (jetpackTimer > 0) {
    jetpackTimer--;
    player.vy = JETPACK_VY;
    if (frame % 3 === 0) {
      particles.push({
        x: player.x + rand(-6, 6), y: player.y + player.h / 2,
        vx: rand(-1, 1), vy: rand(2, 4), life: 20, color: '#e67e22',
      });
    }
  } else {
    player.vy += GRAVITY;
  }
  player.y += player.vy;

  // --- 발판 충돌 (하강 중일 때만) ---
  if (player.vy > 0 && jetpackTimer <= 0) {
    for (const p of platforms) {
      if (p.broken) continue;
      const px = player.x, pb = player.y + player.h / 2;
      if (px > p.x - 8 && px < p.x + p.w + 8 &&
          pb > p.y && pb < p.y + p.h + player.vy + 1) {
        if (p.type === PlatType.BREAKING) {
          p.broken = true;
          p.breakAnim = 1;
          sfx.break();
          continue; // 튕기지 않고 통과
        }
        player.y = p.y - player.h / 2;
        if (p.jetpack) {
          p.jetpack = false;
          jetpackTimer = JETPACK_TIME;
          sfx.jetpack();
        } else if (p.spring) {
          player.vy = SPRING_VY;
          sfx.spring();
        } else {
          player.vy = JUMP_VY;
          sfx.jump();
        }
        if (p.type === PlatType.ONESHOT) p.broken = true;
        break;
      }
    }
  }

  // --- 발판 이동/정리 ---
  for (const p of platforms) {
    if (p.vx) {
      p.x += p.vx;
      if (p.x < 0 || p.x + p.w > W) p.vx *= -1;
    }
    if (p.breakAnim > 0) p.breakAnim++;
  }

  // --- 몬스터 ---
  for (const m of monsters) {
    if (m.dead) continue;
    m.x += m.vx;
    m.wobble += 0.1;
    if (m.x < 20 || m.x > W - 20) m.vx *= -1;

    // 플레이어 충돌
    const dx = Math.abs(player.x - m.x);
    const dy = player.y - m.y;
    if (dx < (player.w + m.w) / 2 - 8 && Math.abs(dy) < (player.h + m.h) / 2 - 6) {
      if (player.vy > 0 && dy < -4) {
        // 위에서 밟으면 처치
        m.dead = true;
        player.vy = JUMP_VY;
        sfx.hit();
        addBurst(m.x, m.y, '#9b59b6');
      } else {
        gameOver();
        return;
      }
    }
  }

  // --- 총알 ---
  for (const b of bullets) {
    b.y += b.vy;
    for (const m of monsters) {
      if (m.dead) continue;
      if (Math.abs(b.x - m.x) < m.w / 2 && Math.abs(b.y - m.y) < m.h / 2) {
        m.dead = true;
        b.y = -9999;
        sfx.hit();
        addBurst(m.x, m.y, '#9b59b6');
      }
    }
  }
  bullets = bullets.filter((b) => b.y > cameraY - 50);
  if (shootPose > 0) shootPose--;

  // --- 파티클 ---
  for (const pt of particles) {
    pt.x += pt.vx;
    pt.y += pt.vy;
    pt.life--;
  }
  particles = particles.filter((pt) => pt.life > 0);

  // --- 카메라 스크롤 & 점수 ---
  const threshold = cameraY + H * 0.4;
  if (player.y < threshold) {
    const diff = threshold - player.y;
    cameraY -= diff;
    score += Math.round(diff);
  }

  // --- 새 발판 생성 / 화면 아래 정리 ---
  while (highestPlatY > cameraY - 100) spawnPlatformRow();
  platforms = platforms.filter((p) => p.y < cameraY + H + 60 && !(p.broken && p.breakAnim > 30));
  monsters = monsters.filter((m) => m.y < cameraY + H + 80 && !m.dead);

  // --- 낙사 ---
  if (player.y > cameraY + H + player.h) {
    gameOver();
  }
}

function addBurst(x, y, color) {
  for (let i = 0; i < 12; i++) {
    particles.push({
      x, y,
      vx: rand(-3, 3), vy: rand(-3, 3),
      life: rand(15, 30), color,
    });
  }
}

// ---------- 그리기 ----------
function drawBackground() {
  // 높이에 따라 하늘색 → 우주로 변화
  const t = clamp(score / 15000, 0, 1);
  const top = lerpColor([135, 206, 235], [10, 10, 40], t);
  const bot = lerpColor([176, 224, 230], [40, 30, 80], t);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, `rgb(${top.join(',')})`);
  g.addColorStop(1, `rgb(${bot.join(',')})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 구름/별 (월드 좌표에 고정된 느낌으로 패럴랙스)
  ctx.save();
  const par = cameraY * 0.3;
  for (let i = 0; i < 8; i++) {
    const cy = ((i * 217 - par) % (H + 80) + H + 80) % (H + 80) - 40;
    const cx = (i * 137) % W;
    if (t < 0.6) {
      ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - t)})`;
      drawCloud(cx, cy);
    } else {
      ctx.fillStyle = `rgba(255,255,255,${0.6 * t})`;
      ctx.fillRect(cx, cy, 3, 3);
    }
  }
  ctx.restore();
}

function drawCloud(x, y) {
  ctx.beginPath();
  ctx.arc(x, y, 16, 0, Math.PI * 2);
  ctx.arc(x + 18, y + 4, 12, 0, Math.PI * 2);
  ctx.arc(x - 18, y + 5, 11, 0, Math.PI * 2);
  ctx.fill();
}

function lerpColor(a, b, t) {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

function drawPlatform(p) {
  const y = p.y - cameraY;
  ctx.save();
  if (p.broken && p.type === PlatType.BREAKING) {
    // 부서지는 애니메이션: 두 조각으로 갈라져 떨어짐
    const fall = p.breakAnim * p.breakAnim * 0.15;
    ctx.fillStyle = '#8B5A2B';
    ctx.save();
    ctx.translate(p.x + p.w / 4, y + fall);
    ctx.rotate(-0.3 - p.breakAnim * 0.02);
    roundRect(-p.w / 4, 0, p.w / 2, p.h, 6);
    ctx.restore();
    ctx.save();
    ctx.translate(p.x + p.w * 0.75, y + fall);
    ctx.rotate(0.3 + p.breakAnim * 0.02);
    roundRect(-p.w / 4, 0, p.w / 2, p.h, 6);
    ctx.restore();
    ctx.restore();
    return;
  }
  if (p.broken) { ctx.restore(); return; }

  const colors = {
    [PlatType.NORMAL]: ['#2ecc71', '#27ae60'],
    [PlatType.MOVING]: ['#3498db', '#2980b9'],
    [PlatType.BREAKING]: ['#a0693a', '#8B5A2B'],
    [PlatType.ONESHOT]: ['#ffffff', '#dcdde1'],
  };
  const [c1, c2] = colors[p.type];
  const g = ctx.createLinearGradient(0, y, 0, y + p.h);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  ctx.fillStyle = g;
  roundRect(p.x, y, p.w, p.h, 7);

  // 스프링
  if (p.spring) {
    ctx.fillStyle = '#e74c3c';
    ctx.fillRect(p.x + p.w / 2 - 8, y - 10, 16, 10);
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(p.x + p.w / 2 - 10, y - 12, 20, 4);
  }
  // 제트팩
  if (p.jetpack) {
    ctx.fillStyle = '#f39c12';
    roundRect(p.x + p.w / 2 - 9, y - 22, 18, 22, 4);
    ctx.fillStyle = '#e67e22';
    ctx.fillRect(p.x + p.w / 2 - 4, y - 26, 8, 6);
  }
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.fill();
}

function drawPlayer() {
  const x = player.x, y = player.y - cameraY;
  ctx.save();
  ctx.translate(x, y);

  // 제트팩 장착 표시
  if (jetpackTimer > 0) {
    ctx.fillStyle = '#f39c12';
    roundRect(-player.w / 2 - 10, -14, 12, 26, 4);
  }

  const img = shootPose > 0 && charImgs.shoot
    ? charImgs.shoot
    : (player.facing === 'right' && charImgs.right) ? charImgs.right : charImgs.left;

  if (img) {
    const flip = !charImgs.right && player.facing === 'right' && !(shootPose > 0 && charImgs.shoot);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(img, -player.w / 2, -player.h / 2, player.w, player.h);
  } else {
    drawDefaultCharacter();
  }
  ctx.restore();
}

// 내장 임시 캐릭터: 동글동글한 초록 캐릭터
function drawDefaultCharacter() {
  const dir = player.facing === 'right' ? 1 : -1;
  // 몸통
  ctx.fillStyle = '#a3d977';
  ctx.strokeStyle = '#6ab04c';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(0, 2, 20, 18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // 발 (점프 자세)
  ctx.fillStyle = '#6ab04c';
  ctx.beginPath();
  ctx.ellipse(-9, 18, 6, 4, 0, 0, Math.PI * 2);
  ctx.ellipse(9, 18, 6, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  // 눈
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(dir * 6, -4, 6, 0, Math.PI * 2);
  ctx.arc(dir * 14, -4, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2c3e50';
  ctx.beginPath();
  ctx.arc(dir * 8, -4, 2.5, 0, Math.PI * 2);
  ctx.arc(dir * 15, -4, 2.2, 0, Math.PI * 2);
  ctx.fill();
  // 코(발사 포즈면 위로 향한 입)
  if (shootPose > 0) {
    ctx.fillStyle = '#2c3e50';
    ctx.beginPath();
    ctx.ellipse(dir * 10, -12, 3, 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawMonster(m) {
  const y = m.y - cameraY + Math.sin(m.wobble) * 3;
  ctx.save();
  ctx.translate(m.x, y);
  // 몸통
  ctx.fillStyle = '#9b59b6';
  ctx.strokeStyle = '#71368a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(0, 0, m.w / 2, m.h / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // 날개
  ctx.fillStyle = '#be90d4';
  const flap = Math.sin(m.wobble * 3) * 6;
  ctx.beginPath();
  ctx.ellipse(-m.w / 2 - 4, -4 + flap, 8, 5, -0.4, 0, Math.PI * 2);
  ctx.ellipse(m.w / 2 + 4, -4 + flap, 8, 5, 0.4, 0, Math.PI * 2);
  ctx.fill();
  // 눈
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(-7, -4, 5, 0, Math.PI * 2);
  ctx.arc(7, -4, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2c3e50';
  ctx.beginPath();
  ctx.arc(-7, -3, 2, 0, Math.PI * 2);
  ctx.arc(7, -3, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function draw() {
  ctx.save();
  ctx.scale(scale, scale);

  drawBackground();

  for (const p of platforms) drawPlatform(p);
  for (const m of monsters) drawMonster(m);

  // 총알
  ctx.fillStyle = '#f1c40f';
  for (const b of bullets) {
    ctx.beginPath();
    ctx.arc(b.x, b.y - cameraY, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // 파티클
  for (const pt of particles) {
    ctx.globalAlpha = clamp(pt.life / 20, 0, 1);
    ctx.fillStyle = pt.color;
    ctx.fillRect(pt.x - 2, pt.y - cameraY - 2, 4, 4);
  }
  ctx.globalAlpha = 1;

  drawPlayer();

  // 점수
  if (state === State.PLAYING || state === State.PAUSED) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    roundRect(8, 8, 110, 34, 17);
    ctx.fillStyle = '#2c3e50';
    ctx.font = '900 20px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(score), 24, 26);
  }

  ctx.restore();
}

// ---------- 루프 ----------
let rafId = null;
function loop() {
  if (state === State.PLAYING) update();
  draw();
  rafId = requestAnimationFrame(loop);
}

// ---------- 화면 전환 ----------
const $ = (id) => document.getElementById(id);
const startScreen = $('start-screen');
const overScreen = $('gameover-screen');
const pauseScreen = $('pause-screen');
const pauseBtn = $('btn-pause');

function showBest() {
  $('best-score-label').textContent = best > 0 ? `최고 기록 ${best}` : '';
}

function startGame() {
  requestTilt();
  newGame();
  state = State.PLAYING;
  startScreen.classList.add('hidden');
  overScreen.classList.add('hidden');
  pauseScreen.classList.add('hidden');
  pauseBtn.classList.remove('hidden');
}

function pauseGame() {
  state = State.PAUSED;
  pauseScreen.classList.remove('hidden');
}

function resumeGame() {
  state = State.PLAYING;
  pauseScreen.classList.add('hidden');
}

function gameOver() {
  if (state !== State.PLAYING) return;
  state = State.OVER;
  sfx.die();
  const isRecord = score > best;
  if (isRecord) {
    best = score;
    localStorage.setItem('jump-best', String(best));
  }
  $('final-score').textContent = String(score);
  $('final-best').textContent = `최고 기록 ${best}`;
  $('new-record').classList.toggle('hidden', !isRecord);
  overScreen.classList.remove('hidden');
  pauseBtn.classList.add('hidden');
}

function goHome() {
  state = State.MENU;
  overScreen.classList.add('hidden');
  pauseScreen.classList.add('hidden');
  pauseBtn.classList.add('hidden');
  startScreen.classList.remove('hidden');
  showBest();
}

$('btn-start').addEventListener('click', startGame);
$('btn-retry').addEventListener('click', startGame);
$('btn-home').addEventListener('click', goHome);
$('btn-resume').addEventListener('click', resumeGame);
$('btn-quit').addEventListener('click', goHome);
pauseBtn.addEventListener('click', pauseGame);

// 탭 전환 시 자동 일시정지
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === State.PLAYING) pauseGame();
});

// ---------- 시작 ----------
newGame(); // 메뉴 뒤 배경용
showBest();
loop();
