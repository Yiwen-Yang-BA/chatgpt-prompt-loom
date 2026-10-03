import {
  $,
  escape,
  uid,
  load,
  save,
  toast,
  download,
  copy,
  markdown,
  init,
  run,
  busy,
  resultMeta,
} from "./ui.js";
const key = "prompt-loom-v1";
let versions = load(key, []);
if (!Array.isArray(versions)) versions = [];
let values = {};
let latest;
let pending = false;
function vars() {
  const names = [
    ...new Set(
      [...$("#prompt").value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(
        (m) => m[1],
      ),
    ),
  ];
  values = Object.fromEntries(
    names.map((n) => [n, typeof values[n] === "string" ? values[n] : ""]),
  );
  $("#variables").innerHTML = names.length
    ? names
        .map(
          (n, i) =>
            `<label>${escape(n)}<input data-variable="${i}" value="${escape(values[n] || "")}" maxlength="2000" placeholder="填写 ${escape(n)}"></label>`,
        )
        .join("")
    : '<p class="muted">当前提示词没有变量，可以直接试运行。</p>';
  document.querySelectorAll("[data-variable]").forEach(
    (el) =>
      (el.oninput = () => {
        values[names[Number(el.dataset.variable)]] = el.value;
      }),
  );
}
function renderVersions() {
  $("#versions").innerHTML =
    versions
      .map(
        (v) =>
          `<article class="card"><div class="row between"><strong>${escape(v.name)}</strong><button class="small" data-restore="${escape(v.id)}">恢复</button></div><p class="hint">${escape(v.prompt.slice(0, 100))}${v.prompt.length > 100 ? "…" : ""}</p><button class="small ghost danger" data-remove="${escape(v.id)}">删除</button></article>`,
      )
      .join("") ||
    '<div class="empty"><p>保存一个版本，让尝试有迹可循。</p></div>';
}
function lock(on, button) {
  pending = on;
  busy(button, on);
  [
    "#prompt",
    "#tone",
    "#goal",
    "#sample",
    "#use",
    "#mode",
    "#test",
    "#optimize",
  ].forEach((s) => ($(s).disabled = on));
}
$("#sample").onclick = () => {
  $("#prompt").value = "请为 {{产品}} 写一段介绍，目标读者是 {{受众}}。";
  $("#goal").value = "提供可直接发布的文案，避免空泛夸张";
  values = { 产品: "帮助自由职业者整理发票的本地工具", 受众: "独立设计师" };
  vars();
};
$("#prompt").oninput = vars;
$("#optimize-form").onsubmit = async (e) => {
  e.preventDefault();
  if (pending) return;
  lock(true, $("#optimize"));
  try {
    const r = await run({
      action: "optimize",
      prompt: $("#prompt").value,
      goal:
        $("#goal").value.trim() || "让任务更具体、约束更清晰、输出更容易检查",
      tone: $("#tone").value,
    });
    latest = r.data;
    $("#optimized").value = latest.optimized;
    $("#changes").innerHTML = latest.changes
      .map((c) => "• " + escape(c))
      .join("<br>");
    $("#meta").innerHTML = resultMeta(r.meta);
    $("#optimized-empty").hidden = true;
    $("#optimized-area").hidden = false;
  } catch (e) {
    toast(e.message, true);
  } finally {
    lock(false, $("#optimize"));
  }
};
$("#use").onclick = () => {
  $("#prompt").value = $("#optimized").value;
  vars();
  toast("已将改进版本设为当前模板");
};
$("#copy").onclick = () => copy($("#optimized").value);
$("#test").onclick = async () => {
  if (pending) return;
  lock(true, $("#test"));
  try {
    const r = await run({
      action: "test",
      prompt: $("#prompt").value,
      variables: values,
    });
    $("#test-result").innerHTML =
      `<div class="meta">${resultMeta(r.meta)}</div>${markdown(r.data.text)}`;
  } catch (e) {
    toast(e.message, true);
  } finally {
    lock(false, $("#test"));
  }
};
$("#save-version").onclick = () => {
  const prompt = $("#prompt").value.trim();
  if (!prompt) return toast("请先填写提示词", true);
  if (versions.length >= 100)
    return toast("最多保存 100 个版本，请先导出并整理。", true);
  const next = [
    {
      id: uid(),
      name: $("#version-name").value.trim() || `版本 ${versions.length + 1}`,
      prompt,
      created: new Date().toISOString(),
    },
    ...versions,
  ];
  if (save(key, next)) {
    versions = next;
    renderVersions();
    toast("版本已保存");
  }
};
$("#versions").onclick = (e) => {
  const r = e.target.closest("[data-restore]");
  if (r && !pending) {
    $("#prompt").value = versions.find(
      (v) => v.id === r.dataset.restore,
    ).prompt;
    vars();
    toast("已恢复到当前模板");
  }
  const d = e.target.closest("[data-remove]");
  if (d) {
    const next = versions.filter((v) => v.id !== d.dataset.remove);
    if (save(key, next)) {
      versions = next;
      renderVersions();
    }
  }
};
$("#export").onclick = () =>
  download(
    "prompt-loom-versions.json",
    JSON.stringify(versions, null, 2),
    "application/json",
  );
await init();
renderVersions();
vars();

$("#export-prompt").onclick = () =>
  download("prompt-template.md", $("#prompt").value);
