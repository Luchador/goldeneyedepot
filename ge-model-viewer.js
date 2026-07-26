import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DEFAULTS = {
	/* Linear is the closer match to the hardware, which sampled bilinearly. */
	filter: 'linear',
	culling: 'material',
	grid: false,
	zoom: 1.5
};

/* data-culling is the control; data-double-sided is the name this used to have
   and is still honoured so existing pages keep working. */
function readCulling(dataset) {
	const value = dataset.culling;
	if (value === 'material' || value === 'on' || value === 'off') return value;
	if (dataset.doubleSided !== undefined) {
		return dataset.doubleSided === 'false' || dataset.doubleSided === '0' ? 'on' : 'off';
	}
	return DEFAULTS.culling;
}

function formatCount(n) {
	return n.toLocaleString('en-US');
}

class ModelViewer {
	constructor(host) {
		this.host = host;
		this.opts = this.readOptions();
		this.state = {
			textures: true,
			vertexColors: true,
			wireframe: false,
			filter: this.opts.filter,
			culling: this.opts.culling
		};
		this.materialRecords = [];
		this.ownedMaterials = [];
		this.rafId = null;
		this.inUpdate = false;
		this.boundTick = () => this.tick();
		this.buildChrome();
	}

	readOptions() {
		const d = this.host.dataset;
		const bool = (v, fallback) =>
			v === undefined ? fallback : v === 'true' || v === '1';
		return {
			src: d.geModel,
			title: d.title || 'Model',
			poster: d.poster || '',
			filter: d.filter === 'nearest' || d.filter === 'linear' ? d.filter : DEFAULTS.filter,
			culling: readCulling(d),
			grid: bool(d.grid, DEFAULTS.grid),
			/* Empty means "leave it to the stylesheet". */
			background: d.background || '',
			zoom: parseFloat(d.zoom) || DEFAULTS.zoom
		};
	}

	/* ---------- DOM ---------- */

	buildChrome() {
		const o = this.opts;
		this.host.classList.add('ge-viewer');
		this.host.innerHTML = `
			<div class="gev-head">
				<span class="gev-eyebrow">Model</span>
				<h3 class="gev-title"></h3>
			</div>
			<div class="gev-stage">
				<canvas class="gev-canvas" tabindex="0"
					aria-label="Interactive 3D model. Drag to rotate, arrow keys also rotate."></canvas>
				<div class="gev-status" role="status"></div>
			</div>
			<div class="gev-controls">
				<button type="button" class="gev-btn" data-act="reset">Reset view</button>
				<button type="button" class="gev-btn is-on" data-act="textures" aria-pressed="true">Textures</button>
				<button type="button" class="gev-btn is-on" data-act="shading" aria-pressed="true">Vertex colours</button>
				<button type="button" class="gev-btn" data-act="wireframe" aria-pressed="false">Wireframe</button>
				<button type="button" class="gev-btn" data-act="culling">Cull: material</button>
				<button type="button" class="gev-btn" data-act="filter">Filter: linear</button>
				<button type="button" class="gev-btn" data-act="fullscreen">Fullscreen</button>
			</div>
			<dl class="gev-readout">
				<div><dt>Tris</dt><dd data-field="tris">&mdash;</dd></div>
				<div><dt>Verts</dt><dd data-field="verts">&mdash;</dd></div>
				<div><dt>Textures</dt><dd data-field="textures">&mdash;</dd></div>
			</dl>
			<p class="gev-hint">
				Drag to rotate &middot; right-drag to pan &middot; scroll to dolly &middot;
				click the viewport, then arrow keys to orbit,
				<span class="gev-key">+</span>/<span class="gev-key">&minus;</span> to dolly,
				<span class="gev-key">R</span> to reset, <span class="gev-key">F</span> for fullscreen
			</p>`;

		this.host.querySelector('.gev-title').textContent = o.title;
		this.host.querySelector('[data-act="culling"]').textContent = 'Cull: ' + o.culling;
		this.host.querySelector('[data-act="filter"]').textContent = 'Filter: ' + o.filter;
		this.canvas = this.host.querySelector('.gev-canvas');
		this.stage = this.host.querySelector('.gev-stage');
		this.statusEl = this.host.querySelector('.gev-status');
		/* Only override the stylesheet when a page asks for something specific. */
		if (o.background) this.stage.style.background = o.background;

		this.host.querySelectorAll('.gev-btn').forEach((btn) => {
			btn.addEventListener('click', () => this.onButton(btn));
		});

		if (!o.src) {
			this.fail('No model path set. Add data-ge-model to this element.');
			return;
		}
		this.observe();
	}

