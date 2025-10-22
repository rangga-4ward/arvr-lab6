import * as THREE from 'three';
import { ARButton } from 'three/examples/jsm/webxr/ARButton.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// ===== Konfigurasi =====
const MODEL_URL = '/models/machine.glb'; // ganti sesuai GLB kamu; jika tak ada → fallback box
const MODEL_SCALE = 0.6;                 // skala awal model

// ring level multipliers
const SAFE_M = 1.0;   // base radius
const WARN_M = 1.5;   // base * 1.5
const DANG_M = 2.0;   // base * 2

let camera, scene, renderer;
let controller, reticle;
let hitTestSource = null, hitTestSourceRequested = false;

let anchorGroup;   // group yang diposisikan di reticle (mesin + zona)
let machineModel;  // model GLB atau placeholder box
let zones = {};    // {safeRing, warnRing, dangerRing, cylinder, cone}

// UI refs
const ui = {
  radius: null, radiusVal: null,
  height: null, heightVal: null,
  showSafe: null, showWarn: null, showDanger: null, showCylinder: null, showCone: null,
  reset: null
};

// gesture state
let activeModel = null;

init();

function init(){
  const container = document.getElementById('app');

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 40);

  // Lighting
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8); dir.position.set(1,2,1); scene.add(dir);

  // Reticle
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.1, 32).rotateX(-Math.PI/2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.9, transparent: true })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // Controller
  controller = renderer.xr.getController(0);
  controller.addEventListener('select', onSelect);
  scene.add(controller);

  // Anchor Group (mesin + zona)
  anchorGroup = new THREE.Group();
  scene.add(anchorGroup);

  // AR Button
  const button = ARButton.createButton(renderer, {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: document.body }
  });
  document.body.appendChild(button);

  setupUI();
  setupGestureControls(renderer.domElement);
  window.addEventListener('resize', onResize);

  renderer.setAnimationLoop(render);
}

function onResize(){
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

async function onSelect(){
  if (!reticle.visible) return;
  anchorGroup.position.setFromMatrixPosition(reticle.matrix);

  // muat model jika belum ada
  if (!machineModel){
    machineModel = await loadOrCreateModel();
    anchorGroup.add(machineModel);
    activeModel = machineModel; // gesture target
  }

  // buat zona jika belum ada
  if (!zones.safeRing){
    createZones();
  }
}

async function loadOrCreateModel(){
  if (MODEL_URL){
    try{
      const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
      const obj = gltf.scene || gltf.scenes?.[0] || gltf;
      obj.traverse(n => { if (n.isMesh){ n.castShadow = true; n.receiveShadow = true; } });
      obj.scale.setScalar(MODEL_SCALE);
      return obj;
    }catch(e){ console.warn('Gagal load GLB, pakai placeholder box.', e); }
  }
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(0.25, 0.18, 0.25),
    new THREE.MeshStandardMaterial({ color: 0x2ecc71, roughness:0.7 })
  );
  box.position.y = 0.09;
  return box;
}

function createZones(){
  const baseRadius = parseFloat(ui.radius.value);
  const height = parseFloat(ui.height.value);

  // rings
  zones.safeRing = makeRing(baseRadius*SAFE_M, 0.04, 0x2ecc71, 0.35);
  zones.warnRing = makeRing(baseRadius*WARN_M, 0.05, 0xf1c40f, 0.35);
  zones.dangerRing = makeRing(baseRadius*DANG_M, 0.06, 0xe74c3c, 0.35);

  // cylinder (holo) — set radius = danger radius
  zones.cylinder = makeHoloCylinder(baseRadius*DANG_M, height, 0xe74c3c, 0.18);

  // cone — dari puncak ke dasar radius danger
  zones.cone = makeCone(baseRadius*DANG_M, height, 0xe74c3c, 0.18);

  for (const k of Object.keys(zones)) anchorGroup.add(zones[k]);
  updateZoneVisibility();
}

function makeRing(radius, thickness, color, opacity){
  const geom = new THREE.RingGeometry(radius, radius + thickness, 64);
  geom.rotateX(-Math.PI/2);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.y = 0.001; // sedikit di atas lantai untuk hindari z-fighting
  return mesh;
}

