/**
 * 一战兵棋推演 —— 游戏状态与规则（阶段 4：移动系统）
 *
 * 规则（用户澄清版）：
 *  - 移动：单位按行动力移动，可到达的格子高亮，点击直达（非一格一格走）
 *  - 行动力：步兵 3 / 炮兵 3 / 坦克 5
 *  - 地形消耗：平原 1.5、森林 2、山地 2（步兵 1.5）、城市 1.5
 *  - 跨河：从一边到另一边 +1 行动力
 *  - 敌方格不可进入（战斗在攻击阶段处理）
 */

// 浮点比较精度
const EPS = 1e-6;

// 移动动画速度：每秒推进量（5 = 约 0.2 秒走完一格动画）
const ANIM_SPEED = 5;

// 当前游戏状态
const game = {
  units: [],            // 所有单位
  currentSide: SIDE.FR, // 当前回合方（法国先手）
  turn: 1,              // 回合计数（战斗日志显示用）
  gold: { fr: 0, de: 20 }, // 双方当前资金（法国 0 / 德国 20；收入在回合开始结算）
  selectedId: null,     // 当前选中的单位 id
  reachable: {},        // 可达格集合（key "c,r" -> { cost, path }）
  attackTargets: {},    // 可攻击的敌方格集合（key "c,r" -> { cost }）
  deployType: null,     // 当前部署模式选中的兵种（infantry/artillery/tank；null=未激活）
  cityChanged: false,   // 城市归属发生变更（供 UI 刷新收入显示）
  captureEvents: [],    // 城市占领事件 { side, cityName, via: 'move'|'combat' }（供日志/胜利判定）
  mode: "pvp",          // 模式：pvp=双人对战 / pve=玩家 vs AI
  aiSide: null,         // pve 模式下 AI 控制的阵营（fr/de）
  aiDifficulty: "normal", // AI 难度：normal=普通 / smart=正常(聪明) / hard=困难(聪明+每回合+10收入)
  combatLine: null,     // 正在交战的双方位置 { from:{col,row}, to:{col,row} }（画红线用）
};

/** hex 网格：某格 (col,row) 的 6 个邻居（odd-r 偏移坐标）。 */
function hexNeighbors(col, row) {
  const odd = row % 2 === 1;
  const dirs = odd
    ? [[1, 0], [-1, 0], [0, -1], [0, 1], [1, -1], [1, 1]]
    : [[1, 0], [-1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1]];
  return dirs
    .map(([dc, dr]) => [col + dc, row + dr])
    .filter(([c, r]) => c >= 0 && c < MAP.cols && r >= 0 && r < MAP.rows);
}

/** 判断两点是否在网格内。 */
function inBounds(col, row) {
  return col >= 0 && col < MAP.cols && row >= 0 && row < MAP.rows;
}

/** 某格是否为城市（返回城市对象或 null）。 */
function cityAt(col, row) {
  return MAP.cities.find((c) => c.x === col && c.y === row) || null;
}

/** 某格是否有单位（返回单位或 null）。 */
function unitAt(col, row, units = game.units) {
  return units.find((u) => u.col === col && u.row === row) || null;
}

/**
 * 进入某格的地形行动力消耗。
 * @param {number} col,row 目标格
 * @param {string} unitType 单位类型
 * @returns {number} 消耗的行动力（1.5 / 2）
 */
function terrainCost(col, row, unitType) {
  if (cityAt(col, row)) return 1.5; // 城市格固定消耗 1.5
  const t = MAP.terrain[row][col];
  if (t === TERRAIN.FOREST) return 2;
  if (t === TERRAIN.MOUNTAIN) return unitType === UNIT_TYPE.INFANTRY ? 1.5 : 2; // 步兵山地适应
  return 1.5; // 平原
}

/**
 * 判断两相邻格之间是否被河流穿过（跨河 +1 行动力）。
 * 河流沿"竖直列边界"分布（map.js rivers: [x, y1, x, y2]），
 * 只要从第 x 列跨越到第 x+1 列——无论水平还是斜向相邻——都视为跨河。
 */