	/* Only spin up WebGL once the panel is actually near the viewport,
	   so a page can carry several viewers without paying for all of them. */
	observe() {
		if (!('IntersectionObserver' in window)) {
			this.init();
			return;
		}
		const io = new IntersectionObserver(
			(entries) => {
				entries.forEach((e) => {
					if (!e.isIntersecting) return;
					io.disconnect();
					this.init();
				});
			},
			{ rootMargin: '200px' }
		);
		io.observe(this.host);
	}

	setStatus(text, kind) {
		this.statusEl.textContent = text || '';
		this.statusEl.className = 'gev-status' + (kind ? ' gev-status--' + kind : '');
		this.statusEl.style.display = text ? '' : 'none';
	}

	fail(message) {
		this.host.classList.add('is-failed');
		if (this.opts.poster) {
			this.stage.innerHTML =
				'<img class="gev-poster" alt="' +
				this.opts.title.replace(/"/g, '&quot;') +
				'" src="' + this.opts.poster + '">' +
				'<div class="gev-status gev-status--error"></div>';
			this.statusEl = this.stage.querySelector('.gev-status');
		}
		this.setStatus(message, 'error');
		this.host.querySelectorAll('.gev-btn').forEach((b) => (b.disabled = true));
	}

	/* ---------- three.js ---------- */

	init() {
		let renderer;
		try {
			renderer = new THREE.WebGLRenderer({
				canvas: this.canvas,
				antialias: true,
				/* Transparent canvas, so the stage's CSS backdrop is the
				   background. Cheaper than rendering a gradient, and it stays
				   editable in the stylesheet rather than in here. */
				alpha: true,
				powerPreference: 'low-power'
			});
		} catch (err) {
			this.fail('This browser could not start WebGL, so the model cannot be shown.');
			return;
		}

		this.renderer = renderer;
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		renderer.outputColorSpace = THREE.SRGBColorSpace;

		renderer.setClearColor(0x000000, 0);

		this.scene = new THREE.Scene();

		this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 5000);
		this.camera.position.set(0, 0, 5);

		this.controls = new OrbitControls(this.camera, this.canvas);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;
		this.controls.screenSpacePanning = true;
		this.controls.rotateSpeed = 0.9;
		this.controls.zoomSpeed = 0.9;
		this.controls.addEventListener('change', () => {
			if (!this.inUpdate) this.requestRender();
		});

		this.modelRoot = new THREE.Group();
		this.scene.add(this.modelRoot);

		this.ro = new ResizeObserver(() => this.resize());
		this.ro.observe(this.stage);
		this.resize();

		this.canvas.addEventListener('keydown', (e) => this.onKey(e));
		/* Clicking the viewport should be enough to start driving it. */
		this.canvas.addEventListener('pointerdown', () => {
			this.canvas.focus({ preventScroll: true });
		});

		this.setStatus('Loading model\u2026');
		this.load();
	}

	load() {
		const loader = new GLTFLoader();
		loader.load(
			this.opts.src,
			(gltf) => {
				try {
					this.adopt(gltf.scene);
					this.setStatus('');
					this.requestRender();
				} catch (err) {
					this.fail('The model loaded but could not be prepared: ' + err.message);
				}
			},
			(progress) => {
				if (progress.total) {
					const pct = Math.round((progress.loaded / progress.total) * 100);
					this.setStatus('Loading model\u2026 ' + pct + '%');
				}
			},
			() => {
				this.fail('Could not load ' + this.opts.src + '. Check the path and that the file is present.');
			}
		);
	}

