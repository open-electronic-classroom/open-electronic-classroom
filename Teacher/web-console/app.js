(() => {
  /* ---------------- 数据 ---------------- */
  let MACHINES = [
    { id: "PC-01", ip: "192.168.10.11", row: "A", state: "online", task: "第二套 · 循环结构", submitted: false },
    { id: "PC-02", ip: "192.168.10.12", row: "A", state: "submitted", task: "第二套 · 循环结构", submitted: true },
    { id: "PC-03", ip: "192.168.10.13", row: "A", state: "locked" },
    { id: "PC-04", ip: "192.168.10.14", row: "A", state: "alert", alert: "检测到非教学程序：game.exe" },
    { id: "PC-05", ip: "192.168.10.15", row: "A", state: "online" },
    { id: "PC-06", ip: "192.168.10.16", row: "A", state: "offline" },
    { id: "PC-07", ip: "192.168.10.17", row: "B", state: "online", task: "第二套 · 循环结构", submitted: false },
    { id: "PC-08", ip: "192.168.10.18", row: "B", state: "online" },
    { id: "PC-09", ip: "192.168.10.19", row: "B", state: "submitted", task: "第二套 · 循环结构", submitted: true },
    { id: "PC-10", ip: "192.168.10.20", row: "B", state: "alert", alert: "检测到非教学程序：minigame.exe" },
    { id: "PC-11", ip: "192.168.10.21", row: "B", state: "online" },
    { id: "PC-12", ip: "192.168.10.22", row: "B", state: "offline" }
  ];

  const STATE_LABEL = {
    online: "在线",
    locked: "已锁定",
    alert: "异常",
    submitted: "已提交",
    offline: "离线"
  };

  const STATE_TONE = {
    online: "ok",
    locked: "lock",
    alert: "warn",
    submitted: "submit",
    offline: "off"
  };

  const VIEW_TITLE = { groups: "分组管理", wall: "监看墙", list: "机器列表", board: "白板" };

  const state = {
    view: "wall",
    row: "",
    machineState: "",
    query: "",
    columns: 0,
    casting: false,
    media: false,
    board: false,
    blank: false,
    source: "teacher",
    sites: ["edu.cn", "python.org", "code.org", "khanacademy.org"],
    presets: [
      { name: "教学白名单", mode: "whitelist", sites: ["edu.cn", "python.org", "code.org", "khanacademy.org"] },
      { name: "课间黑名单", mode: "blacklist", sites: ["game.example.com", "tiktok.com"] }
    ],
    policy: { usb: false, blockNet: false, block: true, mode: "whitelist", preset: "教学白名单", log: false, procs: { mode: "block", list: ["game.exe"] } },
    locked: false,
    groups: ["A", "B"],
    strokes: [],
    collapsed: new Set(),
    brush: { color: "#0f172a", width: 4, eraser: false },
    lockMessage: "上课中，请勿操作",
    settings: { defaultSource: "整个屏幕", columns: "自动" },
    selected: new Set(["PC-01"]),
    log: []
  };

  /* ---------------- DOM ---------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const stageBody = $("#stageBody");
  const stageTitle = $("#stageTitle");
  const visibleCount = $("#visibleCount");
  const selChips = $("#selChips");
  const selCount = $("#selCount");
  const logList = $("#logList");
  const toasts = $("#toasts");
  const taskDialog = $("#taskDialog");
  const policyDialog = $("#policyDialog");
  const settingsDialog = $("#settingsDialog");
  const remoteDialog = $("#remoteDialog");
  const termDialog = $("#terminalDialog");
  const mediaDialog = $("#mediaDialog");
  const confirmDialog = $("#confirmDialog");
  const renameDialog = $("#renameDialog");
  const groupDialog = $("#groupDialog");
  const noticeDialog = $("#noticeDialog");

  /* ---------------- 后端接口 ----------------
     以 http(s) 打开时走后端（Python server），直接双击本地文件时自动退化为纯前端演示。 */
  const API = {
    online: location.protocol === "http:" || location.protocol === "https:",
    base: "/api",
    async init() {
      if (!this.online) return false;
      try {
        const res = await fetch(`${this.base}/state`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        applyServerState(data.state);
        this.listen();
        return true;
      } catch (err) {
        this.online = false;
        return false;
      }
    },
    listen() {
      try {
        const source = new EventSource(`${this.base}/events`);
        source.addEventListener("message", (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === "state") applyServerState(message.data);
          } catch (err) {
            /* 忽略无法解析的消息 */
          }
        });
      } catch (err) {
        /* EventSource 不可用则保持本地模式 */
      }
    },
    async send(action, machines, payload) {
      if (!this.online) return false;
      try {
        const res = await fetch(`${this.base}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, machines, payload })
        });
        if (!res.ok) return false;
        const data = await res.json();
        if (data.state) applyServerState(data.state);
        return true;
      } catch (err) {
        this.online = false;
        return false;
      }
    }
  };

  // 后端快照 → 界面。服务端是机器、投屏、策略、设置的唯一真相。
  function applyServerState(snapshot) {
    if (!snapshot) return;

    if (Array.isArray(snapshot.machines)) {
      MACHINES = snapshot.machines.map((m) => ({ ...m }));
      const ids = new Set(MACHINES.map((m) => m.id));
      state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
    }

    if (Array.isArray(snapshot.machines)) {
      snapshot.machines.forEach((m) => {
        const previous = alertSeen.get(m.id);
        if (m.state === "alert" && m.alert && m.alert !== previous) {
          alertSeen.set(m.id, m.alert);
          toast(`${m.id} · ${m.alert}`, "error");
        } else if (m.state !== "alert") {
          alertSeen.delete(m.id);
        }
      });
    }

    if (Array.isArray(snapshot.groups)) {
      state.groups = [...snapshot.groups];
    }

    if (snapshot.casting) {
      state.casting = Boolean(snapshot.casting.on);
      if (snapshot.casting.source) state.source = snapshot.casting.source;
    }

    if (snapshot.policy) {
      state.sites = [...(snapshot.policy.sites || [])];
      if (Array.isArray(snapshot.policy.presets)) {
        state.presets = snapshot.policy.presets.map((p) => ({
          name: String(p.name || ""),
          mode: p.mode === "blacklist" ? "blacklist" : "whitelist",
          sites: [...(p.sites || [])]
        }));
      }
      state.policy = {
        usb: Boolean(snapshot.policy.usb),
        blockNet: Boolean(snapshot.policy.blockNet),
        block: Boolean(snapshot.policy.block),
        mode: ["whitelist", "blacklist", "blockall"].includes(snapshot.policy.mode)
          ? snapshot.policy.mode
          : "whitelist",
        preset: snapshot.policy.preset || "",
        log: Boolean(snapshot.policy.log),
        procs: {
          mode: snapshot.policy.procs?.mode === "report" ? "report" : "block",
          list: [...(snapshot.policy.procs?.list || [])]
        }
      };
    }

    // 白板：只有共享中才以服务端为准，否则保留本地画稿
    if (state.board && snapshot.whiteboard && Array.isArray(snapshot.whiteboard.strokes)) {
      state.strokes = snapshot.whiteboard.strokes.map((stroke) => ({
        color: stroke.color,
        width: stroke.width,
        points: stroke.points || []
      }));
      if (state.view === "board") paintBoard();
    }

    if (snapshot.screen_lock) {
      state.locked = Boolean(snapshot.screen_lock.on);
      if (snapshot.screen_lock.message) state.lockMessage = snapshot.screen_lock.message;
    }

    if (snapshot.settings) {
      state.settings = { ...state.settings, ...snapshot.settings };
      state.columns =
        state.settings.columns === "每行 4 台" ? 4 : state.settings.columns === "每行 6 台" ? 6 : 0;
    }

    if (Array.isArray(snapshot.log)) {
      const localOnly = state.log.filter((entry) => entry.local);
      state.log = [...snapshot.log, ...localOnly].slice(0, 80);
    }

    renderLog();
    render();
  }

  // 传给后端的机器集合：范围=选中且确实有选中时给 id 列表，否则空数组表示全部
  function targetIds() {
    // 投屏与批量指令一律面向全部在线机器；单机操作走右键菜单
    return [];
  }

  /* ---------------- 工具 ---------------- */
  const now = () =>
    new Date().toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

  // kind = "info"（自动消失）| "warn"（黄色警告，自动消失）| "error"（红色告警，手动关闭）
  function toast(message, kind = "info") {
    const isError = kind === "error";
    const isWarn = kind === "warn";
    const el = document.createElement("div");
    el.className = `toast${isError ? " is-error" : isWarn ? " is-warn" : ""}`;

    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.textContent = isError ? "!" : isWarn ? "!" : "✓";

    const text = document.createElement("span");
    text.className = "toast-text";
    text.textContent = message;

    el.append(icon, text);

    if (isError) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "toast-close";
      close.setAttribute("aria-label", "关闭");
      close.textContent = "✕";
      close.addEventListener("click", () => dismissToast(el));
      el.appendChild(close);
    }

    toasts.appendChild(el);
    while (toasts.children.length > 4) toasts.firstElementChild.remove();

    if (!isError) window.setTimeout(() => dismissToast(el), 2400);
  }

  function dismissToast(el) {
    if (!el.isConnected) return;
    el.style.transition = "opacity .16s ease, transform .16s ease";
    el.style.opacity = "0";
    el.style.transform = "translateX(24px)";
    window.setTimeout(() => el.remove(), 180);
  }

  function log(action, detail = "", localOnly = false) {
    state.log.unshift({ time: now(), action, detail, local: localOnly });
    if (state.log.length > 80) state.log.pop();
    renderLog();
  }

  function renderLog() {
    logList.innerHTML = "";
    state.log.slice(0, 40).forEach((entry) => {
      const li = document.createElement("li");
      const time = document.createElement("time");
      time.textContent = entry.time;
      const action = document.createElement("b");
      action.textContent = entry.action;
      li.append(time, action);
      if (entry.detail) {
        const detail = document.createElement("span");
        detail.className = "log-detail";
        detail.textContent = entry.detail;
        li.append(detail);
      }
      logList.appendChild(li);
    });
  }

  function openDialog(dialog) {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    window.requestAnimationFrame(syncAllSegThumbs);
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  const byId = (id) => MACHINES.find((m) => m.id === id);
  const stateMatches = (m) => {
    if (!state.machineState) return true;
    if (state.machineState === "online") return m.state === "online";
    return m.state === state.machineState;
  };
  const visibleMachines = () =>
    MACHINES.filter((m) => {
      if (state.row && m.row !== state.row) return false;
      if (!stateMatches(m)) return false;
      if (!state.query) return true;
      return `${m.id} ${m.ip} ${STATE_LABEL[m.state]}`.toLowerCase().includes(state.query);
    });

  const selectedMachines = () => MACHINES.filter((m) => state.selected.has(m.id));

  function targetScope() {
    const online = MACHINES.filter((m) => m.state !== "offline");
    return { machines: online, label: `全部 ${online.length} 台` };
  }

  /* ---------------- 渲染 ---------------- */
  function seatEl(m) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "seat";
    el.dataset.id = m.id;
    el.dataset.state = m.state;
    el.setAttribute("aria-pressed", String(state.selected.has(m.id)));
    el.title = `${m.id} · ${m.ip} · ${STATE_LABEL[m.state]}`;
    if (state.selected.has(m.id)) el.classList.add("is-selected");

    el.innerHTML = `
      <span class="seat-top">
        <i class="led" data-tone="${STATE_TONE[m.state]}"></i>
        <span class="seat-id">${m.id}</span>
        <span class="seat-state">${STATE_LABEL[m.state]}</span>
      </span>
      <span class="seat-user">${m.ip}</span>
      <span class="seat-meta">${m.ip}</span>
    `;
    return el;
  }

  function monEl(m) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "mon";
    el.dataset.id = m.id;
    el.dataset.state = m.state;
    el.setAttribute("aria-pressed", String(state.selected.has(m.id)));
    el.title = `${m.id} · ${m.ip}`;
    if (state.selected.has(m.id)) el.classList.add("is-selected");

    const chip = (() => {
      if (m.state === "alert") {
        return { text: "异常", state: "alert", tip: m.alert || "异常" };
      }
      if (m.task) {
        return m.submitted
          ? { text: "已提交", state: "submitted", tip: `已提交 · ${m.task}` }
          : { text: "未提交", state: "pending", tip: `未提交 · ${m.task}` };
      }
      return { text: STATE_LABEL[m.state], state: m.state, tip: "" };
    })();

    el.innerHTML = `
      <span class="mon-screen">
        <i class="sk sk-1"></i><i class="sk sk-2"></i><i class="sk sk-3"></i>
        <i class="sk sk-4"></i><i class="sk sk-5"></i>
        ${m.label ? `<span class="mon-label-tag"><b>${m.id}</b><span>${m.ip}</span></span>` : ""}
      </span>
      <span class="mon-label">
        <i class="led" data-tone="${STATE_TONE[m.state]}"></i>${m.id}
        <span class="mon-name">${m.ip}</span>
        <span class="mon-chip" data-state="${chip.state}"${chip.tip ? ` data-tip="${chip.tip}"` : ""}>${chip.text}</span>
      </span>
    `;
    return el;
  }

  function render() {
    // 行内编辑已在画面上时不再重建，避免输入框被换掉；首次渲染仍需放行
    if (inlineEdit && stageBody.querySelector("#inlineInput, #inlineGroup")) return;
    const list = visibleMachines();
    stageBody.innerHTML = "";
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "没有匹配的机器";
      stageBody.appendChild(empty);
    } else if (state.view === "groups") renderGroups();
    else if (state.view === "wall") renderWall(list);
    else if (state.view === "board") renderBoardSection();
    else renderList(list);

    stageTitle.textContent = VIEW_TITLE[state.view];
    const isBoard = state.view === "board";
    visibleCount.hidden = isBoard;
    const legend = document.querySelector(".legend");
    if (legend) legend.hidden = isBoard;
    if (!isBoard) visibleCount.textContent = `${list.length} / ${MACHINES.length} 台`;
    renderChrome();
  }

  function renderChrome() {
    const online = MACHINES.filter((m) => m.state !== "offline").length;
    const alert = MACHINES.filter((m) => m.state === "alert").length;
    const offline = MACHINES.length - online;
    const selected = selectedMachines();

    // 组筛选跟着分组列表走
    const rowSeg = $("#rowSeg");
    if (rowSeg) {
      const wanted = ["", ...state.groups];
      // 只比较按钮，忽略滑块本身，否则每次都会重建、滑块被重置回第一个
      const buttons = [...rowSeg.querySelectorAll("button")];
      const current = buttons.map((b) => b.dataset.row);
      if (current.join("|") !== wanted.join("|")) {
        const thumb = rowSeg.querySelector(".seg-thumb");
        rowSeg.innerHTML = wanted
          .map((g) => `<button type="button" data-row="${g}"${state.row === g ? ' class="is-active"' : ""}>${g ? `${g} 组` : "全部"}</button>`)
          .join("");
        if (thumb) rowSeg.insertBefore(thumb, rowSeg.firstChild);
      } else {
        buttons.forEach((b) => b.classList.toggle("is-active", b.dataset.row === state.row));
      }
    }

    $("#sbOnline").textContent = online;
    $("#topOnline").textContent = online;
    window.requestAnimationFrame(syncAllSegThumbs);
    $("#sbAlert").textContent = alert;
    $("#sbOffline").textContent = offline;
    $("#sbSelected").textContent = selected.length;
    $("#sbCast").textContent = state.casting ? "进行中" : "关闭";

    selCount.textContent = `${selected.length} 台`;
    selChips.innerHTML = "";
    if (!selected.length) {
      const empty = document.createElement("span");
      empty.className = "chips-empty";
      empty.textContent = "未选择机器";
      selChips.appendChild(empty);
    } else {
      selected.forEach((m) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = m.id;
        selChips.appendChild(chip);
      });
    }

    const castToggle = $("#castToggle");
    $("#castToggleLabel").textContent = state.casting ? "结束共享" : "屏幕共享";
    castToggle.classList.toggle("is-on", state.casting);
    castToggle.classList.toggle("abtn-primary", !state.casting);

    $("#castState").textContent = state.casting ? `屏幕共享 · ${castSourceLabel()}` : "未共享";
    $("#castLed").hidden = !state.casting;
    $("#policyHint").textContent = `同步至在线 ${online} 台`;

    $("#swUsb").checked = state.policy.usb;
    $("#swOffline").checked = state.policy.blockNet;
    $("#swInternet").checked = state.policy.block;

    const lockBtn = $("#lockToggleBtn");
    lockBtn.textContent = state.locked ? "解除锁屏" : "一键锁屏";
    lockBtn.classList.toggle("is-alert", state.locked);
    // 输入框正在编辑时不要被后端推送覆盖
    const lockInput = $("#lockMessage");
    if (document.activeElement !== lockInput) lockInput.value = state.lockMessage;
    $("#targetLabel").textContent = targetScope().label;
  }
  function renderWall(list) {
    const wall = document.createElement("div");
    wall.className = "wall";

    // 按排分组，组头可折叠
    const groups = new Map();
    list.forEach((m) => {
      const key = m.row || "-";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    });

    [...groups.keys()].sort().forEach((row) => {
      const machines = groups.get(row);
      const collapsed = state.collapsed.has(row);

      const section = document.createElement("section");
      section.className = `group${collapsed ? " is-collapsed" : ""}`;

      const head = document.createElement("button");
      head.type = "button";
      head.className = "group-head";
      head.dataset.group = row;
      head.setAttribute("aria-expanded", String(!collapsed));
      head.innerHTML = `
        <span class="group-caret"></span>
        <span class="group-name">${row === "-" ? "未分组" : `${row} 组`}</span>
        <span class="group-line"></span>
        <span class="group-count">${machines.length} 台</span>
      `;
      section.appendChild(head);

      if (!collapsed) {
        const grid = document.createElement("div");
        grid.className = "group-grid";
        machines.forEach((m) => grid.appendChild(monEl(m)));
        section.appendChild(grid);
      }

      wall.appendChild(section);
    });

    stageBody.appendChild(wall);
  }

  function renderList(list) {
    const table = document.createElement("table");
    table.className = "tbl";
    table.innerHTML = `
      <colgroup>
        <col style="width: 32%"><col style="width: 28%"><col style="width: 22%"><col style="width: 18%">
      </colgroup>
      <thead>
        <tr><th>计算机名称</th><th>IPv4</th><th>状态</th><th>组</th></tr>
      </thead>
      <tbody></tbody>
    `;
    const body = table.querySelector("tbody");
    const pencil = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.4 2.3 13.7 4.6 5.9 12.4 2.6 13.4 3.6 10.1z"></path></svg>';

    list.forEach((m) => {
      const tr = document.createElement("tr");
      tr.dataset.id = m.id;
      tr.dataset.state = m.state;
      if (state.selected.has(m.id)) tr.classList.add("is-selected");

      const editingName = inlineEdit && inlineEdit.id === m.id && inlineEdit.kind === "name";
      const editingGroup = inlineEdit && inlineEdit.id === m.id && inlineEdit.kind === "group";

      const nameCell = editingName
        ? '<input class="inline-edit" id="inlineInput" value="" draggable="false">'
        : `<span class="cell-name">${m.id}</span><button type="button" class="pencil" data-edit="name">${pencil}</button>`;

      const groupCell = editingGroup
        ? '<select class="inline-edit" id="inlineGroup"></select>'
        : `<span class="cell-name">${m.row}</span><button type="button" class="pencil" data-edit="group">${pencil}</button>`;

      tr.innerHTML = `
        <td class="cell-mono">${nameCell}</td>
        <td class="cell-mono">${m.ip}</td>
        <td><span class="state-pill" data-state="${m.state}"><i class="led" data-tone="${STATE_TONE[m.state]}"></i>${STATE_LABEL[m.state]}</span></td>
        <td class="cell-mono">${groupCell}</td>
      `;

      tr.querySelectorAll(".pencil").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          const kind = button.dataset.edit;
          inlineEdit = {
            id: m.id,
            kind,
            value: kind === "name" ? m.id : m.row
          };
          render();
        });
      });

      body.appendChild(tr);
    });

    // 行内编辑控件
    const input = table.querySelector("#inlineInput");
    if (input) {
      input.value = inlineEdit.value;
      window.setTimeout(() => input.focus(), 0);

      input.addEventListener("input", () => { inlineEdit.value = input.value; });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          const target = inlineEdit.id;
          const value = input.value.trim();
          inlineEdit = null;
          renameMachine(target, value);
          render();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          inlineEdit = null;
          render();
        }
      });
      input.addEventListener("blur", () => {
        if (!inlineEdit) return;
        const target = inlineEdit.id;
        const value = input.value.trim();
        inlineEdit = null;
        renameMachine(target, value);
        render();
      });
    }

    const select = table.querySelector("#inlineGroup");
    if (select) {
      ["A", "B", "C", "D"].forEach((group) => {
        const option = document.createElement("option");
        option.value = group;
        option.textContent = `${group} 组`;
        select.appendChild(option);
      });
      select.value = inlineEdit.value;
      window.setTimeout(() => select.focus(), 0);

      select.addEventListener("change", () => {
        const machine = byId(inlineEdit.id);
        const group = select.value;
        inlineEdit = null;
        if (machine) {
          machine.row = group;
          log("修改分组", `${machine.id} → ${group} 组`);
          void API.send("group", [machine.id], { group });
        }
        render();
      });

    }

    stageBody.appendChild(table);
  }

  /* 双击打开独立的远程控制窗口 */
  function openRemoteWindow(id) {
    const url = new URL("remote.html", location.href);
    url.searchParams.set("pc", id);
    window.open(url.toString(), `remote-${id}`, "width=2200,height=1520");
    log("打开远程窗口", id);
  }

  /* 重命名：弹窗与列表行内编辑共用 */
  let renameTarget = null;

  function renameMachine(from, value) {
    if (!value || value === from) return false;
    if (MACHINES.some((m) => m.id === value)) {
      toast(`计算机名称 ${value} 已存在`, "warn");
      return false;
    }
    const machine = byId(from);
    if (!machine) return false;

    machine.id = value;
    if (state.selected.has(from)) {
      state.selected.delete(from);
      state.selected.add(value);
    }
    if (anchorId === from) anchorId = value;
    if (ctxMachine === from) ctxMachine = value;

    log("重命名", `${from} → ${value}`);
    void API.send("rename", [], { from, to: value });
    return true;
  }

  function openRename(id) {
    const machine = byId(id);
    if (!machine) return;
    renameTarget = machine.id;
    $("#renameHint").textContent = `当前：${machine.id}`;
    $("#renameField").value = machine.id;
    openDialog(renameDialog);
    window.setTimeout(() => $("#renameField").focus(), 60);
  }

  function saveRename() {
    const value = $("#renameField").value.trim();
    if (!value) {
      toast("名称不能为空", "warn");
      return;
    }
    if (value === renameTarget) {
      closeDialog(renameDialog);
      return;
    }
    if (!renameMachine(renameTarget, value)) return;
    closeDialog(renameDialog);
    render();
  }

  $("#renameSave").addEventListener("click", saveRename);
  $("#renameField").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveRename();
    }
  });

  /* ---------------- 分组管理 ---------------- */
  function renderGroups() {
    const wrap = document.createElement("div");
    wrap.className = "groups-wrap";

    const head = document.createElement("div");
    head.className = "groups-head";
    head.innerHTML = `
      <button type="button" class="btn btn-sm" id="groupAddBtn">新建分组</button>
      <span class="groups-hint">把机器拖到分组框里即可归组</span>
    `;
    wrap.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "groups-grid";

    const buckets = new Map();
    state.groups.forEach((g) => buckets.set(g, []));
    MACHINES.forEach((m) => {
      const key = m.row || "";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(m);
    });

    if (!buckets.has("")) buckets.set("", []);
    const order = ["", ...state.groups];   // 未分组排在最前

    order.forEach((name) => {
      const machines = buckets.get(name) || [];
      const card = document.createElement("section");
      card.className = "group-card";
      card.dataset.group = name;

      const title = document.createElement("div");
      title.className = "group-card-head";
      title.innerHTML = `
        <span>${name ? `${name} 组` : "未分组"}</span>
        <span class="count">${machines.length} 台</span>
        ${name ? `<button type="button" class="del" data-remove="${name}" title="删除分组">✕</button>` : ""}
      `;
      card.appendChild(title);

      const chips = document.createElement("div");
      chips.className = "group-chips";
      if (!machines.length) {
        const empty = document.createElement("span");
        empty.className = "group-empty";
        empty.textContent = "拖机器到这里";
        chips.appendChild(empty);
      }
      machines.forEach((m) => {
        const chip = document.createElement("span");
        chip.className = "mchip";
        chip.draggable = true;
        chip.dataset.machine = m.id;
        chip.dataset.state = m.state;
        chip.textContent = m.id;
        chip.addEventListener("dragstart", (event) => {
          event.dataTransfer.setData("text/plain", m.id);
          event.dataTransfer.effectAllowed = "move";
        });
        chips.appendChild(chip);
      });
      card.appendChild(chips);

      card.addEventListener("dragover", (event) => {
        event.preventDefault();
        card.classList.add("is-over");
      });
      card.addEventListener("dragleave", () => card.classList.remove("is-over"));
      card.addEventListener("drop", (event) => {
        event.preventDefault();
        card.classList.remove("is-over");
        const id = event.dataTransfer.getData("text/plain");
        const machine = byId(id);
        if (!machine || machine.row === name) return;
        machine.row = name;
        log("修改分组", `${machine.id} → ${name || "未分组"}`);
        void API.send("group", [machine.id], { group: name });
        render();
      });

      const delBtn = title.querySelector("[data-remove]");
      if (delBtn) {
        delBtn.addEventListener("click", () => {
          const group = delBtn.dataset.remove;
          askConfirm(
            {
              title: "删除分组",
              text: `删除「${group} 组」？组内机器会转入未分组。`,
              ok: "删除"
            },
            () => {
              state.groups = state.groups.filter((g) => g !== group);
              MACHINES.forEach((m) => { if (m.row === group) m.row = ""; });
              log("删除分组", group);
              void API.send("group-remove", [], { name: group });
              render();
            }
          );
        });
      }

      grid.appendChild(card);
    });

    wrap.appendChild(grid);
    stageBody.appendChild(wrap);

    $("#groupAddBtn").addEventListener("click", () => {
      $("#groupField").value = "";
      openDialog(groupDialog);
      window.setTimeout(() => $("#groupField").focus(), 60);
    });
  }

  $("#groupSave").addEventListener("click", () => {
    const name = $("#groupField").value.trim().toUpperCase().slice(0, 8);
    if (!name) {
      toast("分组名称不能为空", "warn");
      return;
    }
    if (state.groups.includes(name)) {
      toast(`分组 ${name} 已存在`, "warn");
      return;
    }
    state.groups.push(name);
    closeDialog(groupDialog);
    log("新建分组", `${name} 组`);
    void API.send("group-add", [], { name });
    render();
  });
  $("#groupField").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("#groupSave").click();
    }
  });

  /* ---------------- 白板 ---------------- */
  let boardCanvas = null;

  function paintBoard(preview) {
    const canvas = boardCanvas;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const strokes = preview ? [...state.strokes, preview] : state.strokes;
    strokes.forEach((stroke) => {
      if (!stroke.points || stroke.points.length === 0) return;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.beginPath();
      stroke.points.forEach((pt, index) => {
        if (index === 0) ctx.moveTo(pt[0], pt[1]);
        else ctx.lineTo(pt[0], pt[1]);
      });
      ctx.stroke();
    });
  }

  function refreshBoardCount() {
    const counter = $("#boardStrokeCount");
    if (counter) counter.textContent = `${state.strokes.length} 笔`;
  }

  let confirmAction = null;

  function askConfirm(options, onOk) {
    $("#confirmTitle").textContent = options.title;
    $("#confirmText").textContent = options.text;
    $("#confirmOk").textContent = options.ok;
    confirmAction = onOk;
    openDialog(confirmDialog);
  }

  $("#confirmOk").addEventListener("click", () => {
    const action = confirmAction;
    confirmAction = null;
    closeDialog(confirmDialog);
    if (action) action();
  });

  confirmDialog.addEventListener("close", () => { confirmAction = null; });

  function clearBoard(skipConfirm) {
    if (state.strokes.length === 0) {
      toast("画板已经是空的", "warn");
      return;
    }

    if (!skipConfirm) {
      askConfirm(
        {
          title: "清空画板",
          text: `清空 ${state.strokes.length} 笔笔迹？`,
          ok: "确认清空"
        },
        () => clearBoard(true)
      );
      return;
    }

    state.strokes = [];
    paintBoard();
    refreshBoardCount();
    log("白板清空", "");
    if (state.board) void API.send("board-clear", [], {});
  }

  function undoBoard() {
    if (state.strokes.length === 0) {
      toast("没有可撤销的笔迹", "warn");
      return;
    }
    state.strokes.pop();
    paintBoard();
    refreshBoardCount();
    log("白板撤销", `剩 ${state.strokes.length} 笔`);
    if (state.board) void API.send("board-sync", [], { strokes: state.strokes });
  }

  function renderBoardSection() {
    const wrap = document.createElement("div");
    wrap.className = "board-wrap";

    const colors = [
      "#0f172a", // 黑
      "#64748b", // 灰
      "#dc2626", // 红
      "#ea580c", // 橙
      "#ca8a04", // 黄
      "#16a34a", // 绿
      "#2563eb", // 蓝
      "#7c3aed", // 紫
      "#db2777"  // 粉
    ];
    const widths = [2, 4, 8];

    wrap.innerHTML = `
      <div class="board-toolbar">
        ${colors
          .map(
            (color) =>
              `<button type="button" class="swatch${state.brush.color === color && !state.brush.eraser ? " is-active" : ""}" data-color="${color}" style="background:${color}" aria-label="画笔颜色"></button>`
          )
          .join("")}
        <span class="sep"></span>
        ${widths
          .map(
            (width) =>
              `<button type="button" class="abtn${state.brush.width === width && !state.brush.eraser ? " is-on" : ""}" data-width="${width}">${width}px</button>`
          )
          .join("")}
        <button type="button" class="abtn${state.brush.eraser ? " is-on" : ""}" id="boardEraser">橡皮</button>
        <button type="button" class="abtn" id="boardClear">清空</button>
        <span class="ab-right" id="boardShareState"></span>
      </div>
      <div class="board-canvas-box">
        <canvas id="boardCanvas"></canvas>
        <span class="board-status" id="boardStrokeCount"></span>
      </div>
    `;
    stageBody.appendChild(wrap);

    boardCanvas = wrap.querySelector("#boardCanvas");
    const box = boardCanvas.parentElement;

    const syncStatus = () => {
      $("#boardShareState").textContent = state.board ? "共享中" : "未共享";
      $("#boardStrokeCount").textContent = `${state.strokes.length} 笔`;
    };

    const resizeBoard = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = box.clientWidth;
      const height = box.clientHeight;
      if (!width || !height) return;
      boardCanvas.width = Math.round(width * dpr);
      boardCanvas.height = Math.round(height * dpr);
      paintBoard();
    };

    if (typeof ResizeObserver === "function") {
      new ResizeObserver(resizeBoard).observe(box);
    } else {
      window.addEventListener("resize", resizeBoard);
    }
    resizeBoard();
    syncStatus();

    // 画笔
    let drawing = null;
    const pointOf = (event) => {
      const rect = boardCanvas.getBoundingClientRect();
      return [Math.round(event.clientX - rect.left), Math.round(event.clientY - rect.top)];
    };

    boardCanvas.addEventListener("pointerdown", (event) => {
      boardCanvas.setPointerCapture(event.pointerId);
      drawing = {
        color: state.brush.eraser ? "#ffffff" : state.brush.color,
        width: state.brush.eraser ? 18 : state.brush.width,
        points: [pointOf(event)]
      };
      paintBoard(drawing);
    });

    boardCanvas.addEventListener("pointermove", (event) => {
      if (!drawing) return;
      drawing.points.push(pointOf(event));
      paintBoard(drawing);
    });

    const finish = () => {
      if (!drawing) return;
      const stroke = drawing;
      drawing = null;
      if (stroke.points.length < 2) return;

      state.strokes.push(stroke);
      paintBoard();
      $("#boardStrokeCount").textContent = `${state.strokes.length} 笔`;
      if (state.board) void API.send("board-draw", [], { stroke });
    };
    boardCanvas.addEventListener("pointerup", finish);
    boardCanvas.addEventListener("pointercancel", finish);
    boardCanvas.addEventListener("pointerleave", finish);

    // 工具栏
    wrap.querySelectorAll(".swatch").forEach((button) => {
      button.addEventListener("click", () => {
        state.brush.color = button.dataset.color;
        state.brush.eraser = false;
        render();
      });
    });

    wrap.querySelectorAll("[data-width]").forEach((button) => {
      button.addEventListener("click", () => {
        state.brush.width = Number(button.dataset.width);
        state.brush.eraser = false;
        render();
      });
    });

    $("#boardEraser").addEventListener("click", () => {
      state.brush.eraser = !state.brush.eraser;
      render();
    });

    $("#boardClear").addEventListener("click", () => clearBoard());
  }

  /* ---------------- 选择 ---------------- */
  let anchorId = null;

  function selectAllVisible() {
    visibleMachines().forEach((m) => state.selected.add(m.id));
  }

  function invertVisible() {
    visibleMachines().forEach((m) => {
      if (state.selected.has(m.id)) state.selected.delete(m.id);
      else state.selected.add(m.id);
    });
  }

  function clearSelection() {
    state.selected.clear();
    anchorId = null;
  }

  function applyClickSelect(id, event) {
    const order = visibleMachines().map((m) => m.id);
    const from = anchorId ? order.indexOf(anchorId) : -1;
    const to = order.indexOf(id);

    if (event.shiftKey && from >= 0 && to >= 0) {
      if (!(event.ctrlKey || event.metaKey)) state.selected.clear();
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      order.slice(lo, hi + 1).forEach((x) => state.selected.add(x));
    } else if (event.ctrlKey || event.metaKey) {
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      anchorId = id;
    } else {
      state.selected.clear();
      state.selected.add(id);
      anchorId = id;
    }
    render();
  }

  /* ---------------- 框选（实时） ---------------- */
  let dragState = null;
  let marqueeEl = null;

  // 把拖拽矩形裁剪在监看区可见范围内，避免指针跑出边界后选框乱跑
  function dragRect(x0, y0, x1, y1) {
    const b = stageBody.getBoundingClientRect();
    return {
      left: Math.max(b.left, Math.min(x0, x1)),
      right: Math.min(b.right, Math.max(x0, x1)),
      top: Math.max(b.top, Math.min(y0, y1)),
      bottom: Math.min(b.bottom, Math.max(y0, y1))
    };
  }

  function updateMarquee(x0, y0, x1, y1) {
    const r = dragRect(x0, y0, x1, y1);
    if (!marqueeEl) {
      marqueeEl = document.createElement("div");
      marqueeEl.className = "marquee";
      document.body.appendChild(marqueeEl);
    }
    marqueeEl.style.left = `${r.left}px`;
    marqueeEl.style.top = `${r.top}px`;
    marqueeEl.style.width = `${Math.max(0, r.right - r.left)}px`;
    marqueeEl.style.height = `${Math.max(0, r.bottom - r.top)}px`;
  }

  function dropMarquee() {
    if (marqueeEl) {
      marqueeEl.remove();
      marqueeEl = null;
    }
  }

  function idsInRect(x0, y0, x1, y1) {
    const r = dragRect(x0, y0, x1, y1);
    return [...stageBody.querySelectorAll("[data-id]")]
      .filter((el) => {
        const b = el.getBoundingClientRect();
        return b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
      })
      .map((el) => el.dataset.id);
  }

  // 只改类名和计数，不重建列表，保证拖动时不掉帧
  function paintSelection() {
    [...stageBody.querySelectorAll("[data-id]")].forEach((el) => {
      const on = state.selected.has(el.dataset.id);
      el.classList.toggle("is-selected", on);
      el.setAttribute("aria-pressed", String(on));
    });
    renderChrome();
  }

  function applyDragSelection(hits, additive, base) {
    state.selected = new Set(additive ? [...base, ...hits] : hits);
    paintSelection();
  }

  stageBody.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("[data-id]")) return;
    // 白板工具栏 / 画布 / 分组组头不参与框选：
    // 否则松手那一下会触发“空白单击→重绘”，把被点的元素换掉，click 收不到
    if (event.target.closest(".board-toolbar, .board-canvas-box, .group-head, .groups-wrap")) return;
    dragState = {
      x0: event.clientX,
      y0: event.clientY,
      additive: event.ctrlKey || event.metaKey || event.shiftKey,
      moved: false,
      base: new Set(state.selected)
    };
    event.preventDefault();
  });

  window.addEventListener("mousemove", (event) => {
    if (!dragState) return;
    const dx = event.clientX - dragState.x0;
    const dy = event.clientY - dragState.y0;
    if (!dragState.moved && Math.hypot(dx, dy) < 4) return;
    dragState.moved = true;
    updateMarquee(dragState.x0, dragState.y0, event.clientX, event.clientY);
    applyDragSelection(
      idsInRect(dragState.x0, dragState.y0, event.clientX, event.clientY),
      dragState.additive,
      dragState.base
    );
  });

  window.addEventListener("mouseup", (event) => {
    if (!dragState) return;
    const drag = dragState;
    dragState = null;
    dropMarquee();

    if (!drag.moved) {
      if (!drag.additive) {
        clearSelection();
        render();
      }
      return;
    }

    const hits = idsInRect(drag.x0, drag.y0, event.clientX, event.clientY);
    applyDragSelection(hits, drag.additive, drag.base);
    if (hits.length) anchorId = hits[hits.length - 1];
    log("框选", `${state.selected.size} 台`, true);
    render();
  });

  /* ---------------- 右键菜单 ---------------- */
  const ctxMenu = $("#ctxMenu");
  let ctxMachine = null;   // 右键那台机器：投屏此机时作为投屏源

  function closeCtx() {
    ctxMenu.hidden = true;
  }

  function openCtx(x, y, items, header) {
    ctxMenu.innerHTML = "";
    if (header) {
      const head = document.createElement("div");
      head.className = "ctx-head";
      head.textContent = header;
      ctxMenu.appendChild(head);
    }
    items.forEach((item) => {
      if (item === "-") {
        const sep = document.createElement("div");
        sep.className = "ctx-sep";
        ctxMenu.appendChild(sep);
        return;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.act = item.act;
      if (item.icon) btn.innerHTML = `<svg><use href="#${item.icon}"></use></svg>`;
      btn.append(document.createTextNode(item.label));
      ctxMenu.appendChild(btn);
    });

    ctxMenu.hidden = false;
    const box = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - box.width - 6))}px`;
    ctxMenu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - box.height - 6))}px`;
  }

  // 输入框一律不允许拖拽文字（拖拽会打断选区）
  document.addEventListener("pointerdown", (event) => {
    const field = event.target.closest("input, textarea");
    if (field) field.draggable = false;
  }, true);

  // 点到编辑框以外就退出编辑（不提交），否则界面会被“编辑中”锁住
  document.addEventListener("mousedown", (event) => {
    if (!inlineEdit) return;
    if (event.target.closest("#inlineInput, #inlineGroup, .pencil")) return;
    inlineEdit = null;
    render();
  }, true);

  document.addEventListener("contextmenu", (event) => {
    if (event.target.closest("input, textarea, select")) return;
    event.preventDefault();

    // 白板自己的菜单
    if (event.target.closest(".board-wrap")) {
      openCtx(
        event.clientX,
        event.clientY,
        [
          { label: "撤销上一笔", act: "board-undo" },
          { label: "清空画板", act: "board-clear" }
        ],
        `白板 · ${state.strokes.length} 笔`
      );
      return;
    }

    const hit = event.target.closest("[data-id]");

    if (!hit || !stageBody.contains(hit)) {
      if (!stageBody.contains(event.target)) {
        closeCtx();
        return;
      }
      openCtx(
        event.clientX,
        event.clientY,
        [
          { label: "全选", act: "all" },
          { label: "反选", act: "invert" },
          { label: "清除选择", act: "clear" }
        ],
        "机房操作"
      );
      return;
    }

    const machine = byId(hit.dataset.id);
    if (!machine) return;
    ctxMachine = machine.id;
    if (!state.selected.has(machine.id)) {
      state.selected.clear();
      state.selected.add(machine.id);
      anchorId = machine.id;
      render();
    }
    const picked = selectedMachines().length;
    openCtx(
      event.clientX,
      event.clientY,
      [
        ...(picked === 1 ? [{ label: "共享此机屏幕", icon: "i-screen", act: "cast" }] : []),
        { label: "文件分发", icon: "i-folder", act: "task-file" },
        { label: "文件收集", icon: "i-inbox", act: "task-collect" },
        { label: "发送通知…", icon: "i-answer", act: "notice" },
        ...(picked === 1
          ? [
              { label: "远程控制", icon: "i-control", act: "remote" },
              { label: "远程指令", icon: "i-terminal", act: "terminal" }
            ]
          : []),
        (function () {
          const isLocked = machine.state === "locked";
          return {
            label: isLocked ? "解除锁定" : "锁定屏幕",
            icon: "i-lock",
            act: isLocked ? "unlock" : "lock"
          };
        })(),
        "-",
        { label: "打开网址", act: "task-url" },
        { label: "启动程序", act: "task-app" },
        "-",
        { label: "重启", act: "restart" },
        { label: "关机", act: "off" },
        { label: "开机", act: "on" },
        ...(picked === 1
          ? [
              { label: "重命名…", act: "rename" },
              { label: "仅选此机", act: "only" }
            ]
          : [])
      ],
      `${machine.id}${picked > 1 ? ` · 已选 ${picked} 台` : ""}`
    );
  });

  ctxMenu.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    closeCtx();

    const picked = selectedMachines();
    const label = picked.length ? `选中 ${picked.length} 台` : "全部";
    const texts = {
      cast: ["投屏", "投屏已开始"],
      remote: ["远程控制", "远程控制已进入"],
      lock: ["锁定屏幕", "锁定指令已下发"],
      unlock: ["解除锁定", "已解除锁定"],
      restart: ["重启", "重启指令已下发"],
      off: ["关机", "关机指令已下发"],
      on: ["开机", "开机指令已下发"]
    };

    if (act === "all") {
      selectAllVisible();
      log("全选", `${visibleMachines().length} 台`, true);
      render();
      return;
    }
    if (act === "invert") {
      invertVisible();
      log("反选", "", true);
      render();
      return;
    }
    if (act === "clear") {
      clearSelection();
      log("清除选择", "", true);
      render();
      return;
    }
    if (act === "only") {
      render();
      return;
    }

    if (act === "cast") {
      toggleCast(true, ctxMachine || "teacher");
      return;
    }
    if (act === "rename") {
      openRename(ctxMachine);
      return;
    }
    if (act === "board-undo") {
      undoBoard();
      return;
    }
    if (act === "board-clear") {
      clearBoard();
      return;
    }
    if (act === "terminal") {
      openTerminal(ctxMachine);
      return;
    }
    if (act === "notice") {
      openNoticeDialog([...state.selected]);
      return;
    }
    if (act === "task-file" || act === "task-collect") {
      openTask(act === "task-file" ? "file" : "collect", [...state.selected]);
      return;
    }
    if (act === "task-url" || act === "task-app") {
      openTask(act === "task-url" ? "url" : "app");
      return;
    }

    if (act === "remote") {
      openRemote(ctxMachine);
      return;
    }

    const pickedIds = [...state.selected];
    if (act === "lock") void API.send("lock", pickedIds, {});
    else if (act === "unlock") void API.send("unlock", pickedIds, {});
    else if (act === "restart" || act === "off" || act === "on") {
      void API.send("power", pickedIds, { mode: act });
    }

    const [name, said] = texts[act] || [act, act];
    log(name, `→ ${label}`);
    toast(`${said} · ${label}`);
  });

  document.addEventListener("mousedown", (event) => {
    if (!ctxMenu.hidden && !ctxMenu.contains(event.target)) closeCtx();
  });

  window.addEventListener("blur", closeCtx);
  window.addEventListener("resize", () => { closeCtx(); syncAllSegThumbs(); });
  stageBody.addEventListener("scroll", closeCtx);

  /* ---------------- 广播 / 电源 ---------------- */
  // 点按钮投教师机；右键某台学生机则把那台学生机作为投屏源
  function castSourceLabel() {
    return state.source === "teacher" ? "教师机" : state.source;
  }

  function toggleCast(force, source) {
    const next = typeof force === "boolean" ? force : !state.casting;
    if (next && source) state.source = source;
    if (next) {
      // 屏幕共享与媒体 / 白板互斥
      state.media = false;
      state.board = false;
      paintShareButtons();
    }
    state.casting = next;

    const target = targetScope();
    if (state.casting) {
      log("屏幕共享开始", `${castSourceLabel()} 全屏 · ${target.label}`);
      toast(`正在投送${castSourceLabel()} · ${target.label}`);
    } else {
      log("屏幕共享停止", "");
      toast("屏幕共享已停止");
    }

    renderChrome();
    void API.send("cast", targetIds(), {
      on: state.casting,
      source: state.source,
      scope: "all"
    });
  }

  const POWER_LABEL = { on: "开机", off: "关机", restart: "重启" };

  function power(action) {
    const target = targetScope();
    log(POWER_LABEL[action], `→ ${target.label}`);
    toast(`${POWER_LABEL[action]}指令已下发 · ${target.label}`);
    const tag = action === "on" ? "开机" : action === "off" ? "关机" : "重启";
    stageTitle.textContent = `${VIEW_TITLE[state.view]} · ${tag}`;
    window.setTimeout(() => { stageTitle.textContent = VIEW_TITLE[state.view]; }, 1400);
    void API.send("power", targetIds(), { mode: action });
  }

  /* ---------------- 任务下发 ---------------- */
  const TASK = {
    file: {
      title: "文件分发",
      confirm: "开始下发",
      body: `
        <label class="drop">
          <span id="dropLabel">点击选择文件，或拖到此处</span>
          <input type="file" hidden>
        </label>
      `,
      detail: (t) => `→ ${t.label}`
    },
    url: {
      title: "打开网址",
      confirm: "打开网址",
      body: `
        <input class="input" id="urlField" type="url" value="https://www.python.org/" aria-label="网址">
      `,
      detail: (t) => `${$("#urlField")?.value || "网址"} → ${t.label}`
    },
    command: {
      title: "远程指令",
      confirm: "",
      body: `
        <div class="cmd-actions">
          <button type="button" class="btn" data-cmd="shutdown">关机</button>
          <button type="button" class="btn" data-cmd="reboot">重启</button>
          <button type="button" class="btn" data-cmd="url">打开网址</button>
        </div>
        <div class="field-block">
          <span class="field-k">网址</span>
          <input class="input" id="cmdField" type="text" value="https://www.python.org/" draggable="false" aria-label="网址">
        </div>
        <div class="cmd-confirm" id="cmdConfirm" hidden>
          <p class="note" id="cmdConfirmText"></p>
          <div class="cmd-confirm-actions">
            <button type="button" class="btn" id="cmdConfirmCancel">取消</button>
            <button type="button" class="btn btn-primary" id="cmdConfirmOk">确认</button>
          </div>
        </div>
      `,
      detail: () => ""
    },
    collect: {
      title: "文件收集",
      confirm: "开始收集",
      body: `
        <input class="input" id="collectField" type="text" draggable="false" value="D:\\课堂作业" aria-label="收集目录">
      `,
      detail: (t) => `${$("#collectField")?.value || "作业目录"} → ${t.label}`
    },
    app: {
      title: "启动程序",
      confirm: "启动",
      body: `
        <select class="input" id="appField" aria-label="程序">
          <option>Python 3.12</option>
          <option>Visual Studio Code</option>
          <option>画图</option>
          <option>计算器</option>
        </select>
      `,
      detail: (t) => `${$("#appField")?.value || "程序"} → ${t.label}`
    }
  };

  let activeTask = null;
  let taskTargets = null;

  function openTask(type, targets) {
    const cfg = TASK[type];
    if (!cfg) {
      toast(`这个操作还没接上：${type}`, "warn");
      return;
    }
    activeTask = type;
    taskTargets = Array.isArray(targets) && targets.length ? [...targets] : null;
    $("#taskTitle").textContent = cfg.title;
    $("#taskHint").textContent = `目标：${taskTargets ? `${taskTargets.length} 台` : targetScope().label}`;
    $("#taskBody").innerHTML = cfg.body;
    $("#taskConfirm").textContent = cfg.confirm;

    const fileInput = $("#taskBody input[type=file]");
    if (fileInput) {
      const drop = fileInput.closest(".drop");
      const label = $("#dropLabel");
      fileInput.addEventListener("change", () => {
        if (fileInput.files.length) label.textContent = fileInput.files[0].name;
      });
      ["dragenter", "dragover"].forEach((t) =>
        drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("is-over"); })
      );
      ["dragleave", "drop"].forEach((t) =>
        drop.addEventListener(t, () => drop.classList.remove("is-over"))
      );
      drop.addEventListener("drop", (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) label.textContent = file.name;
      });
    }
    $("#taskConfirm").style.display = type === "command" ? "none" : "";
    if (type === "command") mountCommandPanel();

    openDialog(taskDialog);
  }

  /* 远程指令：关机 / 重启 / 打开网址，全体下发 + 二次确认 */
  let cmdPending = null;

  function onlineCount() {
    return MACHINES.filter((m) => m.state !== "offline").length;
  }

  function broadcastPower(mode) {
    const total = onlineCount();
    log(POWER_LABEL[mode], `→ 全部 ${total} 台`);
    toast(`${POWER_LABEL[mode]}指令已下发 · 全部 ${total} 台`);
    void API.send("power", [], { mode });
  }

  function mountCommandPanel() {
    cmdPending = null;
    $("#cmdConfirm").hidden = true;

    document.querySelectorAll(".cmd-actions [data-cmd]").forEach((button) => {
      button.addEventListener("click", () => {
        const kind = button.dataset.cmd;
        const total = onlineCount();
        let text = "";

        if (kind === "shutdown") text = `对全部 ${total} 台在线机器执行「关机」？`;
        else if (kind === "reboot") text = `对全部 ${total} 台在线机器执行「重启」？`;
        else {
          const url = $("#cmdField").value.trim();
          if (!url) {
            toast("先填写要打开的网址");
            $("#cmdField").focus();
            return;
          }
          text = `在全部 ${total} 台在线机器上打开「${url}」？`;
        }

        cmdPending = { kind, total };
        $("#cmdConfirmText").textContent = text;
        $("#cmdConfirmOk").textContent =
          kind === "shutdown" ? "确认关机" : kind === "reboot" ? "确认重启" : "确认打开";
        $("#cmdConfirm").hidden = false;
      });
    });

    $("#cmdConfirmCancel").addEventListener("click", () => {
      cmdPending = null;
      $("#cmdConfirm").hidden = true;
    });

    $("#cmdConfirmOk").addEventListener("click", () => {
      if (!cmdPending) return;
      const { kind, total } = cmdPending;
      closeDialog(taskDialog);

      if (kind === "shutdown") broadcastPower("off");
      else if (kind === "reboot") broadcastPower("restart");
      else {
        const url = $("#cmdField").value.trim();
        log("打开网址", `${url} → 全部 ${total} 台`);
        toast(`网址已下发 · 全部 ${total} 台`);
        void API.send("task", [], { title: "打开网址", detail: `${url} → 全部 ${total} 台` });
      }
    });
  }

  /* 右键单机 → 伪终端 */
  let termMachine = null;

  function openTerminal(id) {
    const machine = byId(id);
    if (!machine) return;
    termMachine = machine;
    $("#termHost").textContent = machine.id;
    $("#termOut").textContent = `已连接 ${machine.id}\n`;
    $("#termField").value = "";
    openDialog(termDialog);
    window.setTimeout(() => $("#termField").focus(), 60);
  }

  function termReply(cmd) {
    const lower = cmd.toLowerCase();
    const who = "student";

    if (lower === "ipconfig") {
      return [
        "Windows IP 配置",
        "",
        "以太网适配器 以太网:",
        "   IPv4 地址 . . . . . . . . . . . . : " + termMachine.ip,
        "   子网掩码  . . . . . . . . . . . . : 255.255.255.0",
        "   默认网关. . . . . . . . . . . . . : 192.168.10.1"
      ].join("\n");
    }

    if (lower.startsWith("ping")) {
      return [
        "正在 Ping 192.168.10.1 具有 32 字节的数据:",
        "来自 192.168.10.1 的回复: 字节=32 时间<1ms TTL=64",
        "来自 192.168.10.1 的回复: 字节=32 时间<1ms TTL=64",
        "192.168.10.1 的 Ping 统计信息: 数据包: 已发送 = 2，已接收 = 2，丢失 = 0 (0% 丢失)"
      ].join("\n");
    }

    if (lower === "dir") {
      return [
        " 驱动器 C 中的卷没有标签。",
        " C:\\Users\\" + who + " 的目录",
        "",
        "2026/11/14  09:12    <DIR>          Desktop",
        "2026/11/14  09:12    <DIR>          Documents",
        "2026/11/14  09:12    <DIR>          Downloads",
        "               0 个文件              0 字节"
      ].join("\n");
    }

    if (lower === "whoami") {
      return "classroom\\" + who;
    }

    return "命令已下发";
  }

  function termRun() {
    const field = $("#termField");
    const cmd = field.value.trim();
    if (!cmd || !termMachine) return;
    field.value = "";

    const out = $("#termOut");
    out.textContent += "C:\\> " + cmd + "\n" + termReply(cmd) + "\n\n";
    out.scrollTop = out.scrollHeight;

    log("远程指令", termMachine.id + ": " + cmd);
    void API.send("task", [termMachine.id], {
      title: "远程指令",
      detail: cmd + " → " + termMachine.id
    });
  }

  $("#termSend").addEventListener("click", termRun);
  $("#termField").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      termRun();
    }
  });

  /* ---------------- 事件 ---------------- */
  stageBody.addEventListener("click", (event) => {
    const group = event.target.closest("[data-group]");
    if (group) {
      const row = group.dataset.group;
      if (state.collapsed.has(row)) state.collapsed.delete(row);
      else state.collapsed.add(row);
      render();
      return;
    }

    const target = event.target.closest("[data-id]");
    if (!target) return;

    const id = target.dataset.id;
    const now = performance.now();
    if (clickMark.id === id && now - clickMark.at < 400) {
      clickMark = { id: null, at: 0 };
      openRemote(id);
      return;
    }
    clickMark = { id, at: now };

    applyClickSelect(id, event);
  });

  let clickMark = { id: null, at: 0 };
  let inlineEdit = null;
  const alertSeen = new Map();

  function openRemote(id) {
    const machine = byId(id);
    if (!machine) return;
    if (machine.state === "offline") {
      toast(`${machine.id} 离线`, "warn");
      return;
    }
    openRemoteWindow(machine.id);
  }

  document.querySelectorAll(".rail-btn[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      document.querySelectorAll(".rail-btn[data-view]").forEach((b) =>
        b.classList.toggle("is-active", b === button)
      );
      render();
    });
  });

  /* 分段控件：白色滑块跟随选中项，切换时平滑移动 */
  function syncSegThumb(seg) {
    if (!seg) return;
    let thumb = seg.querySelector(".seg-thumb");
    if (!thumb) {
      thumb = document.createElement("span");
      thumb.className = "seg-thumb";
      seg.insertBefore(thumb, seg.firstChild);
    }
    const active = seg.querySelector(".is-active");
    if (!active) {
      thumb.style.opacity = "0";
      return;
    }
    const r = active.getBoundingClientRect();
    const sr = seg.getBoundingClientRect();
    thumb.style.opacity = "1";
    thumb.style.width = `${r.width}px`;
    thumb.style.transform = `translateX(${r.left - sr.left}px)`;
  }

  function syncAllSegThumbs() {
    document.querySelectorAll(".seg").forEach(syncSegThumb);
  }

  function bindSeg(container, key, cast = (v) => v) {
    $(container).addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const value = cast(button.dataset[key] ?? "");
      state[key === "row" ? "row" : key === "state" ? "machineState" : key] = value;
      [...$(container).children].forEach((b) => b.classList.toggle("is-active", b === button));
      render();
    });
  }

  bindSeg("#rowSeg", "row");
  bindSeg("#stateSeg", "state");

  $("#searchInput").addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    render();
  });

  $("#selectAllBtn").addEventListener("click", () => {
    selectAllVisible();
    log("全选", `${visibleMachines().length} 台`, true);
    render();
  });

  $("#invertBtn").addEventListener("click", () => {
    invertVisible();
    log("反选", "", true);
    render();
  });

  $("#clearBtn").addEventListener("click", () => {
    clearSelection();
    log("清除选择", "", true);
    render();
  });

  $("#castToggle").addEventListener("click", () => toggleCast(undefined, "teacher"));

  /* 媒体共享 / 白板共享：与屏幕共享互斥，点一下即生效 */
  function paintShareButtons() {
    $("#mediaBtn").classList.toggle("is-on", state.media);
    $("#boardBtn").classList.toggle("is-on", state.board);
  }

  function toggleAuxShare(kind) {
    const pressed = !state[kind];
    if (pressed) {
      if (state.casting) toggleCast(false);
      if (kind === "media") state.board = false;
      else state.media = false;
    }
    state[kind] = pressed;

    const name = kind === "media" ? "媒体共享" : "白板共享";
    const target = targetScope();
    log(pressed ? `${name} 开启` : `${name} 关闭`, `→ ${target.label}`);
    toast(pressed ? `${name}已开始 · ${target.label}` : `${name}已停止`);
    paintShareButtons();
    if (state.view === "board") render();

    if (kind === "board" && pressed) {
      void API.send("board-sync", [], { strokes: state.strokes });
    }
    void API.send(kind, targetIds(), { on: pressed });
  }

  /* 远程控制：先弹机器列表，选一台再接管 */
  function openRemotePicker() {
    const list = $("#remoteList");
    list.innerHTML = "";
    MACHINES.forEach((machine) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "pick-item";
      item.dataset.id = machine.id;
      item.disabled = machine.state === "offline";
      item.innerHTML = `
        <span class="pick-id">${machine.id}</span>
        <span class="pick-user">${machine.ip}</span>
        <span class="state-pill" data-state="${machine.state}">${STATE_LABEL[machine.state]}</span>
      `;
      list.appendChild(item);
    });
    openDialog(remoteDialog);
  }

  $("#remoteBtn").addEventListener("click", openRemotePicker);

  $("#remoteList").addEventListener("click", (event) => {
    const item = event.target.closest(".pick-item");
    if (!item || item.disabled) return;
    const machine = byId(item.dataset.id);
    closeDialog(remoteDialog);
    openRemote(machine.id);
  });

  /* 媒体共享：先选文件，点「投放」才生效 */
  let mediaFile = null;

  function openMediaDialog() {
    mediaFile = null;
    $("#mediaInput").value = "";
    $("#mediaLabel").textContent = "选择文件";
    openDialog(mediaDialog);
  }

  function pickMedia(file) {
    if (!file) return;
    mediaFile = file;
    $("#mediaLabel").textContent = file.name;
  }

  $("#mediaBtn").addEventListener("click", () => {
    if (state.media) {
      toggleAuxShare("media"); // 正在投放：点一下停止
      return;
    }
    openMediaDialog();
  });

  (() => {
    const drop = $("#mediaDrop");
    const input = $("#mediaInput");
    input.addEventListener("change", () => pickMedia(input.files[0]));
    ["dragenter", "dragover"].forEach((t) =>
      drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("is-over"); })
    );
    ["dragleave", "drop"].forEach((t) =>
      drop.addEventListener(t, () => drop.classList.remove("is-over"))
    );
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      pickMedia(e.dataTransfer.files[0]);
    });
  })();

  $("#mediaStart").addEventListener("click", () => {
    if (!mediaFile) {
      toast("先选择要投放的文件", "warn");
      return;
    }
    const name = mediaFile.name;
    closeDialog(mediaDialog);

    // 与屏幕共享 / 白板共享互斥
    if (state.casting) toggleCast(false);
    state.board = false;
    state.media = true;
    paintShareButtons();

    const target = targetScope();
    log("媒体共享 开始", `${name} → ${target.label}`);
    toast(`正在投放 ${name} · ${target.label}`);
    void API.send("media", [], { on: true, file: name });
  });
  $("#boardBtn").addEventListener("click", () => toggleAuxShare("board"));

  $("#remoteCmdBtn").addEventListener("click", () => openTask("command"));
  $("#collectBtn").addEventListener("click", () => openTask("collect"));

  /* 发送通知：右键给选中的一台或多台机器发文字通知 */
  let noticeTargets = [];

  function openNoticeDialog(targets) {
    noticeTargets = [...targets];
    $("#noticeTarget").textContent =
      noticeTargets.length > 1 ? `${noticeTargets.length} 台` : noticeTargets[0] || "";
    $("#noticeBody").value = "";
    openDialog(noticeDialog);
    window.setTimeout(() => $("#noticeBody").focus(), 60);
  }

  function sendNotice() {
    const text = $("#noticeBody").value.trim();
    if (!text) {
      toast("通知内容不能为空", "warn");
      $("#noticeBody").focus();
      return;
    }
    const label = noticeTargets.length > 1 ? `${noticeTargets.length} 台` : noticeTargets[0] || "未选机器";
    log("发送通知", `${text} → ${label}`);
    toast(`通知已发送 · ${label}`);
    void API.send("notice", noticeTargets, { text });
    closeDialog(noticeDialog);
  }

  $("#noticeDialogSend").addEventListener("click", sendNotice);

  /* 发送通知：把一段文字广播到所有学生屏幕 */
  $("#noticeSend").addEventListener("click", () => {
    const field = $("#noticeText");
    const text = field.value.trim();
    if (!text) {
      toast("通知内容不能为空", "warn");
      field.focus();
      return;
    }
    const target = targetScope();
    log("发送通知", `${text} → ${target.label}`);
    toast(`通知已广播 · ${target.label}`);
    void API.send("notice", [], { text });
    field.value = "";
  });

  /* 一键让所有机器在各自屏幕上显示机号与 IP */
  let labelOn = false;

  function applyLabel(on) {
    labelOn = on;
    MACHINES.forEach((m) => { m.label = on; });
    const button = $("#labelBtn");
    button.classList.toggle("is-on", on);
    button.querySelector("span")?.remove?.();
    log(on ? "显示机号" : "隐藏机号", `全部 ${onlineCount()} 台`);
    toast(on ? "已下发显示机号" : "已下发隐藏机号");
    render();
    void API.send("label", [], { on });
  }

  $("#labelBtn").addEventListener("click", () => applyLabel(!labelOn));

  $("#quizBtn").addEventListener("click", () => {
    const target = targetScope();
    log("在线答题", `→ ${target.label}`);
    toast(`答题卡已下发 · ${target.label}`);
    void API.send("quiz", targetIds(), {});
  });

  $("#policyBarBtn").addEventListener("click", openPolicy);

  /* 控制台设置：草稿式 */
  let settingsSaved = false;
  let settingsChanged = false;

  function setSettingsDirty(dirty) {
    settingsChanged = dirty;
    $("#settingsDirty").hidden = !dirty;
  }

  function openSettings() {
    settingsSaved = false;
    $("#setSource").value = state.settings.defaultSource;
    $("#setColumns").value = state.settings.columns;
    setSettingsDirty(false);
    openDialog(settingsDialog);
  }

  $("#railSettings").addEventListener("click", openSettings);

  $("#setSource").addEventListener("change", () => setSettingsDirty(true));
  $("#setColumns").addEventListener("change", () => setSettingsDirty(true));

  settingsDialog.addEventListener("close", () => {
    if (!settingsSaved && settingsChanged) log("控制台设置未保存", "已放弃本次修改");
    setSettingsDirty(false);
  });

  document.querySelectorAll("[data-power]").forEach((button) => {
    button.addEventListener("click", () => power(button.dataset.power));
  });

  document.querySelectorAll("[data-task]").forEach((button) => {
    button.addEventListener("click", () => openTask(button.dataset.task));
  });

  const policySwitches = [
    ["#swUsb", "usb", "禁止 USB 传输"],
    ["#swOffline", "blockNet", "禁止联网"],
    ["#swInternet", "block", "上网限制"]
  ];

  function pushPolicy() {
    void API.send("policy", [], { ...state.policy, sites: state.sites, presets: state.presets });
  }

  policySwitches.forEach(([sel, key, name]) => {
    $(sel).addEventListener("change", (event) => {
      state.policy[key] = event.target.checked;
      log(`${name} ${event.target.checked ? "开启" : "关闭"}`, `→ ${targetScope().label}`);
      toast(`${name}已${event.target.checked ? "开启" : "关闭"}`);
      pushPolicy();
    });
  });

  /* 一键锁屏：同黑屏原理，全屏黑掉 + 屏蔽键鼠，可自定义显示内容 */
  $("#lockToggleBtn").addEventListener("click", () => {
    const message = $("#lockMessage").value.trim() || "上课中，请勿操作";
    state.lockMessage = message;
    const next = !state.locked;
    state.locked = next;

    const target = targetScope();
    if (next) {
      log("一键锁屏", `${message} · ${target.label}`);
      toast(`已锁屏 · ${message}`);
    } else {
      log("解除锁屏", `→ ${target.label}`);
      toast("已解除锁屏");
    }
    renderChrome();
    void API.send(next ? "lock" : "unlock", targetIds(), { message });
  });

  $("#clearSelBtn").addEventListener("click", () => {
    state.selected.clear();
    log("清除选择", "", true);
    render();
  });

  $("#logClearBtn").addEventListener("click", () => {
    state.log = [];
    renderLog();
  });

  $("#policyBtn").addEventListener("click", openPolicy);

  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => closeDialog(button.closest("dialog")));
  });

  // 弹窗只能通过“取消/关闭”按钮关闭：点遮罩、按 Esc 都不生效，避免误关丢掉草稿
  // 点弹窗的空白区域不要给它焦点（否则会出焦点框）
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("mousedown", (event) => {
      if (event.target === dialog) event.preventDefault();
    });
  });

  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("cancel", (event) => event.preventDefault());
  });

  $("#taskConfirm").addEventListener("click", () => {
    const cfg = TASK[activeTask];
    if (!cfg) return;

    const target = taskTargets
      ? { machines: taskTargets, label: `${taskTargets.length} 台` }
      : targetScope();
    const detail = cfg.detail(target);
    log(cfg.title, detail);
    toast(`${cfg.title}指令已下发 · ${target.label}`);
    closeDialog(taskDialog);
    void API.send("task", taskTargets || targetIds(), { title: cfg.title, detail });
  });

  /* 白名单：弹窗内只改草稿，点保存才写入状态，取消即丢弃 */
  const tagInput = $("#tagInput");
  const tagField = $("#tagInputField");
  let policyDirty = false;
  let policySaved = false;

  function renderPolicyTags(list) {
    tagInput.querySelectorAll(".tag").forEach((tag) => tag.remove());
    list.forEach((site) => {
      const tag = document.createElement("button");
      tag.type = "button";
      tag.className = "tag";
      tag.dataset.site = site;
      tag.title = "点击移除";
      tag.textContent = site;
      tagInput.insertBefore(tag, tagField);
    });
  }

  function draftSites() {
    return [...tagInput.querySelectorAll(".tag")].map((tag) => tag.dataset.site);
  }

  function setPolicyDirty(dirty) {
    policyDirty = dirty;
    $("#policyDirty").hidden = !dirty;
  }

  /* 策略分类：访问限制 / 异常程序 */
  let policyTab = "access";
  let policyDraftProcs = [];
  let policyDraftProcMode = "block";

  const procTags = $("#procTags");
  const procField = $("#procField");

  function paintPolicyTab() {
    [...$("#policyTabSeg").children].forEach((b) =>
      b.classList.toggle("is-active", b.dataset.tab === policyTab)
    );
    $("#policyAccessPane").hidden = policyTab !== "access";
    $("#policyProcPane").hidden = policyTab !== "proc";
    // 切页签会改变可见性，整页滑块一起重算
    window.requestAnimationFrame(syncAllSegThumbs);
  }

  function renderProcTags(list) {
    procTags.querySelectorAll(".tag").forEach((tag) => tag.remove());
    list.forEach((name) => {
      const tag = document.createElement("button");
      tag.type = "button";
      tag.className = "tag";
      tag.dataset.proc = name;
      tag.title = "点击移除";
      tag.textContent = name;
      procTags.insertBefore(tag, procField);
    });
  }

  function draftProcs() {
    return [...procTags.querySelectorAll(".tag")].map((tag) => tag.dataset.proc);
  }

  function paintProcMode() {
    [...$("#procModeSeg").children].forEach((b) =>
      b.classList.toggle("is-active", b.dataset.proc === policyDraftProcMode)
    );
    window.requestAnimationFrame(() => syncSegThumb($("#procModeSeg")));
  }

  $("#policyTabSeg").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    policyTab = button.dataset.tab;
    paintPolicyTab();
  });

  $("#procModeSeg").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.dataset.proc === policyDraftProcMode) return;
    policyDraftProcMode = button.dataset.proc;
    paintProcMode();
    setPolicyDirty(true);
  });

  procField.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const value = procField.value.trim();
    if (!value) return;
    if (draftProcs().includes(value)) {
      procField.value = "";
      return;
    }
    const tag = document.createElement("button");
    tag.type = "button";
    tag.className = "tag";
    tag.dataset.proc = value;
    tag.title = "点击移除";
    tag.textContent = value;
    procTags.insertBefore(tag, procField);
    procField.value = "";
    setPolicyDirty(true);
  });

  procTags.addEventListener("click", (event) => {
    const tag = event.target.closest(".tag");
    if (!tag) return;
    tag.remove();
    setPolicyDirty(true);
  });

  let policyDraftMode = state.policy.mode;
  let policyDraftPreset = state.policy.preset;
  let policyDraftPresets = [];

  function modePresets() {
    return policyDraftPresets.filter((p) => p.mode === policyDraftMode);
  }

  function paintPolicyMode() {
    [...$("#policyModeSeg").children].forEach((b) =>
      b.classList.toggle("is-active", b.dataset.mode === policyDraftMode)
    );
    $("#sitesLabel").textContent =
      policyDraftMode === "whitelist" ? "允许访问的网站" : "禁止访问的网站";
    // 完全禁止：除了“限制方式”这一组，其余控件全部置灰且不可操作
    const blocked = policyDraftMode === "blockall";
    const listBlock = $("#policyListBlock");
    listBlock.classList.toggle("is-disabled", blocked);
    listBlock.querySelectorAll("input, select, button").forEach((el) => {
      el.disabled = blocked;
    });
    $("#policyLog").disabled = blocked;
    $("#policyLogRow").classList.toggle("is-disabled", blocked);
    window.requestAnimationFrame(() => syncSegThumb($("#policyModeSeg")));
  }

  function paintPresetSelect() {
    const select = $("#presetSelect");
    select.innerHTML = "";
    const custom = document.createElement("option");
    custom.value = "";
    custom.textContent = "自定义";
    select.appendChild(custom);

    modePresets().forEach((preset) => {
      const option = document.createElement("option");
      option.value = preset.name;
      option.textContent = `${preset.name} · ${preset.sites.length}`;
      select.appendChild(option);
    });
    const matched = modePresets().some((p) => p.name === policyDraftPreset);
    select.value = matched ? policyDraftPreset : "";
    resetPresetDelete();
  }

  /* 删除预设：需要二次确认 */
  let presetDeleteArmed = false;
  let presetDeleteTimer = 0;

  function resetPresetDelete() {
    presetDeleteArmed = false;
    window.clearTimeout(presetDeleteTimer);
    const button = $("#presetDelete");
    button.textContent = "删除";
    button.classList.remove("is-alert");
    button.disabled = !policyDraftPreset || policyDraftMode === "blockall";
  }

  function armPresetDelete() {
    const button = $("#presetDelete");
    presetDeleteArmed = true;
    button.textContent = "确认删除？";
    button.classList.add("is-alert");
    window.clearTimeout(presetDeleteTimer);
    presetDeleteTimer = window.setTimeout(resetPresetDelete, 3000);
  }

  function openPolicy() {
    policySaved = false;
    policyDraftMode = state.policy.mode;
    policyDraftPreset = state.policy.preset;
    policyDraftPresets = state.presets.map((p) => ({ ...p, sites: [...p.sites] }));
    renderPolicyTags(state.sites);
    $("#policyLog").checked = state.policy.log;
    $("#presetName").value = "";
    tagField.value = "";
    policyDraftProcs = [...(state.policy.procs?.list || [])];
    policyDraftProcMode = state.policy.procs?.mode === "report" ? "report" : "block";
    renderProcTags(policyDraftProcs);
    paintProcMode();
    policyTab = "access";
    paintPolicyTab();
    paintPolicyMode();
    paintPresetSelect();
    setPolicyDirty(false);
    openDialog(policyDialog);
  }

  $("#policyModeSeg").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.dataset.mode === policyDraftMode) return;
    policyDraftMode = button.dataset.mode;
    policyDraftPreset = "";
    paintPolicyMode();
    paintPresetSelect();
    setPolicyDirty(true);
  });

  $("#presetSelect").addEventListener("change", (event) => {
    const name = event.target.value;
    policyDraftPreset = name;
    const preset = policyDraftPresets.find((p) => p.name === name && p.mode === policyDraftMode);
    if (preset) renderPolicyTags(preset.sites);
    resetPresetDelete();
    setPolicyDirty(true);
  });

  $("#presetDelete").addEventListener("click", () => {
    if (!policyDraftPreset) return;

    if (!presetDeleteArmed) {
      armPresetDelete();
      toast("再点一次确认");
      return;
    }

    const name = policyDraftPreset;
    policyDraftPresets = policyDraftPresets.filter(
      (p) => !(p.name === name && p.mode === policyDraftMode)
    );
    policyDraftPreset = "";
    paintPresetSelect();
    setPolicyDirty(true);
    toast(`预设「${name}」已删除`);
  });

  $("#presetSave").addEventListener("click", () => {
    const name = $("#presetName").value.trim();
    if (!name) {
      toast("先给预设起个名字");
      $("#presetName").focus();
      return;
    }
    if (policyDraftMode === "blockall") {
      toast("完全禁止不需要预设", "warn");
      return;
    }

    const sites = draftSites();
    const existing = policyDraftPresets.find((p) => p.name === name && p.mode === policyDraftMode);
    if (existing) existing.sites = sites;
    else policyDraftPresets.push({ name, mode: policyDraftMode, sites });

    policyDraftPreset = name;
    $("#presetName").value = "";
    paintPresetSelect();
    setPolicyDirty(true);
    toast(`预设「${name}」已保存`);
  });

  policyDialog.addEventListener("close", () => {
    if (!policySaved && policyDirty) log("白名单未保存", "已放弃本次修改");
    setPolicyDirty(false);
  });

  tagField.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const value = tagField.value.trim();
    if (!value || draftSites().includes(value)) return;

    const tag = document.createElement("button");
    tag.type = "button";
    tag.className = "tag";
    tag.dataset.site = value;
    tag.title = "点击移除";
    tag.textContent = value;
    tagInput.insertBefore(tag, tagField);
    tagField.value = "";
    setPolicyDirty(true);
  });

  tagInput.addEventListener("click", (event) => {
    const tag = event.target.closest(".tag");
    if (!tag) return;
    tag.remove();
    setPolicyDirty(true);
  });

  $("#policyLog").addEventListener("change", () => setPolicyDirty(true));

  $("#policySave").addEventListener("click", () => {
    if (policyDraftMode === "blockall") {
      state.sites = [];
      state.policy.preset = "";
    } else {
      state.sites = draftSites();
      state.policy.preset = policyDraftPreset;
    }
    state.policy.mode = policyDraftMode;
    state.policy.log = $("#policyLog").checked;
    state.policy.procs = { mode: policyDraftProcMode, list: draftProcs() };
    state.presets = policyDraftPresets;

    policySaved = true;
    const modeText = { whitelist: "白名单", blacklist: "黑名单", blockall: "完全禁止" }[state.policy.mode];
    const detail =
      state.policy.mode === "blockall"
        ? "禁止访问任何网站"
        : `${modeText} ${state.sites.length} 个${state.policy.preset ? ` · ${state.policy.preset}` : ""}`;
    log("访问限制策略保存", detail);
    toast(`已保存 · ${detail}`);
    closeDialog(policyDialog);
    void API.send("policy", [], { ...state.policy, sites: state.sites, presets: state.presets });
  });

  $("#settingsSave").addEventListener("click", () => {
    state.settings.defaultSource = $("#setSource").value;
    state.settings.columns = $("#setColumns").value;
    state.columns =
      state.settings.columns === "每行 4 台" ? 4 : state.settings.columns === "每行 6 台" ? 6 : 0;
    settingsSaved = true;
    log("控制台设置保存", `${state.settings.defaultSource} · ${state.settings.columns}`);
    toast("控制台设置已保存");
    closeDialog(settingsDialog);
    render();
    void API.send("settings", [], {
      defaultSource: state.settings.defaultSource,
      columns: state.settings.columns
    });
  });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      $("#searchInput").focus();
      return;
    }
    if (event.key === "Escape" && dragState) {
      state.selected = new Set(dragState.base);
      dragState = null;
      dropMarquee();
      paintSelection();
      return;
    }

    if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
      const input = $("#searchInput");
      if (!input.value) return;
      input.value = "";
      state.query = "";
      render();
    }
  });

  /* ---------------- 时钟 ---------------- */
  function tick() {
    $("#clock").textContent = now();
  }

  /* ---------------- 启动 ---------------- */
  log("控制台就绪", `${MACHINES.length} 个座位`);
  renderLog();
  render();
  tick();
  window.setInterval(tick, 1000);

  // 有后端就以后端为准（本地双击打开时自动跳过）
  void API.init();
})();