function isRiverEdge(col1, row1, col2, row2) {
  if (Math.abs(col1 - col2) !== 1) return false;
  const boundaryCol = Math.min(col1, col2); // 第 min 列与 min+1 列之间
  return MAP.rivers.some(([x]) => x === boundaryCol);
}

/** 从一格移动到相邻格的消耗（地形消耗 + 跨河 +1）。 */
function stepCost(fromCol, fromRow, toCol, toRow, unitType) {
  let cost = terrainCost(toCol, toRow, unitType);
  if (isRiverEdge(fromCol, fromRow, toCol, toRow)) cost += 1;
  return cost;
}

/**
 * 计算单位行动力可到达的所有格子（Dijkstra，按最小消耗扩展）。
 * 同时记录前驱，为每个可达格回溯出"起点 → 该格"的完整路径（经过地块）。
 * @param {object} unit 单位
 * @param {object} [opts] { allowEnemyEnd: boolean } —— true 时敌方单位格可作为
 *        终点（攻击目标：行动力够到该格即可攻击），但不可穿过敌方。
 * @returns {{ [key]: { cost: number, path: Array<{col,row}> } }} 键为 "col,row"
 */
function computeReachable(unit, opts = {}) {
  const reach = {};
  const dist = new Map(); // "c,r" -> 最小消耗
  const prev = new Map(); // "c,r" -> 前驱 key（回溯路径用）
  const key = (c, r) => c + "," + r;

  dist.set(key(unit.col, unit.row), 0);
  const queue = [[unit.col, unit.row, 0]];

  while (queue.length > 0) {
    // 取当前消耗最小的格子（简单线性扫描，格子数少足够快）
    let bestIdx = 0;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i][2] < queue[bestIdx][2]) bestIdx = i;
    }
    const [c, r, cost] = queue.splice(bestIdx, 1)[0];
    if (dist.get(key(c, r)) < cost - EPS) continue; // 已用更优路径访问过

    for (const [nc, nr] of hexNeighbors(c, r)) {
      const occ = unitAt(nc, nr);
      if (occ) {
        // 敌方单位格：仅当允许作为终点（攻击目标）时可达，但不扩展（不穿过）
        if (occ.side !== unit.side && opts.allowEnemyEnd) {
          const newCost = cost + stepCost(c, r, nc, nr, unit.type);
          if (newCost > unit.movePoints + EPS) continue;
          const k = key(nc, nr);
          if (!dist.has(k) || newCost < dist.get(k) - EPS) {
            dist.set(k, newCost);
            prev.set(k, key(c, r));
            reach[k] = { cost: newCost };
            // 不入队：敌方格是终点
          }
        }
        continue; // 任何单位格都不可穿过（含友方，避免重叠）
      }

      const newCost = cost + stepCost(c, r, nc, nr, unit.type);
      if (newCost > unit.movePoints + EPS) continue; // 行动力不够
      const k = key(nc, nr);
      if (!dist.has(k) || newCost < dist.get(k) - EPS) {
        dist.set(k, newCost);
        prev.set(k, key(c, r)); // 记录前驱
        reach[k] = { cost: newCost };
        queue.push([nc, nr, newCost]);
      }
    }
  }

  // 为每个可达格回溯路径（起点 → 该格，含起点与终点）
  for (const k of Object.keys(reach)) {
    const path = [];
    let cur = k;
    while (cur !== undefined) {
      const [cc, rr] = cur.split(",").map(Number);
      path.unshift({ col: cc, row: rr });
      cur = prev.get(cur);
    }
    reach[k].path = path;
  }
  return reach;
}

/**
 * 攻击范围：与敌方单位【相邻】的格子（近战，不能隔空攻击），
 * 且剩余行动力足够"移动到该敌方格"（攻击 = 移动进敌方地块，消耗行动力）。
 */
function computeAttackTargets(unit) {
  const targets = {};
  for (const [c, r] of hexNeighbors(unit.col, unit.row)) {
    const occ = unitAt(c, r);
    if (!occ || occ.side === unit.side) continue;
    const cost = stepCost(unit.col, unit.row, c, r, unit.type);
    if (cost <= unit.movePoints + EPS) {
      targets[c + "," + r] = { cost, path: [{ col: unit.col, row: unit.row }, { col: c, row: r }] };
    }
  }
  return targets;
}

