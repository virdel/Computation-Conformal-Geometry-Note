// 无界面自检：所有核心模块都能在 Node 里跑（不依赖 DOM）。
// 用法：npm run check
//
// 每一行都要给「数字」，不只是 ✓/✗ —— 出问题的时候能看出差多远。

import { PRESETS, randomPTP } from '../src/core/presets.js';
import { Mesh } from '../src/core/mesh.js';
import { checkPTP, comb } from '../src/core/ptp.js';
import { tutteEmbed, orientCCW, planarity, boundaryCycle } from '../src/core/embed.js';
import { ricciFlow } from '../src/core/ricci.js';
import { develop, cornerOrder, normalizeFrame, rectangleResiduals } from '../src/core/unfold.js';
import { solveREL, addOuterEdges, checkREL, blockSummary } from '../src/core/rel.js';
import { runPipeline, buildInputMesh, cornerRoles, referenceAspect, DEFAULT_QUAD, SQUARE_QUAD, quadBlend, quadForPreset, summarize } from '../src/core/pipeline.js';
import { circlePack, auditPacking, imageCircle } from '../src/core/circlepack.js';
import { modulusOfOrder } from '../src/core/modulus.js';
import { contact } from '../src/core/verify.js';
import { MAP_PRESETS, MAP_DATA } from '../src/core/maps/index.js';
import { adjacencyFromEdges, cliques3, cliqueEdgeCount } from '../src/core/diskbuild.js';
import { parseGraphFile, graphToPreset } from '../src/core/graphfile.js';
import { EXAMPLES } from '../src/core/examples.js';

let fails = 0;
const fmt = (x, d = 6) => (Number.isFinite(x) ? x.toExponential(d) : String(x));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function check(label, cond, detail = '') {
  if (!cond) fails++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
}

console.log('=== 1. 预设图 + 初始嵌入 (mesh.js / embed.js / ptp.js) ===\n');

const built = [];
for (const P of PRESETS) {
  console.log(`[${P.id}] ${P.name} — ${P.note ?? ''}`);
  const info = checkPTP(comb(P.faces, P.nv));
  check('PTP 校验', info.ok, `V=${P.nv} F=${info.numTris} 边界=${info.boundaryLen} 分离三角形=${info.numSepTri} 内点最小度=${info.minInteriorDeg}${info.ok ? '' : ' — ' + info.reasons.join('; ')}`);

  // 故意把外边界钉成一个斜四边形（不是矩形）：角点初始不是 π/2，Ricci 流才真的有活干。
  const emb = tutteEmbed(P.faces, P.nv, { shape: 'quad', quad: DEFAULT_QUAD });
  check('Tutte 嵌入无翻转', emb.planarity.bad === 0, `最小面面积=${fmt(emb.planarity.minArea, 3)}${emb.usedRefine ? ' (MVC 细化过)' : ''}`);
  check('外边界是 4-圈', emb.boundary.length === 4, `边界序 [${emb.boundary.join(', ')}]`);

  const facesCCW = orientCCW(emb.verts, P.faces);
  let mesh;
  try {
    mesh = new Mesh(emb.verts, facesCCW);
  } catch (e) {
    check('构造 Mesh', false, e.message);
    console.log('');
    continue;
  }
  check('构造 Mesh', true, `V=${mesh.nv} E=${mesh.ne} F=${mesh.nf}`);
  check('欧拉示性数 V−E+F=1', mesh.euler() === 1, `χ=${mesh.euler()}`);
  check('边界长度 = 4', mesh.boundary.length === 4, `[${mesh.boundary.join(', ')}]`);

  const K = mesh.curvature();
  const sumK = K.reduce((a, b) => a + b, 0);
  check('Gauss–Bonnet ΣK = 2π', near(sumK, 2 * Math.PI, 1e-9), `ΣK=${fmt(sumK, 8)} (2π=${fmt(2 * Math.PI, 8)})`);

  const ce = mesh.checkEmbedding();
  check('内面全部正面积', ce.badFaces === 0, `最小面积=${fmt(ce.minFaceArea, 3)}`);

  built.push({ P, mesh, emb, facesCCW });
  console.log('');
}

console.log('=== 2. Ricci 流 + 等距铺展 (ricci.js / unfold.js) ===\n');

const flowed = [];
for (const b of built) {
  const { P, mesh } = b;
  console.log(`[${P.id}] ${P.name}`);
  const corners = mesh.boundary.slice();
  const res = ricciFlow(mesh, { corners, tol: 1e-12, maxIter: 200 });

  check('流收敛 max|K̄−K| < 1e-11', res.converged, `err=${fmt(res.err, 3)} 迭代=${res.iterations}`);

  // 角点累计角
  const ang = mesh.angleSums();
  let maxCornerDev = 0;
  for (const c of corners) maxCornerDev = Math.max(maxCornerDev, Math.abs(ang[c] - Math.PI / 2));
  check('4 个角点累计角 = π/2', maxCornerDev < 1e-9, `max|θ−π/2|=${fmt(maxCornerDev, 3)}`);

  // 非角点曲率是否 ~0（内点 2π、边界点 π）
  const K = mesh.curvature();
  let maxK = 0;
  for (let v = 0; v < mesh.nv; v++) if (!corners.includes(v)) maxK = Math.max(maxK, Math.abs(K[v]));
  check('其余点曲率 = 0', maxK < 1e-11, `max|K|=${fmt(maxK, 3)}`);

  const sumK = K.reduce((a, x) => a + x, 0);
  check('Gauss–Bonnet ΣK = 2π（流之后）', near(sumK, 2 * Math.PI, 1e-9), `ΣK=${fmt(sumK, 8)}`);

  // 铺展 + 矩形残差
  const { pos } = develop(mesh);
  const order = cornerOrder(mesh, corners);
  const npos = normalizeFrame(pos, order);
  const rr = rectangleResiduals(npos, mesh, order);
  check('铺展后边界成直线（垂距相对值 < 1e-9）', rr.maxLineDevRel < 1e-9, `max 垂距=${fmt(rr.maxLineDev, 3)} (相对 ${fmt(rr.maxLineDevRel, 3)})`);
  check('铺展后 4 个角是直角（|θ−π/2| < 1e-9）', rr.maxCornerDev < 1e-9, `max|θ−π/2|=${fmt(rr.maxCornerDev, 3)}`);
  check('对边等长（矩形闭合）', rr.closureDev < 1e-9 * Math.max(1, rr.W), `残差=${fmt(rr.closureDev, 3)}`);

  console.log(`    W=${rr.W.toFixed(6)}  H=${rr.H.toFixed(6)}  长宽比 W/H=${rr.aspect.toFixed(6)}`);
  flowed.push({ ...b, res, pos: npos, order, rr });
  console.log('');
}

console.log('=== 3. REL 求解 + 公理校验 (rel.js) ===\n');
console.log('  预设   V  图案      回溯  斜率一致   最小块  空块  校验  用时');
const solved = [];
for (const f of flowed) {
  const { P, mesh } = f;
  const c = cornerRoles(f.pos, f.order, f.rr.W, f.rr.H);
  const t0 = Date.now();
  const s = solveREL(mesh, f.pos, c, {});
  const ms = Date.now() - t0;
  const full = addOuterEdges(mesh, s.edgeColor, c);
  const chk = checkREL(mesh, full, c);
  const blocks = blockSummary(mesh, full);
  // 铺展图可能自交叠，斜率标号在那些顶点上会指错（只是取值的排序提示，不影响正确性），
  // 所以这里只要求大部分一致，并把比例打出来。
  const agree = s.slopeAgree.total === 0 || s.slopeAgree.same / s.slopeAgree.total >= 0.7;
  console.log(
    `  ${P.id.padEnd(5)} ${String(mesh.nv).padStart(3)}  ${(s.pattern ?? '—').padEnd(9)}`
    + ` ${String(s.backtracks).padStart(4)}  ${`${s.slopeAgree.same}/${s.slopeAgree.total}`.padStart(7)}`
    + `  ${String(blocks.minBlocks).padStart(5)}  ${String(blocks.vertsWithEmptyBlock).padStart(3)}`
    + `  ${(chk.ok ? '✓' : '✗').padStart(3)}  ${ms}ms`,
  );
  check(`${P.id} 解出 REL（根上无回溯或少量）`, s.ok, s.ok ? '' : s.problems.join('; '));
  check(`${P.id} 公理校验通过（内点 ${chk.numbers.interior} 个）`, chk.ok, chk.ok ? '' : chk.problems.slice(0, 2).join('; '));
  check(`${P.id} 内点四块都非空`, blocks.vertsWithEmptyBlock === 0, `最小块=${blocks.minBlocks}`);
  check(`${P.id} 与斜率标号大体一致（≥70%）`, agree, `${s.slopeAgree.same}/${s.slopeAgree.total}`);
  solved.push({ ...f, c, s, full, chk, blocks });
}
console.log('');

console.log('=== 4. 矩形对偶铺满校验 (rectdual.js / verify.js) ===\n');
console.log('  预设  矩形   W·H        面积相对误差  接触对  缺边  多边  十字  自捏  角点  结果');
const packed = [];
for (const P of PRESETS) {
  const r = runPipeline(P);
  const n = r.verification.numbers;
  const okP = r.verification.ok;
  console.log(
    `  ${P.id.padEnd(5)} ${String(r.packing.rects.length).padStart(4)}`
    + `  ${`${r.packing.W}×${r.packing.H}`.padEnd(10)}`
    + `  ${fmt(n.areaRelErr, 2).padStart(11)}`
    + `  ${String(n.pairsTouching).padStart(5)}  ${String(n.missingAdjacency).padStart(4)}  ${String(n.extraAdjacency).padStart(4)}`
    + `  ${String(n.crossPoints).padStart(4)}  ${String(n.pinchPoints).padStart(4)}  ${(n.cornerMatch ? '✓' : '✗').padStart(4)}`
    + `  ${okP ? '✓' : '✗'}`,
  );
  check(`${P.id} 矩形数 = 顶点数`, r.packing.rects.length === r.mesh.nv, `${r.packing.rects.length}/${r.mesh.nv}`);
  check(`${P.id} 面积和 = W·H`, n.areaRelErr < 1e-12, `Σ=${n.areaSum} W·H=${n.areaTarget}`);
  check(`${P.id} 两两不重叠、无退化`, n.overlappingPairs === 0 && n.degenerate === 0 && n.outside === 0);
  check(`${P.id} 相邻 ⟺ 图上有边`, n.missingAdjacency === 0 && n.extraAdjacency === 0, `接触对=${n.pairsTouching}`);
  check(`${P.id} 无十字点、无自捏`, n.crossPoints === 0 && n.pinchPoints === 0);
  check(`${P.id} 四角 = vS/vE/vN/vW`, n.cornerMatch, `${JSON.stringify(n.cornerGot)} / ${JSON.stringify(n.cornerWant)}`);
  packed.push({ P, r });
}
console.log('');

