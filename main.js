/**
 * main.js（『ハウリング』N1：殻と登場）
 * 配線：登場（スタート画面→カメラ→挨拶）／会話／タップ配置／撮影モード。
 *
 * 設計原則（コンセプト設計 v0.2）:
 * - 数値を見せない：計測パネルは持ち込まない。状態はハウルの振る舞いで伝える
 * - イベント駆動の知覚：常時推論はしない。N1 では検知自体を持ち込まない
 * - すぐ始まる：モデルは MB 級のみ（仮モデル 7.1MB）
 * - キャラが主役の UI：吹き出し＋大きなボタン
 *
 * 挨拶は記憶ストアの静的エクスポート（data/memory.json）を参照する（静的連携）。
 * モデルは仮モデル（TRELLIS.2 生成＋afk.ai リグ、Walk/Trot/Run）。
 * 12月に Tripo Pro 生成モデルへ差し替える前提で、差し替えは avatar.glb の置換のみで済む。
 */
import * as THREE from 'three';
import { createScene, tryLoadAvatarModel } from './ar-viewer/scene.js';
import { createPlaceholderAvatar, createGlbAvatar } from './ar-viewer/avatar.js';
import { CameraManager } from './ar-viewer/camera.js';
import { generateReply, getApiKey, setApiKey } from './ai-agent-engine/gemini-client.js?v=20261113-4';
import { speak } from './ai-agent-engine/speech.js';
import { MotionController } from './motion-controller/motion-controller.js';
import { loadMemory, buildGreeting, memoryContext } from './memory/greeting.js';

const stage = document.getElementById('stage');
const container = document.getElementById('canvas-container');
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const stageNote = document.getElementById('stage-note');
const startOverlay = document.getElementById('start-overlay');
const startButton = document.getElementById('start-button');
const cameraVideo = document.getElementById('camera-video');
const userInput = document.getElementById('user-input');
const talkButton = document.getElementById('talk-button');
const photoButton = document.getElementById('photo-button');
const cameraButton = document.getElementById('camera-button');
const settingsButton = document.getElementById('settings-button');
const settingsPanel = document.getElementById('settings-panel');
const apiKeyInput = document.getElementById('api-key-input');
const saveKeyButton = document.getElementById('save-key-button');
const statusLine = document.getElementById('status-line');
const photoUi = document.getElementById('photo-ui');
const photoExit = document.getElementById('photo-exit');
const shutterButton = document.getElementById('shutter-button');
const photoPreview = document.getElementById('photo-preview');
const photoImg = document.getElementById('photo-img');
const photoDownload = document.getElementById('photo-download');
const photoClose = document.getElementById('photo-close');

const { renderer, scene, camera } = createScene(container);

// 配置用アンカー：タップ配置で動かすのは外側のこのグループ。
// 感情モーションは内側のアバター本体に掛かるため競合しない（第一作の構成を踏襲）。
const anchor = new THREE.Group();
scene.add(anchor);

const placeholder = createPlaceholderAvatar();
anchor.add(placeholder.group);
const motion = new MotionController(placeholder);

tryLoadAvatarModel().then((gltf) => {
  if (!gltf) return;
  const glbAvatar = createGlbAvatar(gltf);
  anchor.remove(placeholder.group);
  anchor.add(glbAvatar.group);
  motion.setAvatar(glbAvatar);
  headBone = null;
  glbAvatar.group.traverse((o) => {
    if (!headBone && o.isBone && o.name.toLowerCase() === 'head') headBone = o;
  });
});

// 仮モデル（TRELLIS.2生成）の顔は右下向きに焼き込まれているため、Headボーンへ
// 一定のヨー補正を毎フレーム合成して正面を向かせる（形状実測＋レンダ検証済み: +32度）。
// 12月にモデルを差し替えたら、この補正は外すこと。
const HEAD_YAW_CORRECTION = THREE.MathUtils.degToRad(32);
let headBone = null;
let prevAppliedHead = null; // 前フレームに自分が設定したローカル回転（累積防止の判定用）
const _hq = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _cq = new THREE.Quaternion();
const _upAxis = new THREE.Vector3(0, 1, 0);
function composeHeadYaw(angle) {
  headBone.getWorldQuaternion(_hq);
  _cq.setFromAxisAngle(_upAxis, angle).multiply(_hq);
  headBone.parent.getWorldQuaternion(_pq);
  headBone.quaternion.copy(_pq.invert().multiply(_cq));
}
function applyHeadCorrection() {
  if (!headBone || !headBone.parent) return;
  // 静止中はアニメーションがボーンを書き換えないため、補正が毎フレーム累積してしまう。
  // 前フレームに自分が設定した値のままなら、まず前回の補正を取り消してから掛け直す。
  if (prevAppliedHead && Math.abs(headBone.quaternion.dot(prevAppliedHead)) > 0.9999) {
    composeHeadYaw(-HEAD_YAW_CORRECTION);
  }
  composeHeadYaw(HEAD_YAW_CORRECTION);
  if (!prevAppliedHead) prevAppliedHead = new THREE.Quaternion();
  prevAppliedHead.copy(headBone.quaternion);
}