function makeHoloCylinder(radius, height, color, opacity){
  const geom = new THREE.CylinderGeometry(radius, radius, height, 64, 1, true);
  const mat = new THREE.MeshBasicMaterial({ color, wireframe: false, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.y = height/2;
  return mesh;
}

function makeCone(radius, height, color, opacity){
  const geom = new THREE.ConeGeometry(radius, height, 64, 1, true);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.y = height/2; // base di ground
  return mesh;
}

function updateZonesGeometry(){
  if (!zones.safeRing) return;

  const baseRadius = parseFloat(ui.radius.value);
  const height = parseFloat(ui.height.value);

  // update rings (dispose lama → buat baru agar sederhana)
  anchorGroup.remove(zones.safeRing, zones.warnRing, zones.dangerRing, zones.cylinder, zones.cone);
  zones.safeRing.geometry.dispose(); zones.warnRing.geometry.dispose(); zones.dangerRing.geometry.dispose();
  zones.cylinder.geometry.dispose(); zones.cone.geometry.dispose();

  zones.safeRing.geometry = new THREE.RingGeometry(baseRadius*SAFE_M, baseRadius*SAFE_M + 0.04, 64).rotateX(-Math.PI/2);
  zones.warnRing.geometry = new THREE.RingGeometry(baseRadius*WARN_M, baseRadius*WARN_M + 0.05, 64).rotateX(-Math.PI/2);
  zones.dangerRing.geometry = new THREE.RingGeometry(baseRadius*DANG_M, baseRadius*DANG_M + 0.06, 64).rotateX(-Math.PI/2);

  zones.cylinder.geometry = new THREE.CylinderGeometry(baseRadius*DANG_M, baseRadius*DANG_M, height, 64, 1, true);
  zones.cylinder.position.y = height/2;

  zones.cone.geometry = new THREE.ConeGeometry(baseRadius*DANG_M, height, 64, 1, true);
  zones.cone.position.y = height/2;

  for (const k of Object.keys(zones)) anchorGroup.add(zones[k]);
}

function updateZoneVisibility(){
  if (!zones.safeRing) return;
  zones.safeRing.visible = ui.showSafe.checked;
  zones.warnRing.visible = ui.showWarn.checked;
  zones.dangerRing.visible = ui.showDanger.checked;
  zones.cylinder.visible = ui.showCylinder.checked;
  zones.cone.visible = ui.showCone.checked;
}

function setupUI(){
  ui.radius = document.getElementById('radius');
  ui.radiusVal = document.getElementById('radiusVal');
  ui.height = document.getElementById('height');
  ui.heightVal = document.getElementById('heightVal');
  ui.showSafe = document.getElementById('showSafe');
  ui.showWarn = document.getElementById('showWarn');
  ui.showDanger = document.getElementById('showDanger');
  ui.showCylinder = document.getElementById('showCylinder');
  ui.showCone = document.getElementById('showCone');
  ui.reset = document.getElementById('btn-reset');

  const updateLabels = () => {
    ui.radiusVal.textContent = `${parseFloat(ui.radius.value).toFixed(2)} m`;
    ui.heightVal.textContent = `${parseFloat(ui.height.value).toFixed(2)} m`;
  };
  updateLabels();

  ui.radius.addEventListener('input', ()=>{ updateLabels(); updateZonesGeometry(); });
  ui.height.addEventListener('input', ()=>{ updateLabels(); updateZonesGeometry(); });
  ui.showSafe.addEventListener('change', updateZoneVisibility);
  ui.showWarn.addEventListener('change', updateZoneVisibility);
  ui.showDanger.addEventListener('change', updateZoneVisibility);
  ui.showCylinder.addEventListener('change', updateZoneVisibility);
  ui.showCone.addEventListener('change', updateZoneVisibility);
  ui.reset.addEventListener('click', ()=>{
    ui.radius.value = 1.0; ui.height.value = 1.2;
    ui.showSafe.checked = true; ui.showWarn.checked = true; ui.showDanger.checked = true;
    ui.showCylinder.checked = false; ui.showCone.checked = false;
    updateLabels();
    updateZonesGeometry();
    updateZoneVisibility();
  });
}

function render(timestamp, frame){
  if (frame){
    const refSpace = renderer.xr.getReferenceSpace();
    const session = renderer.xr.getSession();

    if (!hitTestSourceRequested){
      session.requestReferenceSpace('viewer').then(viewerSpace => {
        session.requestHitTestSource({ space: viewerSpace }).then(source => { hitTestSource = source; });
      });
      session.addEventListener('end', ()=>{ hitTestSourceRequested = false; hitTestSource = null; });
      hitTestSourceRequested = true;
    }

    if (hitTestSource){
      const hits = frame.getHitTestResults(hitTestSource);
      if (hits.length){
        const hit = hits[0];
        const pose = hit.getPose(refSpace);
        reticle.visible = true; reticle.matrix.fromArray(pose.transform.matrix);
      } else {
        reticle.visible = false;
      }
    }
  }
  renderer.render(scene, camera);
}

// ===================== Gesture Controls (two-finger rotate/scale) =====================
function setupGestureControls(canvas){
  let startDistance = 0; let startAngle = 0; let startScale = 1; let startRotationY = 0;
  canvas.addEventListener('touchstart', (e)=>{
    if (!activeModel) return;
    if (e.touches.length === 2){
      const [t0,t1] = e.touches;
      startDistance = dist(t0,t1); startAngle = ang(t0,t1); startScale = activeModel.scale.x; startRotationY = activeModel.rotation.y;
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', (e)=>{
    if (!activeModel) return;
    if (e.touches.length === 2){
      const [t0,t1] = e.touches;
      const k = dist(t0,t1) / (startDistance || 1);
      const nextScale = THREE.MathUtils.clamp(startScale * k, 0.1, 3);
      activeModel.scale.setScalar(nextScale);
      const dAng = ang(t0,t1) - startAngle;
      activeModel.rotation.y = startRotationY + dAng;
    }
  }, { passive: true });
}
function dist(a,b){ const dx=a.clientX-b.clientX, dy=a.clientY-b.clientY; return Math.hypot(dx,dy); }
function ang(a,b){ return Math.atan2(b.clientY-a.clientY, b.clientX-a.clientX); }