	/* Walk the loaded scene: replace every material with an unlit one,
	   fix up vertex colour space, gather counts. */
	adopt(root) {
		const counts = { tris: 0, verts: 0, meshes: 0 };
		const textures = new Set();
		/* Survey COLOR_0 exactly as the file supplies it, before any conversion,
		   so the readout answers "what did the exporter actually write?" rather
		   than "what did we do with it?". */
		const diag = { meshesWithColor: 0, min: Infinity, max: -Infinity, sum: 0, samples: 0, itemSize: 0 };

		root.traverse((node) => {
			if (!node.isMesh) return;
			counts.meshes++;

			const geo = node.geometry;
			const pos = geo.getAttribute('position');
			if (pos) counts.verts += pos.count;
			counts.tris += geo.index ? geo.index.count / 3 : (pos ? pos.count / 3 : 0);

			const colour = geo.getAttribute('color');
			if (colour) {
				diag.meshesWithColor++;
				diag.itemSize = colour.itemSize;
				/* Sample rather than scan: a big level has plenty of vertices and
				   the range is all we need. */
				const stride = Math.max(1, Math.floor(colour.count / 512));
				for (let i = 0; i < colour.count; i += stride) {
					const lum =
						0.2126 * colour.getX(i) +
						0.7152 * colour.getY(i) +
						0.0722 * colour.getZ(i);
					if (lum < diag.min) diag.min = lum;
					if (lum > diag.max) diag.max = lum;
					diag.sum += lum;
					diag.samples++;
				}
			}


			const source = Array.isArray(node.material) ? node.material[0] : node.material;
			if (source && source.map) textures.add(source.map);

			const record = {
				mesh: node,
				/* GLTFLoader has already turned doubleSided into a side value;
				   keep it so "material" mode can hand it straight back. */
				side: source && source.side !== undefined ? source.side : THREE.FrontSide,
				map: source ? source.map || null : null,
				color: source && source.color ? source.color.clone() : new THREE.Color(0xffffff),
				opacity: source ? source.opacity : 1,
				transparent: source ? source.transparent : false,
				alphaTest: source ? source.alphaTest : 0,
				hasVertexColors: !!geo.getAttribute('color')
			};
			this.materialRecords.push(record);
		});

		textures.forEach((tex) => {
			tex.colorSpace = THREE.SRGBColorSpace;
		});
		this.textures = textures;

		this.modelRoot.add(root);
		this.applyMaterials();
		this.frame();

		if (this.opts.grid) {
			const grid = new THREE.GridHelper(this.radius * 4, 16, 0x661111, 0x330a0a);
			grid.position.y = -this.radius;
			this.scene.add(grid);
		}

		this.host.querySelector('[data-field="tris"]').textContent = formatCount(Math.round(counts.tris));
		this.host.querySelector('[data-field="verts"]').textContent = formatCount(counts.verts);
		this.host.querySelector('[data-field="textures"]').textContent = formatCount(textures.size);
		this.describeCulling();
		this.reportShading(counts, diag);
	}

	/* Three outcomes worth telling apart, because they have three different causes:
	     "none"        no COLOR_0 in the file      -> exporter did not write it
	     "flat 1.00"   COLOR_0 present, all white  -> wrong colour attribute exported
	     "0.21-0.98"   real data                   -> any remaining problem is ours */
	reportShading(counts, diag) {
		/* The field is optional: the survey's real audience is the console. */
		const field = this.host.querySelector('[data-field="shade"]');
		if (field) {
			if (!diag.meshesWithColor) {
				field.textContent = 'none';
				field.classList.add('is-warn');
			} else if (diag.max - diag.min < 0.002) {
				field.textContent = 'flat ' + diag.max.toFixed(2);
				field.classList.add('is-warn');
			} else {
				field.textContent = diag.min.toFixed(2) + '\u2013' + diag.max.toFixed(2);
			}
		}

		const summary = {
			model: this.opts.src,
			meshes: counts.meshes,
			meshesWithColor0: diag.meshesWithColor,
			components: diag.itemSize || null,
			luminance: diag.samples
				? {
					min: +diag.min.toFixed(4),
					mean: +(diag.sum / diag.samples).toFixed(4),
					max: +diag.max.toFixed(4)
				}
				: null,
			culling: this.state.culling,
			sidesAsAuthored: this.sideCounts || null
		};
		if (!diag.meshesWithColor) {
			console.warn(
				'[ge-model-viewer] No COLOR_0 in this model, so there is no vertex shading to draw. ' +
				'In Blender 4.1 and later the glTF exporter only writes vertex colours when a Color ' +
				'Attribute node is wired into the material, or when the export option for vertex ' +
				'colours without a node is enabled.',
				summary
			);
		} else {
			console.info('[ge-model-viewer] vertex colour survey', summary);
		}
	}

	/* material: what the file declares, per material - the faithful one.
	   on:       cull everywhere, which exposes inverted winding.
	   off:      draw both sides everywhere, which hides it. */
	resolveSide(rec) {
		if (this.state.culling === 'on') return THREE.FrontSide;
		if (this.state.culling === 'off') return THREE.DoubleSide;
		return rec.side;
	}