/**
 * 移动单位到目标格（目标格必须是可达的）。
 * 不立即落位、不预扣行动力：沿"经过地块的路径"逐段播放动画，
 * 行动力在 tickAnimation 中【每走一格扣一格消耗】，每格后刷新高亮。
 */
function moveUnit(unit, col, row) {
  const entry = game.reachable[key(col, row)];
  if (entry === undefined) return false;
  if (unit.anim) return false; // 动画进行中不可再次移动
  // 路径（含起点和终点）；兜底两点
  const path = entry.path && entry.path.length >= 2
    ? entry.path
    : [{ col: unit.col, row: unit.row }, { col, row }];
  unit.anim = { path, seg: 0, t: 0 }; // seg: 当前从 path[seg] 走向 path[seg+1]
  return true;
}

/**
 * 推进所有单位的移动动画（每帧调用）。
 * 沿路径逐段移动：每段 t 从 0→1，完成后进入下一段，最后一段完成时落位。
 * 每走完一格（段推进）就用当前格 + 剩余行动力刷新高亮（玩家能看到范围动态变化）。
 * @param {number} dt 帧间隔（秒）
 * @returns {boolean} 是否有动画活动（进行中或刚完成）——true 时调用方应重绘
 */
function tickAnimation(dt) {
  let dirty = false;
  for (const u of game.units) {
    if (!u.anim) continue;
    dirty = true; // 有动画（无论进行中还是刚完成）→ 需要重绘
    u.anim.t += dt * ANIM_SPEED;
    const prevSeg = u.anim.seg;
    // 完成当前段则进入下一段（最后一段的索引为 path.length-2），逐格扣行动力
    while (u.anim.t >= 1 && u.anim.seg < u.anim.path.length - 2) {
      u.anim.t -= 1;
      u.anim.seg += 1;
      const from = u.anim.path[u.anim.seg - 1];
      const to = u.anim.path[u.anim.seg];
      u.movePoints = Math.max(0, +(u.movePoints - stepCost(from.col, from.row, to.col, to.row, u.type)).toFixed(3));
    }
    // 走完一格：用当前所在格 + 剩余行动力刷新高亮（若单位仍被选中）
    if (u.anim.seg !== prevSeg && game.selectedId === u.id) {
      refreshReachableAt(u, u.anim.path[u.anim.seg]);
    }
    if (u.anim.t >= 1 && u.anim.seg >= u.anim.path.length - 2) {
      // 最后一段完成：扣最后一格消耗并落位到终点
      const last = u.anim.path[u.anim.path.length - 1];
      const from = u.anim.path[u.anim.path.length - 2];
      u.movePoints = Math.max(0, +(u.movePoints - stepCost(from.col, from.row, last.col, last.row, u.type)).toFixed(3));
      u.col = last.col;
      u.row = last.row;
      // 规则：单位进入【无驻军的敌方城市】即视为占领（归属变更）
      const city = cityAt(u.col, u.row);
      if (city && city.owner !== u.side) {
        city.owner = u.side;
        game.cityChanged = true; // 通知 UI 刷新预估收入
        game.captureEvents.push({ side: u.side, cityName: city.name, via: "move" });
      }
      const wasSelected = game.selectedId === u.id;
      u.anim = null;
      // 若该单位仍被选中，重算可达（基于新位置，可继续移动）
      if (wasSelected) selectUnit(u.id);
    }
  }
  return dirty;
}

/** 以单位"所在格"刷新可达/攻击高亮（用于移动动画中途按当前格重算，不改动单位真实位置）。 */
function refreshReachableAt(unit, cell) {
  const probe = { ...unit, col: cell.col, row: cell.row };
  game.reachable = computeReachable(probe);
  game.attackTargets = computeAttackTargets(probe);
}

// key 工具（暴露给 moveUnit 用）
function key(c, r) { return c + "," + r; }

/** 选中单位：计算可达格与攻击目标；取消：清空。
 *  混乱/刚部署：禁攻禁移；已攻击（任何类型）：不能再攻击，但坦克仍可移动（普通单位行动力已归零）。 */
