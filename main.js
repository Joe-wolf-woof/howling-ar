/**
 * main.js（『HowLink』N1：殻と登場 ＋ N2：見せる・覚える）
 * 配線：登場（スタート画面→カメラ→挨拶）／会話／見せる／タップ配置／撮影モード。
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
import { createScene, tryLoadAvatarModel } from './ar-viewer/scene.js?v=20261113-6';
import { createPlaceholderAvatar, createGlbAvatar } from './ar-viewer/avatar.js';
import { CameraManager } from './ar-viewer/camera.js';
import { generateReply, generateVisionReply, getApiKey, setApiKey } from './ai-agent-engine/gemini-client.js?v=20261113-4';
import { speak } from './ai-agent-engine/speech.js';
import { MotionController } from './motion-controller/motion-controller.js?v=20261113-9';
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
const showButton = document.getElementById('show-button');
const cameraButton = document.getElementById('camera-button');
const settingsButton = document.getElementById('settings-button');
const settingsPanel = document.getElementById('settings-panel');
const apiKeyInput = document.getElementById('api-key-input');
const saveKeyButton = document.getElementById('save-key-button');
const exportButton = document.getElementById('export-button');
const statusLine = document.getElementById('status-line');
const photoUi = document.getElementById('photo-ui');
const photoExit = document.getElementById('photo-exit');
const shutterButton = document.getElementById('shutter-button');
const photoPreview = document.getElementById('photo-preview');
const photoImg = document.getElementById('photo-img');
const photoDownload = document.getElementById('photo-download');
const photoClose = document.getElementById('photo-close');

const { renderer, scene, camera, ground } = createScene(container);

// 通常モードのカメラの定位置。WebXR セッション中、three.js はこのカメラの
// position/quaternion を頭の姿勢で上書きし、終了しても元に戻さない。
// そのため終了時にここへ復元しないと、通常モードで視点が頭の最後の位置に
// 残り、オオカミが巨大化したり画面の端に張り付いたりする（2026-11-13 実機報告）。
const CAM_HOME_POS = camera.position.clone();
const CAM_HOME_QUAT = camera.quaternion.clone();

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
  applyHeadCorrectionOnce();
});

// 仮モデル（TRELLIS.2生成）の顔は右下向きに焼き込まれているため、読み込み時に
// Headボーンの静止姿勢へ +32度 のヨー補正を一度だけ焼き込む（形状実測＋レンダ検証済み）。
// 毎フレーム合成は累積・競合の温床になるため行わない。ミキサーはこの姿勢を
// 「元の姿勢」として保持するので、静止時は常に補正が効いた状態になる。
// 12月にモデルを差し替えたら、この補正は外すこと。
const HEAD_YAW_CORRECTION = THREE.MathUtils.degToRad(32);
let headBone = null;
const _hq = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _cq = new THREE.Quaternion();
const _upAxis = new THREE.Vector3(0, 1, 0);
function applyHeadCorrectionOnce() {
  if (!headBone || !headBone.parent) return;
  headBone.getWorldQuaternion(_hq);
  _cq.setFromAxisAngle(_upAxis, HEAD_YAW_CORRECTION).multiply(_hq);
  headBone.parent.getWorldQuaternion(_pq);
  headBone.quaternion.copy(_pq.invert().multiply(_cq));
  headBone.updateMatrixWorld(true);
}

statusLine.textContent = 'build 20261113-15';

// --- 記憶（静的連携） ---
let memory = { posts: [], episodes: [] };
let memCtx = '';
loadMemory().then((m) => {
  memory = m;
  refreshMemCtx();
});

// --- 見せた記憶（ローカルエピソード。N2「覚える」） ---
// 「見せる」で得た反応を localStorage に残し、会話の文脈へ合流させる。
// howl-agent の記憶ストアとの同期は N3。ここではローカル完結＋書き出しまで。
const EPISODES_KEY = 'howling_episodes';
const MAX_LOCAL_EPISODES = 50;

function loadLocalEpisodes() {
  try {
    const arr = JSON.parse(localStorage.getItem(EPISODES_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveShownEpisode(text, userText) {
  const episodes = loadLocalEpisodes();
  episodes.push({
    id: `ep_${Date.now().toString(36)}${Math.floor(Math.random() * 10000)}`,
    date: new Date().toISOString(),
    kind: 'shown',
    text,
    userText: userText || '',
  });
  try {
    localStorage.setItem(EPISODES_KEY, JSON.stringify(episodes.slice(-MAX_LOCAL_EPISODES)));
  } catch { /* 保存できなくても体験は止めない */ }
}

