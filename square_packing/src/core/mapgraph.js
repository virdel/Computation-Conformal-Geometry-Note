// 地图数据 → 平面三角剖分（直接当成 pipeline.js 的 preset 用）。
//
// 手写的数据只有三样东西：谁和谁相邻（adj / dummies.neighbours / extra）、
// 外边界上是哪些区域（boundary，逆时针）、哪 4 个是角点（corners）。
// 这里负责把它变成 pipeline 能吃的东西：
//
//   1. 组装图：真实区域 + 人工块（水域 / 补块）+ 真实相邻 + 数据声明的人工边；
//   2. 嵌入：把声明的外边界按顺序钉在凸位置（圆上），内点解调和方程。
//      2-连通平面图 + 指定外面 ⟹ Tutte 定理：无翻转、无交叉。
//      **经纬度不参与这一步** —— 2-连通平面图给定外面之后嵌入是唯一的，
//      所以结构完全由「图 + 外边界圈」决定；经纬度只用于显示和下面第 4 步判断。
//   3. 面游走 → 面列表（打印出来供人工核对：每个面都应该是真实的「三区交点」）；
//   4. 三角化每个面：三角形不动；≥ 4 边形若顶点两两相邻就加对角线
//      （Four Corners 那种「只交于一点」的情形），否则报错，让人去数据里补
//      人工边（extra）或人工块（dummies）—— 这条不能自动猜；
//   5. 自检：外面 == 声明的外边界、欧拉数、每个面是简单圈、真实相邻条数、
//      广义 PTP（外边界是简单圈 + 4 个角点把它切成 4 段非空链 + 无分离三角形
//      + 内点度 ≥ 4 + 墙点度 ≥ 3）。

import { embedOnBoundary, triangulateFaces, checkDisk } from './diskbuild.js';

const TAU = Math.PI * 2;

/**
 * @param {object} data 见 src/core/maps/us.js 的格式说明
 * @param {{verbose?:boolean}} opts verbose 时打印面列表 / 修补清单 / 自检数字
 */