function selectUnit(id) {
  game.selectedId = id;
  game.reachable = {};
  game.attackTargets = {};
  if (id !== null) {
    const u = game.units.find((x) => x.id === id);
    if (!u) return;
    if (u.confused) return;   // 混乱：禁攻禁移
    if (u.deployed) return;   // 刚部署：本回合不能行动
    game.reachable = computeReachable(u);
    if (!u.attacked) game.attackTargets = computeAttackTargets(u); // 已攻击不能再攻击
  }
}

/**
 * 战斗结算（纯计算，不改状态）：掷骰 d6 + 加成，返回判定结果。
 * @param {object} attacker, defender 攻防单位
 * @param {object} [dice] 可选：{ atkRoll, defRoll } 指定骰子值（用于动画与结算联动）
 * 加成规则（用户平衡调整版）：
 *  - 坦克攻击步兵 / 坦克：+1 攻击
 *  - 炮兵攻击【城市里的单位】：+1 攻击（不再对步兵加成）
 *  - 跨河进攻 -1 攻击
 *  - 防守方在城市：+1 防御；若守军是步兵，额外 +1 防御（步兵守城总 +2）
 *  - 防守方在森林且被炮兵攻击 +1 防御
 *  - 防守方混乱 -2 防御
 * 判定（diff = 攻击力 - 防御力）：
 *  - diff ≥ 3             → 消灭并占领（炮兵只消灭不占领）
 *  - diff = 2             → 击退（防守方后撤，无路可退则混乱）
 *  - diff ≤ -3            → 进攻方混乱（攻击力比防御力低 3 点及以上，进攻被压制）
 *  - 其余 (-2 ≤ diff ≤ 1) → 无事发生
 */
function resolveCombat(attacker, defender, dice) {
  // 逐条修正明细（用于界面显示，如 "+1-1"）
  const atkMods = [];
  const defMods = [];
  // 坦克 vs 步兵/坦克 +1
  if (attacker.type === UNIT_TYPE.TANK && (defender.type === UNIT_TYPE.INFANTRY || defender.type === UNIT_TYPE.TANK)) atkMods.push(1);
  // 炮兵 vs 城市里的单位 +2（炮击城防）
  if (attacker.type === UNIT_TYPE.ARTILLERY && cityAt(defender.col, defender.row)) atkMods.push(2);
  // 跨河进攻
  if (isRiverEdge(attacker.col, attacker.row, defender.col, defender.row)) atkMods.push(-1);
  // 城市防守：首都(3级) +2，普通城市 +1；步兵守城额外 +1
  const defCity = cityAt(defender.col, defender.row);
  if (defCity) {
    defMods.push(defCity.level === 3 ? 2 : 1);
    if (defender.type === UNIT_TYPE.INFANTRY) defMods.push(1);
  }
  // 森林防炮
  if (MAP.terrain[defender.row][defender.col] === TERRAIN.FOREST && attacker.type === UNIT_TYPE.ARTILLERY) defMods.push(1);
  // 混乱防御
  if (defender.confused) defMods.push(-2);

  const atkBonus = atkMods.reduce((s, m) => s + m, 0);
  const defBonus = defMods.reduce((s, m) => s + m, 0);
  const atkRoll = dice ? dice.atkRoll : 1 + Math.floor(Math.random() * 6);
  const defRoll = dice ? dice.defRoll : 1 + Math.floor(Math.random() * 6);
  const atk = atkRoll + atkBonus;
  const def = defRoll + defBonus;
  const diff = atk - def;

  let type;
  if (diff >= 3) type = "kill";
  else if (diff === 2) type = "retreat";
  else if (diff <= -3) type = "attacker-confused";
  else type = "miss";

  return { type, atkRoll, defRoll, atkBonus, defBonus, atkMods, defMods, atk, def, diff };
}

/** hex 距离（odd-r offset → axial 计算），用于"后方"判定。 */
function axialDistance(c1, r1, c2, r2) {
  const q1 = c1 - (r1 - (r1 & 1)) / 2;
  const q2 = c2 - (r2 - (r2 & 1)) / 2;
  const s1 = -q1 - r1;
  const s2 = -q2 - r2;
  return (Math.abs(q1 - q2) + Math.abs(r1 - r2) + Math.abs(s1 - s2)) / 2;
}

