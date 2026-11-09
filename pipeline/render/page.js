// Isometric Burlington renderer page. Runs in headless Chromium (see render.mjs).
// window.renderShot({angle, x, y, w, h}) renders map-pixel rect [x,x+w)x[y,y+h) of one
// angle and returns {rgb, height} PNG data URLs. Height is ENU "up" in centimetres + 20000,
// packed big-endian into R,G,B (alpha 255; alpha 0 where nothing was drawn).
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { CesiumIonAuthPlugin, GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';

const GOOGLE_3D_TILES_ASSET = '2275207';

let renderer, scene, tiles, cfg, heightMat, enuFromEcef;

function enuMatrix(latDeg, lonDeg, h) {
  // ECEF -> local frame with three.js axes: x = east, y = up, z = south
  const a = 6378137.0, f = 1 / 298.257223563, e2 = f * (2 - f);
  const la = THREE.MathUtils.degToRad(latDeg), lo = THREE.MathUtils.degToRad(lonDeg);
  const N = a / Math.sqrt(1 - e2 * Math.sin(la) ** 2);
  const o = new THREE.Vector3((N + h) * Math.cos(la) * Math.cos(lo), (N + h) * Math.cos(la) * Math.sin(lo), (N * (1 - e2) + h) * Math.sin(la));
  const E = new THREE.Vector3(-Math.sin(lo), Math.cos(lo), 0);
  const Nn = new THREE.Vector3(-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la));
  const U = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
  // rows: east, up, -north
  const m = new THREE.Matrix4().set(
    E.x, E.y, E.z, -E.dot(o),
    U.x, U.y, U.z, -U.dot(o),
    -Nn.x, -Nn.y, -Nn.z, Nn.dot(o),
    0, 0, 0, 1);
  return m;
}

function cameraFor(angle, x, y, w, h) {
  const el = THREE.MathUtils.degToRad(cfg.elev_deg);
  const hd = THREE.MathUtils.degToRad(cfg.headings[angle]);
  const P = cfg.pixel_m;
  // ENU vectors -> three (x=e, y=u, z=-n)
  const fwd = new THREE.Vector3(Math.sin(hd), 0, -Math.cos(hd));
  const right = new THREE.Vector3(Math.cos(hd), 0, Math.sin(hd));
  const up3 = new THREE.Vector3(0, 1, 0);
  const V = fwd.clone().multiplyScalar(Math.sin(el)).add(up3.clone().multiplyScalar(Math.cos(el))); // screen up
  const D = fwd.clone().multiplyScalar(Math.cos(el)).add(up3.clone().multiplyScalar(-Math.sin(el))); // view dir
  // centre of the rect in screen coordinates (metres): sx = px*P, sy(up) = -py*P
  const cx = (x + w / 2) * P, cy = -(y + h / 2) * P;
  const dist = 20000;
  const pos = right.clone().multiplyScalar(cx).add(V.clone().multiplyScalar(cy)).add(D.clone().multiplyScalar(-dist));
  const cam = new THREE.OrthographicCamera(-w * P / 2, w * P / 2, h * P / 2, -h * P / 2, 1, dist * 2);
  cam.position.copy(pos);
  cam.up.copy(V);
  cam.lookAt(pos.clone().add(D));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

function makeHeightMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
      varying float vUp;
      void main(){
        vec4 wp = modelMatrix * vec4(position,1.0);
        vUp = wp.y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      precision highp float;
      varying float vUp;
      void main(){
        float v = clamp(floor(vUp*100.0 + 20000.0 + 0.5), 0.0, 16777215.0);
        float r = floor(v / 65536.0);
        float g = floor((v - r*65536.0) / 256.0);
        float b = v - r*65536.0 - g*256.0;
        gl_FragColor = vec4(r/255.0, g/255.0, b/255.0, 1.0);
      }`,
    side: THREE.DoubleSide,
  });
}

window.setup = async function (config, token, opts = {}) {
  cfg = config;
  renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, alpha: true, logarithmicDepthBuffer: false });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  tiles = new TilesRenderer();
  tiles.registerPlugin(new CesiumIonAuthPlugin({ apiToken: token, assetId: GOOGLE_3D_TILES_ASSET, autoRefreshToken: true }));
  tiles.registerPlugin(new GLTFExtensionsPlugin({}));
  tiles.addEventListener('load-tileset', () => { tiles.errorTarget = opts.errorTarget ?? 4; });
  tiles.lruCache.minSize = 4000; tiles.lruCache.maxSize = 20000;
  tiles.lruCache.minBytesSize = 1.5e9; tiles.lruCache.maxBytesSize = 4e9;
  tiles.lruCache.unloadPercent = 0.25;
  tiles.downloadQueue.maxJobs = opts.downloads ?? 24;
  tiles.parseQueue.maxJobs = 4;
  enuFromEcef = enuMatrix(cfg.origin[0], cfg.origin[1], cfg.origin[2]);
  tiles.group.matrixAutoUpdate = false;
  tiles.group.matrix.copy(enuFromEcef);
  tiles.group.matrixWorldNeedsUpdate = true;
  scene.add(tiles.group);
  heightMat = makeHeightMaterial();
  window.__attrib = () => tiles.getAttributions ? tiles.getAttributions().map(a => a.value).join(' | ') : '';
  return true;
};

async function settle(cam, w, h, timeoutMs) {
  renderer.setSize(w, h, false);
  tiles.setCamera(cam);
  tiles.setResolution(cam, w, h);
  const t0 = performance.now();
  let quiet = 0, iters = 0;
  while (performance.now() - t0 < timeoutMs) {
    cam.updateMatrixWorld();
    tiles.update();
    iters++;
    const s = tiles.stats;
    // settled = the tileset is loaded, this view uses tiles, nothing is queued, loading or
    // refused by a full cache, for 10 updates in a row (and never before 20 updates)
    const busy = s.queued + s.downloading + s.parsing + s.refused;
    if (busy === 0 && tiles.root && s.visible > 0 && iters >= 20) { quiet++; if (quiet >= 10) return { ok: true, ms: performance.now() - t0, iters, stats: { ...s } }; }
    else quiet = 0;
    await new Promise(r => setTimeout(r, busy ? 60 : 30));
  }
  return { ok: false, ms: performance.now() - t0, iters, stats: { ...tiles.stats } };
}

window.renderShot = async function ({ angle, x, y, w, h, timeoutMs = 240000, wantHeight = true }) {
  const cam = cameraFor(angle, x, y, w, h);
  const s = await settle(cam, w, h, timeoutMs);
  renderer.setClearColor(0x000000, 0);
  scene.overrideMaterial = null;
  renderer.render(scene, cam);
  const rgb = renderer.domElement.toDataURL('image/png');
  let height = null;
  if (wantHeight) {
    scene.overrideMaterial = heightMat;
    renderer.render(scene, cam);
    height = renderer.domElement.toDataURL('image/png');
    scene.overrideMaterial = null;
  }
  return { rgb, height, settle: s, attribution: window.__attrib() };
};

// For tests: project an ENU point with the same camera the renderer uses.
window.projectEnu = function (angle, x, y, w, h, e, n, u) {
  const cam = cameraFor(angle, x, y, w, h);
  const v = new THREE.Vector3(e, u, -n).project(cam);
  return [x + (v.x + 1) / 2 * w, y + (1 - v.y) / 2 * h];
};
window.setConfig = (c) => { cfg = c; };