	/* Tell the Cull button what "material" currently means, so the authored
	   split is discoverable without opening the console. */
	describeCulling() {
		const btn = this.host.querySelector('[data-act="culling"]');
		if (!btn) return;
		let single = 0;
		let double = 0;
		this.materialRecords.forEach((rec) => {
			if (rec.side === THREE.DoubleSide) double++;
			else single++;
		});
		btn.title =
			'As authored: ' + single + ' single-sided, ' + double + ' two-sided. ' +
			'Click to cycle material / on / off.';
		this.sideCounts = { single: single, double: double };
	}

	/* One material per distinct signature, shared across meshes. A level split
	   into a hundred room chunks then needs a handful of materials rather than a
	   hundred, which means fewer shader programs and fewer state changes per
	   frame. Old materials are disposed only after every mesh has been
	   repointed, since they are shared and disposing in-place would pull a
	   material out from under another mesh. */
	applyMaterials() {
		const s = this.state;
		const cache = new Map();
		const previous = this.ownedMaterials;

		this.materialRecords.forEach((rec) => {
			const useMap = s.textures && rec.map && !s.wireframe;
			const useVertexColors = s.vertexColors && rec.hasVertexColors && !s.wireframe;
			const key = [
				useMap ? rec.map.uuid : 'nomap',
				rec.color.getHex(),
				rec.opacity,
				rec.transparent,
				rec.alphaTest,
				useVertexColors,
				s.wireframe,
				this.resolveSide(rec)
			].join('|');

			let mat = cache.get(key);
			if (!mat) {
				mat = new THREE.MeshBasicMaterial({
					map: useMap ? rec.map : null,
					color: s.wireframe ? new THREE.Color(0xff4444) : rec.color,
					vertexColors: useVertexColors,
					side: this.resolveSide(rec),
					transparent: rec.transparent,
					opacity: rec.opacity,
					alphaTest: rec.alphaTest,
					wireframe: s.wireframe
				});
				cache.set(key, mat);
			}
			rec.mesh.material = mat;
		});

		this.ownedMaterials = Array.from(cache.values());
		previous.forEach((m) => m.dispose());

		this.applyFilter();
		this.requestRender();
	}

	applyFilter() {
		if (!this.textures) return;
		const nearest = this.state.filter === 'nearest';
		const max = this.renderer.capabilities.getMaxAnisotropy
			? this.renderer.capabilities.getMaxAnisotropy()
			: 1;
		this.textures.forEach((tex) => {
			/* Nearest shows the authentic texel grid, so mipmaps are off and
			   minification is left to alias the way the source art does.
			   Linear is the closer match to the hardware's own sampling, and
			   wants mipmaps or distant geometry shimmers. */
			tex.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
			tex.minFilter = nearest ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
			tex.generateMipmaps = !nearest;
			tex.anisotropy = nearest ? 1 : max;
			tex.needsUpdate = true;
		});
	}

	/* Centre the model on the origin and pull the camera back far
	   enough for its bounding sphere to fit the vertical FOV. */
	frame() {
		const box = new THREE.Box3().setFromObject(this.modelRoot);
		if (box.isEmpty()) {
			this.radius = 1;
			return;
		}
		const centre = box.getCenter(new THREE.Vector3());
		this.modelRoot.position.sub(centre);

		const sphere = box.getBoundingSphere(new THREE.Sphere());
		this.radius = sphere.radius || 1;

		const fov = THREE.MathUtils.degToRad(this.camera.fov);
		this.homeDistance = (this.radius / Math.sin(fov / 2)) * this.opts.zoom;

		this.camera.near = Math.max(this.radius / 500, 0.001);
		this.camera.far = this.homeDistance * 20;
		this.camera.updateProjectionMatrix();

		this.controls.minDistance = this.radius * 0.15;
		this.controls.maxDistance = this.homeDistance * 6;
		this.resetView();
	}

	resetView() {
		if (!this.homeDistance) return;
		/* Three-quarter view: reads as a display piece rather than an elevation. */
		this.camera.position.set(
			this.homeDistance * 0.55,
			this.homeDistance * 0.35,
			this.homeDistance * 0.75
		);
		this.controls.target.set(0, 0, 0);
		this.controls.update();
		this.requestRender();
	}

	/* ---------- interaction ---------- */

