/*
 * WINRO project page - interactive skeleton motion viewer.
 * Adapted from the ECCV 2026 supplementary 3D motion viewer,
 * reduced to stick-figure (skeleton) rendering only: no SMPL mesh
 * geometry is loaded or displayed on this page.
 *
 * Rendering: Three.js (MIT License) + OrbitControls (MIT License).
 */
"use strict";

var WINRO = (function () {

  var BODY_COLOR = 0x28a028;
  var STYLE_REF_COLOR = 0x24329e;
  var FPS = 20;

  // HumanML3D 22-joint parent indices (temporal composition data)
  var HUMANML_PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19];

  // Joint index -> body part mapping (22 joints, for MTT timeline coloring)
  var JOINT_TO_BP = {
    0: "legs", 1: "legs", 2: "legs", 3: "spine", 4: "legs", 5: "legs", 6: "spine",
    7: "legs", 8: "legs", 9: "spine", 10: "legs", 11: "legs", 12: "head", 13: "left arm",
    14: "right arm", 15: "head", 16: "left arm", 17: "right arm", 18: "left arm",
    19: "right arm", 20: "left arm", 21: "right arm"
  };
  var BP_COLORS = { "left arm": "#2196F3", "right arm": "#F44336", "legs": "#4CAF50", "head": "#9C27B0", "spine": "#FF9800" };
  var BP_INACTIVE = "#BBBBBB";

  // ------------------------------------------------------------
  // Compressed joint decoder (delta + gzip + base64)
  // ------------------------------------------------------------
  async function gunzip(base64str) {
    var raw = atob(base64str);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    var ds = new DecompressionStream("gzip");
    var blob = new Blob([bytes]);
    var stream = blob.stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function decodeMotionJoints(motionData, nJoints) {
    var decompressed = await gunzip(motionData.joints.data);
    var int16 = new Int16Array(decompressed.buffer);
    var vmin = motionData.joints.min;
    var vmax = motionData.joints.max;
    var range = [vmax[0] - vmin[0], vmax[1] - vmin[1], vmax[2] - vmin[2]];
    var nFrames = motionData.n_frames;
    var planeSize = nFrames * nJoints;
    var planes = [new Uint16Array(planeSize), new Uint16Array(planeSize), new Uint16Array(planeSize)];
    for (var ci = 0; ci < 3; ci++) {
      var offset = ci * planeSize;
      for (var v = 0; v < nJoints; v++) planes[ci][v] = int16[offset + v] & 0xFFFF;
      for (var i = nJoints; i < planeSize; i++) planes[ci][i] = (planes[ci][i - nJoints] + int16[offset + i]) & 0xFFFF;
    }
    var frames = [];
    for (var f = 0; f < nFrames; f++) {
      var joints = [];
      var fOff = f * nJoints;
      for (var ji = 0; ji < nJoints; ji++) {
        joints.push([
          (planes[0][fOff + ji] / 65535) * range[0] + vmin[0],
          (planes[1][fOff + ji] / 65535) * range[1] + vmin[1],
          (planes[2][fOff + ji] / 65535) * range[2] + vmin[2]
        ]);
      }
      frames.push(joints);
    }
    return frames;
  }

  // ------------------------------------------------------------
  // Camera helpers
  // ------------------------------------------------------------
  function computeCameraFromMotion(motion) {
    var minX = Infinity, minY = Infinity, minZ = Infinity;
    var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (var f = 0; f < motion.joints.length; f++) {
      var jd = motion.joints[f];
      for (var j = 0; j < jd.length; j++) {
        if (jd[j][0] < minX) minX = jd[j][0]; if (jd[j][0] > maxX) maxX = jd[j][0];
        if (jd[j][1] < minY) minY = jd[j][1]; if (jd[j][1] > maxY) maxY = jd[j][1];
        if (jd[j][2] < minZ) minZ = jd[j][2]; if (jd[j][2] > maxZ) maxZ = jd[j][2];
      }
    }
    if (motion.markers) {
      for (var mi = 0; mi < motion.markers.length; mi++) {
        var mp = motion.markers[mi].position;
        var mr = motion.markers[mi].radius || 0;
        var mh = motion.markers[mi].height || 0;
        if (mp[0] - mr < minX) minX = mp[0] - mr; if (mp[0] + mr > maxX) maxX = mp[0] + mr;
        if (mp[1] < minY) minY = mp[1]; if (mp[1] + mh > maxY) maxY = mp[1] + mh;
        if (mp[2] - mr < minZ) minZ = mp[2] - mr; if (mp[2] + mr > maxZ) maxZ = mp[2] + mr;
      }
    }
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    var dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    var maxExtent = Math.max(dx, dy, dz);
    var fovRad = 50 * Math.PI / 180;
    var viewExtent = Math.max(dy, Math.max(dx, dz)) * 1.15;
    var dist = (viewExtent / 2) / Math.tan(fovRad / 2);
    dist = Math.max(dist, 1.5);
    return { target: [cx, cy, cz], dist: dist, extent: maxExtent, dx: dx, dy: dy, dz: dz };
  }

  function unifyCameraDistance(cams) {
    var maxDist = 0;
    for (var i = 0; i < cams.length; i++) if (cams[i].dist > maxDist) maxDist = cams[i].dist;
    var angle = 20 * Math.PI / 180;
    for (var j = 0; j < cams.length; j++) {
      var t = cams[j].target;
      cams[j].position = [t[0], t[1] + maxDist * Math.sin(angle), t[2] + maxDist * Math.cos(angle)];
      cams[j].extent = Math.max(cams[j].extent, maxDist);
    }
    return cams;
  }

  // ------------------------------------------------------------
  // SkeletonViewer: one canvas showing one stick-figure motion
  // ------------------------------------------------------------
  function SkeletonViewer(container, motionData, camParams, opts) {
    this.container = container;
    this.motion = motionData;
    this.camParams = camParams;
    this.currentT = 0;
    this._opts = opts;
    this._activeBPs = null;
    this._perJointColors = opts.perJointColors || false;
    this._setup();
    if (motionData.markers && motionData.markers.length > 0) this._setupMarkers(motionData.markers);
    this.updateFrame(0);
  }

  SkeletonViewer.prototype._setup = function () {
    var w = this.container.clientWidth, h = this.container.clientHeight;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf0f0f0);
    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
    this.camera.position.set(this.camParams.position[0], this.camParams.position[1], this.camParams.position[2]);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.container.appendChild(this.renderer.domElement);
    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(this.camParams.target[0], this.camParams.target[1], this.camParams.target[2]);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.update();

    // Lights
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    var cx = this.camParams.target[0], cy = this.camParams.target[1], cz = this.camParams.target[2];
    var ext = this.camParams.extent;
    var dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(cx + 2, cy + 5, cz + 3);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024; dirLight.shadow.mapSize.height = 1024;
    var ss = Math.max(ext, 3) + 2;
    dirLight.shadow.camera.left = -ss; dirLight.shadow.camera.right = ss;
    dirLight.shadow.camera.top = ss; dirLight.shadow.camera.bottom = -ss;
    dirLight.shadow.camera.near = 0.1; dirLight.shadow.camera.far = 30;
    dirLight.shadow.bias = -0.001;
    dirLight.target.position.set(cx, 0, cz);
    this.scene.add(dirLight); this.scene.add(dirLight.target);
    var fillLight = new THREE.DirectionalLight(0x88aaff, 0.2);
    fillLight.position.set(cx - 2, cy + 2, cz - 1);
    this.scene.add(fillLight);

    // Checkerboard ground
    var groundSize = Math.max(this.camParams.dx, this.camParams.dz) + 8;
    var cc = document.createElement("canvas"); cc.width = 2; cc.height = 2;
    var ctx2d = cc.getContext("2d");
    ctx2d.fillStyle = "#f0f0f0"; ctx2d.fillRect(0, 0, 2, 2);
    ctx2d.fillStyle = "#999999"; ctx2d.fillRect(1, 0, 1, 1); ctx2d.fillRect(0, 1, 1, 1);
    var tex = new THREE.CanvasTexture(cc);
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
    tex.repeat.set(groundSize / 0.5, groundSize / 0.5);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize),
      new THREE.MeshPhongMaterial({ map: tex, specular: 0x111111, shininess: 5 }));
    this.ground.rotation.x = -Math.PI / 2; this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.shadowGround = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize),
      new THREE.ShadowMaterial({ opacity: 0.2 }));
    this.shadowGround.rotation.x = -Math.PI / 2; this.shadowGround.position.y = 0.001;
    this.shadowGround.receiveShadow = true;
    this.scene.add(this.shadowGround);

    this._setupSkeleton();

    var self = this;
    this._resizeObserver = new ResizeObserver(function () {
      var w2 = self.container.clientWidth, h2 = self.container.clientHeight;
      if (w2 > 0 && h2 > 0 && self.renderer) {
        self.camera.aspect = w2 / h2; self.camera.updateProjectionMatrix(); self.renderer.setSize(w2, h2);
      }
    });
    this._resizeObserver.observe(this.container);
  };

  SkeletonViewer.prototype._setupSkeleton = function () {
    var parents = this._opts.parents;
    var nj = parents.length;
    this.skeletonGroup = new THREE.Group();
    this.scene.add(this.skeletonGroup);
    this._skelJoints = [];

    var sphereRadius = this._opts.sphereRadius || 0.035;
    var boneRadius = this._opts.boneRadius || 0.02;
    var sGeo = new THREE.SphereGeometry(sphereRadius, 8, 8);
    var bGeo = new THREE.CylinderGeometry(boneRadius, boneRadius, 1, 8); bGeo.translate(0, 0.5, 0);

    var bodyColor = this._opts.bodyColor || BODY_COLOR;

    if (this._perJointColors) {
      for (var ji = 0; ji < nj; ji++) {
        var mat = new THREE.MeshPhongMaterial({ color: bodyColor, transparent: true, opacity: 1.0 });
        var s = new THREE.Mesh(sGeo, mat); s.castShadow = true;
        this.skeletonGroup.add(s); this._skelJoints.push(s);
      }
    } else {
      var jMat = new THREE.MeshPhongMaterial({ color: bodyColor });
      for (var jk = 0; jk < nj; jk++) {
        var sj = new THREE.Mesh(sGeo, jMat); sj.castShadow = true;
        this.skeletonGroup.add(sj); this._skelJoints.push(sj);
      }
    }

    this._skelBones = [];
    if (this._perJointColors) {
      this._boneMat = null;
      for (var jb = 1; jb < nj; jb++) {
        if (parents[jb] < 0) continue;
        var bmat = new THREE.MeshPhongMaterial({ color: bodyColor, transparent: true, opacity: 1.0 });
        var b = new THREE.Mesh(bGeo, bmat); b.castShadow = true;
        this.skeletonGroup.add(b);
        this._skelBones.push({ mesh: b, parent: parents[jb], child: jb });
      }
    } else {
      this._boneMat = new THREE.MeshPhongMaterial({ color: bodyColor });
      for (var jc = 1; jc < nj; jc++) {
        if (parents[jc] < 0) continue;
        var bc = new THREE.Mesh(bGeo, this._boneMat); bc.castShadow = true;
        this.skeletonGroup.add(bc);
        this._skelBones.push({ mesh: bc, parent: parents[jc], child: jc });
      }
    }

    // Root trajectory lines (one per skeleton root, for merged scenes)
    this._trajRoots = [];
    for (var jr = 0; jr < nj; jr++) if (parents[jr] < 0) this._trajRoots.push(jr);
    this._trajPts = [];
    this._trajLines = [];
    for (var tr = 0; tr < this._trajRoots.length; tr++) {
      this._trajPts.push([]);
      var tGeo = new THREE.BufferGeometry();
      tGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      var line = new THREE.Line(tGeo, new THREE.LineBasicMaterial({ color: 0xe94560, linewidth: 2 }));
      this.scene.add(line);
      this._trajLines.push(line);
    }
  };

  SkeletonViewer.prototype._updateSkeletonColors = function (activeBPs) {
    if (!this._perJointColors) return;
    for (var ji = 0; ji < this._skelJoints.length; ji++) {
      var bp = JOINT_TO_BP[ji];
      var isActive = activeBPs && activeBPs.has(bp);
      this._skelJoints[ji].material.color.set(isActive ? BP_COLORS[bp] : BP_INACTIVE);
      this._skelJoints[ji].material.opacity = isActive ? 1.0 : 0.4;
    }
    for (var i = 0; i < this._skelBones.length; i++) {
      var bpb = JOINT_TO_BP[this._skelBones[i].child];
      var isActiveB = activeBPs && activeBPs.has(bpb);
      this._skelBones[i].mesh.material.color.set(isActiveB ? BP_COLORS[bpb] : BP_INACTIVE);
      this._skelBones[i].mesh.material.opacity = isActiveB ? 1.0 : 0.4;
    }
  };

  SkeletonViewer.prototype._setupMarkers = function (markers) {
    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];
      var color = new THREE.Color(m.color || "#4285f4");
      var pos = m.position;
      var opacity = (m.opacity !== undefined) ? m.opacity : (m.type === "cylinder" ? 0.35 : 0.7);
      var isTransparent = opacity < 1.0;
      var mesh;
      if (m.type === "disc") {
        var r = m.radius || 0.2, h = 0.02;
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 32),
          new THREE.MeshPhongMaterial({ color: color, transparent: isTransparent, opacity: opacity }));
        mesh.position.set(pos[0], pos[1] + h / 2, pos[2]);
        mesh.receiveShadow = true;
      } else if (m.type === "cylinder") {
        var r2 = m.radius || 0.75, h2 = m.height || 1.5;
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(r2, r2, h2, 32),
          new THREE.MeshPhongMaterial({ color: color, transparent: isTransparent, opacity: opacity }));
        mesh.position.set(pos[0], pos[1] + h2 / 2, pos[2]);
        mesh.castShadow = true; mesh.receiveShadow = true;
      }
      if (mesh) this.scene.add(mesh);
    }
  };

  SkeletonViewer.prototype._updateSkeleton = function (jd) {
    for (var ji = 0; ji < jd.length; ji++) this._skelJoints[ji].position.set(jd[ji][0], jd[ji][1], jd[ji][2]);
    for (var i = 0; i < this._skelBones.length; i++) {
      var b = this._skelBones[i], p = jd[b.parent], c = jd[b.child];
      var dx = c[0] - p[0], dy = c[1] - p[1], dz = c[2] - p[2], len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      b.mesh.position.set(p[0], p[1], p[2]); b.mesh.scale.set(1, Math.max(len, 0.001), 1);
      if (len > 1e-6) b.mesh.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize()));
    }
  };

  SkeletonViewer.prototype._updateTrajectory = function (jd) {
    for (var i = 0; i < this._trajRoots.length; i++) {
      var root = jd[this._trajRoots[i]];
      this._trajPts[i].push(root[0], 0.003, root[2]);
      var arr = new Float32Array(this._trajPts[i]); this._trajLines[i].geometry.dispose();
      var g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      this._trajLines[i].geometry = g;
    }
  };

  SkeletonViewer.prototype._resetTrajectory = function () {
    for (var i = 0; i < this._trajLines.length; i++) {
      this._trajPts[i] = []; this._trajLines[i].geometry.dispose();
      var g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      this._trajLines[i].geometry = g;
    }
  };

  SkeletonViewer.prototype.updateFrame = function (t) {
    if (!this.motion) return;
    var nStored = this.motion.joints.length;
    t = Math.max(0, Math.min(t, nStored - 1));
    var idx0 = Math.floor(t);
    var idx1 = Math.min(idx0 + 1, nStored - 1);
    var alpha = t - idx0;
    var prev = this.currentT;

    var jd;
    if (alpha < 0.001) {
      jd = this.motion.joints[idx0];
    } else {
      var j0 = this.motion.joints[idx0], j1 = this.motion.joints[idx1];
      jd = [];
      for (var ji = 0; ji < j0.length; ji++) {
        jd.push([
          j0[ji][0] + (j1[ji][0] - j0[ji][0]) * alpha,
          j0[ji][1] + (j1[ji][1] - j0[ji][1]) * alpha,
          j0[ji][2] + (j1[ji][2] - j0[ji][2]) * alpha
        ]);
      }
    }

    this._updateSkeleton(jd);
    if (this._perJointColors && this._activeBPs) this._updateSkeletonColors(this._activeBPs);
    if (t < prev) this._resetTrajectory();
    this._updateTrajectory(jd);
    this.currentT = t;
  };

  SkeletonViewer.prototype.render = function () {
    if (!this.renderer) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  SkeletonViewer.prototype.resetCamera = function () {
    this.camera.position.set(this.camParams.position[0], this.camParams.position[1], this.camParams.position[2]);
    this.controls.target.set(this.camParams.target[0], this.camParams.target[1], this.camParams.target[2]);
    this.controls.update();
  };

  SkeletonViewer.prototype.dispose = function () {
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this.controls) this.controls.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      if (this.renderer.domElement && this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
      this.renderer = null;
    }
  };

  // ------------------------------------------------------------
  // Panel: one comparison group (N synced viewers + playback bar)
  // ------------------------------------------------------------
  function Panel(groupData, dataInfo, mount) {
    this.groupData = groupData;
    this.dataInfo = dataInfo;
    this.mount = mount;
    this.viewers = [];
    this.playing = true;
    this.currentFrame = 0;
    this.frameAccum = 0;
    this._syncingCamera = false;
    this.totalFrames = Math.min.apply(null, groupData.motions.map(function (m) {
      return m.n_frames_original || m.n_frames;
    }));
  }

  Panel.prototype.init = async function () {
    var motions = this.groupData.motions;
    for (var i = 0; i < motions.length; i++) {
      var mot = motions[i];
      if (this.dataInfo.isDirect22) {
        if (!mot.joints) mot.joints = mot.joints_per_frame;
      } else if (!Array.isArray(mot.joints)) {
        mot.joints = await decodeMotionJoints(mot, mot.n_joints || this.dataInfo.nJoints);
      }
    }
    this._buildDOM();
    this._createViewers();
  };

  function richText(s) {
    return (s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/&lt;hl&gt;/g, '<span class="highlight">').replace(/&lt;\/hl&gt;/g, "</span>");
  }

  Panel.prototype._buildDOM = function () {
    var root = document.createElement("div");
    root.className = "winro-panel";
    this.root = root;

    if (this.groupData.prompt) {
      var prompt = document.createElement("div"); prompt.className = "comp-prompt";
      prompt.innerHTML = richText(this.groupData.prompt);
      root.appendChild(prompt);
    }

    var rowSize = this.groupData.rowSize || 0;
    var rowLabels = this.groupData.rowLabels || [];
    this._rows = [];
    if (rowSize > 0) {
      var nRows = Math.ceil(this.groupData.motions.length / rowSize);
      for (var ri = 0; ri < nRows; ri++) {
        var isOursRow = rowLabels[ri] && rowLabels[ri].toLowerCase().indexOf("ours") >= 0;
        var wrapper = document.createElement("div");
        wrapper.className = "viewer-row-wrapper" + (isOursRow ? " highlighted" : "");
        var label = document.createElement("div");
        label.className = "row-label" + (isOursRow ? " ours" : "");
        label.textContent = rowLabels[ri] || "";
        wrapper.appendChild(label);
        var row = document.createElement("div"); row.className = "viewer-row";
        wrapper.appendChild(row);
        root.appendChild(wrapper);
        this._rows.push(row);
      }
    } else {
      var row0 = document.createElement("div"); row0.className = "viewer-row";
      if (this.groupData.motions.length >= 5) row0.classList.add("compact");
      root.appendChild(row0);
      this._rows.push(row0);
    }

    if (this.groupData.markerLegend) {
      var legend = document.createElement("div"); legend.className = "marker-legend";
      for (var li = 0; li < this.groupData.markerLegend.length; li++) {
        var item = this.groupData.markerLegend[li];
        var el = document.createElement("span"); el.className = "marker-legend-item";
        el.innerHTML = '<span class="marker-legend-swatch" style="background:' + item.color + '"></span> ' + item.label;
        legend.appendChild(el);
      }
      root.appendChild(legend);
    }

    // Timeline panel (temporal composition)
    this._tl = null;
    if (this.groupData.timeline && this.groupData.timeline.length > 0) {
      var tlPanel = document.createElement("div"); tlPanel.className = "timeline-panel";
      var tlProg = document.createElement("div"); tlProg.className = "tl-progress";
      var tlFill = document.createElement("div"); tlFill.className = "tl-progress-fill"; tlFill.style.width = "0%";
      var tlTime = document.createElement("span"); tlTime.className = "tl-time"; tlTime.textContent = "0.0s / 0.0s";
      tlProg.appendChild(tlFill); tlProg.appendChild(tlTime);
      tlPanel.appendChild(tlProg);
      var tlIntervals = document.createElement("div"); tlIntervals.className = "tl-intervals";
      var ivEls = [];
      var timeline = this.groupData.timeline;
      for (var ti = 0; ti < timeline.length; ti++) {
        var iv = timeline[ti];
        var ivEl = document.createElement("div"); ivEl.className = "tl-interval";
        var bpTags = "";
        for (var bpi = 0; bpi < iv.bodyparts.length; bpi++) {
          var bp = iv.bodyparts[bpi];
          var bpColor = BP_COLORS[bp] || "#999";
          bpTags += '<span class="tl-bp-tag" style="color:' + bpColor + '">[' + bp.toUpperCase() + ']</span> ';
        }
        ivEl.innerHTML = '<span class="tl-bullet">&#9679;</span>' +
          '<span class="tl-text">' + iv.text + '</span>' + bpTags +
          '<span class="tl-time-range">' + iv.start_sec.toFixed(1) + '-' + iv.end_sec.toFixed(1) + 's</span>';
        tlIntervals.appendChild(ivEl);
        ivEls.push(ivEl);
      }
      tlPanel.appendChild(tlIntervals);
      var tlLegend = document.createElement("div"); tlLegend.className = "tl-legend";
      var bpNames = ["left arm", "right arm", "legs", "head", "spine"];
      for (var lj = 0; lj < bpNames.length; lj++) {
        var bpn = bpNames[lj];
        tlLegend.innerHTML += '<span class="tl-legend-item"><span class="tl-legend-swatch" style="background:' + BP_COLORS[bpn] + '"></span>' + bpn.toUpperCase() + '</span>';
      }
      tlPanel.appendChild(tlLegend);
      root.appendChild(tlPanel);
      this._tl = { fill: tlFill, time: tlTime, ivEls: ivEls };
    }

    // Playback bar
    var bar = document.createElement("div"); bar.className = "playback-bar";
    var playBtn = document.createElement("button"); playBtn.className = "play-btn playing"; playBtn.innerHTML = "&#9646;&#9646;";
    var slider = document.createElement("input");
    slider.type = "range"; slider.className = "timeline-slider";
    slider.min = 0; slider.max = this.totalFrames - 1; slider.value = 0;
    var flabel = document.createElement("span"); flabel.className = "frame-label";
    flabel.textContent = "1 / " + this.totalFrames;
    bar.appendChild(playBtn); bar.appendChild(slider); bar.appendChild(flabel);
    root.appendChild(bar);
    this._playBtn = playBtn; this._slider = slider; this._flabel = flabel;

    var self = this;
    playBtn.addEventListener("click", function () {
      self.playing = !self.playing;
      playBtn.innerHTML = self.playing ? "&#9646;&#9646;" : "&#9654;";
      playBtn.classList.toggle("playing", self.playing);
    });
    slider.addEventListener("input", function (e) { self.setFrame(parseInt(e.target.value)); });

    this.mount.appendChild(root);
  };

  Panel.prototype._createViewers = function () {
    var motions = this.groupData.motions;
    var rowSize = this.groupData.rowSize || 0;
    this._cams = unifyCameraDistance(motions.map(computeCameraFromMotion));
    this._containers = [];
    var self = this;

    motions.forEach(function (motion, idx) {
      var rowIdx = (rowSize > 0) ? Math.floor(idx / rowSize) : 0;
      var row = self._rows[rowIdx];

      var nameLower = motion.name.toLowerCase();
      var isOurs = nameLower.indexOf("ours") >= 0 || nameLower.indexOf("optimized") >= 0;
      var col = document.createElement("div"); col.className = "viewer-column";
      var label = document.createElement("div"); label.className = "viewer-label" + (isOurs ? " ours" : "");
      label.textContent = motion.name;
      col.appendChild(label);
      var cc = document.createElement("div");
      cc.className = "viewer-canvas-container" + (isOurs ? " ours" : "");
      if (!WINRO._hintDismissed) {
        var hint = document.createElement("div"); hint.className = "viewer-hint";
        hint.innerHTML = '<div class="viewer-hint-content">' +
          '<div class="viewer-hint-icon">&#x1F5B1;</div>' +
          '<div class="viewer-hint-text">Drag to Rotate</div>' +
          '<div class="viewer-hint-sub">Scroll = Zoom / Right-drag = Pan</div>' +
          '</div>';
        cc.appendChild(hint);
        // Each hint fades out on its own a few seconds after its viewer appears
        setTimeout(function () {
          hint.classList.add("hidden");
          setTimeout(function () { if (hint.parentNode) hint.parentNode.removeChild(hint); }, 700);
        }, 6000);
      }
      col.appendChild(cc);
      row.appendChild(col);
      self._containers.push(cc);
    });

    this._instantiateViewers();
  };

  // Create the WebGL viewers inside the (persistent) canvas containers.
  // Called on first build and again when a suspended panel is resumed.
  Panel.prototype._instantiateViewers = function () {
    var self = this;
    this.groupData.motions.forEach(function (motion, idx) {
      var isStyleRef = motion.name.toLowerCase().indexOf("style reference") >= 0;
      var viewer = new SkeletonViewer(self._containers[idx], motion, self._cams[idx], {
        parents: self.groupData.parents || self.dataInfo.parents,
        sphereRadius: self.dataInfo.sphereRadius,
        boneRadius: self.dataInfo.boneRadius,
        perJointColors: self.dataInfo.isDirect22,
        bodyColor: isStyleRef ? STYLE_REF_COLOR : BODY_COLOR
      });
      self.viewers.push(viewer);
    });

    // Camera sync within the panel
    this.viewers.forEach(function (srcViewer, srcIdx) {
      srcViewer.controls.addEventListener("change", function () {
        WINRO.dismissHints();
        if (!WINRO.syncCameras || self._syncingCamera) return;
        self._syncingCamera = true;
        var offset = new THREE.Vector3().subVectors(srcViewer.camera.position, srcViewer.controls.target);
        self.viewers.forEach(function (dstViewer, dstIdx) {
          if (dstIdx === srcIdx) return;
          dstViewer.camera.position.copy(dstViewer.controls.target).add(offset);
          dstViewer.controls.update();
        });
        self._syncingCamera = false;
      });
    });

    this.setFrame(this.currentFrame);
  };

  // Release the WebGL contexts but keep the panel DOM in place, so the
  // page layout (and the scroll position) never changes.
  Panel.prototype.suspend = function () {
    this.viewers.forEach(function (v) { v.dispose(); });
    this.viewers = [];
  };

  Panel.prototype.resume = function () {
    if (this.viewers.length > 0) return;
    this._instantiateViewers();
  };

  Panel.prototype.setFrame = function (idx) {
    idx = Math.max(0, Math.min(idx, this.totalFrames - 1));
    this.currentFrame = idx;
    var subsample = this.dataInfo.subsample || 1;
    var t = idx / subsample;
    this.viewers.forEach(function (v) { v.updateFrame(t); });
    this._slider.value = idx;
    this._flabel.textContent = (idx + 1) + " / " + this.totalFrames;

    if (this._tl) {
      var timeSec = idx / FPS;
      var totalSec = this.totalFrames / FPS;
      var progress = idx / Math.max(this.totalFrames - 1, 1);
      this._tl.fill.style.width = (progress * 100).toFixed(1) + "%";
      this._tl.time.textContent = timeSec.toFixed(1) + "s / " + totalSec.toFixed(1) + "s";

      var activeBPs = new Set();
      var timeline = this.groupData.timeline;
      for (var ti = 0; ti < timeline.length; ti++) {
        var iv = timeline[ti];
        var isActive = timeSec >= iv.start_sec && timeSec < iv.end_sec;
        this._tl.ivEls[ti].classList.toggle("active", isActive);
        if (isActive) for (var bpi = 0; bpi < iv.bodyparts.length; bpi++) activeBPs.add(iv.bodyparts[bpi]);
      }
      this.viewers.forEach(function (v) {
        v._activeBPs = activeBPs;
        v._updateSkeletonColors(activeBPs);
      });
    }
  };

  Panel.prototype.step = function (dt) {
    if (!this.playing) return;
    this.frameAccum += dt * FPS;
    while (this.frameAccum >= 1) {
      this.frameAccum -= 1;
      var next = this.currentFrame + 1;
      if (next >= this.totalFrames) {
        next = 0;
        this.viewers.forEach(function (v) { v._resetTrajectory(); });
      }
      this.setFrame(next);
    }
  };

  Panel.prototype.render = function () { this.viewers.forEach(function (v) { v.render(); }); };

  Panel.prototype.destroy = function () {
    this.viewers.forEach(function (v) { v.dispose(); });
    this.viewers = [];
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
  };

  // ------------------------------------------------------------
  // Data loading (lazy script injection, one file per section)
  // ------------------------------------------------------------
  var _dataPromises = {};
  function loadData(key, src) {
    if (!_dataPromises[key]) {
      _dataPromises[key] = new Promise(function (resolve, reject) {
        if (window.WINRO_MOTIONS && window.WINRO_MOTIONS[key]) { resolve(window.WINRO_MOTIONS[key]); return; }
        var script = document.createElement("script");
        script.src = src;
        script.onload = function () {
          if (window.WINRO_MOTIONS && window.WINRO_MOTIONS[key]) resolve(window.WINRO_MOTIONS[key]);
          else reject(new Error("No data found in " + src));
        };
        script.onerror = function () { reject(new Error("Failed to load " + src)); };
        document.head.appendChild(script);
      });
    }
    return _dataPromises[key];
  }

  function dataInfoFor(data) {
    if (data.jointMode === "direct22") {
      return { isDirect22: true, parents: HUMANML_PARENTS, subsample: 1, sphereRadius: 0.055, boneRadius: 0.035 };
    }
    return {
      isDirect22: false, parents: data.parents, nJoints: data.n_joints,
      subsample: data.subsample || 1, sphereRadius: 0.035, boneRadius: 0.02
    };
  }

  // ------------------------------------------------------------
  // ResultSection: tab bar + one live panel, lazily built/destroyed
  // ------------------------------------------------------------
  function ResultSection(config) {
    this.config = config;      // {rootId, dataKey, src, tabLabel(group,i), showTitleAsPrompt, groupOrder}
    this.root = document.getElementById(config.rootId);
    this.tabsEl = this.root.querySelector(".winro-tabs");
    this.panelMount = this.root.querySelector(".winro-panel-mount");
    this.statusEl = this.root.querySelector(".winro-loading");
    this.currentTab = 0;
    this.panel = null;
    this.active = false;
    this._buildToken = 0;
    this._tabsBuilt = false;
  }

  ResultSection.prototype.activate = async function () {
    if (this.active) return;
    this.active = true;

    // A suspended panel keeps its DOM; just recreate its WebGL viewers.
    if (this.panel) {
      this.panel.resume();
      if (WINRO.livePanels.indexOf(this.panel) < 0) WINRO.livePanels.push(this.panel);
      return;
    }

    var token = ++this._buildToken;
    var data;
    try {
      data = await loadData(this.config.dataKey, this.config.src);
    } catch (e) {
      if (this.statusEl) this.statusEl.textContent = "Failed to load motion data.";
      console.error(e);
      return;
    }
    if (!this.active || token !== this._buildToken) return;
    if (this.config.groupIndex !== undefined) {
      data = Object.assign({}, data, { groups: [data.groups[this.config.groupIndex]] });
    }
    if (this.config.groupOrder) {
      var seen = {};
      var groups = [];
      this.config.groupOrder.forEach(function (groupIndex) {
        if (data.groups[groupIndex]) {
          seen[groupIndex] = true;
          groups.push(data.groups[groupIndex]);
        }
      });
      data.groups.forEach(function (group, groupIndex) {
        if (!seen[groupIndex]) groups.push(group);
      });
      data = Object.assign({}, data, { groups: groups });
    }
    this.data = data;
    this.dataInfo = dataInfoFor(data);
    if (!this._tabsBuilt) { this._buildTabs(); this._tabsBuilt = true; }
    await this._showTab(this.currentTab);
  };

  ResultSection.prototype.deactivate = function () {
    if (!this.active) return;
    this.active = false;
    this._buildToken++;
    if (this.panel) {
      var i = WINRO.livePanels.indexOf(this.panel);
      if (i >= 0) WINRO.livePanels.splice(i, 1);
      this.panel.suspend();
    }
  };

  ResultSection.prototype._buildTabs = function () {
    if (!this.tabsEl) return;
    var groups = this.data.groups;
    if (groups.length < 2) { this.tabsEl.style.display = "none"; return; }
    var self = this;
    groups.forEach(function (g, i) {
      var btn = document.createElement("button");
      btn.className = "winro-tab" + (i === self.currentTab ? " active" : "");
      btn.textContent = self.config.tabLabel ? self.config.tabLabel(g, i) : (g.title || ("#" + (i + 1)));
      btn.addEventListener("click", function () {
        if (i === self.currentTab && self.panel) return;
        self.currentTab = i;
        self.tabsEl.querySelectorAll(".winro-tab").forEach(function (b, bi) {
          b.classList.toggle("active", bi === i);
        });
        self._showTab(i);
      });
      self.tabsEl.appendChild(btn);
    });
  };

  ResultSection.prototype._showTab = async function (i) {
    var token = ++this._buildToken;
    if (this.panel) {
      var pi = WINRO.livePanels.indexOf(this.panel);
      if (pi >= 0) WINRO.livePanels.splice(pi, 1);
      this.panel.destroy();
      this.panel = null;
    }
    if (this.statusEl) this.statusEl.style.display = "block";

    var group = this.data.groups[i];
    // Group title doubles as the prompt text on most pages
    if (this.config.showTitleAsPrompt !== false && group.title && !group.prompt) {
      group = Object.assign({}, group, { prompt: group.title });
    }
    var panel = new Panel(group, this.dataInfo, this.panelMount);
    await panel.init();
    if (!this.active || token !== this._buildToken) { panel.destroy(); return; }
    if (this.statusEl) this.statusEl.style.display = "none";
    this.panel = panel;
    WINRO.livePanels.push(panel);
  };

  // ------------------------------------------------------------
  // App
  // ------------------------------------------------------------
  var WINRO = {
    livePanels: [],
    syncCameras: true,
    _hintDismissed: false,
    _sections: [],
    _lastTime: 0,

    dismissHints: function () {
      if (this._hintDismissed) return;
      this._hintDismissed = true;
      document.querySelectorAll(".viewer-hint").forEach(function (h) {
        h.classList.add("hidden");
        setTimeout(function () { if (h.parentNode) h.parentNode.removeChild(h); }, 700);
      });
    },

    init: function (sectionConfigs) {
      if (typeof THREE === "undefined" || typeof DecompressionStream === "undefined") {
        document.querySelectorAll(".winro-loading").forEach(function (el) {
          el.textContent = "This browser does not support the interactive viewer. Please use a recent version of Chrome, Firefox, Safari, or Edge.";
        });
        return;
      }

      var self = this;
      sectionConfigs.forEach(function (cfg) {
        var sec = new ResultSection(cfg);
        self._sections.push(sec);
      });

      // Lazily create viewers when a section approaches the viewport and
      // release its WebGL contexts when it moves far away.
      var byRoot = new Map();
      this._sections.forEach(function (s) { byRoot.set(s.root, s); });
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          var sec = byRoot.get(entry.target);
          if (!sec) return;
          if (entry.isIntersecting) sec.activate();
          else sec.deactivate();
        });
      }, { rootMargin: "400px 0px 400px 0px", threshold: 0 });
      this._sections.forEach(function (s) { io.observe(s.root); });

      // Global controls
      var syncBtn = document.getElementById("winro-sync-cam");
      if (syncBtn) {
        syncBtn.classList.add("active");
        syncBtn.addEventListener("click", function () {
          self.syncCameras = !self.syncCameras;
          syncBtn.classList.toggle("active", self.syncCameras);
        });
      }
      var resetBtn = document.getElementById("winro-reset-cam");
      if (resetBtn) {
        resetBtn.addEventListener("click", function () {
          self.livePanels.forEach(function (p) {
            p.viewers.forEach(function (v) { v.resetCamera(); });
          });
        });
      }

      // Dismiss hints on interaction
      ["mousedown", "wheel", "touchstart"].forEach(function (evt) {
        document.addEventListener(evt, function (e) {
          if (e.target.closest && e.target.closest(".viewer-canvas-container")) self.dismissHints();
        }, { passive: true });
      });

      this._animate(0);
    },

    _animate: function (time) {
      var self = this;
      requestAnimationFrame(function (t) { self._animate(t); });
      var dt = (time - this._lastTime) / 1000;
      this._lastTime = time;
      if (dt <= 0 || dt > 0.5) { this.livePanels.forEach(function (p) { p.render(); }); return; }
      this.livePanels.forEach(function (p) { p.step(dt); p.render(); });
    }
  };

  return WINRO;
})();