console.log('=== 5. 交叉验证（另一条路径 / 边界情形）===\n');

// 5a. 正方形输入：角点本来就是 π/2，Ricci 流没事干 → 长宽比恰好 1
for (const P of [PRESETS[0], PRESETS[PRESETS.length - 1]]) {
  const r = runPipeline(P, { quad: SQUARE_QUAD });
  check(`[${P.id}] 正方形输入 → 长宽比 = 1`, near(r.rectResidual.aspect, 1, 1e-9), `W/H=${r.rectResidual.aspect.toFixed(12)}`);
  check(`[${P.id}] 正方形输入仍铺满成功`, r.verification.ok, r.verification.ok ? '' : r.verification.problems.slice(0, 2).join('; '));
}

// 5b. 后处理拉长宽比不影响组合结构（只整体缩放 x）
for (const P of [PRESETS[0], PRESETS[PRESETS.length - 1]]) {
  const r = runPipeline(P, { aspect: 1.5 });
  check(`[${P.id}] 指定长宽比 1.5 后仍铺满成功`, r.verification.ok && near(r.packing.W / r.packing.H, 1.5, 1e-12),
    `W/H=${(r.packing.W / r.packing.H).toFixed(9)}`);
}

// 5c. 共形模交叉验证：Ricci 铺展出的 W/H vs 独立 FEM（解 Laplace）
console.log('  预设  Ricci W/H     FEM N=20    FEM N=40    相对差');
for (const { P, r } of packed) {
  const M20 = modulusOfOrder(DEFAULT_QUAD, r.cornersCCW, r.order, 20);
  const M40 = modulusOfOrder(DEFAULT_QUAD, r.cornersCCW, r.order, 40);
  const asp = r.rectResidual.aspect;
  console.log(`  ${P.id.padEnd(5)} ${asp.toFixed(8)}  ${M20.toFixed(8)}  ${M40.toFixed(8)}  ${(100 * (asp / M40 - 1)).toFixed(3)}%`);
  // 两条路都不精确：离散共形结构 vs 连续共形模，差在 2% 以内就算一致
  check(`[${P.id}] Ricci 长宽比与 FEM 共形模一致（<2%）`, Math.abs(asp / M40 - 1) < 0.02, `差 ${(100 * (asp / M40 - 1)).toFixed(3)}%`);
}

// 5d. 随机 PTP 压力测试（不在预设里的图）
let rndOk = 0;
const rndCases = [];
for (let seed = 1; seed <= 6; seed++) rndCases.push({ id: `r20-${seed}`, nv: 20, seed });
for (let seed = 1; seed <= 4; seed++) rndCases.push({ id: `r60-${seed}`, nv: 60, seed });
for (let seed = 1; seed <= 2; seed++) rndCases.push({ id: `r120-${seed}`, nv: 120, seed });
for (const rc of rndCases) {
  const g = randomPTP(rc.nv, rc.seed);
  const r = runPipeline({ id: rc.id, name: rc.id, nv: g.nv, faces: g.faces });
  const good = r.rel.relOk && r.verification.ok;
  if (good) rndOk++;
  else console.log(`  ✗ ${rc.id}: REL=${r.rel.relOk} 铺满=${r.verification.ok} ${JSON.stringify(r.rel.solved.problems)}`);
}
check(`随机 PTP 压力测试 ${rndOk}/${rndCases.length} 通过（REL + 铺满校验）`, rndOk === rndCases.length);

console.log('\n=== 6. 长宽比不变性 + 流停住时的兜底 (pipeline.js: aspect / referenceAspect) ===\n');

// 6a. 关键实测事实：只要流收敛，长宽比（= 离散共形模）只由**输入四边形**决定，
//     和图的点数/内部结构无关 —— 所以下面这张表里所有收敛的图应该是同一个数。
const cases6 = [];
for (const P of PRESETS) cases6.push({ id: P.id, g: P });
for (const nv of [20, 60, 120, 200]) {
  for (let seed = 1; seed <= 3; seed++) {
    const rp = randomPTP(nv, seed);
    cases6.push({ id: `r${nv}-${seed}`, g: { id: `r${nv}-${seed}`, name: `随机 ${nv} 点`, nv: rp.nv, faces: rp.faces } });
  }
}

const rows = [], conv = [], stalled = [];
for (const c of cases6) {
  const r = runPipeline(c.g);
  const row = { id: c.id, r };
  rows.push(row);
  (r.flow.converged ? conv : stalled).push(row);
}

const a0 = conv.length ? conv[0].r.aspect.flow : NaN;
let spread = 0, worst = '';
for (const c of conv) {
  const d = Math.abs(c.r.aspect.flow - a0);
  if (d > spread) { spread = d; worst = c.id; }
}
check(`收敛的 ${conv.length}/${cases6.length} 个图长宽比完全相同（互相差 ≤ 1e-9）`,
  conv.length > 0 && spread <= 1e-9,
  `公共值=${a0.toFixed(12)} 最大偏差=${fmt(spread, 2)}${worst ? `（${worst}）` : ''}`);
console.log(`    收敛的每个图：来源都是本图流。停住的 ${stalled.length} 个：`
  + `${stalled.map((s) => s.id).join(', ') || '（无）'}`);

// 6b. 停住的图：铺展出来的长宽比不可信 → 退回「同一四边形在参考图上的值」
const ref = referenceAspect(DEFAULT_QUAD);
check('参考长宽比可用（默认四边形在最小预设上收敛）', Number.isFinite(ref), `参考值=${ref}`);
check('参考值 = 收敛图上的公共值（≤ 1e-9）', Number.isFinite(ref) && Math.abs(ref - a0) <= 1e-9,
  `差=${fmt(Math.abs(ref - a0), 2)}`);

for (const { id, r } of stalled) {
  check(`[${id}] 流停住 → 长宽比来源标为 reference，且取值 = 参考值`,
    r.aspect.source === 'reference' && Math.abs(r.aspect.used - ref) <= 1e-12,
    `来源=${r.aspect.source} 用=${r.aspect.used.toFixed(12)} 本图铺展=${fmt(r.aspect.flow, 2)}`);
  check(`[${id}] 停住也不影响组合结果：REL 合法 + 铺满校验通过`,
    r.rel.relOk && r.verification.ok,
    `REL=${r.rel.relOk} 铺满=${r.verification.ok}`);
  check(`[${id}] 停住原因写在 flow.note 里（stalled=true 且非收敛）`, r.flow.stalled === true && !r.flow.converged,
    `${r.flow.note.slice(0, 40)}…`);
}
if (stalled.length) {
  console.log(`    例：${stalled[0].r.flow.note}`);
  console.log('    → 这是离散共形类的数学障碍，不是实现 bug；见 NOTES.md「事实 2」一节。');
} else {
  console.log('    这一批图全都收敛了（换更大的图/别的四边形就会出现停住的，见 NOTES.md）。');
}

// 6c. 全表：长宽比与图的规模无关（同一四边形）
console.log('\n  图             V   收敛   填充用长宽比      来源');
for (const { id, r } of rows) {
  console.log(`  ${id.padEnd(12)} ${String(r.mesh.nv).padStart(3)}   ${(r.flow.converged ? '是' : '否').padStart(2)}   `
    + `${r.aspect.used.toFixed(12)}  ${r.aspect.source}`);
}

console.log('\n=== 7. 真实地图：美国各州 / 中国各省 → 方块填充 (maps/*.js + mapgraph.js) ===\n');

// 手写数据最关键的一道人工核对：三角化之前的每个面都该是真实的「三区交点」。
// 默认不打印（太长），要看就 `node scripts/check.mjs --faces`。
const showFaces = process.argv.includes('--faces');

// 输入四边形滑杆：t = 0 是正方形，t = 1 是地图自己的地理四边形，中间是逐顶点凸组合。
// 只有插出来的四边形一直是凸的，Tutte 嵌入（把边界钉在这个四边形上）才成立，所以这里数一遍。
function quadConvex(q) {
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length], c = q[(i + 2) % q.length];
    if (!((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) > 0)) return false;
  }
  return true;
}

