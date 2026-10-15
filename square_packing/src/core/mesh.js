// 半边结构（只支持圆盘三角剖分：所有内面是三角形，边界是一条简单圈）。
//
// 约定：
//   * 输入 faces 必须是逆时针 (CCW) 三角形；
//   * 半边编号：边 e = (a,b) 且 a<b，则 he[2e] = a→b，he[2e+1] = b→a；
//   * rot[v] = v 的出边在*逆时针*方向的循环序（用输入坐标的 atan2 排一次即可，
//     Ricci 流是共形变换，不改嵌入，所以这个顺序全程不变）；
//   * 面在其半边的*左侧*：next(h) 沿面的边界走。
//
// 长度是可变状态：Ricci 流改的是边长 len[e]，角度一律由边长用余弦定理算出
// （不要用坐标算角度，流之后坐标是旧的）。

const TAU = Math.PI * 2;

export class Mesh {
  /**
   * @param {number[][]} verts  [[x,y], ...]
   * @param {number[][]} faces  [[a,b,c], ...] 逆时针三角形
   */
  constructor(verts, faces) {
    this.verts0 = verts.map((p) => [p[0], p[1]]);
    this.nv = verts.length;
    this.faces = faces.map((f) => f.slice());
    this.nf = faces.length;

    // ---- 边表 ----
    const edgeOf = new Map();
    const edges = [];
    const key = (a, b) => (a < b ? a * this.nv + b : b * this.nv + a);
    this.facesOfEdge = []; // 每条边最多两个面
    for (let f = 0; f < this.nf; f++) {
      const t = this.faces[f];
      for (let i = 0; i < 3; i++) {
        const a = t[i], b = t[(i + 1) % 3];
        if (a === b) throw new Error('mesh: 面里有重复顶点');
        const k = key(a, b);
        let e = edgeOf.get(k);
        if (e === undefined) {
          e = edges.length;
          edgeOf.set(k, e);
          edges.push(a < b ? [a, b] : [b, a]);
          this.facesOfEdge.push([]);
        }
        this.facesOfEdge[e].push(f);
      }
    }
    this.edgeOf = edgeOf;
    this.edges = edges;
    this.ne = edges.length;
    this.edgeKey = key;

    // ---- 半边 ----
    const ne = this.ne;
    this.heNext = new Int32Array(2 * ne);
    this.heFace = new Int32Array(2 * ne).fill(-1);
    this.heVert = new Int32Array(2 * ne); // 起点
    for (let e = 0; e < ne; e++) {
      this.heVert[2 * e] = edges[e][0];
      this.heVert[2 * e + 1] = edges[e][1];
    }
    // 面内的 next
    for (let f = 0; f < this.nf; f++) {
      const t = this.faces[f];
      for (let i = 0; i < 3; i++) {
        const h = this.heIndexOf(t[i], t[(i + 1) % 3]);
        this.heNext[h] = this.heIndexOf(t[(i + 1) % 3], t[(i + 2) % 3]);
        this.heFace[h] = f;
      }
    }

    // ---- 逆时针旋转系统（按输入坐标排序）----
    const out = Array.from({ length: this.nv }, () => []);
    for (let e = 0; e < ne; e++) {
      const [a, b] = edges[e];
      out[a].push(2 * e);       // a→b
      out[b].push(2 * e + 1);   // b→a
    }
    for (let v = 0; v < this.nv; v++) {
      const p = this.verts0[v];
      out[v].sort((h1, h2) => {
        const q1 = this.verts0[this.heTarget(h1)], q2 = this.verts0[this.heTarget(h2)];
        return Math.atan2(q1[1] - p[1], q1[0] - p[0]) - Math.atan2(q2[1] - p[1], q2[0] - p[0]);
      });
    }
    this.rot = out;
    this.rotPos = new Int32Array(2 * ne);
    for (let v = 0; v < this.nv; v++) out[v].forEach((h, i) => { this.rotPos[h] = i; });

    // 边界半边的 next：next(h) = twin(h) 在目标点旋转序里的*逆时针前驱*
    for (let h = 0; h < 2 * ne; h++) {
      if (this.heFace[h] !== -1) continue;
      const w = this.heTarget(h);
      const tw = this.heTwin(h);
      const cyc = this.rot[w];
      const i = this.rotPos[tw];
      this.heNext[h] = cyc[(i - 1 + cyc.length) % cyc.length];
    }

    // ---- 面枚举（含外面），外面是唯一负面积的那个 ----
    this.facesAll = [];       // {hes:[...], verts:[...], area, isOuter}
    const seen = new Int8Array(2 * ne);
    for (let h = 0; h < 2 * ne; h++) {
      if (seen[h]) continue;
      const hes = [];
      let x = h;
      let guard = 0;
      do {
        seen[x] = 1;
        hes.push(x);
        x = this.heNext[x];
        if (++guard > 4 * ne + 10) throw new Error('mesh: next 指针成不了环');
      } while (x !== h);
      const vs = hes.map((hh) => this.heVert[hh]);
      this.facesAll.push({ hes, verts: vs, area: polygonArea(vs, this.verts0) });
    }
    const outerIdx = this.facesAll.findIndex((f) => f.area < 0);
    if (outerIdx < 0) throw new Error('mesh: 找不到外面（输入面的定向可能不是 CCW）');
    this.outer = outerIdx;

    // ---- 边界圈（按外面边界走的顶点序）----
    this.boundary = this.facesAll[outerIdx].verts.slice();
    this.isBoundaryVert = new Uint8Array(this.nv);
    for (const v of this.boundary) this.isBoundaryVert[v] = 1;

    // ---- 度数 ----
    this.deg = new Int32Array(this.nv);
    for (let e = 0; e < this.ne; e++) { this.deg[edges[e][0]]++; this.deg[edges[e][1]]++; }

    // ---- 边长 ----
    this.len = new Float64Array(ne);
    for (let e = 0; e < ne; e++) {
      const [a, b] = edges[e];
      this.len[e] = Math.hypot(verts[a][0] - verts[b][0], verts[a][1] - verts[b][1]);
    }
    this.background = Float64Array.from(this.len);

    this.faceAngles = new Array(this.nf);
    this.refreshAngles();
  }

