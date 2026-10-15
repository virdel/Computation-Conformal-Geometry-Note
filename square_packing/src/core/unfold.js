// 等距铺展：用 Ricci 流之后的边长，从某个三角形出发把整张圆盘逐个铺到平面上。
// 流收敛后（4 角 π/2、其余 0）铺出来的图形应该正好是个矩形：
//   * 角点处累计角 = π/2 → 边界在角点拐直角；
//   * 非角点边界处累计角 = π → 边界直线穿过。
// 于是「矩形残差」是很强的数值检验（见 rectangleResiduals）。

function perp(d) { return [-d[1], d[0]]; }

/** 已知 a,b 的坐标与三边长，求 c（side=+1 表示 c 在 a→b 左侧）。*/
function placeThird(pa, pb, rAC, rBC, side) {
  const dx = pb[0] - pa[0], dy = pb[1] - pa[1];
  const L = Math.hypot(dx, dy) || 1e-300;
  const x = (rAC * rAC - rBC * rBC + L * L) / (2 * L);
  const y2 = Math.max(0, rAC * rAC - x * x);
  const y = Math.sqrt(y2) * side;
  const ex = dx / L, ey = dy / L;
  const px = -ey, py = ex;
  return [pa[0] + x * ex + y * px, pa[1] + x * ey + y * py];
}

/**
 * 等距铺展所有三角形。
 * @returns {{pos:number[][], faceSign:number[]}} faceSign 记录每个面摆的时候的 side
 */
export function develop(mesh) {
  const pos = new Array(mesh.nv).fill(null);
  const seen = new Uint8Array(mesh.nf);
  const len = (a, b) => mesh.len[mesh.edgeOf.get(mesh.edgeKey(a, b))];

  const placeFace = (f, from) => {
    const t = mesh.faces[f];
    if (from === null) {
      // 第一个面：a 在原点，b 在 x 轴上，c 在左侧（保持 CCW）
      pos[t[0]] = [0, 0];
      pos[t[1]] = [len(t[0], t[1]), 0];
      pos[t[2]] = placeThird(pos[t[0]], pos[t[1]], len(t[0], t[2]), len(t[1], t[2]), +1);
      return 1;
    }
    // 通过共享边 (a,b) 摆第三个点
    const [a, b] = from;
    const c = t.find((v) => v !== a && v !== b);
    const sideA = directedEdgeSign(t, a, b); // +1: 面里有 a→b，则 c 在左侧
    pos[c] = placeThird(pos[a], pos[b], len(a, c), len(b, c), sideA);
    return sideA;
  };

  const q = [0];
  seen[0] = 1;
  const signs = new Array(mesh.nf).fill(0);
  signs[0] = placeFace(0, null);
  for (let qi = 0; qi < q.length; qi++) {
    const f = q[qi];
    const t = mesh.faces[f];
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3];
      const e = mesh.edgeOf.get(mesh.edgeKey(a, b));
      const fs = mesh.facesOfEdge[e];
      if (fs.length < 2) continue;
      const g = fs[0] === f ? fs[1] : fs[0];
      if (seen[g]) continue;
      seen[g] = 1;
      signs[g] = placeFace(g, [a, b]);
      q.push(g);
    }
  }
  if (q.length !== mesh.nf) throw new Error(`develop: 只铺了 ${q.length}/${mesh.nf} 个面`);
  return { pos, faceSign: signs };
}

function directedEdgeSign(t, a, b) {
  for (let i = 0; i < 3; i++) {
    if (t[i] === a && t[(i + 1) % 3] === b) return +1;
    if (t[i] === b && t[(i + 1) % 3] === a) return -1;
  }
  throw new Error('directedEdgeSign: 边不在面里');
}

/** 4 个角点沿边界（CCW）的先后顺序。*/
export function cornerOrder(mesh, corners) {
  const set = new Set(corners);
  const cw = mesh.boundary.filter((v) => set.has(v));   // 外面走的是 CW
  return cw.slice().reverse();                          // 反过来 = CCW
}

/** 旋转 + 平移，使 cornerOrder[0] 在原点、cornerOrder[1] 在 +x 轴上。*/
export function normalizeFrame(pos, cornerOrderArr) {
  const c0 = pos[cornerOrderArr[0]], c1 = pos[cornerOrderArr[1]];
  const dx = c1[0] - c0[0], dy = c1[1] - c0[1];
  const ang = -Math.atan2(dy, dx);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  return pos.map((p) => {
    const x = p[0] - c0[0], y = p[1] - c0[1];
    return [x * ca - y * sa, x * sa + y * ca];
  });
}

/**
 * 矩形残差：整张图铺出来到底「方不方」。
 * @returns {{maxLineDev:number, maxLineDevRel:number, maxCornerDev:number,
 *            W:number, H:number, aspect:number, closureDev:number}}
 */
export function rectangleResiduals(pos, mesh, order) {
  const c = order.map((v) => pos[v]);
  const W = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]);
  const H = Math.hypot(c[2][0] - c[1][0], c[2][1] - c[1][1]);

  // 边界链上每个点离弦的垂距（沿 CCW 边界走）
  const bccw = mesh.boundary.slice().reverse();
  const n = bccw.length;
  const idx = order.map((v) => bccw.indexOf(v));
  let maxLineDev = 0;
  for (let k = 0; k < 4; k++) {
    const from = pos[order[k]], to = pos[order[(k + 1) % 4]];
    const ux = to[0] - from[0], uy = to[1] - from[1];
    const ul = Math.hypot(ux, uy) || 1e-300;
    const i0 = idx[k], i1 = idx[(k + 1) % 4];
    for (let s = (i0 + 1) % n; s !== i1; s = (s + 1) % n) {
      const p = pos[bccw[s]];
      const dev = Math.abs(ux * (p[1] - from[1]) - uy * (p[0] - from[0])) / ul;
      maxLineDev = Math.max(maxLineDev, dev);
      if (s === i0) break;
    }
  }

  // 角点处两条弦的夹角 vs π/2
  let maxCornerDev = 0;
  for (let k = 0; k < 4; k++) {
    const p = c[(k + 3) % 4], q = c[k], r = c[(k + 1) % 4];
    const a1 = angleBetween([q[0] - p[0], q[1] - p[1]], [r[0] - q[0], r[1] - q[1]]);
    maxCornerDev = Math.max(maxCornerDev, Math.abs(a1 - Math.PI / 2));
  }

  const side2 = Math.hypot(c[3][0] - c[2][0], c[3][1] - c[2][1]);   // 第三边 vs 第一边
  const side3 = Math.hypot(c[3][0] - c[0][0], c[3][1] - c[0][1]);   // 第四边 vs 第二边
  const closureDev = Math.max(Math.abs(side2 - W), Math.abs(side3 - H));

  return {
    maxLineDev,
    maxLineDevRel: maxLineDev / Math.max(W, H),
    maxCornerDev,
    W, H, aspect: W / H,
    closureDev,
  };
}

function angleBetween(u, v) {
  const nu = Math.hypot(u[0], u[1]), nv = Math.hypot(v[0], v[1]);
  if (nu < 1e-300 || nv < 1e-300) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (nu * nv))));
}