for (let mi = 0; mi < MAP_PRESETS.length; mi++) {
  const g = MAP_PRESETS[mi], data = MAP_DATA[mi];
  const rep = g.report;
  const at = (id) => g.ids.indexOf(id);
  console.log(`[${g.id}] ${g.name}`);
  console.log(`    结构：V=${rep.nv} E=${rep.ne} F=${rep.nf} χ=${rep.chi}　外边界 k=${rep.boundaryLen}`
    + `　角点 S=${rep.cornerNames.S} / E=${rep.cornerNames.E} / N=${rep.cornerNames.N} / W=${rep.cornerNames.W}`);
  console.log(`    边：真实相邻 ${rep.counts.real}，水域块 ${rep.counts.water}，补块 ${rep.counts.patch}，`
    + `人工边 ${rep.counts.artificial}，点接触 ${rep.counts.point}`);

  // ---- 结构 ----
  check('手写数据自检全过（0 项问题）', g.ok && g.problems.length === 0, g.problems.slice(0, 3).join('; '));
  check('欧拉 V−E+F = 1（圆盘三角剖分）', rep.chi === 1, `V=${rep.nv} E=${rep.ne} F=${rep.nf} χ=${rep.chi}`);
  check('每个面都是三角形', g.faces.every((f) => f.length === 3), `${g.faces.length} 个面`);
  check('4 个角点互不相同且都在外边界上',
    new Set(g.cornersCCW).size === 4 && g.cornersCCW.every((v) => g.boundary.includes(v)),
    `[${g.cornersCCW.map((v) => g.names[v]).join(', ')}]`);
  check(`度数下限：内点 ≥ 4、墙点 ≥ 3（PTP 必要条件）`,
    rep.minInteriorDeg >= 4 && rep.minWallDeg >= 3 && rep.ptpOk,
    `内点最小度=${rep.minInteriorDeg} 墙点最小度=${rep.minWallDeg} PTP=${rep.ptpOk}`);
  check('调和嵌入干净（每个内面正面积、外面唯一）', rep.embedAttempt >= 0, `第 ${rep.embedAttempt + 1} 种边界形状可用`);
  check('外边界方位角基本单调（数据没写反）', rep.facingInversions.maxDeg < 90,
    `最大逆序 ${rep.facingInversions.maxDeg.toFixed(1)}°（${rep.facingInversions.at || '无'}）`);

  // ---- 手写数据的最终账：每条声明的相邻 ⟺ 每一条边 ----
  const declared = new Set();
  const put = (a, b) => { if (a >= 0 && b >= 0) declared.add(a < b ? `${a},${b}` : `${b},${a}`); };
  const dropped = new Set((data.dropAdj || []).map((e) => {
    const a = at(e.a), b = at(e.b); return a < b ? `${a},${b}` : `${b},${a}`;
  }));
  for (const [a, b] of data.adj) {
    const ia = at(a), ib = at(b);
    if (!dropped.has(ia < ib ? `${ia},${ib}` : `${ib},${ia}`)) put(ia, ib);
  }
  for (const d of data.dummies) for (const x of d.neighbours) put(at(d.id), at(x));
  for (const e of data.extra) put(at(e.a), at(e.b));

  // ---- 流 ----
  const r = runPipeline(g);
  const v = r.verification.numbers;
  const s = summarize(r);
  check('没有偷偷加进来的边：图上的边数 == 数据里声明的条数',
    declared.size === rep.ne, `声明 ${declared.size} / 图上 ${rep.ne}`);
  check('每条声明的相邻都贴边（逐条查接触长度 > 0）',
    [...declared].every((k) => {
      const [a, b] = k.split(',').map(Number);
      return contact(r.packing.rects[a], r.packing.rects[b]).len > 1e-9;
    }), `${declared.size} 条`);
  check('Ricci 流收敛', r.flow.converged, `迭代=${r.flow.iterations} err=${fmt(r.flow.err, 3)}`);
  check('REL 解出且公理校验通过', r.rel.relOk,
    `图案=${r.rel.solved.pattern} 回溯=${r.rel.solved.backtracks} 边界越界=${r.rel.check.numbers?.boundaryViolations ?? '?'}`);
  check('角点角色：声明的 S/E/N/W 与铺展后几何认出来的一致（没吃进镜像）',
    r.cornerRolesDeclared?.agrees === true,
    JSON.stringify(r.cornerRolesDeclared?.geo));

  // ---- 填充 ----
  check('矩形数 = 顶点数', r.packing.rects.length === r.mesh.nv, `${r.packing.rects.length}/${r.mesh.nv}`);
  check('头号断言：真实相邻 ⟺ 正长度接触（缺 0 / 多 0）',
    v.missingAdjacency === 0 && v.extraAdjacency === 0 && v.pairsTouching === rep.ne,
    `接触对=${v.pairsTouching} 缺=${v.missingAdjacency} 多=${v.extraAdjacency}`);
  check('两两不重叠、无退化、无跑出', v.overlappingPairs === 0 && v.degenerate === 0 && v.outside === 0);
  check('无十字点、无自捏', v.crossPoints === 0 && v.pinchPoints === 0, `${v.crossPoints}/${v.pinchPoints}`);
  check('面积和 = W·H', v.areaRelErr < 1e-12, `相对误差=${fmt(v.areaRelErr, 2)}`);
  check('四角 = 声明的 vS/vE/vN/vW', v.cornerMatch, `${JSON.stringify(v.cornerGot)} / ${JSON.stringify(v.cornerWant)}`);
  check(`每个边界点贴框（${rep.boundaryLen} 个）、内点不贴框`,
    v.boundaryOnFrame === rep.boundaryLen && v.interiorOnFrame === 0,
    `贴框 ${v.boundaryOnFrame}/${v.wallVerts}，内点贴框 ${v.interiorOnFrame}`);

  // 「多出来的接触」必须恰好是公开声明的那几条修补（水域块贴的边 + 人工边 + 点接触）
  const declaredRepairs = data.dummies.reduce((a, d) => a + d.neighbours.length, 0)
    + (data.extra || []).length + g.repairs.length;
  check('非真实接触恰好 = 声明的人工块边 + 人工边 + 点接触对角线',
    rep.ne - rep.counts.real === rep.counts.water + rep.counts.patch + rep.counts.artificial + rep.counts.point
    && rep.counts.water + rep.counts.patch + rep.counts.artificial + rep.counts.point === declaredRepairs,
    `${rep.ne} − ${rep.counts.real} = ${rep.ne - rep.counts.real}，声明 ${declaredRepairs} 条`);

  // ---- 输入四边形滑杆（0 = 正方形 → 1 = 本图地理四边形）----
  const blendOk = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].every((t) => quadConvex(quadForPreset(g, t)));
  check('四边形滑杆每一档都还是凸的（Tutte 嵌入始终成立）', blendOk,
    `quad=[${g.quad.map((p) => `[${p[0].toFixed(3)},${p[1].toFixed(3)}]`).join(', ')}]`);

  if (showFaces) {
    console.log(`    三角化前的面（${g.faceCycles.length} 个）—— 每个都该是真实的多区交点：`);
    for (const { cyc, note } of g.faceCycles) {
      console.log(`      · ${cyc.map((i) => g.names[i]).join(' - ')}${note ? `  ${note}` : ''}`);
    }
  }

  console.log(`    填充：W×H = ${r.packing.W.toFixed(4)} × ${r.packing.H.toFixed(4)}`
    + `　长宽比 = ${s.aspect.toFixed(6)}（来源 ${s.aspectSource}）　接触对 = ${v.pairsTouching}`);
  console.log(`    三条腿：REL ${r.rel.relOk ? '✓' : '✗'}　铺满 ${r.verification.ok ? '✓' : '✗'}`
    + `　结构 ${g.ok ? '✓' : '✗'}`);
  if (!r.verification.ok) console.log('    ' + r.verification.problems.join('; '));

  // ---- 修补账（界面上也逐条列出来）----
  console.log(`    偏离真实相邻关系的地方（共 ${declaredRepairs + (data.merges || []).length
    + (data.excluded || []).length} 处，逐条公开）：`);
  for (const d of data.dummies) {
    console.log(`      · 人工块「${d.name}」［${d.kind}］← ${d.neighbours.join('、')}`);
  }
  for (const e of data.extra || []) {
    const kd = g.edgeKind.get((() => { const a = at(e.a), b = at(e.b); return a < b ? a * g.nv + b : b * g.nv + a; })());
    console.log(`      · ${kd === 'point' ? '点接触' : '人工边'} ${e.a}–${e.b}`);
  }
  for (const x of data.merges || []) console.log(`      · 并入：${x.name} → ${x.into}`);
  for (const x of data.excluded || []) console.log(`      · 不在图里：${x.name}`);
  console.log('');
}

console.log('\n=== 8. 圆盘填充：同一张图、同一条流水线，只换度量族 (circlepack.js) ===\n');
console.log('  同一条流水线（相切度量 l_ij = r_i + r_j + 同一个 develop）上有**两种边界条件**，');
console.log('  它们不是同一个填充 —— 界面里的 ④ 用的是 A：');
console.log("    A) mode:'angles'（默认）：与方块填充**同一套目标曲率** K̄ = targetCurvature(corners)");
console.log('       （4 个角点 π/2、其余 0）⟹ 四角各 90°、墙点各 180°、内点各 360°，外框是矩形。');
console.log("    B) mode:'maximal'：极大填充（KAT：所有边界圆内切于同一个外圆），角点角度不受约束。");
console.log('');

// 先独立验一遍 Möbius 的「圆 → 圆」公式（B 的规范固定全靠它）：拿三个点定圆的解析解做基准。
// 2 万次抽样（约 1.5 万组合法构型）下圆心/半径的最大绝对误差都要在 1e-9 以内 ——
// 这个量是纯几何，与算法无关。
{
  const phi = (z, a) => {
    const nr = [z[0] - a[0], z[1] - a[1]];
    const dr = [1 - (a[0] * z[0] + a[1] * z[1]), -(a[0] * z[1] - a[1] * z[0])];
    const dd = dr[0] * dr[0] + dr[1] * dr[1];
    return [(nr[0] * dr[0] + nr[1] * dr[1]) / dd, (nr[1] * dr[0] - nr[0] * dr[1]) / dd];
  };
  const circ3 = (p, q, r) => {
    const d = 2 * (p[0] * (q[1] - r[1]) + q[0] * (r[1] - p[1]) + r[0] * (p[1] - q[1]));
    const ux = ((p[0] ** 2 + p[1] ** 2) * (q[1] - r[1]) + (q[0] ** 2 + q[1] ** 2) * (r[1] - p[1])
      + (r[0] ** 2 + r[1] ** 2) * (p[1] - q[1])) / d;
    const uy = ((p[0] ** 2 + p[1] ** 2) * (r[0] - q[0]) + (q[0] ** 2 + q[1] ** 2) * (p[0] - r[0])
      + (r[0] ** 2 + r[1] ** 2) * (q[0] - p[0])) / d;
    return [ux, uy, Math.hypot(ux - p[0], uy - p[1])];
  };
  let maxC = 0, maxR = 0, n = 0;
  for (let t = 0; t < 20000; t++) {
    const th = Math.random() * 2 * Math.PI, Rc = 0.02 + 0.97 * Math.random();
    const c = [Rc * Math.cos(th), Rc * Math.sin(th)];
    const rho = (1 - Rc) * Math.random();
    const a = [0.98 * Math.random(), 0.98 * Math.random()];
    if (a[0] * a[0] + a[1] * a[1] > 0.96) continue;
    const pts = [0, 2.1, 4.3].map((u) => phi([c[0] + rho * Math.cos(u), c[1] + rho * Math.sin(u)], a));
    const [ux, uy, rr] = circ3(...pts);
    const F = imageCircle(c, rho, a);
    maxC = Math.max(maxC, Math.hypot(ux - F.c[0], uy - F.c[1]));
    maxR = Math.max(maxR, Math.abs(rr - F.rho));
    n++;
  }
  check('Möbius「圆 → 圆」公式 vs 三点定圆（纯几何基准，B 的规范固定用它）', maxC < 1e-9 && maxR < 1e-9,
    `${n} 组随机圆：圆心误差 ${fmt(maxC, 2)}，半径误差 ${fmt(maxR, 2)}`);
}

/* ---------- A) mode:'angles'：四角 90°，界面里的 ④ ---------- */

console.log("\n  ── A) mode:'angles'：与③同一套目标曲率（4 角 π/2、其余 0）──\n");
console.log('  图          V   k  内点  角点角度和       墙点/内点角度和(180°/360°)   K̄残差     相切误差 重叠/多余'
  + '  外框 4 条边                       直线/对边/转角偏差          边界半径比   耗时');