// --- 記憶（静的連携） ---
let memory = { posts: [], episodes: [] };
let memCtx = '';
loadMemory().then((m) => {
  memory = m;
  memCtx = memoryContext(m);
});

// --- 吹き出しと小さな通知 ---
let noteTimer = null;
function showNote(text, ms = 3200) {
  stageNote.textContent = text;
  stageNote.classList.remove('hidden');
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = setTimeout(() => stageNote.classList.add('hidden'), ms);
}

function showBubble(text) {
  bubbleText.textContent = text;
  bubble.classList.remove('hidden');
}

function say(text, emotion = 'idle', { speakIt = true } = {}) {
  showBubble(text);
  motion.play(emotion);
  if (speakIt) speak(text);
}

// --- 接地：タップした地面の位置へハウルが移動する（第一作 Phase 3-C を踏襲） ---
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const placeTarget = new THREE.Vector3();
let hasPlaceTarget = false;
let journeyMode = 'walk'; // タップ時点の総距離で決める移動モード（途中では切り替えない）
let photoMode = false;

const marker = new THREE.Mesh(
  new THREE.RingGeometry(0.16, 0.22, 40),
  new THREE.MeshBasicMaterial({
    color: 0xffd166, transparent: true, opacity: 0,
    side: THREE.DoubleSide, depthWrite: false,
  })
);
marker.rotation.x = -Math.PI / 2;
scene.add(marker);
let markerShownAt = -Infinity;

container.addEventListener('pointerdown', (ev) => {
  if (!started || photoMode) return;
  const rect = container.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(groundPlane, hit)) {
    hit.set(ndc.x * 2.4, 0, -1.2);
  }
  hit.x = THREE.MathUtils.clamp(hit.x, -2.0, 2.0);
  hit.z = THREE.MathUtils.clamp(hit.z, -1.2, 1.8);
  placeTarget.copy(hit);
  hasPlaceTarget = true;
  // 残り距離ではなく「旅の総距離」で trot/walk を決める。
  // 残り距離判定だと閾値を超えるタップが少なく、超えても接近と同時に walk へ落ちてしまう。
  const journey = Math.hypot(hit.x - anchor.position.x, hit.z - anchor.position.z);
  journeyMode = journey > 0.85 ? 'trot' : 'walk';
  marker.position.set(hit.x, 0.01, hit.z);
  markerShownAt = performance.now();
});

/** 角度の最短差分で滑らかに近づける */
function dampAngle(current, target, lambda, dt) {
  let diff = (target - current) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * (1 - Math.exp(-lambda * dt));
}

let lastLoopAt = performance.now();
function loop(now) {
  const dt = Math.min((now - lastLoopAt) / 1000, 0.05);
  lastLoopAt = now;

  let mode = 'idle';
  if (hasPlaceTarget && !photoMode) {
    const dx = placeTarget.x - anchor.position.x;
    const dz = placeTarget.z - anchor.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.03) {
      mode = dist < 0.3 ? 'walk' : journeyMode; // 到着間際だけ walk に落として自然に減速
      const speed = mode === 'trot' ? 3.6 : 2.0;
      const step = Math.min(dist, speed * dt);
      anchor.position.x += (dx / dist) * step;
      anchor.position.z += (dz / dist) * step;
      anchor.rotation.y = dampAngle(anchor.rotation.y, Math.atan2(dx, dz), 12, dt);
    } else {
      anchor.rotation.y = dampAngle(anchor.rotation.y, 0, 6, dt); // 着いたら正面へ
    }
  } else if (photoMode) {
    // 撮影中はカメラ（正面）を向く
    anchor.rotation.y = dampAngle(anchor.rotation.y, 0, 6, dt);
  }
  motion.setLocomotion(mode);

  const mt = (now - markerShownAt) / 1400;
  if (mt < 1) {
    marker.material.opacity = 0.9 * (1 - mt);
    const s = 1 + mt * 0.9;
    marker.scale.set(s, s, 1);
  } else {
    marker.material.opacity = 0;
  }

  motion.update(now);
  applyHeadCorrection();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// --- カメラ ---
