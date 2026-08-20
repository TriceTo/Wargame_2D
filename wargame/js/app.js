/**
 * 一战兵棋推演 —— 入口与交互（阶段 4：移动系统）
 *
 *  - 画布自适应、滚轮缩放、拖拽平移、双击复位
 *  - 点击己方单位 → 选中并高亮可达格（行动力）
 *  - 点击高亮格 → 移动单位（扣行动力，可继续移动）
 *  - 点击其他 → 取消选中
 *  - 结束回合 → 切换回合方、重置行动力
 */

(function () {
  "use strict";

  const canvas = document.getElementById("mapCanvas");
  const ctx = canvas.getContext("2d");

  // ── 游戏初始化 ──
  game.units = createInitialUnits();
  updateTurnUI();

  // ── 画布尺寸适配 ──
  function resizeCanvas() {
    const stage = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(320, stage.clientWidth - 40);
    const h = Math.max(240, stage.clientHeight - 40);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!viewport.initialized) {
      viewport.initialized = true;
      const mapW = MAP.cols * HEX_W + HEX_W / 2;
      const mapH = MAP.rows * HEX_H + HEX_R / 2;
      const fitScale = Math.min(w / mapW, h / mapH);
      viewport.scale = Math.min(1.5, fitScale);
      viewport.ox = (w / viewport.scale / HEX_W - MAP.cols) / 2;
      viewport.oy = (h / viewport.scale / HEX_H - MAP.rows) / 2 - 0.5;
    }
    render();
  }

  function render() {
    renderMap(ctx, canvas);
  }

  // ── 点击拾取：像素坐标 → 最近的 hex 格坐标 ──
  function pickHex(px, py) {
    const { gx, gy } = screenToGrid(px, py);
    let best = null;
    let bestDist = Infinity;
    for (let r = Math.max(0, Math.floor(gy) - 1); r <= Math.min(MAP.rows - 1, Math.ceil(gy) + 1); r++) {
      for (let c = Math.max(0, Math.floor(gx) - 1); c <= Math.min(MAP.cols - 1, Math.ceil(gx) + 1); c++) {
        const center = gridToScreen(c, r);
        const d = (center.x - px) ** 2 + (center.y - py) ** 2;
        if (d < bestDist) { bestDist = d; best = { col: c, row: r }; }
      }
    }
    return best;
  }

  // ── 点击逻辑 ──
  let aiRunning = false; // AI 回合进行中，锁定玩家输入
  function onClick(px, py) {
    if (aiRunning) return; // AI 回合玩家不能操作
    const cell = pickHex(px, py);
    if (!cell) return;
    const occ = unitAt(cell.col, cell.row);
    const selected = game.units.find((u) => u.id === game.selectedId) || null;

    // 1) 已有选中单位
    if (selected) {
      // 1a) 点击可达格 → 移动到目标格（沿路径动画；走的过程中每经过一格会刷新高亮）
      const keyStr = cell.col + "," + cell.row;
      if (game.reachable[keyStr]) {
        if (selected.col === cell.col && selected.row === cell.row) return; // 点自己=原地
        const ok = moveUnit(selected, cell.col, cell.row);
        if (ok) {
          // 动画推进由 rAF 循环驱动；每走完一格 tickAnimation 会刷新高亮
          render();
          return;
        }
      }
      // 1b) 点击攻击目标（红色敌方格）→ 掷骰动画 + 结算战斗
      if (game.attackTargets[keyStr]) {
        const defender = unitAt(cell.col, cell.row);
        if (defender && defender.side !== selected.side) {
          doCombat(selected, defender);
          return;
        }
      }
      // 1b) 点击另一个己方单位 → 切换选中
      if (occ && occ.side === game.currentSide) {
        selectUnit(occ.id);
        render();
        return;
      }
      // 1c) 点击其他（空地/敌方/不可达）→ 取消选中
      selectUnit(null);
      render();
      return;
    }

    // 2) 部署模式激活：点击己方城市 → 花钱部署当前兵种
    if (game.deployType) {
      const city = cityAt(cell.col, cell.row);
      if (city && city.owner === game.currentSide) {
        if (occ) {
          showMsg("该城市已被单位占用，无法部署");
          return;
        }
        const res = purchaseUnit(game.currentSide, game.deployType, city);
        if (res.ok) {
          updateGoldUI();
          render();
        } else {
          showMsg(res.reason);
        }
        return;
      }
      // 部署模式下点击非己方城市：保持部署模式，不响应
      return;
    }

    // 3) 无部署模式：点击己方单位 → 选中
    if (occ && occ.side === game.currentSide) {
      selectUnit(occ.id);
      render();
      return;
    }
  }

  // ── 事件：点击 ──
  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    onClick(e.clientX - rect.left, e.clientY - rect.top);
  });

  // ── 事件：滚轮缩放（鼠标锚点）──
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const before = screenToGrid(mx, my);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    viewport.scale = Math.min(4, Math.max(0.3, viewport.scale * factor));
    const after = screenToGrid(mx, my);
    viewport.ox += before.gx - after.gx;
    viewport.oy += before.gy - after.gy;
    render();
  }, { passive: false });

  // ── 事件：拖拽平移 ──
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.classList.add("dragging");
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = (e.clientX - lastX) / HEX_W / viewport.scale;
    const dy = (e.clientY - lastY) / HEX_H / viewport.scale;
    viewport.ox += dx;
    viewport.oy += dy;
    lastX = e.clientX;
    lastY = e.clientY;
    render();
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    canvas.classList.remove("dragging");
  });

  // ── 事件：双击复位 ──
  canvas.addEventListener("dblclick", () => {
    viewport.scale = 1;
    viewport.ox = 0;
    viewport.oy = 0;
    resizeCanvas();
  });

  // ── 战斗流程：掷骰动画（数字跳动→定格）+ 修正显示 + 结果标签 → 结算 ──
  let combatLock = false; // 防重复点击
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand6 = () => 1 + Math.floor(Math.random() * 6);
  const fmtMods = (mods) =>
    mods.map((m) => (m > 0 ? `+${m}` : `${m}`)).join("");
  // 战斗结果中文标签
  const RESULT_LABEL = {
    kill: "成功击杀",
    retreat: "击退",
    "attacker-confused": "进攻失败",
    miss: "平",
  };
  const RESULT_CLASS = {
    kill: "r-kill",
    retreat: "r-retreat",
    "attacker-confused": "r-confused",
    miss: "r-miss",
  };

  async function doCombat(attacker, defender) {
    if (combatLock) return;
    combatLock = true;
    // 预掷骰（跳停的值 = 实际结算值）
    const atkRoll = rand6();
    const defRoll = rand6();

    // 交战红线：连接攻防双方（画布上显示谁在打谁）
    game.combatLine = { from: { col: attacker.col, row: attacker.row }, to: { col: defender.col, row: defender.row } };
    render();

    const panel = document.getElementById("dicePanel");
    const frNum = document.getElementById("diceFr");
    const deNum = document.getElementById("diceDe");
    const frMod = document.getElementById("diceFrMod");
    const deMod = document.getElementById("diceDeMod");
    const resEl = document.getElementById("diceResult");
    if (panel) panel.classList.remove("hidden");
    if (resEl) { resEl.textContent = ""; resEl.className = "dice-result"; }

    // 1) 数字跳动动画（0.8 秒）
    const rollEnd = performance.now() + 800;
    while (performance.now() < rollEnd) {
      if (frNum) frNum.textContent = rand6();
      if (deNum) deNum.textContent = rand6();
      await sleep(60);
    }
    // 2) 定格真实骰子值
    if (frNum) frNum.textContent = atkRoll;
    if (deNum) deNum.textContent = defRoll;

    // 3) 结算（用同一组骰子）
    const { result, messages } = applyCombat(attacker, defender, { atkRoll, defRoll });

    // 4) 显示修正（如 "4 +1-1"：骰子 + 修正明细）与结果标签
    if (frMod) frMod.textContent = fmtMods(result.atkMods);
    if (deMod) deMod.textContent = fmtMods(result.defMods);
    if (resEl) {
      resEl.textContent = RESULT_LABEL[result.type] || "";
      resEl.className = "dice-result " + (RESULT_CLASS[result.type] || "r-miss");
    }

    // 5) 修正与结果展示 1.5 秒后收起面板
    await sleep(1500);
    if (panel) panel.classList.add("hidden");
    if (frMod) frMod.textContent = "";
    if (deMod) deMod.textContent = "";
    if (resEl) resEl.textContent = "";

    // 6) 日志与界面刷新
    game.combatLine = null; // 清除交战红线
    showCombatResult(attacker, defender, result, messages);
    updateTurnUI(); // 城市被占领后收入变化
    selectUnit(attacker.id); // 攻击后重算（普通单位行动力归零无可达；坦克仍可移动）
    render();
    combatLock = false;
  }

  // ── 战斗结果提示（顶部提示条 + 右侧永久日志）──
  /** 追加一条日志到右侧战斗日志面板。 */
  function appendLog(meta, line, typeClass) {
    const body = document.getElementById("battleLogBody");
    if (!body) return;
    const empty = body.querySelector(".battle-log-empty");
    if (empty) empty.remove();
    const entry = document.createElement("div");
    entry.className = "log-entry log-" + (typeClass || "miss");
    const metaEl = document.createElement("div");
    metaEl.className = "log-meta";
    metaEl.textContent = meta;
    const lineEl = document.createElement("div");
    lineEl.className = "log-line";
    lineEl.textContent = line;
    entry.appendChild(metaEl);
    entry.appendChild(lineEl);
    body.appendChild(entry);
    body.scrollTop = body.scrollHeight; // 自动滚到底部
  }

  function showCombatResult(attacker, defender, result, messages) {
    const atkName = UNIT_STATS[attacker.type].name;
    const defName = UNIT_STATS[defender.type].name;
    const sideName = (s) => (s === SIDE.FR ? "法国" : "德国");
    const bonus = (b) => (b > 0 ? `+${b}` : b < 0 ? `${b}` : "");
    const line =
      `【${RESULT_LABEL[result.type] || ""}】` +
      ` ${sideName(attacker.side)}${atkName} 攻击 ${result.atkRoll}${bonus(result.atkBonus)} = ${result.atk}` +
      `  VS  ${sideName(defender.side)}${defName} 防御 ${result.defRoll}${bonus(result.defBonus)} = ${result.def}` +
      `  →  ${messages.join(" ")}`;

    // 1) 顶部提示条（短暂显示）
    const log = document.getElementById("combatLog");
    if (log) {
      log.textContent = line;
      log.classList.add("show");
      clearTimeout(log._t);
      log._t = setTimeout(() => log.classList.remove("show"), 6000);
    }

    // 2) 右侧战斗日志（永久保留，按结果类型着色）
    const typeClass = result.type === "attacker-confused" ? "confused" : result.type;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    appendLog(`回合 ${game.turn} · ${sideName(attacker.side)}进攻 · ${time}`, line, typeClass);
  }

  // 清空战斗日志
  const clearBtn = document.getElementById("clearLogBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      const body = document.getElementById("battleLogBody");
      if (!body) return;
      body.innerHTML = '<div class="battle-log-empty">暂无战斗记录</div>';
    });
  }

  // ── 资金显示（左上法国 / 右上德国：当前资金 + 预估收入）──
  /** 一方每回合实际可得收入（困难难度 AI 方额外 +10）。 */
  function effectiveIncome(side) {
    let inc = sideIncome(side);
    if (game.mode === "pve" && game.aiDifficulty === "hard" && game.aiSide === side) inc += 10;
    return inc;
  }
  function updateGoldUI() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("goldFr", game.gold.fr);
    set("goldDe", game.gold.de);
    set("incomeFr", "+" + effectiveIncome(SIDE.FR));
    set("incomeDe", "+" + effectiveIncome(SIDE.DE));
  }

  // 兵种介绍：动态填充行动力 / 造价（与 UNIT_STATS 同步）
  document.querySelectorAll(".ug-stat i[data-type]").forEach((el) => {
    const type = el.dataset.type;
    const stats = UNIT_STATS[type];
    if (el.dataset.cost !== undefined) el.textContent = stats.cost;
    else el.textContent = stats.movePoints;
  });
  // 兵种介绍图标：用与棋盘棋子一致的 Canvas 图案（钢盔/火炮/坦克）
  document.querySelectorAll(".ug-icon[data-type]").forEach((canvas) => {
    const ctx2 = canvas.getContext("2d");
    const type = canvas.dataset.type;
    drawUnitIcon(ctx2, type, canvas.width / 2, canvas.height / 2, canvas.width * 0.42);
  });

  // ── 部署模式（点击图标选兵种 → 城市黄色条纹高亮 → 点击城市部署）──
  const deployBtns = document.querySelectorAll(".deploy-btn");
  // 价格动态从 UNIT_STATS 读取（避免与 HTML 硬编码不同步）
  deployBtns.forEach((b) => {
    const cost = UNIT_STATS[b.dataset.type].cost;
    const price = b.querySelector("i");
    if (price) price.textContent = cost;
    b.title = `${UNIT_STATS[b.dataset.type].name} 造价 ${cost}`;
  });
  function setDeployType(type) {
    game.deployType = game.deployType === type ? null : type; // 再次点击取消
    deployBtns.forEach((b) => b.classList.toggle("active", b.dataset.type === game.deployType));
    render();
  }
  deployBtns.forEach((b) => b.addEventListener("click", () => setDeployType(b.dataset.type)));

  // 通用提示（复用顶部提示条）
  function showMsg(text) {
    const log = document.getElementById("combatLog");
    if (!log) return;
    log.textContent = text;
    log.classList.add("show");
    clearTimeout(log._t);
    log._t = setTimeout(() => log.classList.remove("show"), 4000);
  }

  // ── AI 回合（pve 模式，AI 自动部署/移动/攻击）──
  const aiSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitAnimDone = (unit) =>
    new Promise((resolve) => {
      const check = () => {
        if (!unit.anim) resolve();
        else setTimeout(check, 40);
      };
      check();
    });

  /** 某格到指定阵营（单位/城市）的最近六边形距离。 */
  function minDistToSide(col, row, side) {
    let md = Infinity;
    for (const u of game.units) {
      if (u.side === side) md = Math.min(md, axialDistance(col, row, u.col, u.row));
    }
    for (const c of MAP.cities) {
      if (c.owner === side) md = Math.min(md, axialDistance(col, row, c.x, c.y));
    }
    return md;
  }

  /** 某格 range 距离内是否有敌方单位。 */
  function hasEnemyWithin(col, row, enemySide, range) {
    return game.units.some(
      (u) => u.side === enemySide && axialDistance(col, row, u.col, u.row) <= range
    );
  }

  /**
   * AI 城市评估（正常/困难难度）。
   * 城市权重：1级 10 / 2级 20 / 3级 30。
   *  - level 3「受威胁」：4 格内有敌方坦克，或 2 格内有敌方炮兵/步兵，或 4 格内 ≥3 敌人 → 回防
   *  - level 2「危险」  ：4 格内无敌人，但 5 格内有敌人 → 需要蹲守
   *  - level 1「安全」
   */
  function assessCities() {
    const side = game.aiSide;
    const enemy = side === SIDE.FR ? SIDE.DE : SIDE.FR;
    return MAP.cities
      .filter((c) => c.owner === side)
      .map((c) => {
        let e2 = 0, e4 = 0, e5 = 0;
        let hasTank4 = false, hasArtInf2 = false;
        for (const u of game.units) {
          if (u.side !== enemy) continue;
          const d = axialDistance(c.x, c.y, u.col, u.row);
          if (d <= 2) {
            e2++;
            if (u.type === UNIT_TYPE.ARTILLERY || u.type === UNIT_TYPE.INFANTRY) hasArtInf2 = true;
          }
          if (d <= 4) {
            e4++;
            if (u.type === UNIT_TYPE.TANK) hasTank4 = true;
          }
          if (d <= 5) e5++;
        }
        let level = 1;
        if (hasTank4 || hasArtInf2 || e4 >= 3) level = 3;      // 受威胁
        else if (e4 === 0 && e5 > 0) level = 2;                // 危险
        return { city: c, level, e2, e4, e5 };
      });
  }

  /** 可达格中离"目标城市集合"最近的一格；preferEnter=true 时空城可达则直接进入蹲守。 */
  function bestCellTowardCities(u, cityStates, preferEnter) {
    if (preferEnter) {
      for (const s of cityStates) {
        const k = s.city.x + "," + s.city.y;
        if (game.reachable[k]) return { col: s.city.x, row: s.city.y }; // 进城蹲守
      }
    }
    let best = null;
    let bestD = Infinity;
    for (const k of Object.keys(game.reachable)) {
      const [c, r] = k.split(",").map(Number);
      let md = Infinity;
      for (const s of cityStates) md = Math.min(md, axialDistance(c, r, s.city.x, s.city.y));
      if (md < bestD) { bestD = md; best = { col: c, row: r }; }
    }
    return best;
  }

  /** 走向离玩家最近的格（反攻/普通模式前进）。 */
  function bestCellTowardEnemy(u, enemy) {
    let best = null;
    let bestD = Infinity;
    for (const k of Object.keys(game.reachable)) {
      const [c, r] = k.split(",").map(Number);
      const d = minDistToSide(c, r, enemy);
      if (d < bestD) { bestD = d; best = { col: c, row: r }; }
    }
    return best;
  }

  /** 低优先级移动：向玩家推进，优先占领城市（能进的敌方空城直接进，否则朝最近敌方城市走）。 */
  function bestCellForConquest(u, enemy) {
    let best = null;
    let bestD = Infinity;
    for (const k of Object.keys(game.reachable)) {
      const [c, r] = k.split(",").map(Number);
      const city = cityAt(c, r);
      if (city && city.owner === enemy && !unitAt(c, r)) {
        return { col: c, row: r }; // 敌方空城：直接进驻占领
      }
      // 到最近敌方城市的距离
      let md = Infinity;
      for (const cc of MAP.cities) {
        if (cc.owner === enemy) md = Math.min(md, axialDistance(c, r, cc.x, cc.y));
      }
      if (md < bestD) { bestD = md; best = { col: c, row: r }; }
    }
    if (best) return best;
    return bestCellTowardEnemy(u, enemy); // 兜底：走向玩家
  }

  /** 1) AI 移动（正常/困难，按优先级）：
   *  高：受威胁城市 → 移动回防（附近单位向该城集结）
   *  中：危险城市 → 单位进城蹲守
   *  低：向玩家推进、优先占领城市
   *  普通难度：所有单位走向玩家（原逻辑）。
   */
  async function aiMoveUnits() {
    const smart = game.aiDifficulty !== "normal";
    const side = game.aiSide;
    const enemy = side === SIDE.FR ? SIDE.DE : SIDE.FR;
    const states = assessCities();
    const threatened = states.filter((s) => s.level === 3);
    const dangerous = states.filter((s) => s.level === 2);
    for (const u of game.units) {
      if (u.side !== side) continue;
      if (u.confused || u.deployed || u.attacked) continue;
      selectUnit(u.id);
      let bestCell = null;
      if (smart) {
        // 被贴脸且打不了 → 先撤离
        const underThreat = hexNeighbors(u.col, u.row).some(([c, r]) => {
          const occ = unitAt(c, r);
          return occ && occ.side === enemy;
        });
        if (underThreat && Object.keys(game.attackTargets).length === 0) {
          let bestD = -Infinity;
          for (const k of Object.keys(game.reachable)) {
            const [c, r] = k.split(",").map(Number);
            const d = minDistToSide(c, r, enemy);
            if (d > bestD) { bestD = d; bestCell = { col: c, row: r }; }
          }
        } else if (threatened.length > 0) {
          // 高：向受威胁城市回防
          bestCell = bestCellTowardCities(u, threatened, false);
        } else if (dangerous.length > 0) {
          // 中：危险城市蹲守（空城可达则进）
          bestCell = bestCellTowardCities(u, dangerous, true);
        } else {
          // 低：向玩家推进、优先占领城市
          bestCell = bestCellForConquest(u, enemy);
        }
      } else {
        // 普通：一直走向玩家
        bestCell = bestCellTowardEnemy(u, enemy);
      }
      if (bestCell) {
        moveUnit(u, bestCell.col, bestCell.row);
        render();
        await waitAnimDone(u);
        await aiSleep(160);
      }
    }
    selectUnit(null);
  }

  /** 部署城市选择：优先级 高=受威胁城 / 中=危险城 / 低=离玩家最近。 */
  function pickAICity(side, states) {
    const enemy = side === SIDE.FR ? SIDE.DE : SIDE.FR;
    const pick = (list) => {
      let best = null;
      let bestD = Infinity;
      for (const s of list) {
        if (unitAt(s.city.x, s.city.y)) continue; // 只选空城
        const d = minDistToSide(s.city.x, s.city.y, enemy);
        if (d < bestD) { bestD = d; best = s.city; }
      }
      return best;
    };
    const threatened = states.filter((s) => s.level === 3);
    const dangerous = states.filter((s) => s.level === 2);
    return pick(threatened) || pick(dangerous) || pick(states);
  }

  /** 2) AI 部署：高=受威胁城市先补步兵防守；中=危险城市；低=最近城（平时买最强兵种）。 */
  async function aiPurchase() {
    const side = game.aiSide;
    const states = assessCities();
    const threatened = states.filter((s) => s.level === 3);
    let guard = 0;
    while (guard++ < 30) {
      // 兵种：有受威胁城市 → 优先部署步兵来防；否则买得起的最强
      let type = null;
      if (threatened.length > 0) {
        if (game.gold[side] >= UNIT_STATS.infantry.cost) type = UNIT_TYPE.INFANTRY;
        else break;
      } else {
        if (game.gold[side] >= UNIT_STATS.tank.cost) type = UNIT_TYPE.TANK;
        else if (game.gold[side] >= UNIT_STATS.artillery.cost) type = UNIT_TYPE.ARTILLERY;
        else if (game.gold[side] >= UNIT_STATS.infantry.cost) type = UNIT_TYPE.INFANTRY;
        else break;
      }
      const city = pickAICity(side, states);
      if (!city) break;
      const res = purchaseUnit(side, type, city);
      if (!res.ok) break;
      updateGoldUI();
      render();
      await aiSleep(320);
    }
  }

  /** 3) AI 攻击：普通=优先城市守军；正常/困难=选预期最可能击杀的目标。 */
  async function aiAttack() {
    const side = game.aiSide;
    const enemy = side === SIDE.FR ? SIDE.DE : SIDE.FR;
    const smart = game.aiDifficulty !== "normal";
    for (const u of game.units) {
      if (u.side !== side) continue;
      if (u.confused || u.deployed || u.attacked) continue;
      selectUnit(u.id);
      const keys = Object.keys(game.attackTargets);
      if (keys.length === 0) continue;
      // 选目标
      let targetKey = keys[0];
      if (smart) {
        // 用期望骰子 3.5 估算每个目标的预期差值，选最可能击杀的
        let bestDiff = -Infinity;
        for (const k of keys) {
          const [c, r] = k.split(",").map(Number);
          const occ = unitAt(c, r);
          if (!occ) continue;
          const probe = resolveCombat(u, occ, { atkRoll: 3.5, defRoll: 3.5 });
          if (probe.diff > bestDiff) { bestDiff = probe.diff; targetKey = k; }
        }
      } else {
        // 普通：优先玩家城市守军
        for (const k of keys) {
          const [c, r] = k.split(",").map(Number);
          const occ = unitAt(c, r);
          if (occ && occ.side === enemy && cityAt(c, r)) { targetKey = k; break; }
        }
      }
      const [tc, tr] = targetKey.split(",").map(Number);
      const defender = unitAt(tc, tr);
      if (defender) await doCombat(u, defender); // 复用掷骰动画 + 结算
      await aiSleep(200);
    }
    selectUnit(null);
  }

  /** AI 整回合：移动 → 部署 → 攻击 → 结束回合。 */
  async function runAITurn() {
    if (aiRunning) return;
    aiRunning = true;
    selectUnit(null);
    updateTurnUI();
    await aiSleep(700); // "思考"
    await aiMoveUnits();
    await aiPurchase();
    await aiAttack();
    await aiSleep(500);
    aiRunning = false;
    endTurn(); // 切回玩家
    updateTurnUI();
    render();
  }

  // ── 回合 UI ──
  function updateTurnUI() {
    const label = document.getElementById("turnLabel");
    const btn = document.getElementById("endTurnBtn");
    const income = document.getElementById("incomeLabel");
    const modeLabel = document.getElementById("modeLabel");
    const sideName = (s) => (s === SIDE.FR ? "法国" : "德国");
    if (modeLabel) {
      if (game.mode === "pve") {
        const human = game.aiSide === SIDE.FR ? SIDE.DE : SIDE.FR;
        const diffName = { normal: "普通", smart: "正常", hard: "困难" }[game.aiDifficulty] || "普通";
        modeLabel.textContent = `对战 AI · 你用${sideName(human)} · ${diffName}`;
      } else {
        modeLabel.textContent = "双人对战";
      }
    }
    if (label) {
      const isAI = game.mode === "pve" && game.aiSide === game.currentSide;
      const fr = game.currentSide === SIDE.FR;
      label.textContent = (isAI ? "🤖 " : "") + (fr ? "当前回合：法国（蓝）" : "当前回合：德国（红）");
      label.style.color = fr ? "#7ea3ff" : "#ff9a8a";
    }
    if (btn) btn.disabled = game.mode === "pve" && game.aiSide === game.currentSide; // AI 回合禁用结束按钮
    if (income) {
      income.textContent =
        `收入：法国 ${effectiveIncome(SIDE.FR)} / 德国 ${effectiveIncome(SIDE.DE)}`;
    }
    updateGoldUI();
  }

  // 结束回合按钮
  const endBtn = document.getElementById("endTurnBtn");
  if (endBtn) {
    endBtn.addEventListener("click", () => {
      endTurn();
      updateTurnUI();
      // 回合切换退出部署模式，按钮复位
      deployBtns.forEach((b) => b.classList.remove("active"));
      render();
      // pve：轮到 AI 则自动执行 AI 回合
      if (game.mode === "pve" && game.aiSide === game.currentSide) runAITurn();
    });
  }

  // ── 模态：开屏规则提示 / 规则 / 详细设定 ──
  const overlay = document.getElementById("modalOverlay");
  const modalTitle = document.getElementById("modalTitle");
  const modalBody = document.getElementById("modalBody");
  const modalOk = document.getElementById("modalOk");
  const modalClose = document.getElementById("modalClose");
  const modalPick = document.getElementById("modalPick");

  function openModal(key, okLabel, showPick) {
    const content = HELP_CONTENT[key];
    if (!content) return;
    if (modalTitle) modalTitle.textContent = content.title;
    if (modalBody) modalBody.innerHTML = content.html;
    if (modalOk) modalOk.textContent = okLabel || "关闭";
    if (modalPick) modalPick.classList.toggle("hidden", !showPick);
    if (overlay) overlay.classList.remove("hidden");
  }
  function closeModal() {
    if (overlay) overlay.classList.add("hidden");
  }
  // 模式选择：选"对战AI"时显示阵营/难度选择；难度说明联动
  const DIFF_DESC = {
    normal: "普通：只会朝你走、能打就打（简单贪心）",
    smart: "正常：攻击选最可能击杀的目标，被贴脸会撤退",
    hard: "困难：同正常 + 每回合额外 +10 收入",
  };
  const modeRadios = document.querySelectorAll('input[name="mode"]');
  const sidePick = document.getElementById("pickSide");
  const diffPick = document.getElementById("pickDiff");
  const diffDescPick = document.getElementById("pickDiffDesc");
  const diffDescText = document.getElementById("diffDescText");
  document.querySelectorAll('input[name="diff"]').forEach((r) =>
    r.addEventListener("change", () => {
      if (diffDescText) diffDescText.textContent = DIFF_DESC[r.value] || "";
    })
  );
  modeRadios.forEach((r) =>
    r.addEventListener("change", () => {
      const isPve = r.value === "pve";
      if (sidePick) sidePick.classList.toggle("hidden", !isPve);
      if (diffPick) diffPick.classList.toggle("hidden", !isPve);
      if (diffDescPick) diffDescPick.classList.toggle("hidden", !isPve);
    })
  );
  // "开始游戏"：读取模式设置，关闭开屏
  let starting = true; // 当前是否为开屏（决定是否应用模式选择）
  if (modalOk) {
    modalOk.addEventListener("click", () => {
      if (starting) {
        starting = false;
        const mode = document.querySelector('input[name="mode"]:checked')?.value || "pvp";
        const side = document.querySelector('input[name="side"]:checked')?.value || "fr";
        const diff = document.querySelector('input[name="diff"]:checked')?.value || "normal";
        game.mode = mode;
        game.aiDifficulty = diff;
        if (mode === "pve") {
          game.aiSide = side === SIDE.FR ? SIDE.DE : SIDE.FR; // AI 控制另一方
        }
        updateTurnUI();
        render();
        // 若 AI 是先手（玩家用德国）→ 开局即 AI 回合
        if (game.mode === "pve" && game.aiSide === game.currentSide) runAITurn();
      }
      closeModal();
    });
  }
  if (modalClose) modalClose.addEventListener("click", closeModal);
  // 左下角"规则"、右下角"详细设定"按钮
  const ruleBtn = document.getElementById("ruleBtn");
  if (ruleBtn) ruleBtn.addEventListener("click", () => openModal("rules", "关闭", false));
  const detailBtn = document.getElementById("detailBtn");
  if (detailBtn) detailBtn.addEventListener("click", () => openModal("detail", "关闭", false));
  // 开屏：显示规则提示 + 模式选择
  openModal("rules", "开始游戏", true);

  // ── 启动 ──
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  updateGoldUI();

  // ── 胜利判定与界面 ──
  function checkAndShowVictory() {
    const winner = checkVictory();
    if (!winner) return;
    const overlay = document.getElementById("victoryOverlay");
    const title = document.getElementById("victoryTitle");
    const badge = document.getElementById("victoryBadge");
    if (winner === SIDE.FR) {
      if (title) title.textContent = "法国获胜！";
      if (badge) badge.textContent = "🏆";
    } else {
      if (title) title.textContent = "德国获胜！";
      if (badge) badge.textContent = "🏆";
    }
    if (overlay) overlay.classList.remove("hidden");
  }
  const restartBtn = document.getElementById("victoryRestart");
  if (restartBtn) restartBtn.addEventListener("click", () => window.location.reload());

  // ── 动画循环：推进移动动画；消费占领事件（写日志/胜利判定）；城市归属变化刷新收入 ──
  let lastFrame = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    if (tickAnimation(dt)) render();
    // 城市被移动进驻（动画落位）等场景归属变化 → 刷新资金/预估收入显示
    if (game.cityChanged) {
      game.cityChanged = false;
      updateGoldUI();
      updateTurnUI();
    }
    // 消费占领事件：移动进驻写日志 + 胜负判定
    if (game.captureEvents.length > 0) {
      const events = game.captureEvents;
      game.captureEvents = [];
      for (const ev of events) {
        if (ev.via === "move") {
          const sideName = (s) => (s === SIDE.FR ? "法国" : "德国");
          const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
          appendLog(`回合 ${game.turn} · 占领 · ${time}`,
            `${sideName(ev.side)}部队进驻「${ev.cityName}」，城市被占领！`, "kill");
        }
      }
      checkAndShowVictory();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
