// 填充结果的硬校验：不只看「画出来像不像」，而是逐条数出来。
//
//   1. 每个矩形非退化（宽、高 > 0）
//   2. 全都落在大矩形 [0,W]×[0,H] 里
//   3. 两两内部不相交
//   4. 面积和 = W·H（配合 (2)(3) 就是「恰好铺满」）
//   5. 相邻 ⟺ 图上原来有这条边（两个方向都查）
//   6. 没有 4 个矩形交于一点（那会让对偶出现 4-圈）
//   7. 没有「自捏」：同一个矩形在两个对角象限同时出现
//   8. 大矩形的四个角分别属于 vS/vE/vN/vW
//   9. 只有边界顶点的矩形能碰到外框（给了 walls 才查）—— 外边界有 k > 4 个点时，
//      这条是「每条外边都被正确当成墙」的直接体现：
//      boundaryOnFrame == k（每个边界点都贴框）且 interiorOnFrame == 0

const EPS = 1e-9;

function overlap1D(a1, a2, b1, b2) { return Math.min(a2, b2) - Math.max(a1, b1); }

/** 两个矩形共享的边界段长度（正数表示真的贴在一起）。*/
export function contact(r, s) {
  const vy = overlap1D(r.y1, r.y2, s.y1, s.y2);
  const vx = overlap1D(r.x1, r.x2, s.x1, s.x2);
  let best = 0, kind = null;
  if (Math.abs(r.x2 - s.x1) < EPS && vy > EPS) { if (vy > best) { best = vy; kind = 'r|s'; } }
  if (Math.abs(s.x2 - r.x1) < EPS && vy > EPS) { if (vy > best) { best = vy; kind = 's|r'; } }
  if (Math.abs(r.y2 - s.y1) < EPS && vx > EPS) { if (vx > best) { best = vx; kind = 'r/s'; } }
  if (Math.abs(s.y2 - r.y1) < EPS && vx > EPS) { if (vx > best) { best = vx; kind = 's/r'; } }
  return { len: best, kind };
}

/**
 * 两个矩形共享的那条线段（用来在图上把「人工补出来的接触」画出来）。
 * 没有接触返回 null。
 * @returns {number[][]|null} [[x1,y1],[x2,y2]]
 */
export function contactSegment(r, s) {
  const t = contact(r, s);
  if (!t || t.len <= EPS) return null;
  if (t.kind === 'r|s') return [[r.x2, Math.max(r.y1, s.y1)], [r.x2, Math.min(r.y2, s.y2)]];
  if (t.kind === 's|r') return [[r.x1, Math.max(r.y1, s.y1)], [r.x1, Math.min(r.y2, s.y2)]];
  if (t.kind === 'r/s') return [[Math.max(r.x1, s.x1), r.y2], [Math.min(r.x2, s.x2), r.y2]];
  return [[Math.max(r.x1, s.x1), r.y1], [Math.min(r.x2, s.x2), r.y1]];
}

/**
 * @param {Mesh} mesh
 * @param {{v,x1,x2,y1,y2}[]} rects
 * @param {number} W @param {number} H
 * @param {{S:number,E:number,N:number,W:number}} c
 * @param {{leftWall:number[],rightWall:number[],bottomWall:number[],topWall:number[]}|null} walls
 *   给了就额外查第 9 条（只有边界顶点的矩形能贴外框）
 */