export function buildMapGraph(data, opts = {}) {
  const verbose = !!opts.verbose;
  const problems = [];
  const P = (m) => problems.push(m);

  // ---- 1. 顶点表 ----
  const idx = new Map();
  const ids = [], names = [], kind = [], geoIn = [];
  const push = (id, name, k, lon, lat) => {
    if (idx.has(id)) { P(`区域 id 重复：${id}`); return; }
    idx.set(id, ids.length);
    ids.push(id); names.push(name); kind.push(k);
    geoIn.push([typeof lon === 'number' ? lon : null, typeof lat === 'number' ? lat : null]);
  };
  for (const r of data.regions) push(r.id, r.name, 'real', r.lon, r.lat);
  for (const d of data.dummies) push(d.id, d.name, d.kind, d.lon, d.lat);
  const nv = ids.length;
  const V = (id) => {
    const i = idx.get(id);
    if (i === undefined) P(`数据里用到了没定义的区域「${id}」`);
    return i;
  };
  const nm = (v) => names[v];

  // ---- 2. 边表 ----
  const ekey = (a, b) => (a < b ? a * nv + b : b * nv + a);
  const edgeKind = new Map();          // a*nv+b → 'real'|'water'|'patch'|'artificial'|'point'
  const edgeWhy = new Map();
  const dropped = new Set();
  for (const e of data.dropAdj || []) {
    const a = V(e.a), b = V(e.b);
    if (a !== undefined && b !== undefined) dropped.add(ekey(a, b));
  }
  const putEdge = (idA, idB, k, why) => {
    const a = V(idA), b = V(idB);
    if (a === undefined || b === undefined) return;
    if (a === b) { P(`自环：${idA}`); return; }
    const key = ekey(a, b);
    if (edgeKind.has(key)) {
      if (edgeKind.get(key) === k) return;                 // 同一类重复声明，忽略
      P(`边 ${idA}-${idB} 被声明成了两种（${edgeKind.get(key)} / ${k}）`);
      return;
    }
    edgeKind.set(key, k);
    edgeWhy.set(key, why || '');
  };
  for (const [a, b] of data.adj) {
    const ia = idx.get(a), ib = idx.get(b);
    if (ia !== undefined && ib !== undefined && dropped.has(ekey(ia, ib))) continue;
    putEdge(a, b, 'real');
  }
  for (const d of data.dummies) {
    for (const nbId of d.neighbours) putEdge(d.id, nbId, d.kind, d.why);
  }
  for (const e of data.extra || []) putEdge(e.a, e.b, e.kind || 'artificial', e.why);

  const nb = Array.from({ length: nv }, () => new Set());
  for (const key of edgeKind.keys()) { nb[Math.floor(key / nv)].add(key % nv); nb[key % nv].add(Math.floor(key / nv)); }

  // 连通性（整套框架是单连通盘，图必须是连通的）
  {
    const seen = new Set([0]);
    const st = [0];
    while (st.length) { const v = st.pop(); for (const w of nb[v]) if (!seen.has(w)) { seen.add(w); st.push(w); } }
    if (seen.size !== nv) P(`图不连通：只有 ${seen.size}/${nv} 个点从 v0 可达`);
  }

  // ---- 3. 外边界 ----
  const boundary = data.boundary.map(V);
  if (boundary.some((v) => v === undefined)) {
    throw new Error(`buildMapGraph(${data.id}): 外边界里有没定义的区域`);
  }
  const bset = new Set(boundary);
  if (bset.size !== boundary.length) {
    const dup = boundary.filter((v, i) => boundary.indexOf(v) !== i).map(nm);
    P(`外边界上有区域出现了两次（${[...new Set(dup)].join(', ')}）—— 说明它是割点，`
      + '去掉它图就断开（比如美国去掉纽约、中国去掉河北）。矩形不能同时贴外框两次，'
      + '数据里要在那一段插一个水域人工块把边界岔开');
  }
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i], b = boundary[(i + 1) % boundary.length];
    if (!nb[a].has(b)) P(`外边界上相邻的「${nm(a)}」和「${nm(b)}」之间没有边`);
  }
  const k = boundary.length;
  if (k < 4) P(`外边界只有 ${k} 个点`);

  // ---- 4. 角点 ----
  const corners = { S: V(data.corners.S), E: V(data.corners.E), N: V(data.corners.N), W: V(data.corners.W) };
  const cornersCCW = [corners.S, corners.E, corners.N, corners.W];
  if (new Set(cornersCCW).size !== 4) P('4 个角点里有重复');
  for (const v of cornersCCW) if (!bset.has(v)) P(`角点「${nm(v)}」不在外边界上`);

  // ---- 5. 嵌入（把边界钉在圆上解调和方程）----
  // 尺度和旋转都无所谓（后面按 quad 重新钉），只需要是平面嵌入。
  const emb = embedOnBoundary(nv, nb, boundary, { label: nm, what: data.id });
  const { pos, rot, faces, areas, outerIdx, attempt, badFaces } = emb;
  for (const m of emb.problems) P(m);

  // ---- 6. 三角化 ----
  const tz = triangulateFaces(nv, nb, faces, outerIdx, {
    label: nm, edgeKind, edgeWhy,
    nonCliqueHint: '数据里要给这个面补人工边（extra）或人工块（dummies）',
  });
  const { tri, repairs, faceLines } = tz;
  for (const m of tz.problems) P(m);

  // 连通性再查一次：三角化之后每个顶点都得有面
  {
    const touched = new Set();
    for (const t of tri) for (const v of t) touched.add(v);
    if (touched.size !== nv) {
      P(`有 ${nv - touched.size} 个点不属于任何三角形：`
        + [...Array(nv).keys()].filter((v) => !touched.has(v)).map(nm).join(', '));
    }
  }

  // ---- 7. 自检 ----
  const disk = checkDisk(nv, tri, cornersCCW);
  const { C, ptp, chi } = disk;
  for (const m of disk.problems) P(m);

  const counts = { real: 0, water: 0, patch: 0, artificial: 0, point: 0 };
  for (const kd of edgeKind.values()) counts[kd] = (counts[kd] || 0) + 1;

  // 显示坐标：没给经纬度的人工块用邻居的重心
  const geo = geoIn.map((p, v) => {
    if (p[0] !== null && p[1] !== null) return [p[0], p[1]];
    const list = [...nb[v]].filter((w) => geoIn[w][0] !== null);
    if (!list.length) return [0, 0];
    return [list.reduce((s, w) => s + geoIn[w][0], 0) / list.length,
      list.reduce((s, w) => s + geoIn[w][1], 0) / list.length];
  });
  let geoBad = 0;
  geo.forEach((p, v) => {
    if (kind[v] === 'real' && (p[0] < -180 || p[0] > 180 || p[1] < -90 || p[1] > 90)) geoBad++;
  });
  if (geoBad) P(`有 ${geoBad} 个区域的经纬度超范围`);

  // 外边界上各区域绕几何重心的方位角是否单调（数据写错次序时能看出来）
  const cx = geo.reduce((s, p) => s + p[0], 0) / nv;
  const cy = geo.reduce((s, p) => s + p[1], 0) / nv;
  const ang = boundary.map((v) => Math.atan2(geo[v][1] - cy, geo[v][0] - cx));
  const unwrapped = [];
  for (let i = 0; i < ang.length; i++) {
    let x = ang[i];
    if (i > 0) {
      while (x - unwrapped[i - 1] > Math.PI) x -= TAU;
      while (x - unwrapped[i - 1] < -Math.PI) x += TAU;
    }
    unwrapped.push(x);
  }
  let maxInv = 0, invAt = '';
  for (let i = 0; i + 1 < unwrapped.length; i++) {
    const d = unwrapped[i] - unwrapped[i + 1];
    if (d > maxInv) { maxInv = d; invAt = `${nm(boundary[i])}→${nm(boundary[i + 1])}`; }
  }

  const report = {
    id: data.id, name: data.name,
    nv, ne: C.edges.length, nf: tri.length, chi,
    boundaryLen: k,
    facesBefore: faces.length - 1,
    cornerNames: { S: nm(corners.S), E: nm(corners.E), N: nm(corners.N), W: nm(corners.W) },
    counts, repairs: repairs.length,
    minInteriorDeg: ptp.minInteriorDeg, minWallDeg: ptp.minWallDeg,
    ptpOk: ptp.ok, embedAttempt: attempt,
    facingInversions: { maxDeg: (maxInv * 180) / Math.PI, at: invAt },
  };

  if (verbose) {
    console.log(`\n[${data.id}] ${data.name}`);
    console.log(`  V=${nv} E=${C.edges.length} F=${tri.length} χ=${chi}`
      + ` | 外边界 ${k} 点：${boundary.map(nm).join(' → ')}`);
    console.log(`  角点 S=${nm(corners.S)}  E=${nm(corners.E)}  N=${nm(corners.N)}  W=${nm(corners.W)}`);
    console.log(`  边：真实 ${counts.real}，水域块 ${counts.water}，补块 ${counts.patch}，`
      + `人工边 ${counts.artificial}，点接触 ${counts.point}（共 ${C.edges.length}）`);
    console.log(`  三角化前的面（${faces.length - 1} 个）—— 每个都该是真实的三区交点：`);
    for (const { cyc, note } of faceLines) {
      console.log(`    ${cyc.map(nm).join('-')}${note ? `  ${note}` : ''}`);
    }
    if (repairs.length) {
      console.log(`  三角化时加的修补（${repairs.length} 条）：`);
      for (const r of repairs) console.log(`    · ${r.why}`);
    }
    if ((data.extra || []).length) {
      console.log(`  数据声明的人工边（${data.extra.length} 条）：`);
      for (const e of data.extra) console.log(`    · ${e.a}-${e.b}（${e.kind || 'artificial'}）：${e.why}`);
    }
    if ((data.dummies || []).length) {
      console.log(`  人工块（${data.dummies.length} 个）：`);
      for (const d of data.dummies) {
        console.log(`    · ${d.name}[${d.kind}] ← ${d.neighbours.join(', ')}：${d.why}`);
      }
    }
    if ((data.merges || []).length) {
      console.log(`  并入邻区的区域（${data.merges.length} 个）：`);
      for (const m of data.merges) console.log(`    · ${m.name} → ${m.into}：${m.why}`);
    }
    if ((data.excluded || []).length) {
      console.log(`  不在图里的区域（${data.excluded.length} 个）：`);
      for (const e of data.excluded) console.log(`    · ${e.name}：${e.why}`);
    }
    console.log(`  边界方位角最大逆序 ${(maxInv * 180 / Math.PI).toFixed(1)}°（${invAt || '无'}）`
      + ' —— 只在数据写错圈上次序时才有明显逆序');
    console.log(`  自检：${problems.length ? `${problems.length} 项没过` : '全部通过'}`
      + ` | 调和嵌入第 ${attempt + 1} 种边界形状可用`);
  }
  if (problems.length) {
    for (const m of problems) console.error(`  ✗ [${data.id}] ${m}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    id: data.id,
    name: data.name,
    note: data.notes,
    nv,
    faces: tri,
    corners,
    cornersCCW,
    quad: data.quad || quadFromGeo(cornersCCW, geo),
    boundary,
    ids, names, kind, geo,
    geoKind: 'geo',                            // 经纬度布局：① 只画陆块轮廓（三角形会互相压在一起）

    edgeKind,
    edgeWhy,
    repairs,                                   // 三角化时自动加的（点接触对角线）
    faceCycles: faceLines,                     // 三角化**前**的面（人工核对用：每个都该是真实三区交点）
    extra: data.extra || [],                   // 数据声明的人工边（带理由）
    dummies: data.dummies || [],               // 数据声明的人工块（带理由）
    merges: data.merges || [],
    excluded: data.excluded || [],
    report,
    tuttePos: pos,
    rot,
  };
}

/** 由 4 个角点的经纬度拼一个四边形（x=经度归一化，y=纬度归一化，逆时针）。*/
export function quadFromGeo(cornersCCW, geo) {
  const pts = cornersCCW.map((v) => geo[v]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = x1 - x0 || 1, sy = y1 - y0 || 1;
  const q = pts.map((p) => [1.3 * (p[0] - x0) / sx, 1.0 * (p[1] - y0) / sy]);
  // 面积 < 0 说明是顺时针，翻过来
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i], r = q[(i + 1) % q.length];
    s += p[0] * r[1] - r[0] * p[1];
  }
  return s < 0 ? q.slice().reverse() : q;
}

/** 一句人话总结（给界面用）。*/
export function mapSummary(g) {
  const r = g.report;
  return `${g.name}：V=${r.nv} E=${r.ne} F=${r.nf}，外边界 ${r.boundaryLen} 点；`
    + `真实相邻 ${r.counts.real} 条，人工块/人工边 ${r.counts.water + r.counts.patch + r.counts.artificial + r.counts.point} 条`;
}