const ratioA = new Map();
for (const preset of [...PRESETS, ...MAP_PRESETS]) {
  const { mesh, corners } = buildInputMesh(preset);
  const isMap = !!preset.report;
  const k = mesh.boundary.length;
  const cp = circlePack(mesh, { corners });
  const A = auditPacking(mesh, cp.pos, cp.r);
  ratioA.set(preset.id, cp.ratioBoundary);
  const d2 = (x) => (x * 180) / Math.PI;              // 弧度 → 度

  // 结束后 mesh.len 仍与返回的半径自洽：重新 develop 一遍，两两圆心距必须一致。
  const { pos: pos2 } = develop(mesh);
  let dev2 = 0;
  for (let i = 0; i < mesh.nv; i++) {
    for (let j = i + 1; j < mesh.nv; j++) {
      dev2 = Math.max(dev2, Math.abs(
        Math.hypot(cp.pos[i][0] - cp.pos[j][0], cp.pos[i][1] - cp.pos[j][1])
        - Math.hypot(pos2[i][0] - pos2[j][0], pos2[i][1] - pos2[j][1])));
    }
  }
  const cornersDeg = cp.angles.cornerSums.map((s) => d2(s));
  const cDev = Math.max(...cornersDeg.map((x) => Math.abs(x - 90)));
  const wallRange = cp.angles.nWall
    ? `${d2(cp.angles.wallMin).toFixed(6)} … ${d2(cp.angles.wallMax).toFixed(6)}`
    : '（k = 4，没有墙点）'.padEnd(20);

  console.log(`  ${(preset.id || preset.name).padEnd(10)} ${String(mesh.nv).padStart(3)} ${String(k).padStart(3)}`
    + ` ${String(mesh.nv - k).padStart(4)}  ${cornersDeg.map((x) => x.toFixed(6)).join(' ')}`
    + `  ${wallRange}`
    + ` / ${d2(cp.angles.intMin).toFixed(6)} … ${d2(cp.angles.intMax).toFixed(6)}`
    + `  ${fmt(cp.err, 1).padStart(9)}  ${fmt(A.maxEdgeErr, 1).padStart(8)}`
    + `  ${String(A.overlaps).padStart(2)} / ${String(A.extraTangencies).padStart(2)}`
    + `  ${cp.frame.chords.map((x) => x.toFixed(4)).join(' ')}`
    + `  ${fmt(cp.frame.straightErr, 1)} / ${fmt(cp.frame.oppositeErr, 1)} / ${fmt(d2(cp.frame.turnErr), 1)}°`
    + `  ${cp.ratioBoundary.toExponential(2)}  ${String(cp.ms).padStart(4)}ms`);

  check(`[${preset.id || preset.name}] A 四个角各 90°（角度和 = π/2）`, cp.angles.cornerErr < 1e-12,
    `4 个角点角度和 ${cornersDeg.map((x) => x.toFixed(9)).join(' ')}°，最大偏差 ${fmt(cDev, 2)}°`);
  check('A 墙点各 180°（边界圆心链在墙上走直线）', cp.angles.wallErr < 1e-12,
    `${cp.angles.nWall} 个墙点，Σθ ∈ [${d2(cp.angles.wallMin).toFixed(9)}°, ${d2(cp.angles.wallMax).toFixed(9)}°]，max|K| = ${fmt(cp.angles.wallErr, 2)}`);
  check('A 内点各 360°（内部严丝合缝）', cp.angles.intErr < 1e-12,
    `${cp.angles.nInt} 个内点，Σθ ∈ [${d2(cp.angles.intMin).toFixed(9)}°, ${d2(cp.angles.intMax).toFixed(9)}°]，max|K| = ${fmt(cp.angles.intErr, 2)}`);
  check('A K̄ 残差 → 0（相切度量上的阻尼 Newton）', cp.converged && cp.err < 1e-12,
    `max|K̄−K| = ${fmt(cp.err, 2)}，${cp.iterations} 步，${cp.ms}ms`);
  check('A 外框是矩形：对边相等', cp.frame.oppositeErr < 1e-9,
    `4 条边 ${cp.frame.chords.map((x) => x.toFixed(6)).join(' / ')}，对边偏差 ${fmt(cp.frame.oppositeErr, 2)}`);
  check('A 墙是直的：弦长 = 折线长（Σ(r_i + r_{i+1})）', cp.frame.straightErr < 1e-9,
    `最大差 ${fmt(cp.frame.straightErr, 2)}`);
  check('A 四角转弯都是 90°', cp.frame.turnErr < 1e-9,
    `${cp.frame.cornerTurns.map((t) => d2(t).toFixed(9)).join(' / ')}°，最大偏差 ${fmt(d2(cp.frame.turnErr), 2)}°`);
  if (k === 4) {
    const c = cp.frame.chords;
    const sq = Math.max(...c) - Math.min(...c);
    check("A 外边界只有 4 点时外框必是正方形（4 条边全相等）", sq < 1e-9,
      `边长 ${c[0].toFixed(9)}，极差 ${fmt(sq, 2)}（4 角 90° 的四边形必是矩形，而边 = r_t + r_{t+1} ⟹ 矩形就是正方形）`);
  }
  check('A 图上每条边正好相切（相切对 = 边数）', A.tangentPairs === mesh.ne && A.maxEdgeErr < 1e-9,
    `${A.tangentPairs}/${mesh.ne} 对，最大误差 ${fmt(A.maxEdgeErr, 2)}`);
  check('A 两两不重叠、且没有多余的相切（非边一颗都不碰）', A.overlaps === 0 && A.extraTangencies === 0,
    `重叠 ${A.overlaps} 对，多余相切 ${A.extraTangencies} 对，最近的非边间隙 ${fmt(A.minGap, 2)}`);
  check('A 结束后 mesh.len 与返回的半径自洽（重新 develop 一致）', dev2 < 1e-9,
    `两两圆心距最大差 ${fmt(dev2, 2)}`);

  // 相切度量里没有坐标 → 换一个输入四边形，填充必须一模一样（方块填充的长宽比会变，这个不会）
  const alt = buildInputMesh(preset, { quad: quadForPreset(preset, 0) });
  const cpAlt = circlePack(alt.mesh, { corners: alt.corners });
  let dR = 0;
  for (let v = 0; v < mesh.nv; v++) dR = Math.max(dR, Math.abs(cp.r[v] - cpAlt.r[v]) / cp.r[v]);
  check('A 与输入四边形无关：换成正方形输入，半径一字不变', dR < 1e-9, `最大相对差 ${fmt(dR, 2)}`);

  if (isMap) {
    const rows = mesh.boundary.map((v) => ({ n: preset.names[v], d: mesh.deg[v], r: cp.r[v] }))
      .sort((x, y) => x.r - y.r);
    console.log(`        边界半径最小 4：${rows.slice(0, 4).map((x) => `${x.n}(度${x.d})=${x.r.toExponential(1)}`).join(' ')}`);
    console.log(`        边界半径最大 4：${rows.slice(-4).map((x) => `${x.n}(度${x.d})=${x.r.toExponential(1)}`).join(' ')}`);
    console.log(`        → 比值 ${cp.ratioBoundary.toFixed(0)} 是**固有**的：外框是边界圆心的矩形，`);
    console.log(`          边长 = Σ(r_i + r_{i+1})，整圈周长被内点的尺度锁住；边界点 ${k} 个、内点 ${mesh.nv - k} 个，`);
    console.log('          边界半径必然两极分化（B 组的极大填充也躲不掉，只是数字不同）—— 见 NOTES.md。');
  }
  console.log('');
}

/* ---------- B) mode:'maximal'：极大填充（所有边界圆共外圆） ---------- */

console.log("\n  ── B) mode:'maximal'：极大填充（角点角度不受约束，所以**不是**「四角 90°」）──\n");
console.log('  图          V   k   球面流         外圆残差  共外圆偏差  角点角度和（对比 A 的 90°）        边界半径比 B vs A        耗时');
for (const preset of [...PRESETS, ...MAP_PRESETS]) {
  const { mesh, corners } = buildInputMesh(preset);
  const isMap = !!preset.report;
  const k = mesh.boundary.length;
  const cp = circlePack(mesh, { mode: 'maximal', diagnostics: k > 5 });
  const A = auditPacking(mesh, cp.pos, cp.r, { o: cp.o, R: cp.R });
  // B 自己不知道「角点」是哪些（它的边界条件里没有角点），所以角点从 pipeline 拿，
  // 只为了把两种边界条件下的角度和摆在一起对比。
  const sums = mesh.angleSums();
  const cornerAngles = corners.map((v) => (sums[v] * 180) / Math.PI);
  const devFrom90 = Math.max(...cornerAngles.map((x) => Math.abs(x - 90)));

  console.log(`  ${(preset.id || preset.name).padEnd(10)} ${String(mesh.nv).padStart(3)} ${String(k).padStart(3)}`
    + `   ${String(cp.stages.sphere.iterations).padStart(2)} 步 ${fmt(cp.stages.sphere.err, 1)}`
    + `  ${fmt(cp.obj, 2).padStart(9)}  ${fmt(A.boundaryRing, 1).padStart(9)}`
    + `  ${cornerAngles.map((x) => x.toFixed(2)).join(' ')}`
    + `  ${cp.ratioBoundary.toExponential(2)} vs ${ratioA.get(preset.id).toExponential(2)}`
    + `  ${String(cp.ms).padStart(5)}ms`);

  check(`[${preset.id || preset.name}] B 球面流收敛（补 ∞ 成球面，边界 k 点均分 4π）`, cp.stages.sphere.converged,
    `${cp.stages.sphere.iterations} 步，max|K̄−K| = ${fmt(cp.stages.sphere.err, 2)}`);
  check('B 极大：所有边界圆内切于同一个外圆（外圆残差 → 0）', cp.obj < 1e-9,
    `残差 ${fmt(cp.obj, 2)}，打靶 ${cp.steps} 步；边界圆到外圆的偏差带 ${fmt(A.boundaryRing, 2)}`);
  check('B 所有圆都在外圆里，边界圆全内切（没有一颗探出去）', A.outsideOuter <= 1e-9,
    `最大外溢 ${fmt(A.outsideOuter, 2)}（v${A.outsideOuterV}）`);
  check('B 图上每条边正好相切、两两不重叠、无多余相切',
    A.tangentPairs === mesh.ne && A.maxEdgeErr < 1e-9 && A.overlaps === 0 && A.extraTangencies === 0,
    `${A.tangentPairs}/${mesh.ne} 对；相切误差 ${fmt(A.maxEdgeErr, 2)}；重叠 ${A.overlaps}，多余相切 ${A.extraTangencies}，最近非边间隙 ${fmt(A.minGap, 2)}`);
  if (isMap) {
    check('A 与 B 确实不是同一个填充：极大填充的四角不是 90°', devFrom90 > 1,
      `B 的角点角度和 ${cornerAngles.map((x) => x.toFixed(2) + '°').join(' ')}，与 90° 最大差 ${devFrom90.toFixed(2)}°`);
  }
  // 解处 Jacobian 的奇异值 → 「极大填充族」的维数。零空间 = 改半径的那些规范方向（Aut(D) 3 维，
  // 其中旋转不改半径），所以维数恰好 2 就说明：过这个解的极大填充族**就是**它的 Aut(D) 轨道。
  if (cp.svs) {
    const th = cp.svs[0] * 1e-6;
    const nul = cp.svs.filter((x) => x < th).length;
    console.log(`        奇异值 ${cp.svs.length} 个：首 ${cp.svs.slice(0, 2).map((x) => x.toExponential(1)).join(', ')}`
      + `　末 4 个 ${cp.svs.slice(-4).map((x) => (x < th ? '≈0' : x.toExponential(1))).join(', ')}`
      + `　→ 零空间维数 ≈ ${nul}`);
    check('极大填充族 = Aut(D) 轨道（解处 Jacobian 零空间维数 = 2）', nul === 2,
      `${cp.svs.length} 个奇异值里 ${nul} 个 ≈ 0；阈值 ${th.toExponential(1)}`);
  }
  console.log('');
}

