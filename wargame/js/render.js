/**
 * 一战兵棋推演 —— Canvas 渲染层（六边形网格 + 单位 + 高亮）
 *
 * 绘制顺序：背景 → 地形 → 河流 → 网格线 → 可达高亮 → 城市 → 单位 → 国名
 * 布局：尖顶朝上（pointy-top）+ 奇数行右移（odd-r offset）
 */

// 地形配色
const TERRAIN_COLORS = {
  [TERRAIN.PLAIN]: "#c8d6a5",
  [TERRAIN.FOREST]: "#2f6b31",
  [TERRAIN.MOUNTAIN]: "#8d8274",
};

// 归属配色
const SIDE_COLORS = {
  [SIDE.FR]: { main: "#3b6fd4", dark: "#274a94", label: "#ffffff" },
  [SIDE.DE]: { main: "#d4574a", dark: "#8f3026", label: "#ffffff" },
};

// hex 几何参数
const HEX_R = 24;
const HEX_W = Math.sqrt(3) * HEX_R;
const HEX_H = 1.5 * HEX_R;

// 视口状态
const viewport = { scale: 1, ox: 0, oy: 0 };

/** (col,row) → hex 中心像素坐标。 */
function gridToScreen(col, row) {
  return {
    x: (col * HEX_W + (row % 2 === 1 ? HEX_W / 2 : 0) + viewport.ox * HEX_W) * viewport.scale,
    y: (row * HEX_H + viewport.oy * HEX_H) * viewport.scale,
  };
}

/** 画布像素 → 格坐标（近似）。 */
function screenToGrid(px, py) {
  return {
    gx: px / viewport.scale / HEX_W - viewport.ox,
    gy: py / viewport.scale / HEX_H - viewport.oy,
  };
}

/** hex 的 6 个顶点（pointy-top）。 */
function hexCorners(cx, cy, size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (-90 + 60 * i);
    pts.push([cx + size * Math.cos(ang), cy + size * Math.sin(ang)]);
  }
  return pts;
}

/** 画一个 hex 路径（不填充，供 fill/stroke 使用）。 */
function traceHex(ctx, cx, cy, size) {
  ctx.beginPath();
  for (const [px, py] of hexCorners(cx, cy, size)) ctx.lineTo(px, py);
  ctx.closePath();
}

/** 画一个 hex（填充 + 可选描边）。 */
function fillHex(ctx, cx, cy, size, color) {
  traceHex(ctx, cx, cy, size);
  ctx.fillStyle = color;
  ctx.fill();
}