/** 直近の「見せた記憶」最大3件を、会話の文脈に足すためのテキスト */
function shownContext() {
  return loadLocalEpisodes()
    .slice(-3)
    .map((e) => `見せてもらった物への反応（${(e.date || '').slice(0, 10)}）: ${e.text}`)
    .join('\n');
}

/** 静的メモリ＋見せた記憶を合わせた会話文脈を memCtx に反映する */
function refreshMemCtx() {
  memCtx = [memoryContext(memory), shownContext()].filter(Boolean).join('\n');
}

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

/** 移動目標をセットする（通常モードのタップと XR の select で共用） */
function setPlaceTarget(hit, { clamp = true } = {}) {
  const p = hit.clone();
  if (clamp) {
    p.x = THREE.MathUtils.clamp(p.x, -2.0, 2.0);
    p.z = THREE.MathUtils.clamp(p.z, -1.2, 1.8);
  }
  placeTarget.copy(p);
  hasPlaceTarget = true;
  // 残り距離ではなく「旅の総距離」で trot/walk を決める。
  // 残り距離判定だと閾値を超えるタップが少なく、超えても接近と同時に walk へ落ちてしまう。
  const journey = Math.hypot(p.x - anchor.position.x, p.z - anchor.position.z);
  journeyMode = journey > 0.85 ? 'trot' : 'walk';
  marker.position.set(p.x, floorY + 0.01, p.z);
  markerShownAt = performance.now();
}

// --- WebXR：実際の床に合わせる（対応端末のみ。通常モードはそのまま残す） ---
let xrSupported = false;
let xrActive = false;
let xrSession = null;
let hitTestSource = null;
let xrPlaced = false;
let xrHitSeen = false; // ヒットテストが一度でも床を捉えたか（診断用）
let lastHitAt = -Infinity; // 最後に床を捉えた時刻（レティクルの保持用）
let floorY = 0; // 現在の床の高さ（通常モードは 0、XR ではヒットテストで決まる）
let lastStageTapAt = -Infinity;

const reticleGeo = new THREE.RingGeometry(0.14, 0.2, 40);
reticleGeo.rotateX(-Math.PI / 2); // 姿勢クォータニオンで面に沿わせるため、法線を +Y にしておく
const reticle = new THREE.Mesh(
  reticleGeo,
  new THREE.MeshBasicMaterial({ color: 0x7ee2a8, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
);
reticle.visible = false;
scene.add(reticle);

let xrSupportNote = '';
if (navigator.xr?.isSessionSupported) {
  navigator.xr.isSessionSupported('immersive-ar').then((ok) => {
    xrSupported = !!ok;
    if (xrSupported) {
      startButton.textContent = 'ARで会いに行く';
      document.querySelector('.start-note').innerHTML =
        'ARを使うと、実際の床の上にハウルが現れます。<br />床を映して、緑の輪が出た場所をタップしてください。';
    } else {
      xrSupportNote = 'この端末・ブラウザではAR（WebXR）が使えないため、通常モードで開きます。';
      document.querySelector('.start-note').innerHTML += `<br />${xrSupportNote}`;
    }
  }).catch((err) => {
    xrSupportNote = `AR対応の確認でエラー: ${err.name || err}`;
    document.querySelector('.start-note').innerHTML += `<br />${xrSupportNote}`;
  });
} else {
  xrSupportNote = 'このブラウザはWebXRに未対応です（Chromeで開くとARが使えます）。';
}

async function startXR() {
  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: document.body },
    });
    xrSession = session;
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
    const viewerSpace = await session.requestReferenceSpace('viewer');
    hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
    session.addEventListener('select', onXRSelect);
    session.addEventListener('end', onXRSessionEnd);
    xrActive = true;
    anchor.visible = false; // 配置するまでは姿を見せない（原点＝目の高さに浮いて見えるため）
    document.body.classList.add('xr-on');
    cameraButton.textContent = 'AR終了';
    setTimeout(() => {
      if (xrActive && !xrHitSeen) {
        showNote('床が検出できていない。明るい場所で床を映し、ゆっくり動かして。', 7000);
      }
    }, 6000);
    return true;
  } catch (err) {
    xrSession = null;
    hitTestSource = null;
    showNote(`ARを開始できなかった（${err.name || 'Error'}: ${err.message || err}）。通常モードで開く。`, 9000);
    return false;
  }
}