console.log('\n=== 9. 用户图导入：边表 / JSON → 同一个 preset → 同一套流水线 (graphfile.js + examples.js) ===\n');
console.log('  一条边表（或一个 JSON）进去，出来的是和 8 个预设**同一种** preset');
console.log('  （{id, name, nv, faces, corners?}）—— 所以四个视图、右侧数字、长宽比滑杆一行都不用改。');
console.log('  这一节量三件事：解析（两种格式 + 每个错误样例）、**往返**（10 张内建图 → 边表 → 导入 →');
console.log('  与原图逐项相等）、修补阶梯与拒绝路径（每一处偏离都记账，修不掉的要说清卡在哪一条）。\n');

const imp = (text, name) => parseGraphFile(text, { name: name || 't' });
const impPreset = (text, name) => graphToPreset(imp(text, name).graph);
const edgesOf = (P) => {
  const s = new Set();
  for (const f of P.faces) for (let i = 0; i < 3; i++) {
    const a = f[i], b = f[(i + 1) % 3];
    s.add(a < b ? `${a} ${b}` : `${b} ${a}`);
  }
  return [...s];
};
const edgeListOf = (P) => { const e = edgesOf(P); return [`${P.nv} ${e.length}`, ...e].join('\n'); };
const cycleSet = (cyc) => {
  const s = new Set();
  for (let i = 0; i < cyc.length; i++) {
    const a = cyc[i], b = cyc[(i + 1) % cyc.length];
    s.add(a < b ? `${a},${b}` : `${b},${a}`);
  }
  return s;
};
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const degOf = (nv, edges) => {
  const d = new Array(nv).fill(0);
  for (const [a, b] of edges) { d[a]++; d[b]++; }
  return d;
};
const cornersOf = (rep) => (rep && rep.cornerNames
  ? [rep.cornerNames.S, rep.cornerNames.E, rep.cornerNames.N, rep.cornerNames.W] : []);
// 名字（'v7' / '加州'）→ 下标，导入的图不带原图的名字，比较时要回到下标
const idxOfName = (nm) => Number(String(nm).replace(/^v/, ''));
// 一个错误样例：解析必须失败，而且问题里要出现给定关键词（不能是「读不进去」这种废话）。
const badFile = (label, text, kw) => {
  const r = imp(text);
  check(label, !r.ok && r.problems.some((p) => p.includes(kw)),
    r.ok ? `居然读进去了（V=${r.graph.nv} E=${r.graph.edges.length}）` : `「${r.problems[0]}」`);
};
// 网格：cols × rows 个格子（每格一条对角线）—— 最常见的用户输入
const gridEdges = (cols, rows) => {
  const W = cols + 1, H = rows + 1, id = (i, j) => j * W + i, out = [];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (i + 1 < W) out.push([id(i, j), id(i + 1, j)]);
      if (j + 1 < H) out.push([id(i, j), id(i, j + 1)]);
      if (i + 1 < W && j + 1 < H) out.push([id(i, j), id(i + 1, j + 1)]);
    }
  }
  return { nv: W * H, edges: out };
};

/* ---------- 9.1 解析 ---------- */

console.log('  ── 9.1 解析：边表 / JSON + 每个错误样例 ──\n');

{
  const r = imp('4 4\n0 1\n1 2\n2 3\n3 0\n');
  check('边表：`n m` 表头被认出来（0 基）', r.ok && r.graph.nv === 4 && r.graph.edges.length === 4 && r.graph.base === 0 && r.graph.headerUsed,
    `V=${r.graph && r.graph.nv} E=${r.graph && r.graph.edges.length} 下标基=${r.graph && r.graph.base} 用了表头=${r.graph && r.graph.headerUsed}`);

  const r2 = imp('0 1\n1 2\n2 3\n3 0\n');
  check('边表：没有表头也读得出来（顶点数 = 最大下标 + 1）', r2.ok && r2.graph.nv === 4 && !r2.graph.headerUsed,
    `V=${r2.graph && r2.graph.nv} E=${r2.graph && r2.graph.edges.length} 用了表头=${r2.graph && r2.graph.headerUsed}`);

  const r3 = imp('4 4\n1 2\n2 3\n3 4\n4 1\n');
  check('边表：出现等于 n 的下标 → 按 1 基读并整体减 1（PACE .gr 惯例）',
    r3.ok && r3.graph.base === 1 && r3.graph.nv === 4
      && JSON.stringify(r3.graph.edges) === JSON.stringify([[0, 1], [1, 2], [2, 3], [3, 0]]),
    `下标基=${r3.graph && r3.graph.base}，边 ${r3.graph && r3.graph.edges.map((e) => e.join('-')).join(' ')}`);

  const r4 = imp('# 注释行\n\n0,1\n1;2\n');
  check('边表：注释 / 空行 / 逗号分号分隔都吃', r4.ok && r4.graph.edges.length === 2 && r4.graph.nv === 3,
    `V=${r4.graph && r4.graph.nv} E=${r4.graph && r4.graph.edges.length}（「#」开头的行整行跳过）`);
}

// 表头里的 m 和实际边行数不一致时，首行会被当边读 —— 这里把它固定下来，别的例子都带对的表头。
{
  const r = imp('4 9\n0 1\n1 2\n');
  check('边表：表头对不上（m ≠ 边行数）时首行退回当成边读，不报错',
    r.ok && !r.graph.headerUsed && r.graph.edges.length === 3 && r.graph.nv === 10,
    `V=${r.graph && r.graph.nv}（「4 9」当边读 → 顶点到 9）E=${r.graph && r.graph.edges.length} 用了表头=${r.graph && r.graph.headerUsed}`);
}

const W5 = ['0 1', '1 2', '2 3', '3 4', '4 0', '0 2', '2 4', '0 3'];
const w5Text = (head) => [head, `5 ${W5.length}`, ...W5].join('\n');
{
  const c = imp(w5Text('# corners: 2 0 4 1'));
  check('`# corners:` 就用声明的（沿外圈逆时针 S E N W）',
    c.ok && JSON.stringify(c.graph.corners) === '[2,0,4,1]', `corners=${JSON.stringify(c.graph && c.graph.corners)}`);

  const b = imp(w5Text('# boundary: 0 1 2 3'));
  check('`# boundary:` 就用声明的（一般平面图走这条路）',
    b.ok && JSON.stringify(b.graph.boundary) === '[0,1,2,3]', `boundary=${JSON.stringify(b.graph && b.graph.boundary)}`);

  const n = imp(w5Text('# name: w5 手写'));
  check('`# name:` 认出来', n.ok && n.graph.name === 'w5 手写', `name=「${n.graph && n.graph.name}」`);

  const p1 = imp(w5Text('# pos: 0 0.5 -0.25\n# pos: 2 1 1.5'));
  check('`# pos: 顶点 x y`：顶点可乱序、坐标可以是小数',
    p1.ok && JSON.stringify(p1.graph.pos[0]) === '[0.5,-0.25]' && JSON.stringify(p1.graph.pos[2]) === '[1,1.5]',
    `pos[0]=${JSON.stringify(p1.graph && p1.graph.pos[0])} pos[2]=${JSON.stringify(p1.graph && p1.graph.pos[2])}（没写到的点回退到重心，只影响 ①）`);

  const p2 = imp('# pos: 0 0\n# pos: 1 0\n# pos: 0 1\n# pos: 1 1\n4 5\n0 1\n1 3\n3 2\n2 0\n0 3\n');
  check('`# pos: x y` 不给顶点号：按出现顺序赋给 0,1,2,…',
    p2.ok && JSON.stringify(p2.graph.pos) === '[[0,0],[1,0],[0,1],[1,1]]', `pos=${JSON.stringify(p2.graph && p2.graph.pos)}`);
}

{
  const j1 = imp('{"nv":4,"faces":[[0,1,2],[0,2,3]]}');
  check('JSON：只给 faces 时边从面里推出来',
    j1.ok && j1.graph.faces.length === 2 && j1.graph.edges.length === 5,
    `F=${j1.graph && j1.graph.faces.length} → E=${j1.graph && j1.graph.edges.length}（两个三角共 5 条边）`);

  const j2 = imp('{"edges":[[0,1],[1,2],[2,3],[3,0]]}');
  check('JSON：也可以只给 edges（nv 从下标推）',
    j2.ok && j2.graph.nv === 4 && j2.graph.edges.length === 4 && j2.graph.faces === null,
    `V=${j2.graph && j2.graph.nv} E=${j2.graph && j2.graph.edges.length} faces=${j2.graph && j2.graph.faces}`);

  const j3 = imp('{"nv":4,"faces":[[0,1,2],[0,2,3]],"corners":{"S":0,"E":1,"N":2,"W":3}}');
  const j4 = imp('{"nv":4,"faces":[[0,1,2],[0,2,3]],"corners":[0,1,2,3]}');
  check('JSON：corners 写 {S,E,N,W} 或 4 个整数的数组都行',
    j3.ok && j4.ok && JSON.stringify(j3.graph.corners) === '[0,1,2,3]' && JSON.stringify(j4.graph.corners) === '[0,1,2,3]',
    `对象 → ${JSON.stringify(j3.graph && j3.graph.corners)}；数组 → ${JSON.stringify(j4.graph && j4.graph.corners)}`);

  const j5 = imp('{"nv":4,"faces":[[0,1,2],[0,2,3]],"names":["a","b","c","d"],"pos":[[0,0],[1,0],[0,1],[1,1]]}');
  check('JSON：names / pos 收下（只用于显示）',
    j5.ok && j5.graph.names.length === 4 && j5.graph.pos.length === 4, `names=${JSON.stringify(j5.graph && j5.graph.names)}`);
}

