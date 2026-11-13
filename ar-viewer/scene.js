import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * ar-viewer/scene.js
 * 3Dシーンの土台（レンダラ・カメラ・ライト・地面と影）。
 * Phase 2以降でカメラ映像や平面検知と差し替え・拡張する前提の最小構成。
 */
export function createScene(container) {
  // 撮影モードで現在のフレームを確実に合成できるよう、描画バッファを保持する。
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setClearColor(0x000000, 0); // 透明：背面のカメラ映像が透ける（Phase 2）
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.xr.enabled = true; // WebXR（実際の床への配置）用。通常表示では無害
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.1,
    100
  );
  camera.position.set(0, 1.6, 3.2);
  camera.lookAt(0, 0.9, 0);

  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2, 4, 2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);

  // 地面：影だけを受け取る ShadowMaterial（仮説B「接地表現」の最小実装）
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 10),
    new THREE.ShadowMaterial({ opacity: 0.3 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  return { renderer, scene, camera, ground };
}

/**
 * 外部GLTFモデルを読み込む（assets/models/avatar.glb を置けば自動で差し替わる）。
 * 戻り値は gltf オブジェクト全体（scene と animations を含む）。
 * シーンへの追加と正規化は avatar.js の createGlbAvatar が担当する。
 * 読み込めない場合は null を返し、プレースホルダーアバターで継続する。
 */
export async function tryLoadAvatarModel(url = './assets/models/avatar.glb') {
  const loader = new GLTFLoader();
  try {
    const gltf = await loader.loadAsync(url);
    gltf.scene.traverse((obj) => {
      if (obj.isMesh) obj.castShadow = true;
    });
    return gltf;
  } catch {
    return null;
  }
}