/** 部署模式：给可部署城市画黄色斜条纹高亮（裁剪到六边形内画平行斜线）。 */
function drawDeployStripes(ctx, city) {
  const c = gridToScreen(city.x, city.y);
  const size = HEX_R * viewport.scale;
  ctx.save();
  traceHex(ctx, c.x, c.y, size);
  ctx.clip();
  // 黄色斜条纹
  ctx.strokeStyle = "rgba(255, 215, 0, 0.55)";
  ctx.lineWidth = Math.max(2, 5 * viewport.scale);
  for (let i = -3; i <= 3; i++) {
    const x0 = c.x - size * 1.5 + i * size * 0.55;
    ctx.beginPath();
    ctx.moveTo(x0, c.y - size * 1.2);
    ctx.lineTo(x0 + size, c.y + size * 1.2);
    ctx.stroke();
  }
  ctx.restore();
  // 黄色边框
  traceHex(ctx, c.x, c.y, size);
  ctx.strokeStyle = "rgba(255, 215, 0, 0.95)";
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

/** 城市图标路径：1级=圆形 / 2级=方形 / 3级=五角星（等级由形状表达）。 */
function traceCityShape(ctx, cx, cy, r, level) {  if (level >= 3) {
    // 五角星（外半径 r，内半径 r*0.45）
    const inner = r * 0.45;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? r : inner;
      const ang = -Math.PI / 2 + (i * Math.PI) / 5;
      const x = cx + rad * Math.cos(ang);
      const y = cy + rad * Math.sin(ang);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  } else if (level === 2) {
    // 方形
    ctx.beginPath();
    ctx.rect(cx - r, cy - r, r * 2, r * 2);
  } else {
    // 圆形（1级）
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
}

/** 主绘制入口。 */
function renderMap(ctx, canvas) {
  const { cols, rows, terrain, cities } = MAP;
  const { units, currentSide, selectedId, reachable, attackTargets } = game;

  // 背景
  ctx.fillStyle = "#10141d";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // ── 1. 地形（城市格：地块填充阵营色，让城市一目了然）──
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const c = gridToScreen(col, row);
      if (c.x + HEX_R * viewport.scale < 0 || c.x - HEX_R * viewport.scale > canvas.width) continue;
      if (c.y + HEX_R * viewport.scale < 0 || c.y - HEX_R * viewport.scale > canvas.height) continue;
      const city = cityAt(col, row);
      let fill;
      if (city) {
        fill = SIDE_COLORS[city.owner].main; // 城市地块 = 所属阵营色
      } else {
        fill = TERRAIN_COLORS[terrain[row][col]] || TERRAIN_COLORS[TERRAIN.PLAIN];
      }
      fillHex(ctx, c.x, c.y, HEX_R * viewport.scale, fill);
    }
  }

  // ── 2. 河流（沿列边界的锯齿折线）──
  ctx.strokeStyle = "#3d8bdc";
  ctx.lineWidth = Math.max(2, 4 * viewport.scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [x1, y1, x2, y2] of MAP.rivers) {
    const pts = [];
    for (let row = y1; row <= y2; row++) {
      const bx = (x1 + (row % 2 === 1 ? 1 : 0.5)) * HEX_W;
      const by = row * HEX_H;
      pts.push([(bx + viewport.ox * HEX_W) * viewport.scale, (by + viewport.oy * HEX_H) * viewport.scale]);
    }
    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }
  }

  // ── 3. 网格边框 ──
  ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
  ctx.lineWidth = 1;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const c = gridToScreen(col, row);
      if (c.x + HEX_R * viewport.scale < 0 || c.x - HEX_R * viewport.scale > canvas.width) continue;
      if (c.y + HEX_R * viewport.scale < 0 || c.y - HEX_R * viewport.scale > canvas.height) continue;
      traceHex(ctx, c.x, c.y, HEX_R * viewport.scale);
      ctx.stroke();
    }
  }

  // ── 4. 可达格高亮（金色）与攻击目标（红色）──
  for (const keyStr of Object.keys(reachable)) {
    const [col, row] = keyStr.split(",").map(Number);
    const c = gridToScreen(col, row);
    fillHex(ctx, c.x, c.y, HEX_R * viewport.scale, "rgba(255, 215, 0, 0.35)");
    traceHex(ctx, c.x, c.y, HEX_R * viewport.scale);
    ctx.strokeStyle = "rgba(255, 215, 0, 0.9)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  for (const keyStr of Object.keys(attackTargets)) {
    const [col, row] = keyStr.split(",").map(Number);
    const c = gridToScreen(col, row);
    fillHex(ctx, c.x, c.y, HEX_R * viewport.scale, "rgba(255, 70, 70, 0.5)");
    traceHex(ctx, c.x, c.y, HEX_R * viewport.scale);
    ctx.strokeStyle = "rgba(255, 70, 70, 0.95)";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // ── 5. 城市（图标分级：1级圆形 / 2级方形 / 3级五角星；地块已是阵营色，图标用白色+深描边）──
  for (const city of cities) {
    // 部署模式：己方且为空的城市的黄色条纹高亮
    if (game.deployType && city.owner === game.currentSide && !unitAt(city.x, city.y)) {
      drawDeployStripes(ctx, city);
    }
    const color = SIDE_COLORS[city.owner];
    const c = gridToScreen(city.x, city.y);
    const r = (city.level === 3 ? 15 : city.level === 2 ? 12 : 9) * viewport.scale;
    // 形状路径
    traceCityShape(ctx, c.x, c.y, r, city.level);
    ctx.fillStyle = "#ffffff"; // 白色图标，在阵营色地块上清晰
    ctx.fill();
    ctx.strokeStyle = color.dark;
    ctx.lineWidth = 2 * viewport.scale;
    ctx.stroke();
    // 等级数字（深色，形状中央）
    ctx.fillStyle = color.dark;
    ctx.font = `bold ${Math.max(9, (city.level === 3 ? 12 : 11) * viewport.scale)}px "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(city.level), c.x, c.y + 0.5);
    // 城市名（2级及以上显示）
    if (viewport.scale >= 0.8 && city.level >= 2) {
      ctx.font = `${Math.max(10, 11 * viewport.scale)}px "Microsoft YaHei", sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fillText(city.name, c.x, c.y - r - 6 * viewport.scale);
    }
  }

  // ── 6. 单位 ──
  for (const unit of units) {
    drawUnit(ctx, unit);
  }

  // ── 6.5 交战红线：连接正在对战的双方单位 ──
  if (game.combatLine) {
    const a = gridToScreen(game.combatLine.from.col, game.combatLine.from.row);
    const b = gridToScreen(game.combatLine.to.col, game.combatLine.to.row);
    ctx.save();
    ctx.strokeStyle = "rgba(255, 60, 60, 0.95)";
    ctx.lineWidth = Math.max(3, 5 * viewport.scale);
    ctx.lineCap = "round";
    ctx.setLineDash([8 * viewport.scale, 6 * viewport.scale]); // 虚线，闪烁感
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    // 红点标记双方
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5 * viewport.scale, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 60, 60, 0.9)";
      ctx.fill();
    }
    ctx.restore();
  }

  // ── 7. 国名 ──
  const frPos = gridToScreen(2.5, 1.2);
  const dePos = gridToScreen(cols - 3.5, 1.2);
  ctx.font = `bold ${Math.max(20, 34 * viewport.scale)}px "Microsoft YaHei", sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(59,111,212,0.28)";
  ctx.fillText("法 国", frPos.x, frPos.y);
  ctx.fillStyle = "rgba(212,87,74,0.28)";
  ctx.fillText("德 国", dePos.x, dePos.y);
}

/** 绘制一个单位：阵营色圆底 + 类型图标 + 选中金环 + 剩余行动力。 */
function drawUnit(ctx, unit) {
  const color = SIDE_COLORS[unit.side];

  // 单位显示位置：动画中沿路径逐段移动（当前段 = path[seg] → path[seg+1]）
  let cx, cy;
  if (unit.anim) {
    const a = unit.anim.path[unit.anim.seg];
    const b = unit.anim.path[unit.anim.seg + 1];
    const fa = gridToScreen(a.col, a.row);
    const fb = gridToScreen(b.col, b.row);
    const t = unit.anim.t;
    cx = fa.x + (fb.x - fa.x) * t;
    cy = fa.y + (fb.y - fa.y) * t;
  } else {
    const c = gridToScreen(unit.col, unit.row);
    cx = c.x;
    cy = c.y;
  }
  const r = 13 * viewport.scale;

  // 是否被选中
  const isSelected = game.selectedId === unit.id;

  // 选中金环（画在圆底外）
  if (isSelected) {
    ctx.beginPath();
    ctx.arc(cx, cy, r + 5 * viewport.scale, 0, Math.PI * 2);
    ctx.strokeStyle = "#ffd700";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // 圆底
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color.main;
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 类型图标（白色图形，随单位类型不同）
  drawUnitIcon(ctx, unit.type, cx, cy, r);

  // 剩余行动力（圆底部小字）
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.max(8, 10 * viewport.scale)}px "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(unit.movePoints), cx, cy + r + 7 * viewport.scale);

  // 已攻击（非坦克）：半透明灰罩，表示本回合不能再行动
  if (unit.attacked && unit.type !== UNIT_TYPE.TANK) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(40, 40, 40, 0.45)";
    ctx.fill();
  }

  // 混乱：红色角标"乱"
  if (unit.confused) {
    ctx.beginPath();
    ctx.arc(cx + r * 0.85, cy - r * 0.85, r * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = "#e5484d";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.max(8, r * 0.5)}px "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("乱", cx + r * 0.85, cy - r * 0.85 + 0.5);
  }

  // 刚部署：金色角标"新"（本回合不能行动）
  if (unit.deployed) {
    ctx.beginPath();
    ctx.arc(cx - r * 0.85, cy - r * 0.85, r * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd700";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#3a2d00";
    ctx.font = `bold ${Math.max(8, r * 0.5)}px "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("新", cx - r * 0.85, cy - r * 0.85 + 0.5);
  }
}