  // ---------- 半边基本访问 ----------
  heIndexOf(a, b) {
    const e = this.edgeOf.get(this.edgeKey(a, b));
    return this.edges[e][0] === a ? 2 * e : 2 * e + 1;
  }
  heTwin(h) { return h ^ 1; }
  heTarget(h) { return this.heVert[h ^ 1]; }
  edgeOfHe(h) { return h >> 1; }

  /** 边 e 上、位于面 f 内的对角（对角顶点）。*/
  oppositeVertex(e, f) {
    const t = this.faces[f];
    for (const v of t) if (v !== this.edges[e][0] && v !== this.edges[e][1]) return v;
    return -1;
  }

  // ---------- 角度 / 曲率 ----------
  /** 用当前 len 重算所有面积角：faceAngles[f] = [θ(a), θ(b), θ(c)]。*/
  refreshAngles() {
    const { faces, len, edgeOf, edges } = this;
    for (let f = 0; f < this.nf; f++) {
      const t = faces[f];
      const l = [0, 0, 0];
      // l[i] = 边 t[i]→t[i+1] 的长度
      for (let i = 0; i < 3; i++) l[i] = len[edgeOf.get(this.edgeKey(t[i], t[(i + 1) % 3]))];
      const ang = new Array(3);
      for (let i = 0; i < 3; i++) {
        // 顶点 t[i] 的对边是 l[(i+1)%3]（t[i+1]→t[i+2]），邻边 l[i]、l[(i+2)%3]
        ang[i] = angleFromSides(l[(i + 1) % 3], l[i], l[(i + 2) % 3]);
      }
      this.faceAngles[f] = ang;
    }
  }

  /** 每个顶点的角度和 Σθ。*/
  angleSums() {
    const s = new Float64Array(this.nv);
    for (let f = 0; f < this.nf; f++) {
      const t = this.faces[f], a = this.faceAngles[f];
      for (let i = 0; i < 3; i++) s[t[i]] += a[i];
    }
    return s;
  }