badFile('错误样例：空文件', '   \n', '空的');
badFile('错误样例：只有注释、没有边', '# 只有注释\n', '没有边');
badFile('错误样例：某行不是两个整数', '3 2\n0 1\n1 x\n', '不是整数');
badFile('错误样例：下标为负（越界）', '3 3\n0 1\n1 2\n-1 0\n', '越界');
badFile('错误样例：JSON 语法错', '{"nv":3,', 'JSON 语法错');
badFile('错误样例：JSON 既没有 faces 也没有 edges', '{"nv":3}', '既没有 faces 也没有 edges');
badFile('错误样例：faces 里混进 4 个点的面', '{"nv":4,"faces":[[0,1,2,3]]}', '不是 3 个点');
badFile('错误样例：faces 里有非整数', '{"nv":4,"faces":[[0,1,"a"]]}', '不是整数');
badFile('错误样例：JSON 下标 ≥ nv（不是 1 基，是真的越界）', '{"nv":3,"faces":[[0,1,5]]}', '≥ nv');
badFile('错误样例：names 长度 ≠ nv', '{"nv":4,"faces":[[0,1,2],[0,2,3]],"names":["a"]}', 'nv=4');
badFile('错误样例：`# pos:` 写了 4 个数', w5Text('# pos: 0.5 1.5 -0.25 2'), 'pos');

/* ---------- 9.2 3-团法 ---------- */

console.log('\n  ── 9.2 什么都不声明时：3-团法恢复出「面」和「外圈」 ──\n');
for (const P of [...PRESETS, ...MAP_PRESETS]) {
  const { mesh, corners } = buildInputMesh(P);
  const nb = adjacencyFromEdges(P.nv, mesh.edges);
  const cl = cliques3(P.nv, nb);
  const cnt = cliqueEdgeCount(P.nv, nb, cl);
  const one = new Set();
  for (const [k, c] of cnt) if (c === 1) one.add(k);
  const bd = cycleSet(mesh.boundary);
  const g = impPreset(edgeListOf(P), P.id);
  check(`[${P.id}] 「只属一个 3-团的边」= mesh.boundary（${mesh.boundary.length} 条）`,
    one.size === mesh.boundary.length && sameSet(one, bd) && g.ok && g.preset.report.boundaryLen === mesh.boundary.length,
    `${cl.length} 个 3-团 → 外圈边 ${one.size} 条；导入后外圈 ${g.ok ? g.preset.report.boundaryLen : '-'} 点`
    + `，4 个角点 ${corners.length ? `[${corners.map((v) => P.names ? P.names[v] : 'v' + v).join(' ')}]` : '-'}`);
}

/* ---------- 9.3 往返 ---------- */

console.log('\n  ── 9.3 往返（这一节最强的一条）：10 张内建图 → 边表 → 导入 → 与原图逐项相等 ──\n');
console.log('  图      V/E/F（原→导）        外圈  角点（导入后自动选的）        长宽比（原 / 导）        流 REL 铺满  ④四角偏差');
let rtBad = 0;
for (const P of [...PRESETS, ...MAP_PRESETS]) {
  const g = impPreset(edgeListOf(P), P.id);
  const o = buildInputMesh(P);
  const k = o.mesh.boundary.length;
  const rep = g.ok ? g.preset.report : null;
  const m = g.ok ? buildInputMesh(g.preset) : null;
  const q = quadForPreset(P, 1);
  const sO = summarize(runPipeline(P, { quad: q }));
  const sI = g.ok ? summarize(runPipeline(g.preset, { quad: q })) : null;
  const cpI = g.ok ? circlePack(m.mesh, { corners: m.corners }) : null;
  const auto = cornersOf(rep).map(idxOfName);
  const decl = o.corners.slice();                       // 原图用的 4 个角点（下标）
  const nm = (v) => (P.names ? P.names[v] : 'v' + v);
  if (!g.ok) rtBad++;
  console.log(`  ${P.id.padEnd(6)} ${String(o.mesh.nv).padStart(2)}/${String(o.mesh.ne).padStart(2)}/${String(o.mesh.nf).padStart(2)}`
    + ` → ${g.ok ? `${String(rep.nv).padStart(2)}/${String(rep.ne).padStart(2)}/${String(rep.nf).padStart(2)}` : ' ✗ '}`
    + `  ${String(k).padStart(3)}  ${(auto.length ? auto.map(nm).join(' ') : '-').padEnd(25)}`
    + ` ${sO.aspect.toFixed(6)} / ${String(sI ? sI.aspect.toFixed(6) : '-').padEnd(8)}`
    + ` ${sI && sI.relOk ? ' ✓ ' : ' ✗ '} ${sI && sI.packingOk ? ' ✓ ' : ' ✗ '}  ${cpI ? fmt(cpI.angles.cornerErr, 2) : '-'}`);

  check(`[${P.id}] 边表往返：直接可用、0 条修补`, g.ok && g.repairs.length === 0,
    g.ok ? `V=${rep.nv} E=${rep.ne} F=${rep.nf} 外圈=${rep.boundaryLen}` : g.problems[0]);
  check(`[${P.id}] 往返后 V/E/F/χ 与原图逐项相等`,
    g.ok && rep.nv === o.mesh.nv && rep.ne === o.mesh.ne && rep.nf === o.mesh.nf && rep.chi === 1,
    `V ${o.mesh.nv}→${g.ok ? rep.nv : '-'}　E ${o.mesh.ne}→${g.ok ? rep.ne : '-'}`
    + `　F ${o.mesh.nf}→${g.ok ? rep.nf : '-'}　χ=${g.ok ? rep.chi : '-'}`);
  check(`[${P.id}] 往返后外圈边集 = 原图 mesh.boundary`,
    g.ok && sameSet(cycleSet(m.mesh.boundary), cycleSet(o.mesh.boundary)), `${k} 条边逐一相等`);
  check(`[${P.id}] 往返后流水线照跑：流✓ REL✓ 铺满✓`,
    g.ok && sI.relOk && sI.packingOk, `长宽比 ${sI ? sI.aspect.toFixed(6) : '-'}，流 ${sI ? sI.flowIters : '-'} 步`);
  check(`[${P.id}] 往返后 ④ 圆盘填充四角各 90°`,
    g.ok && cpI.angles.cornerErr < 1e-12, `Σ|Σθ−π/2| = ${cpI ? fmt(cpI.angles.cornerErr, 2) : '-'}`);
  if (k === 4) {
    check(`[${P.id}] 往返后长宽比与原图相同（k=4 时只由输入四边形决定，与原图无关）`,
      g.ok && near(sI.aspect, sO.aspect, 1e-9), `原 ${sO.aspect.toFixed(12)} / 导 ${sI ? sI.aspect.toFixed(12) : '-'}`);
  } else {
    const sameCorner = decl.length === 4 && auto.length === 4 && decl.every((v, i) => v === auto[i]);
    check(`[${P.id}] k=${k} > 4：自动角点和原图声明的那组不同 ⟹ 长宽比不同（这条限制是明说的，不是 bug）`,
      g.ok && !sameCorner && !near(sI.aspect, sO.aspect, 1e-9),
      `声明 [${decl.map(nm).join(' ')}] → ${sO.aspect.toFixed(6)}；自动 [${auto.map(nm).join(' ')}] → ${sI ? sI.aspect.toFixed(6) : '-'}（同一个输入四边形）`);
  }
}
check('10 张内建图全部往返成功', rtBad === 0, `${[...PRESETS, ...MAP_PRESETS].length} 张里失败 ${rtBad} 张`);

/* ---------- 9.4 自动选角 ---------- */

console.log('\n  ── 9.4 自动选角：外圈上度为 2 的点强制当角点（PTP 要求非角点外圈点度 ≥ 3），');
console.log('      剩下的名额按「最大化最小间隔」贪心补满 ──\n');
console.log('  图        V  外圈  角点（自动选的）        长宽比      流 REL 铺满  ④四角偏差');
for (const [c, r] of [[1, 1], [1, 3], [2, 2], [3, 3], [4, 4], [8, 8]]) {
  const G = gridEdges(c, r);
  const text = [`${G.nv} ${G.edges.length}`, ...G.edges.map(([a, b]) => `${a} ${b}`)].join('\n');
  const g = impPreset(text, `grid${c}x${r}`);
  const rep = g.ok ? g.preset.report : null;
  const auto = cornersOf(rep).map(idxOfName);
  const s = g.ok ? summarize(runPipeline(g.preset, { quad: quadForPreset(g.preset, 1) })) : null;
  const cp = g.ok ? (() => { const mm = buildInputMesh(g.preset); return circlePack(mm.mesh, { corners: mm.corners }); })() : null;
  const deg = degOf(G.nv, G.edges);
  const deg2 = [];
  for (let v = 0; v < G.nv; v++) if (deg[v] === 2) deg2.push(v);
  console.log(`  grid${c}x${r}  ${String(G.nv).padStart(3)} ${String(rep ? rep.boundaryLen : '-').padStart(4)}`
    + `  ${(auto.length ? auto.join(' ') : '-').padEnd(25)} ${String(s ? s.aspect.toFixed(6) : '-').padEnd(10)}`
    + ` ${s && s.relOk ? ' ✓ ' : ' ✗ '} ${s && s.packingOk ? ' ✓ ' : ' ✗ '}  ${cp ? fmt(cp.angles.cornerErr, 2) : '-'}`);

  check(`[grid${c}x${r}] 不声明任何东西也直接可用（0 条修补）`, g.ok && g.repairs.length === 0,
    g.ok ? `V=${rep.nv} E=${rep.ne} F=${rep.nf} 外圈=${rep.boundaryLen} 长宽比 ${s.aspect.toFixed(6)}` : g.problems[0]);
  check(`[grid${c}x${r}] 外圈上度为 2 的点全部被选成角点（${deg2.length} 个）`,
    g.ok && deg2.every((v) => auto.includes(v)) && new Set(auto).size === 4,
    `度 2 的外圈点 [${deg2.join(' ')}] ⊆ 角点 [${auto.join(' ')}]`);
  check(`[grid${c}x${r}] 流✓ REL✓ 铺满✓ ④ 四角 90°`,
    g.ok && s.relOk && s.packingOk && cp.angles.cornerErr < 1e-12,
    `REL/铺满 ${s.relOk}/${s.packingOk}，Σ|Σθ−π/2| = ${cp ? fmt(cp.angles.cornerErr, 2) : '-'}`);
}

