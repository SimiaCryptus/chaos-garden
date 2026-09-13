import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Orbit-view display box (half extents): Lx : Ly : Lz(shown) = 2 : 1 : 0.5 whatever the slab aspect H is, so every design fills the same volume. The HUD reports the z stretch. */
const VOL_HALF = new THREE.Vector3(1, 0.5, 0.25);
export const VOLUME_DEPTH = 2 * VOL_HALF.z;

const VOL_VS = /* glsl */`
out vec3 vPos;
void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
/** Emission–absorption ray march through the voxel texture. Alpha is an extinction density; ≥ 0.99 flags an opaque (solid) voxel. Premultiplied output. */
const VOL_FS = /* glsl */`
precision highp float; precision highp sampler3D;
in vec3 vPos;
uniform sampler3D uVol; uniform vec3 uHalf; uniform float uSteps; uniform float uDensity;
out vec4 outColor;
void main() {
  vec3 ro = cameraPosition, rd = normalize(vPos - ro), inv = 1.0 / rd;
  vec3 t0 = (-uHalf - ro) * inv, t1 = (uHalf - ro) * inv, tmn = min(t0, t1), tmx = max(t0, t1);
  float tn = max(max(max(tmn.x, tmn.y), tmn.z), 0.0), tf = min(min(tmx.x, tmx.y), tmx.z);
  if (tf <= tn) discard;
  float dt = (tf - tn) / uSteps;
  vec3 p = ro + rd * (tn + 0.5 * dt), dp = rd * dt, col = vec3(0.0); float T = 1.0;
  for (int i = 0; i < 512; i++) {
    if (float(i) >= uSteps || T < 0.01) break;
    vec4 s = texture(uVol, p / (2.0 * uHalf) + 0.5);
    if (s.a > 0.99) { col += T * s.rgb; T = 0.0; break; }
    float a = 1.0 - exp(-s.a * uDensity * dt);
    col += T * a * s.rgb; T *= 1.0 - a; p += dp;
  }
  outColor = vec4(col, 1.0 - T);
}`;

/** three.js setup: orthographic plan camera rendering a DataTexture quad (§8.1), plus an orbitable volumetric view of the 3D voxels. */
export class Renderer {
  constructor(canvas, Nx, Ny) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10); this.camera.position.z = 1;
    this.viewMode = 'plan'; this.mesh = null; this.volTex = null;
    this._buildOrbit();
    this.setGrid(Nx, Ny); this.resize();
  }
  _buildOrbit() {
    const s = this.volScene = new THREE.Scene(); s.background = new THREE.Color(0x05060a);
    this.persp = new THREE.PerspectiveCamera(38, 2, 0.01, 60); this.persp.up.set(0, 0, 1); this.persp.position.set(2.3, -2.5, 1.6);
    this.controls = new OrbitControls(this.persp, this.canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, minDistance: 0.4, maxDistance: 10, enabled: false });
    this.controls.update();
    const box = new THREE.BoxGeometry(2 * VOL_HALF.x, 2 * VOL_HALF.y, 2 * VOL_HALF.z);
    s.add(new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0x3a4150 })));
    // inlet face (−x) outlined in the accent colour so orientation is unambiguous once rotated
    const inlet = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(2 * VOL_HALF.z, 2 * VOL_HALF.y)), new THREE.LineBasicMaterial({ color: 0x6cc4ff }));
    inlet.rotation.y = Math.PI / 2; inlet.position.x = -VOL_HALF.x; s.add(inlet);
    this.volMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VOL_VS, fragmentShader: VOL_FS, side: THREE.BackSide, transparent: true, depthWrite: false, premultipliedAlpha: true,
      uniforms: { uVol: { value: null }, uHalf: { value: VOL_HALF }, uSteps: { value: 220 }, uDensity: { value: 14 } },
    });
    this.volMesh = new THREE.Mesh(box, this.volMat); this.volMesh.renderOrder = 1; s.add(this.volMesh);
  }
  setGrid(Nx, Ny) {
    const tex = new THREE.DataTexture(new Uint8Array(Nx * Ny * 4), Nx, Ny, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
    if (!this.mesh) { this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: tex })); this.scene.add(this.mesh); }
    else { this.mesh.material.map?.dispose(); this.mesh.material.map = tex; this.mesh.material.needsUpdate = true; }
    this.texture = tex;
  }
  /** (Re)allocate the voxel texture; call whenever the solver grid (Nz follows H) changes. Layout matches Grid.idx. */
  setVolumeGrid(Nx, Ny, Nz) {
    const tex = new THREE.Data3DTexture(new Uint8Array(Nx * Ny * Nz * 4), Nx, Ny, Nz);
    tex.format = THREE.RGBAFormat; tex.type = THREE.UnsignedByteType; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.unpackAlignment = 1; tex.needsUpdate = true;
    this.volTex?.dispose(); this.volTex = tex; this.volMat.uniforms.uVol.value = tex;
  }
  upload(data) { this.texture.image.data.set(data); this.texture.needsUpdate = true; }
  uploadVolume(data) { if (!this.volTex) return; this.volTex.image.data.set(data); this.volTex.needsUpdate = true; }
  /** 'plan' (top-down quad) or 'orbit' (volumetric, mouse-orbitable). Controls only capture the pointer in orbit mode. */
  setView(mode) { this.viewMode = mode; this.controls.enabled = mode === 'orbit'; this.resize(); }
  resize() {
    const w = this.canvas.clientWidth || 2, h = this.canvas.clientHeight || 1;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h; this.persp.updateProjectionMatrix();
  }
  render() {
    if (this.viewMode === 'orbit') { this.controls.update(); this.renderer.render(this.volScene, this.persp); }
    else this.renderer.render(this.scene, this.camera);
  }
  screenshot() { return this.canvas.toDataURL('image/png'); }
  dispose() { this.texture?.dispose(); this.volTex?.dispose(); this.mesh?.geometry.dispose(); this.mesh?.material.dispose(); this.volMesh?.geometry.dispose(); this.volMat?.dispose(); this.controls?.dispose(); this.renderer.dispose(); }
}