/** 击退目标：防守方"后方"（离进攻方最远）的空位集合中随机选一个；无空位返回 null。 */
function findRetreatCell(defender, attacker) {
  const candidates = hexNeighbors(defender.col, defender.row)
    .filter(([c, r]) => !unitAt(c, r))
    .map(([c, r]) => ({ col: c, row: r }));
  if (candidates.length === 0) return null;
  // 取离进攻方最远的格子（同等远则随机）
  let maxD = -1;
  for (const cell of candidates) {
    const d = axialDistance(cell.col, cell.row, attacker.col, attacker.row);
    if (d > maxD) maxD = d;
  }
  const farthest = candidates.filter(
    (cell) => axialDistance(cell.col, cell.row, attacker.col, attacker.row) === maxD
  );
  return farthest[Math.floor(Math.random() * farthest.length)];
}

/** 移除单位（被消灭）。 */
function removeUnit(unit) {
  game.units = game.units.filter((u) => u.id !== unit.id);
}

/**
 * 购买并部署单位（规则：购买的单位只能在【己方城市】里面部署）。
 * @param {string} side 阵营
 * @param {string} type 单位类型
 * @param {object} city 城市对象
 * @returns {{ ok: boolean, reason?: string, unit?: object }}
 */
function purchaseUnit(side, type, city) {
  const stats = UNIT_STATS[type];
  if (!stats) return { ok: false, reason: "未知单位类型" };
  if (city.owner !== side) return { ok: false, reason: "这不是你的城市" };
  if (unitAt(city.x, city.y)) return { ok: false, reason: "该城市已被单位占用" };
  if (game.gold[side] < stats.cost) return { ok: false, reason: `资金不足（需要 ${stats.cost}）` };
  game.gold[side] -= stats.cost;
  const unit = {
    id: `u${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    side,
    col: city.x,
    row: city.y,
    movePoints: stats.movePoints,
    confused: false,
    attacked: false,
    deployed: true, // 刚部署：本回合不能行动，下个己方回合开始解除
  };
  game.units.push(unit);
  return { ok: true, unit };
}

/**
 * 执行战斗（应用结果到游戏状态）。
 * 攻击 = 用行动力"移动到敌方地块"（消耗行进 cost）；
 * 消灭/击退时进攻方进驻该格（炮兵不前进）；失败/混乱时进攻方留在原地。
 * @returns {{ result, messages: string[] }}
 */
function applyCombat(attacker, defender, dice) {
  // 1) 攻击消耗行动力（到达敌方格所需的行进消耗）
  const cost = game.attackTargets[key(defender.col, defender.row)]?.cost ?? 0;
  attacker.movePoints = Math.max(0, +(attacker.movePoints - cost).toFixed(3));

  const result = resolveCombat(attacker, defender, dice);
  const messages = [];
  const canAdvance = attacker.type !== UNIT_TYPE.ARTILLERY; // 炮兵不前进

  if (result.type === "attacker-confused") {
    attacker.confused = true;
    messages.push(`进攻方 ${UNIT_STATS[attacker.type].name} 攻击力比防御低 ${-result.diff} 点（≥3），进攻被压制陷入混乱！`);
  } else if (result.type === "miss") {
    messages.push(`进攻未造成效果（${result.atk} vs ${result.def}）`);
  } else if (result.type === "retreat") {
    const defendCol = defender.col;
    const defendRow = defender.row;
    const cell = findRetreatCell(defender, attacker);
    if (cell) {
      // 防守方成功撤退 → 进攻方进驻防守方原格（炮兵不前进）；被击退单位陷入混乱（溃退）
      defender.col = cell.col;
      defender.row = cell.row;
      defender.confused = true;
      messages.push(`防守方被击退至 (${cell.col},${cell.row})，陷入混乱！（${result.atk} vs ${result.def}）`);
      if (canAdvance) {
        attacker.col = defendCol;
        attacker.row = defendRow;
        const city = cityAt(defendCol, defendRow);
        if (city) {
          city.owner = attacker.side;
          game.cityChanged = true; // 通知 UI 刷新预估收入
          game.captureEvents.push({ side: attacker.side, cityName: city.name, via: "combat" });
          messages.push(`城市「${city.name}」被占领！`);
        }
      }
    } else {
      // 防守方无路可退 → 混乱并留在原地；进攻方【不前进】（避免单位重叠）
      defender.confused = true;
      messages.push(`防守方无路可退，陷入混乱！（${result.atk} vs ${result.def}）`);
    }
  } else if (result.type === "kill") {
    const city = cityAt(defender.col, defender.row);
    if (canAdvance) {
      // 普通单位：消灭并进驻（进驻城市才算占领）
      attacker.col = defender.col;
      attacker.row = defender.row;
      if (city) {
        city.owner = attacker.side;
        game.cityChanged = true;
        game.captureEvents.push({ side: attacker.side, cityName: city.name, via: "combat" });
        messages.push(`城市「${city.name}」被占领！`);
      }
      messages.push(`防守方被消灭，${UNIT_STATS[attacker.type].name} 进驻该地`);
    } else {
      // 炮兵：只消灭不前进、不占领
      messages.push(`防守方被消灭（炮兵不前进）`);
      if (city) messages.push(`炮兵消灭了「${city.name}」守军，但未占领该城`);
    }
    removeUnit(defender);
  }

  // 攻击标记：一回合只能攻击一次（任何类型）；普通单位攻击后行动力归零（不能再移动），坦克保留
  attacker.attacked = true;
  if (attacker.type !== UNIT_TYPE.TANK) attacker.movePoints = 0;

  return { result, messages };
}

/**
 * 结束回合：当前方回合结束（清除其"已攻击"标记）→ 切换回合方 → 新回合方开始。
 * 混乱规则（用户澄清）：混乱持续到"对方结束回合"才算一回合，
 * 即混乱单位在自己【下个回合开始】时才恢复；对方回合中保持混乱（防御-2 仍生效）。
 */
function endTurn() {
  // 当前方回合结束：清除该方所有单位的"已攻击"标记
  for (const u of game.units) {
    if (u.side === game.currentSide) u.attacked = false;
  }
  // 切换回合方
  game.currentSide = game.currentSide === SIDE.FR ? SIDE.DE : SIDE.FR;
  game.turn += 1; // 回合计数（战斗日志显示用）
  // 新回合方开始：清除该方的混乱（混乱在对方整个回合持续）与"刚部署"标记
  for (const u of game.units) {
    if (u.side === game.currentSide) {
      u.confused = false;
      u.deployed = false; // 上回合部署的单位，这回合可以行动了
    }
  }
  resetMovePoints(game.units);
  selectUnit(null);
  // 回合开始结算收入：新回合方获得其城市总收入（占领地按 12/7/3）
  game.gold[game.currentSide] += sideIncome(game.currentSide);
  // 困难难度：AI 每回合额外 +10 收入
  if (game.mode === "pve" && game.aiDifficulty === "hard" && game.aiSide === game.currentSide) {
    game.gold[game.currentSide] += 10;
  }
  game.deployType = null; // 回合切换时退出部署模式
}

/** 胜负判定：某方占领全部城市即获胜。返回获胜方（fr/de）或 null。 */
function checkVictory() {
  const total = MAP.cities.length;
  const fr = MAP.cities.filter((c) => c.owner === SIDE.FR).length;
  if (fr === total) return SIDE.FR;
  const de = MAP.cities.filter((c) => c.owner === SIDE.DE).length;
  if (de === total) return SIDE.DE;
  return null;
}

// 暴露到全局
window.game = game;
window.hexNeighbors = hexNeighbors;
window.terrainCost = terrainCost;
window.isRiverEdge = isRiverEdge;
window.stepCost = stepCost;
window.computeReachable = computeReachable;
window.computeAttackTargets = computeAttackTargets;
window.moveUnit = moveUnit;
window.tickAnimation = tickAnimation;
window.selectUnit = selectUnit;
window.resolveCombat = resolveCombat;
window.applyCombat = applyCombat;
window.purchaseUnit = purchaseUnit;
window.checkVictory = checkVictory;
window.axialDistance = axialDistance;
window.endTurn = endTurn;
window.unitAt = unitAt;
window.cityAt = cityAt;