// 两张真实地图：外圈几十个点，度 2 的点极少，正好考「强制 + 贪心」
for (const P of MAP_PRESETS) {
  const g = impPreset(edgeListOf(P), P.id);
  const rep = g.preset.report;
  const auto = cornersOf(rep).map(idxOfName);
  const E = edgesOf(P).map((s) => s.split(' ').map(Number));
  const deg = degOf(P.nv, E);
  const deg2 = [];
  for (let v = 0; v < P.nv; v++) if (deg[v] === 2) deg2.push(v);
  check(`[${P.id}] 外圈 ${rep.boundaryLen} 点、度 2 的 ${deg2.length} 个（${deg2.map((v) => P.names[v]).join('/') || '无'}）全在自动角点里`,
    deg2.every((v) => auto.includes(v)) && new Set(auto).size === 4,
    `自动角点 [${auto.map((v) => P.names[v]).join(' ')}]，手写的是 [${cornersOf(P.report).join(' ')}]`);
}

/* ---------- 9.5 修补阶梯 ---------- */

console.log('\n  ── 9.5 修补阶梯：每个 fixture 一条，修完必须照跑（数字都在） ──\n');
// 每个 fixture：{ 名字, 文本, 期望出现的修补种类, 只能出现的种类（校验阶梯没乱走）, 额外断言 }
const fixtures = [];
{
  // (1) steiner：声明外圈 0 1 2 3，中间一块不是团的面 → 插人工点
  fixtures.push({
    id: 'steiner',
    text: ['# boundary: 0 1 2 3', '6 10', '0 1', '1 2', '2 3', '3 0', '0 4', '1 4', '2 4', '2 5', '3 5', '0 5'].join('\n'),
    want: 'steiner', nv0: 6,
  });
  // (2) merge：五耳十边形 —— 外圈上有 5 个度 2 的点，多出来的并入邻居
  const ear = ['0 1', '1 2', '2 3', '3 4', '4 5', '5 6', '6 7', '7 8', '8 9', '9 0'];
  const diag = ['0 2', '2 4', '4 6', '6 8', '8 0', '0 4', '0 6'];
  fixtures.push({
    id: 'ears10', text: [`10 ${ear.length + diag.length}`, ...ear, ...diag].join('\n'), want: 'merge', nv0: 10,
  });
  // (3) flip（干净）：六边形 + 内三角 6-7-8 + 内点 9 —— 分离三角形 6-7-8 翻边
  const hex = ['0 1', '1 2', '2 3', '3 4', '4 5', '5 0'];
  const spokes = ['0 6', '1 6', '2 6', '2 7', '3 7', '4 7', '4 8', '5 8', '0 8'];
  const tri = ['6 7', '7 8', '8 6'];
  const cap = ['6 9', '7 9', '8 9'];
  fixtures.push({
    id: 'flip-clean', text: [`10 ${hex.length + spokes.length + tri.length + cap.length}`, ...hex, ...spokes, ...tri, ...cap].join('\n'),
    want: 'flip', nv0: 10, vef: [10, 21, 12],
  });
  // (4) flip（贴着外圈）：正方形 0-1-2-3 + 对角线 0-2 + 内三角环 4-5-6 ——
  //     分离三角形 0-1-2 的一条边是**真外圈边**，3-团计数会漏掉外圈点，要先认出来再翻
  fixtures.push({
    id: 'flip-leaning',
    text: ['7 14', '0 1', '1 2', '2 3', '3 0', '0 2', '0 4', '1 4', '1 5', '2 5', '2 6', '0 6', '4 5', '5 6', '6 4'].join('\n'),
    want: 'flip', nv0: 7, vef: [7, 14, 8], note: '贴着外圈',
  });
  // (5) cut：八面体（闭合球面）→ 沿度 4 的顶点剪开
  fixtures.push({
    id: 'octahedron',
    text: ['6 12', '0 1', '1 2', '2 0', '3 4', '4 5', '5 3', '0 4', '0 5', '1 3', '1 5', '2 3', '2 4'].join('\n'),
    want: 'cut', nv0: 6, vef: [5, 8, 4],
  });
}
console.log('  图            修补    V→V  E   F  外圈  长宽比      流 REL 铺满  ④四角偏差');
for (const fx of fixtures) {
  const g = impPreset(fx.text, fx.id);
  const kinds = g.repairs.map((r) => r.kind);
  const rep = g.ok ? g.preset.report : null;
  const s = g.ok ? summarize(runPipeline(g.preset, { quad: quadForPreset(g.preset, 1) })) : null;
  const cp = g.ok ? (() => { const mm = buildInputMesh(g.preset); return circlePack(mm.mesh, { corners: mm.corners }); })() : null;
  console.log(`  ${fx.id.padEnd(13)} ${(kinds.join('+') || '-').padEnd(7)} ${String(fx.nv0).padStart(2)}→${String(rep ? rep.nv : '-').padStart(2)}`
    + ` ${String(rep ? rep.ne : '-').padStart(3)} ${String(rep ? rep.nf : '-').padStart(3)} ${String(rep ? rep.boundaryLen : '-').padStart(4)}`
    + `  ${String(s ? s.aspect.toFixed(6) : '-').padEnd(10)} ${s && s.relOk ? ' ✓ ' : ' ✗ '} ${s && s.packingOk ? ' ✓ ' : ' ✗ '}  ${cp ? fmt(cp.angles.cornerErr, 2) : '-'}`);
  for (const r of g.repairs) console.log(`        [${r.kind}] ${r.why}`);
  for (const n of g.notes) console.log(`        note: ${n}`);

  check(`[${fx.id}] 走的是 ${fx.want} 这条修补（${kinds.join(' + ') || '没修'}）`, g.ok && kinds.includes(fx.want),
    g.ok ? `${g.repairs.length} 条：${kinds.join(' + ')}` : g.problems[0]);
  check(`[${fx.id}] 修补后照跑：流✓ REL✓ 铺满✓ ④ 四角 90°`,
    g.ok && s.relOk && s.packingOk && cp.angles.cornerErr < 1e-12,
    `长宽比 ${s ? s.aspect.toFixed(6) : '-'}，REL/铺满 ${s ? s.relOk : '-'}/${s ? s.packingOk : '-'}，Σ|Σθ−π/2| = ${cp ? fmt(cp.angles.cornerErr, 2) : '-'}`);
  if (fx.vef) {
    check(`[${fx.id}] 修完的结构 V/E/F = ${fx.vef.join('/')}`,
      g.ok && rep.nv === fx.vef[0] && rep.ne === fx.vef[1] && rep.nf === fx.vef[2] && rep.chi === 1,
      `V=${rep && rep.nv} E=${rep && rep.ne} F=${rep && rep.nf} χ=${rep && rep.chi}`);
  }
  if (fx.want === 'steiner') {
    const nIns = kinds.filter((x) => x === 'steiner').length;
    check(`[${fx.id}] 每插一个点 V 就 +1（V ${fx.nv0}→${fx.nv0 + nIns}），插进去的点 kind='patch'（界面上是灰块）`,
      g.ok && rep.nv === fx.nv0 + nIns && g.preset.kind.filter((x) => x === 'patch').length === nIns
        && nIns > 0,
      `V ${fx.nv0}→${rep && rep.nv}，插了 ${nIns} 个，kind 里有 ${g.preset.kind.filter((x) => x === 'patch').length} 个 patch`);
    check(`[${fx.id}] 人工点的辐条记进 counts.patch 和 extra[]（① 里画成灰虚线）`,
      g.ok && rep.counts.patch === g.preset.extra.filter((e) => e.kind === 'patch').length && rep.counts.patch >= 3 * nIns,
      `counts.patch=${rep && rep.counts.patch} 条辐条（${nIns} 个点各度 ≥ 3），extra 里 ${g.preset.extra.filter((e) => e.kind === 'patch').length} 条`);
  }
  if (fx.want === 'merge') {
    check(`[${fx.id}] 每并入一个点 V 就 −1，且 merges 里记了「并到谁、为什么」`,
      g.ok && rep.nv === fx.nv0 - g.preset.merges.length && g.preset.merges.length > 0
        && g.preset.merges.every((m) => m.name && m.into && m.why),
      `V ${fx.nv0}→${rep && rep.nv}，并入 ${g.preset.merges.length} 个：`
      + `${g.preset.merges.map((m) => `${m.name}→${m.into}`).join(' ')}`);
  }
  if (fx.want === 'cut') {
    check(`[${fx.id}] 剪掉的顶点进了 excluded（它不在结果图里，但账上要留着）`,
      g.ok && g.preset.excluded.length === 1 && rep.nv === fx.nv0 - 1,
      `excluded=${JSON.stringify(g.preset.excluded)}`);
  }
  if (fx.note) {
    check(`[${fx.id}] 贴着外圈这件事有说明（外圈点认全了才敢翻）`,
      g.ok && g.notes.some((x) => x.includes(fx.note)), `notes 里有一条提到「${fx.note}」`);
  }
}

/* ---------- 9.6 拒绝路径 ---------- */

console.log('\n  ── 9.6 修不掉的：明确拒绝，并说清卡在哪一条 ──\n');
{
  const cases = [
    ['K5（非平面）', ['5 10', '0 1', '0 2', '0 3', '0 4', '1 2', '1 3', '1 4', '2 3', '2 4', '3 4'].join('\n'), ['找不到一条外圈边', 'boundary']],
    ['K3,3（一个三角形都没有）', ['6 9', '0 3', '0 4', '0 5', '1 3', '1 4', '1 5', '2 3', '2 4', '2 5'].join('\n'), ['一个三角形都没有']],
    ['不连通的图', ['4 2', '0 1', '2 3'].join('\n'), ['不连通', '2 块']],
    ['K4 闭合（球面但没有度 4 的顶点可剪）', ['4 6', '0 1', '1 2', '2 3', '3 0', '0 2', '1 3'].join('\n'), ['球面', '度 4']],
    ['外圈本身就是三角形（3 个点钉不成四边形）', ['3 3', '0 1', '1 2', '2 0'].join('\n'), ['外圈只有 3 个点']],
    ['自环', ['3 3', '0 1', '1 1', '1 2'].join('\n'), ['自环']],
    ['重复边', ['3 3', '0 1', '1 0', '1 2'].join('\n'), ['重复的边']],
  ];
  for (const [label, text, kws] of cases) {
    const g = impPreset(text, label);
    const hit = !g.ok && g.problems.length > 0 && kws.some((kw) => g.problems.some((p) => p.includes(kw)));
    check(`拒绝并说清原因：${label}`, hit, g.ok ? '居然接受了' : `「${g.problems[0].slice(0, 76)}${g.problems[0].length > 76 ? '…' : ''}」`);
  }
}