/** 单位类型图标（Canvas 手绘：钢盔 / 火炮 / 坦克俯视图）。 */
function drawUnitIcon(ctx, type, cx, cy, r) {
  if (type === UNIT_TYPE.INFANTRY) {
    // 钢盔（正面）：圆顶在上 + 帽檐在下；白色填充 + 深色描边保证清晰
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.strokeStyle = "rgba(20, 30, 50, 0.8)";
    ctx.lineWidth = Math.max(1, r * 0.08);
    // 盔体（上半圆：顺时针 PI→2PI 经过正上方 270°，圆顶朝上）
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.2, r * 0.52, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // 帽檐（宽条，紧贴盔体底部）
    ctx.beginPath();
    ctx.rect(cx - r * 0.64, cy + r * 0.18, r * 1.28, r * 0.15);
    ctx.fill();
    ctx.stroke();
  } else if (type === UNIT_TYPE.ARTILLERY) {
    // 火炮（简化版）：斜 45° 炮管 + 下方轮子；轮子和炮口描黑
    const dark = "rgba(20, 30, 50, 0.85)";
    // 斜 45° 炮管（白色）
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillRect(-r * 0.55, -r * 0.1, r * 1.1, r * 0.2); // 炮管
    // 炮口描黑（前端加粗深色块）
    ctx.fillStyle = dark;
    ctx.fillRect(r * 0.42, -r * 0.14, r * 0.16, r * 0.28);
    ctx.restore();
    // 轮子（炮管下方，白底深描边）
    ctx.beginPath();
    ctx.arc(cx + r * 0.05, cy + r * 0.32, r * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill();
    ctx.strokeStyle = dark;
    ctx.lineWidth = Math.max(1.5, r * 0.12);
    ctx.stroke();
  } else if (type === UNIT_TYPE.TANK) {
    // 坦克俯视图：两条履带（带轮子）+ 车身 + 炮塔 + 朝上炮管
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    // 履带（左右两条竖直）
    ctx.fillRect(cx - r * 0.66, cy - r * 0.54, r * 0.2, r * 1.08); // 左履带
    ctx.fillRect(cx + r * 0.46, cy - r * 0.54, r * 0.2, r * 1.08); // 右履带
    // 履带轮子（深色小圆，每侧 3 个）
    ctx.fillStyle = "rgba(20, 30, 50, 0.85)";
    for (let i = -1; i <= 1; i++) {
      const wy = cy + i * r * 0.3;
      ctx.beginPath();
      ctx.arc(cx - r * 0.56, wy, r * 0.07, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx + r * 0.56, wy, r * 0.07, 0, Math.PI * 2);
      ctx.fill();
    }
    // 车身（中间）
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillRect(cx - r * 0.42, cy - r * 0.44, r * 0.84, r * 0.88);
    // 炮塔（偏上）
    ctx.fillRect(cx - r * 0.2, cy - r * 0.3, r * 0.4, r * 0.34);
    // 炮管（朝上伸出）
    ctx.fillRect(cx - r * 0.07, cy - r * 0.82, r * 0.14, r * 0.52);
    // 炮口制退器
    ctx.fillRect(cx - r * 0.1, cy - r * 0.86, r * 0.2, r * 0.08);
  }
}