function onXRSelect(ev) {
  if (!xrActive) return;
  const refSpace = renderer.xr.getReferenceSpace();
  if (!ev.frame || !refSpace) return;
  if (!xrPlaced) {
    // 配置前：レティクルの位置（実床のヒット点）に立たせる
    if (!reticle.visible) return;
    anchor.visible = true;
    anchor.position.copy(reticle.position);
    floorY = reticle.position.y;
    ground.position.y = floorY;
    // AR では通常モードの「見え方」に合わせる。通常モードは 3.2m 先から見た姿で、
    // 実寸 1.5m のままだと近くで巨大に見えるため、体長 約0.83m に縮小する（JOE指定）。
    anchor.scale.setScalar(0.55);
    xrPlaced = true;
    reticle.visible = false;
    showNote('ハウルが床に立った。床をタップすると、そこへ移動する。');
    return;
  }
  // 配置後：タップのレイと床面の交点へ移動する。
  // UIボタンへのタップでも select は発火するため、ステージ自体へのタップと時刻で照合する。
  if (performance.now() - lastStageTapAt > 600) return;
  const pose = ev.frame.getPose(ev.inputSource.targetRaySpace, refSpace);
  if (!pose) return;
  const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
  const origin = new THREE.Vector3().setFromMatrixPosition(m);
  const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
  if (Math.abs(dir.y) < 0.05) return;
  const t = (floorY - origin.y) / dir.y;
  if (t < 0.2 || t > 7) return;
  const target = origin.add(dir.multiplyScalar(t));
  target.y = floorY;
  setPlaceTarget(target, { clamp: false });
}

function onXRSessionEnd() {
  xrActive = false;
  xrPlaced = false;
  xrHitSeen = false;
  anchor.visible = true;
  xrSession = null;
  if (hitTestSource) {
    hitTestSource.cancel();
    hitTestSource = null;
  }
  reticle.visible = false;
  floorY = 0;
  ground.position.y = 0;
  anchor.position.set(0, 0, 0);
  anchor.rotation.y = 0;
  anchor.scale.setScalar(1);
  // XR が上書きしたカメラの姿勢を通常モードの定位置へ復元する（上の CAM_HOME 参照）。
  camera.position.copy(CAM_HOME_POS);
  camera.quaternion.copy(CAM_HOME_QUAT);
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  hasPlaceTarget = false;
  document.body.classList.remove('xr-on');
  cameraButton.textContent = cameraManager.isRunning ? 'カメラ切' : 'カメラ入';
  showNote('ARを終了した。通常モードに戻った。');
}

container.addEventListener('pointerdown', (ev) => {
  if (!started || photoMode) return;
  lastStageTapAt = performance.now();
  if (xrActive) return; // XR中は select イベント側で処理する
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
  setPlaceTarget(hit);
});

const _camPos = new THREE.Vector3();

/** 角度の最短差分で滑らかに近づける */
function dampAngle(current, target, lambda, dt) {
  let diff = (target - current) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * (1 - Math.exp(-lambda * dt));
}

let lastLoopAt = performance.now();
function loop(now, frame) {
  const dt = Math.min((now - lastLoopAt) / 1000, 0.05);
  lastLoopAt = now;

  // XR 配置前：ヒットテストで実床の位置にレティクルを出す。
  // 床を見失っても 0.6 秒は残す（チラつき防止と、タップの狙いを付けやすくするため）。
  if (xrActive && !xrPlaced && hitTestSource && frame) {
    const refSpace = renderer.xr.getReferenceSpace();
    const hits = frame.getHitTestResults(hitTestSource);
    if (hits.length) {
      xrHitSeen = true;
      lastHitAt = now;
      if (refSpace) {
        const pose = hits[0].getPose(refSpace);
        if (pose) {
          reticle.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
          reticle.quaternion.set(
            pose.transform.orientation.x, pose.transform.orientation.y,
            pose.transform.orientation.z, pose.transform.orientation.w
          );
          reticle.visible = true;
        }
      }
    } else if (now - lastHitAt > 600) {
      reticle.visible = false;
    }
  }

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
      // 着いたらカメラ（XR中はユーザー本人）の方を向く
      camera.getWorldPosition(_camPos);
      const faceYaw = Math.atan2(_camPos.x - anchor.position.x, _camPos.z - anchor.position.z);
      anchor.rotation.y = dampAngle(anchor.rotation.y, faceYaw, 6, dt);
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
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(loop); // XR 提示中も回り続けるよう、rAF ではなくこちらを使う

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
  if (xrActive) {
    // AR 中はこのボタンが「AR終了」になる（通常モードへ戻る出口）。
    // セッションを終えると 'end' イベント経由で onXRSessionEnd が後片付けする。
    const session = xrSession;
    if (session) {
      try {
        await session.end();
      } catch {
        if (xrActive) onXRSessionEnd();
      }
    } else {
      onXRSessionEnd();
    }
    return;
  }
  if (cameraManager.isRunning) {
    stopCamera();
    showNote('カメラを止めた。ワガハイはここにいる。');
  } else if (!(await startCamera())) {
    showNote('カメラを始められなかった。許可を確認してくれ。');
  }
});