  /** 离散曲率：内点 2π − Σθ，边界点 π − Σθ（圆盘上总和恒为 2π）。*/
  curvature() {
    const s = this.angleSums();
    const K = new Float64Array(this.nv);
    for (let v = 0; v < this.nv; v++) {
      const full = this.isBoundaryVert[v] ? Math.PI : TAU;
      K[v] = full - s[v];
    }
    return K;
  }

  /** 目标曲率：4 个角点 π/2，其余 0。*/
  targetCurvature(corners) {
    const Kbar = new Float64Array(this.nv);
    for (const c of corners) Kbar[c] = Math.PI / 2;
    return Kbar;
  }

  /** 余切 Laplacian（FEM 刚度阵，PSD）：(L u)_i = Σ_j w_ij (u_i − u_j)。*/
  cotanLaplacian() {
    const { nv, ne, edges, facesOfEdge, faceAngles, faces } = this;
    const W = new Map(); // 边 -> 权重
    for (let e = 0; e < ne; e++) {
      let w = 0;
      for (const f of facesOfEdge[e]) {
        const opp = this.oppositeVertex(e, f);
        const t = faces[f];
        const i = t.indexOf(opp);
        w += 1 / Math.tan(faceAngles[f][i]);
      }
      W.set(e, w);
    }
    const L = zerosDense(nv);
    for (let e = 0; e < ne; e++) {
      const [a, b] = edges[e], w = W.get(e);
      L[a][a] += w; L[b][b] += w; L[a][b] -= w; L[b][a] -= w;
    }
    return L;
  }

  /** 平面性自检：所有面正面积、无相反定向的面。*/
  checkEmbedding() {
    let bad = 0, minArea = Infinity;
    for (const f of this.facesAll) {
      if (f === this.facesAll[this.outer]) continue;
      if (!(f.area > 0)) bad++;
      minArea = Math.min(minArea, f.area);
    }
    return { badFaces: bad, minFaceArea: minArea };
  }

  /** 欧拉示性数（圆盘应为 1）。*/
  euler() { return this.nv - this.ne + this.nf; }

  /** 顶点的出半边（逆时针序）。*/
  neighborsCCW(v) { return this.rot[v].map((h) => this.heTarget(h)); }

  /** 把边长设回背景度量。*/
  resetLengths() { this.len.set(this.background); this.refreshAngles(); }

  /** 从当前坐标重设背景度量（Ricci 流的输入度量）。*/
  setBackgroundFromCoords(verts) {
    this.verts0 = verts.map((p) => [p[0], p[1]]);
    for (let e = 0; e < this.ne; e++) {
      const [a, b] = this.edges[e];
      this.background[e] = Math.hypot(verts[a][0] - verts[b][0], verts[a][1] - verts[b][1]);
    }
    this.len.set(this.background);
    this.refreshAngles();
  }
}

// ---------- 工具 ----------

/** 由三边求 a 边对着的角（余弦定理，clamp 保护退化）。*/
export function angleFromSides(a, b, c) {
  const x = (b * b + c * c - a * a) / (2 * b * c);
  return Math.acos(Math.max(-1, Math.min(1, x)));
}

export function polygonArea(vs, coords) {
  let s = 0;
  for (let i = 0; i < vs.length; i++) {
    const p = coords[vs[i]], q = coords[vs[(i + 1) % vs.length]];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

function zerosDense(n) {
  const A = new Array(n);
  for (let i = 0; i < n; i++) A[i] = new Array(n).fill(0);
  return A;
}

/** 三角形面积（Heron）。*/
export function heronArea(a, b, c) {
  const s = (a + b + c) / 2;
  const t = s * (s - a) * (s - b) * (s - c);
  return t > 0 ? Math.sqrt(t) : 0;
}

/** 从无向边表构造「边 → 相邻面」的邻接（用于 BFS 铺展）。*/
export function faceAdjacency(mesh) {
  const adj = Array.from({ length: mesh.nf }, () => []);
  for (let e = 0; e < mesh.ne; e++) {
    const fs = mesh.facesOfEdge[e];
    if (fs.length === 2) { adj[fs[0]].push([fs[1], e]); adj[fs[1]].push([fs[0], e]); }
  }
  return adj;
}
