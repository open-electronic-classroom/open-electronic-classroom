(() => {
  const params = new URLSearchParams(location.search);
  const pcId = params.get("pc") || "PC-01";

  const frame = document.getElementById("remoteFrame");
  const label = document.getElementById("remotePc");
  const stateText = document.getElementById("remoteState");
  const toggle = document.getElementById("remoteToggle");
  const closeBtn = document.getElementById("remoteClose");
  const lockText = document.getElementById("remoteLock");

  label.textContent = pcId;

  const api =
    location.protocol === "http:" || location.protocol === "https:"
      ? ""
      : null;

  let mode = "view";

  function paint() {
    const control = mode === "control";
    frame.dataset.mode = mode;
    stateText.dataset.mode = mode;
    stateText.textContent = control ? "控制中" : "观看";
    toggle.textContent = control ? "结束控制" : "开始控制";
    lockText.textContent = control ? "" : "观看模式";
    document.title = `${pcId} · ${control ? "控制中" : "观看"}`;
  }

  toggle.addEventListener("click", () => {
    mode = mode === "control" ? "view" : "control";
    paint();
  });

  closeBtn.addEventListener("click", () => window.close());

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (mode === "control") {
        mode = "view";
        paint();
      }
    }
  });

  // 屏幕上按一下 = 一次点击指令（控制模式下才生效）
  frame.addEventListener("pointerdown", (event) => {
    if (mode !== "control" || !api) return;
    const rect = frame.getBoundingClientRect();
    const x = Math.round(((event.clientX - rect.left) / rect.width) * 100);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * 100);
    void fetch(`${api}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "remote",
        machines: [pcId],
        payload: { click: [x, y] }
      })
    }).catch(() => {});
  });

  async function poll() {
    if (!api) return;
    try {
      const res = await fetch(`${api}/api/state`, { cache: "no-store" });
      const data = await res.json();
      const machine = (data.state.machines || []).find((m) => m.id === pcId);
      if (machine) {
        label.textContent = machine.id;
        if (mode === "view" && machine.state === "offline") {
          lockText.textContent = "离线";
        } else if (mode === "view") {
          lockText.textContent = "观看模式";
        }
      }
    } catch {
      /* 后端不可达时保持静态 */
    }
  }

  paint();
  void poll();
  window.setInterval(poll, 3000);
})();