// --- 登場：スタート画面 → （AR or カメラ） → 記憶を踏まえた挨拶 ---
let started = false;
async function ensureMemory() {
  // 記憶の読み込みが終わっていない場合は少し待つ（挨拶に使うため）
  if (!memCtx && memory.posts.length === 0 && memory.episodes.length === 0) {
    await loadMemory().then((m) => { memory = m; refreshMemCtx(); });
  }
}
startButton.addEventListener('click', async () => {
  if (started) return;
  started = true;
  startOverlay.classList.add('fading');
  setTimeout(() => startOverlay.classList.add('hidden'), 700);

  if (xrSupported && (await startXR())) {
    showNote('床にスマホを向けて、緑の輪が出た場所をタップして。');
    await ensureMemory();
    say(buildGreeting(memory), 'happy');
    return;
  }

  const cameraOk = await startCamera();
  if (!cameraOk) showNote('カメラなしでも会える。部屋の様子は見えていないがな。');
  await ensureMemory();
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

// --- 見せる（体験B：カメラ越しに物を見せると反応し、その反応が記憶に残る） ---
let showBusy = false;
async function showToHowl() {
  if (showBusy || talkBusy) return;
  if (xrActive) {
    showNote('見せるは通常モードで使ってくれ。戻るには「AR終了」を押して。');
    return;
  }
  if (!cameraManager.isRunning) {
    showNote('カメラを入れてから見せてくれ。');
    return;
  }
  const frame = cameraManager.captureFrame();
  if (!frame) {
    showNote('まだ映像が届いていない。少し待ってから見せて。');
    return;
  }
  const userText = userInput.value.trim();
  showBusy = true;
  showButton.disabled = true;
  showBubble('……');
  motion.play('thinking'); // 待っている間も「見ている」ことが伝わるように
  try {
    const reply = await generateVisionReply(frame, userText);
    say(reply.text, reply.emotion);
    saveShownEpisode(reply.text, userText); // 覚える：反応をエピソードとして保存
    refreshMemCtx(); // 以後の会話で「前に見せてもらった物」に触れられるようにする
    if (userText) userInput.value = '';
  } catch (err) {
    say('よく見えなかった。もう一度見せてくれ。', 'thinking', { speakIt: false });
    statusLine.textContent = `エラー: ${err.message}`;
  } finally {
    showBusy = false;
    showButton.disabled = false;
  }
}
showButton.addEventListener('click', showToHowl);

// --- 設定（APIキー） ---
apiKeyInput.value = getApiKey();
settingsButton.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});
saveKeyButton.addEventListener('click', () => {
  setApiKey(apiKeyInput.value.trim());
  statusLine.textContent = 'キーを保存した。次に話すときから使う。';
});

// --- 見せた記憶の書き出し（将来 howl-agent のエピソード記憶へ取り込む連携フォーマット） ---
exportButton.addEventListener('click', () => {
  const episodes = loadLocalEpisodes();
  if (!episodes.length) {
    statusLine.textContent = '見せた記憶はまだない。';
    return;
  }
  const data = episodes.map((e) => ({ date: e.date, kind: 'shown', text: e.text }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'howling-episodes.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  statusLine.textContent = `見せた記憶を${data.length}件書き出した。`;
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
photoButton.addEventListener('click', () => {
  if (xrActive) {
    showNote('写真は通常モードで撮ってくれ。戻るには「AR終了」を押して。');
    return;
  }
  enterPhotoMode();
});
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