/* ---------- 9.7 边界情形 ---------- */

console.log('\n  ── 9.7 边界情形：0 个内点、朝向写乱的 JSON、k = 4 与 k > 4 ──\n');
{
  // 0 个内点：4-圈 + 一条对角线，4 个点全在外圈上
  const g = impPreset(['4 5', '0 1', '1 2', '2 3', '3 0', '0 2'].join('\n'), 'k4diag');
  const rep = g.preset.report;
  const s = summarize(runPipeline(g.preset, { quad: quadForPreset(g.preset, 1) }));
  const mm = buildInputMesh(g.preset);
  const cp = circlePack(mm.mesh, { corners: mm.corners });
  check('0 个内点的图也照算（V = 外圈点数，没有墙点）',
    g.ok && rep.nv === 4 && rep.ne === 5 && rep.nf === 2 && rep.nv - rep.boundaryLen === 0,
    `V=${rep.nv} E=${rep.ne} F=${rep.nf} 外圈=${rep.boundaryLen} 内点=0`);
  check('0 个内点时流/REL/铺满/④ 四角 90° 全过',
    s.relOk && s.packingOk && cp.angles.cornerErr < 1e-12 && cp.angles.nWall === 0,
    `长宽比 ${s.aspect.toFixed(6)}，墙点 ${cp.angles.nWall} 个，Σ|Σθ−π/2| = ${fmt(cp.angles.cornerErr, 2)}`);

  // 朝向写乱的 JSON faces：3-团只给「顶点集合」，朝向必须自己传播一致。
  // 把 w5 的每个面**隔一个翻一次**，能让「同一方向走两遍」的边暴露出来。
  const w5Faces = PRESETS[0].faces.map((f, i) => (i % 2 ? [f[1], f[0], f[2]] : [f[2], f[0], f[1]]));
  const gj = impPreset(JSON.stringify({ nv: 5, faces: w5Faces }), 'w5-shuffled');
  const faceKey = (fs) => fs.map((f) => [...f].sort((a, b) => a - b).join(',')).sort().join(' | ');
  // 朝向一致的判据：每条无向边的两个方向各最多出现一次（内部边两个方向各一次、外圈边只一次）
  const dir = new Map();
  for (const f of gj.preset.faces) for (let i = 0; i < 3; i++) {
    const kk = `${f[i]},${f[(i + 1) % 3]}`;
    dir.set(kk, (dir.get(kk) || 0) + 1);
  }
  let oriBad = 0;
  for (const [kk, n] of dir) {
    const [a, b] = kk.split(',');
    const rev = dir.get(`${b},${a}`) || 0;
    if (n > 1 || n + rev > 2) oriBad++;
  }
  check('朝向写乱的 JSON faces：传播成一致朝向后与原图同一张（顶点集合逐个相等）',
    gj.ok && faceKey(gj.preset.faces) === faceKey(PRESETS[0].faces),
    `传完 ${gj.preset.faces.map((f) => `(${f.join(' ')})`).join(' ')}`);
  check('朝向写乱的 JSON faces：没有一条边被同一个方向走两遍（朝向真的一致了）', gj.ok && oriBad === 0,
    `${dir.size} 条有向边里冲突 ${oriBad} 条`);
  const sj = summarize(runPipeline(gj.preset, { quad: quadForPreset(gj.preset, 1) }));
  check('朝向写乱的 JSON faces：长宽比 = 1.233827（= 同一张图的值）',
    gj.ok && near(sj.aspect, 1.233827, 1e-6) && sj.relOk && sj.packingOk,
    `长宽比 ${sj.aspect.toFixed(6)}，REL/铺满 ${sj.relOk}/${sj.packingOk}`);
}

/* ---------- 9.8 内置的三个示例 ---------- */

console.log('\n  ── 9.8 导入浮层里那三个示例（和界面「用示例」按钮读的是同一份字面量）──\n');
for (const ex of EXAMPLES) {
  const pa = imp(ex.text, ex.id);
  const g = pa.ok ? graphToPreset(pa.graph) : { ok: false, problems: pa.problems };
  const rep = g.ok ? g.preset.report : null;
  const s = g.ok ? summarize(runPipeline(g.preset, { quad: quadForPreset(g.preset, 1) })) : null;
  console.log(`  ${ex.id.padEnd(13)} ${ex.title.replace(`${ex.id} — `, '')}：`
    + (g.ok ? `V=${rep.nv} E=${rep.ne} F=${rep.nf} 外圈=${rep.boundaryLen} 修补=${rep.repairs}`
      + ` 角点 ${cornersOf(rep).join(' ')} 长宽比 ${s.aspect.toFixed(6)}` : `✗ ${g.problems[0]}`));
  check(`[${ex.id}] 解析 + 建图 + 跑通一套（REL✓ 铺满✓）`, g.ok && s.relOk && s.packingOk,
    g.ok ? `${ex.note || ''} 长宽比 ${s.aspect.toFixed(6)}` : g.problems[0]);
}
{
  const hex = EXAMPLES.find((e) => e.id.startsWith('hex7'));
  const gh = impPreset(hex.text, 'hex7');
  check('[hex7] JSON 里声明的角点（名字）就用声明的',
    gh.ok && cornersOf(gh.preset.report).join(',') === ['西南', '东', '西北', '西'].join(','),
    `角点 [${cornersOf(gh.preset.report).join(' ')}]（文件里 corners 写的是 {S:4,E:0,N:2,W:3}）`);

  const gr = EXAMPLES.find((e) => e.id.startsWith('grid2x4'));
  const gg = impPreset(gr.text, 'grid2x4');
  const sg = summarize(runPipeline(gg.preset, { quad: quadForPreset(gg.preset, 1) }));
  check('[grid2x4] 声明了 `# corners:` 就用声明的那 4 个点（不进贪心）',
    gg.ok && cornersOf(gg.preset.report).join(' ') === 'v0 v3 v7 v4' && gg.preset.report.repairs === 0,
    `角点 [${cornersOf(gg.preset.report).join(' ')}]，长宽比 ${sg.aspect.toFixed(6)}`);
  // 同一张网格：声明角点 vs 不声明（自动选）—— 长宽比会不一样，这就是 k > 4 的那条限制
  const G24 = gridEdges(1, 3);
  const ga = impPreset([`${G24.nv} ${G24.edges.length}`, ...G24.edges.map(([a, b]) => `${a} ${b}`)].join('\n'), 'g');
  const sa = summarize(runPipeline(ga.preset, { quad: quadForPreset(ga.preset, 1) }));
  check('[grid2x4] 同一张网格什么都不声明：自动选的角点不同 ⟹ 长宽比不同（明说的限制）',
    ga.ok && ga.preset.report.nv === 8 && ga.preset.report.ne === 13
      && cornersOf(ga.preset.report).join(' ') !== 'v0 v3 v7 v4' && !near(sa.aspect, sg.aspect, 1e-9),
    `声明 [v0 v3 v7 v4] → ${sg.aspect.toFixed(6)}；自动 [${cornersOf(ga.preset.report).join(' ')}] → ${sa.aspect.toFixed(6)}`);

  const wl = EXAMPLES.find((e) => e.id.startsWith('wheel7'));
  const gw = impPreset(wl.text, 'wheel7');
  check('[wheel7] 什么都没声明：外圈 7 个点、自动选出 4 个角点，照样跑通',
    gw.ok && gw.preset.report.boundaryLen === 7 && new Set(cornersOf(gw.preset.report)).size === 4,
    `外圈 ${gw.preset.report.boundaryLen} 点 → 角点 [${cornersOf(gw.preset.report).join(' ')}]`);
}

/* ---------- 9.9 Stats 的渲染契约 ---------- */

console.log('\n  ── 9.9 渲染契约：Stats.jsx 会无保护地遍历这些字段，导入的 preset 一个都不能缺 ──\n');
{
  const steinerText = ['# boundary: 0 1 2 3', '6 10', '0 1', '1 2', '2 3', '3 0', '0 4', '1 4', '2 4', '2 5', '3 5', '0 5'].join('\n');
  const cases = [['内建图往返', impPreset(edgeListOf(PRESETS[0]), 'w5')], ['带修补的图', impPreset(steinerText, 'steiner')]];
  for (const [tag, g] of cases) {
    const P = g.preset, R = P.report;
    check(`[${tag}] preset.kind / names 是数组、长度 = nv、取值都是字符串`,
      Array.isArray(P.kind) && Array.isArray(P.names) && P.kind.length === P.nv && P.names.length === P.nv
        && P.kind.every((k) => typeof k === 'string' && k) && P.names.every((s) => typeof s === 'string'),
      `kind ${JSON.stringify([...new Set(P.kind)])}，names[0..2] ${JSON.stringify(P.names.slice(0, 3))}`);
    check(`[${tag}] report.counts 的 5 个键都是数字（Stats.jsx 的 kind.filter / counts 靠它）`,
      ['real', 'water', 'patch', 'artificial', 'point'].every((k) => typeof R.counts[k] === 'number'),
      JSON.stringify(R.counts));
    check(`[${tag}] repairs / dummies / extra / merges / excluded 都是数组（这几处 .map 没有保护）`,
      [P.repairs, P.dummies, P.extra, P.merges, P.excluded].every(Array.isArray),
      `长度 ${[P.repairs, P.dummies, P.extra, P.merges, P.excluded].map((x) => x.length).join(' / ')}`);
    check(`[${tag}] report.source = 'file'（Stats 靠它把措辞从「地图」换成「输入图」）`, R.source === 'file', `source=${R.source}`);
    check(`[${tag}] ids 有 nv 个，kind 里的 patch 个数 = steiner 修补条数（一个点一条）`,
      Array.isArray(P.ids) && P.ids.length === P.nv
        && P.kind.filter((k) => k === 'patch').length === P.repairs.filter((r) => r.kind === 'steiner').length,
      `${P.ids.length} 个 id，${P.kind.filter((k) => k === 'patch').length} 个 patch 顶点`);
  }
}

console.log('\n=== 汇总 ===');
console.log(`预设 ${built.length}/${PRESETS.length} 个建成；失败项 ${fails}`);
process.exit(fails ? 1 : 0);