const cameraManager = new CameraManager(cameraVideo);

async function startCamera() {
  if (cameraManager.isRunning) return true;
  try {
    await cameraManager.start();
    document.body.classList.add('camera-on');
    cameraButton.textContent = 'カメラ切';
    return true;
  } catch {
    return false;
  }
}

function stopCamera() {
  cameraManager.stop();
  document.body.classList.remove('camera-on');
  cameraButton.textContent = 'カメラ入';
}

cameraButton.addEventListener('click', async () => {
  if (cameraManager.isRunning) {
    stopCamera();
    showNote('カメラを止めた。ワガハイはここにいる。');
  } else if (!(await startCamera())) {
    showNote('カメラを始められなかった。許可を確認してくれ。');
  }
});

// --- 登場：スタート画面 → カメラ → 記憶を踏まえた挨拶 ---
let started = false;
startButton.addEventListener('click', async () => {
  if (started) return;
  started = true;
  startOverlay.classList.add('fading');
  setTimeout(() => startOverlay.classList.add('hidden'), 700);

  const cameraOk = await startCamera();
  if (!cameraOk) showNote('カメラなしでも会える。部屋の様子は見えていないがな。');

  // 記憶の読み込みが終わっていない場合は少し待つ（挨拶に使うため）
  if (!memCtx && memory.posts.length === 0 && memory.episodes.length === 0) {
    await loadMemory().then((m) => { memory = m; memCtx = memoryContext(m); });
  }
  say(buildGreeting(memory), 'happy');
});

// --- 会話 ---
let talkBusy = false;
async function talk() {
  if (talkBusy) return;
  const text = userInput.value.trim() || 'こんにちは';
  talkBusy = true;
  talkButton.disabled = true;
  showBubble('……');
  motion.play('thinking'); // 待っている間も「考えている」ことが見えるように
  try {
    const reply = await generateReply(text, memCtx);
    say(reply.text, reply.emotion);
    userInput.value = '';
  } catch (err) {
    say('うまく考えがまとまらなかった。もう一度言ってくれ。', 'thinking', { speakIt: false });
    statusLine.textContent = `エラー: ${err.message}`;
  } finally {
    talkBusy = false;
    talkButton.disabled = false;
  }
}
talkButton.addEventListener('click', talk);
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') talk();
});

// --- 設定（APIキー） ---
apiKeyInput.value = getApiKey();
settingsButton.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});
saveKeyButton.addEventListener('click', () => {
  setApiKey(apiKeyInput.value.trim());
  statusLine.textContent = 'キーを保存した。次に話すときから使う。';
});

// --- 撮影モード（体験C） ---
function enterPhotoMode() {
  photoMode = true;
  hasPlaceTarget = false;
  document.body.classList.add('photo-mode');
  photoUi.classList.remove('hidden');
}
function exitPhotoMode() {
  photoMode = false;
  document.body.classList.remove('photo-mode');
  photoUi.classList.add('hidden');
}
photoButton.addEventListener('click', enterPhotoMode);
photoExit.addEventListener('click', exitPhotoMode);

function capturePhoto() {
  renderer.render(scene, camera);
  const gl = renderer.domElement;
  const out = document.createElement('canvas');
  out.width = gl.width;
  out.height = gl.height;
  const ctx = out.getContext('2d');

  if (cameraManager.isRunning && cameraVideo.readyState >= 2) {
    // <video> の object-fit: cover と同じ見え方で合成する
    const vw = cameraVideo.videoWidth;
    const vh = cameraVideo.videoHeight;
    const scale = Math.max(out.width / vw, out.height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx.drawImage(cameraVideo, (out.width - dw) / 2, (out.height - dh) / 2, dw, dh);
  } else {
    const grad = ctx.createLinearGradient(0, 0, 0, out.height);
    grad.addColorStop(0, '#2a3348');
    grad.addColorStop(1, '#141926');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, out.width, out.height);
  }
  ctx.drawImage(gl, 0, 0);

  const url = out.toDataURL('image/png');
  photoImg.src = url;
  photoDownload.href = url;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  photoDownload.download = `howling-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
  photoPreview.classList.remove('hidden');
}
shutterButton.addEventListener('click', capturePhoto);
photoClose.addEventListener('click', () => {
  photoPreview.classList.add('hidden');
});