export function verifyPacking(mesh, rects, W, H, c, walls = null) {
  const problems = [];
  const nums = {};
  const n = rects.length;

  // 1. 非退化
  let degenerate = 0;
  for (const r of rects) if (!(r.x2 - r.x1 > 0) || !(r.y2 - r.y1 > 0)) degenerate++;
  nums.degenerate = degenerate;
  if (degenerate) problems.push(`${degenerate} 个矩形退化（宽或高 ≤ 0）`);

  // 2. 在大矩形里
  let outside = 0;
  for (const r of rects) {
    if (r.x1 < -EPS || r.y1 < -EPS || r.x2 > W + EPS || r.y2 > H + EPS) outside++;
  }
  nums.outside = outside;
  if (outside) problems.push(`${outside} 个矩形跑出大矩形`);

  // 3. 两两内部不相交
  let overlaps = 0;
  const worst = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ox = overlap1D(rects[i].x1, rects[i].x2, rects[j].x1, rects[j].x2);
      const oy = overlap1D(rects[i].y1, rects[i].y2, rects[j].y1, rects[j].y2);
      if (ox > EPS && oy > EPS) { overlaps++; if (worst.length < 3) worst.push([rects[i].v, rects[j].v, ox, oy]); }
    }
  }
  nums.overlappingPairs = overlaps;
  if (overlaps) problems.push(`${overlaps} 对矩形内部重叠`);

  // 4. 面积和
  const areaSum = rects.reduce((a, r) => a + (r.x2 - r.x1) * (r.y2 - r.y1), 0);
  nums.areaSum = areaSum;
  nums.areaTarget = W * H;
  nums.areaRelErr = Math.abs(areaSum - W * H) / (W * H);
  if (nums.areaRelErr > 1e-12) problems.push(`面积和 ${areaSum} ≠ W·H ${W * H}`);

  // 5. 相邻 ⟺ 图上的边
  const shared = new Map();   // "a,b" -> 接触长度
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const t = contact(rects[i], rects[j]);
      if (t.len > EPS) shared.set(`${Math.min(i, j)},${Math.max(i, j)}`, t.len);
    }
  }
  nums.pairsTouching = shared.size;
  let missing = 0, extra = 0;
  const missingList = [], extraList = [];
  for (let e = 0; e < mesh.ne; e++) {
    const [a, b] = mesh.edges[e];
    if (!shared.has(`${Math.min(a, b)},${Math.max(a, b)}`)) {
      missing++; if (missingList.length < 5) missingList.push([a, b]);
    }
  }
  for (const k of shared.keys()) {
    const [a, b] = k.split(',').map(Number);
    if (mesh.edgeOf.get(mesh.edgeKey(a, b)) === undefined) {
      extra++; if (extraList.length < 5) extraList.push([a, b]);
    }
  }
  nums.missingAdjacency = missing;
  nums.extraAdjacency = extra;
  if (missing) problems.push(`${missing} 条图上的边在填充里没接触 ${JSON.stringify(missingList)}`);
  if (extra) problems.push(`${extra} 对接触在图里没有边 ${JSON.stringify(extraList)}`);

  // 6/7. 格点处的情况（十字、自捏）
  const atPoint = new Map();
  for (const r of rects) {
    for (const x of [r.x1, r.x2]) for (const y of [r.y1, r.y2]) {
      const k = `${x},${y}`;
      if (!atPoint.has(k)) atPoint.set(k, []);
      atPoint.get(k).push(r);
    }
  }
  let cross = 0, pinch = 0;
  const crossList = [];
  for (const [k, list] of atPoint) {
    const [x, y] = k.split(',').map(Number);
    if (x <= EPS || y <= EPS || x >= W - EPS || y >= H - EPS) continue;   // 大矩形边界上的点不算
    if (list.length >= 4) { cross++; if (crossList.length < 3) crossList.push([x, y, list.length]); }
    // 自捏：两个对角象限是同一个矩形
    for (const r of list) {
      const dx = (r.x1 === x) ? +1 : -1;
      const dy = (r.y1 === y) ? +1 : -1;
      const diag = list.find((s) => ((s.x1 === x) ? +1 : -1) === -dx && ((s.y1 === y) ? +1 : -1) === -dy);
      if (diag && diag.v === r.v) { pinch++; break; }
    }
  }
  nums.crossPoints = cross;
  nums.pinchPoints = pinch;
  if (cross) problems.push(`${cross} 个点有 4 个矩形相交 ${JSON.stringify(crossList)}`);
  if (pinch) problems.push(`${pinch} 个点自捏（对角象限同一个矩形）`);

  // 8. 大矩形四角（角点落在矩形内部的哪个象限，就按哪个象限取 x/y）
  const cornerOf = (x, y) => rects.find((r) => {
    const okx = x === 0 ? r.x1 === 0 && r.x2 > 0 : r.x2 === W && r.x1 < W;
    const oky = y === 0 ? r.y1 === 0 && r.y2 > 0 : r.y2 === H && r.y1 < H;
    return okx && oky;
  });
  const bl = cornerOf(0, 0), br = cornerOf(W, 0), tr = cornerOf(W, H), tl = cornerOf(0, H);
  nums.mapIsRectangle = [bl?.v, br?.v, tr?.v, tl?.v];
  const want = [c.S, c.E, c.N, c.W];
  const got = [bl?.v, br?.v, tr?.v, tl?.v].map((v) => (v === undefined ? v : v));
  let cornerOk = true;
  for (let i = 0; i < 4; i++) if (got[i] !== want[i]) cornerOk = false;
  nums.cornerMatch = cornerOk;
  nums.cornerWant = want;
  nums.cornerGot = got;
  if (!cornerOk) problems.push(`大矩形四角 = [${got}]，期望 vS/vE/vN/vW = [${want}]`);

  // 9. 只有边界顶点的矩形能贴外框（等价于「这个点确实缺某个方向的邻居」）
  if (walls) {
    const onFrame = (r) => r.x1 < EPS || r.y1 < EPS || r.x2 > W - EPS || r.y2 > H - EPS;
    const wallVerts = new Set([...walls.bottomWall, ...walls.rightWall, ...walls.topWall, ...walls.leftWall]);
    let offFrame = 0, innerOnFrame = 0;
    const offList = [], onList = [];
    for (const r of rects) {
      if (wallVerts.has(r.v)) {
        if (!onFrame(r)) { offFrame++; if (offList.length < 5) offList.push(r.v); }
      } else if (onFrame(r)) { innerOnFrame++; if (onList.length < 5) onList.push(r.v); }
    }
    nums.wallVerts = wallVerts.size;
    nums.boundaryOnFrame = wallVerts.size - offFrame;   // 贴到外框的边界点数（应 == k）
    nums.boundaryOffFrame = offFrame;
    nums.interiorOnFrame = innerOnFrame;
    if (offFrame) problems.push(`${offFrame} 个边界顶点的矩形没贴到外框 ${JSON.stringify(offList)}`);
    if (innerOnFrame) problems.push(`${innerOnFrame} 个内点的矩形贴到了外框 ${JSON.stringify(onList)}`);
  }

  return { ok: problems.length === 0, problems, numbers: nums, shared };
}
