import * as THREE from 'three';

/**
 * ar-viewer/avatar.js
 * プレースホルダーアバター（プリミティブ合成）と、実モデル（GLB）の取り込み。
 * 実モデルは createGlbAvatar で正規化し、motion-controller が扱える形に揃える。
 */

/**
 * GLBモデルをアバターとして使える形に整える（Phase 3-B）。
 * - スケール正規化：最大寸法が約1.5mになるよう拡縮し、底面を y=0、XZ中心を原点へ
 * - 名前付きパーツ（Head / Tail）を探し、プロシージャルモーションに使う
 * - アニメーションクリップがあれば AnimationMixer とクリップ表を用意する
 */
export function createGlbAvatar(gltf) {
  const inner = gltf.scene;

  // 向きの自動補正：頭のある方向が +Z（カメラ正面）を向くよう、必要ならモデルを回す。
  // モデルごとに「前」の定義や書き出し時の軸が違っても、頭の位置から機械的にそろえる。
  inner.updateMatrixWorld(true);
  let headObj = null;
  inner.traverse((obj) => {
    const n = (obj.name || '').toLowerCase();
    if (!headObj && /(^|[^a-z])head/.test(n)) headObj = obj;
  });
  if (headObj) {
    const sceneBox = new THREE.Box3().setFromObject(inner);
    const center = sceneBox.getCenter(new THREE.Vector3());
    const hp = new THREE.Vector3();
    headObj.getWorldPosition(hp);
    const dx = hp.x - center.x;
    const dz = hp.z - center.z;
    if (Math.abs(dx) > Math.abs(dz)) {
      inner.rotation.y = dx > 0 ? -Math.PI / 2 : Math.PI / 2;
    } else if (dz < 0) {
      inner.rotation.y = Math.PI;
    }
    inner.updateMatrixWorld(true);
  }

  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  inner.scale.setScalar(1.5 / maxDim);
  const box2 = new THREE.Box3().setFromObject(inner);
  inner.position.x -= (box2.min.x + box2.max.x) / 2;
  inner.position.z -= (box2.min.z + box2.max.z) / 2;
  inner.position.y -= box2.min.y;

  const group = new THREE.Group();
  group.add(inner);

  const parts = {};
  inner.traverse((obj) => {
    const n = (obj.name || '').toLowerCase();
    if (!parts.head && /(^|[^a-z])head/.test(n)) parts.head = obj;
    if (!parts.tail && n.includes('tail')) parts.tail = obj;
    // 脚（歩行アニメーション用）：LegFL のような名前や front-left 等から4本を拾う
    const legKey = (n.match(/leg[-_ ]?(fl|fr|bl|br)/) || [])[1]
      || (n.includes('leg') && n.includes('front') && n.includes('left') ? 'fl' : null)
      || (n.includes('leg') && n.includes('front') && n.includes('right') ? 'fr' : null)
      || (n.includes('leg') && (n.includes('back') || n.includes('rear')) && n.includes('left') ? 'bl' : null)
      || (n.includes('leg') && (n.includes('back') || n.includes('rear')) && n.includes('right') ? 'br' : null);
    if (legKey) {
      parts.legs = parts.legs || {};
      parts.legs[legKey] = obj;
      obj.userData.baseRotationX = obj.rotation.x;
    }
  });

  let mixer = null;
  const actions = {};
  if (gltf.animations && gltf.animations.length > 0) {
    mixer = new THREE.AnimationMixer(inner);
    for (const clip of gltf.animations) {
      actions[clip.name] = mixer.clipAction(clip);
    }
  }

  return { group, inner, parts, mixer, actions, isGlb: true };
}
export function createPlaceholderAvatar() {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4f7ddf, roughness: 0.5 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.35 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x182233, roughness: 0.2 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.45, 6, 16), bodyMat);
  body.position.y = 0.55;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 24, 18), headMat);
  head.position.y = 1.22;
  head.castShadow = true;
  group.add(head);

  const eyeGeo = new THREE.SphereGeometry(0.032, 12, 10);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.085, 1.26, 0.21);
  group.add(eyeL);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.085;
  group.add(eyeR);

  const armGeo = new THREE.CapsuleGeometry(0.06, 0.34, 4, 10);
  const armL = new THREE.Mesh(armGeo, bodyMat);
  armL.position.set(-0.36, 0.78, 0);
  armL.rotation.z = 0.5;
  armL.castShadow = true;
  group.add(armL);
  const armR = armL.clone();
  armR.position.x = 0.36;
  armR.rotation.z = -0.5;
  group.add(armR);

  return { group, parts: { body, head, eyeL, eyeR, armL, armR } };
}