	onButton(btn) {
		const act = btn.dataset.act;
		const press = (on) => {
			btn.classList.toggle('is-on', on);
			btn.setAttribute('aria-pressed', on ? 'true' : 'false');
		};

		switch (act) {
			case 'reset':
				this.resetView();
				break;
			case 'textures':
				this.state.textures = !this.state.textures;
				press(this.state.textures);
				this.applyMaterials();
				break;
			case 'shading':
				this.state.vertexColors = !this.state.vertexColors;
				press(this.state.vertexColors);
				this.applyMaterials();
				break;
			case 'wireframe':
				this.state.wireframe = !this.state.wireframe;
				press(this.state.wireframe);
				this.applyMaterials();
				break;
			case 'filter':
				this.state.filter = this.state.filter === 'nearest' ? 'linear' : 'nearest';
				btn.textContent = 'Filter: ' + this.state.filter;
				this.applyFilter();
				this.requestRender();
				break;
			case 'culling': {
				const order = ['material', 'on', 'off'];
				const next = order[(order.indexOf(this.state.culling) + 1) % order.length];
				this.state.culling = next;
				btn.textContent = 'Cull: ' + next;
				this.applyMaterials();
				break;
			}
			case 'fullscreen':
				this.toggleFullscreen();
				break;
		}
	}

	toggleFullscreen() {
		/* Focus follows the viewport across the transition in both directions,
		   otherwise F gets you in and then stops responding on the way out. */
		if (document.fullscreenElement === this.host) {
			document.exitFullscreen()
				.then(() => this.focusCanvas())
				.catch(() => {});
		} else if (this.host.requestFullscreen) {
			this.host.requestFullscreen()
				.then(() => {
					this.resize();
					this.focusCanvas();
				})
				.catch(() => {});
		}
	}

	focusCanvas() {
		if (this.canvas) this.canvas.focus({ preventScroll: true });
	}

	onKey(e) {
		if (!this.controls) return;
		const step = 0.12;
		let handled = true;
		switch (e.key) {
			case 'ArrowLeft':  this.orbit(-step, 0); break;
			case 'ArrowRight': this.orbit(step, 0); break;
			case 'ArrowUp':    this.orbit(0, -step); break;
			case 'ArrowDown':  this.orbit(0, step); break;
			case '+':
			case '=':          this.dolly(0.9); break;
			case '-':
			case '_':          this.dolly(1.1); break;
			case 'r':
			case 'R':          this.resetView(); break;
			case 'f':
			case 'F':          this.toggleFullscreen(); break;
			default:           handled = false;
		}
		if (handled) e.preventDefault();
	}

	orbit(dTheta, dPhi) {
		const offset = this.camera.position.clone().sub(this.controls.target);
		const spherical = new THREE.Spherical().setFromVector3(offset);
		spherical.theta += dTheta;
		spherical.phi = THREE.MathUtils.clamp(spherical.phi + dPhi, 0.05, Math.PI - 0.05);
		offset.setFromSpherical(spherical);
		this.camera.position.copy(this.controls.target).add(offset);
		this.controls.update();
		this.requestRender();
	}

	dolly(factor) {
		const offset = this.camera.position.clone().sub(this.controls.target);
		const len = THREE.MathUtils.clamp(
			offset.length() * factor,
			this.controls.minDistance,
			this.controls.maxDistance
		);
		offset.setLength(len);
		this.camera.position.copy(this.controls.target).add(offset);
		this.controls.update();
		this.requestRender();
	}

	/* ---------- render loop ----------
	   On demand rather than continuous: several viewers on one page
	   shouldn't hold the GPU awake for a static object.

	   Exactly ONE frame may ever be queued. rafId is the guard, and it is
	   deliberately not cleared until the queued frame actually runs, because
	   controls.update() below dispatches 'change' while damping settles and
	   that handler calls back into requestRender(). Clearing the guard too
	   early lets each frame queue two successors, which doubles per frame
	   and buries the main thread within a couple of seconds. */

	resize() {
		if (!this.renderer) return;
		const w = this.stage.clientWidth;
		const h = this.stage.clientHeight;
		if (!w || !h) return;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.requestRender();
	}

	requestRender() {
		if (this.rafId !== null) return;
		this.rafId = requestAnimationFrame(this.boundTick);
	}

	tick() {
		this.rafId = null;
		if (!this.renderer) return;

		/* Suppress the 'change' events our own update() emits; the return
		   value already tells us whether another frame is needed. */
		this.inUpdate = true;
		const moved = this.controls.update();
		this.inUpdate = false;

		this.renderer.render(this.scene, this.camera);

		if (moved && this.rafId === null) {
			this.rafId = requestAnimationFrame(this.boundTick);
		}
	}
}

function boot() {
	document.querySelectorAll('[data-ge-model]').forEach((el) => {
		if (el.dataset.geViewerReady) return;
		el.dataset.geViewerReady = '1';
		new ModelViewer(el);
	});
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', boot);
} else {
	boot();
}

export { ModelViewer, boot };