// An isolated design prototype: no extension APIs, persistence, clipboard or network.
const byId = (id) => document.getElementById(id);
const transcriptExample = byId("transcript").innerHTML;
const popovers = ["options", "attachMenu", "modelMenu"];
const triggers = ["optionsButton", "attachButton", "modelButton"];

function closeMenus() {
  popovers.forEach((id) => { byId(id).hidden = true; });
  triggers.forEach((id) => byId(id).setAttribute("aria-expanded", "false"));
}

function toggleMenu(index) {
  const open = byId(popovers[index]).hidden;
  closeMenus();
  byId(popovers[index]).hidden = !open;
  byId(triggers[index]).setAttribute("aria-expanded", String(open));
  if (open) byId(popovers[index]).querySelector("button").focus();
}
triggers.forEach((id, index) => byId(id).addEventListener("click", () => toggleMenu(index)));

function showHistory(show) {
  closeMenus();
  byId("history").hidden = !show;
  byId("chat").hidden = show;
  byId("sidebarTitle").textContent = show ? "對話紀錄" : "Margina";
  byId("historyButton").setAttribute("aria-expanded", String(show));
  byId("historyButton").setAttribute("aria-label", show ? "返回對話" : "顯示對話紀錄");
  if (show) byId("historySearch").focus();
}
byId("historyButton").addEventListener("click", () => showHistory(byId("history").hidden));

function showChat(empty = false) {
  showHistory(false);
  byId("transcript").hidden = empty;
  byId("empty").hidden = !empty;
  byId("notice").hidden = true;
  byId("prompt").value = "";
  byId("sendButton").disabled = true;
  byId("attachments").replaceChildren();
  byId("attachments").hidden = true;
  if (!empty) byId("transcript").innerHTML = transcriptExample;
  byId("prompt").focus();
}
byId("newButton").addEventListener("click", () => showChat(true));
byId("emptyButton").addEventListener("click", () => showChat(true));
byId("exampleButton").addEventListener("click", () => showChat(false));
document.querySelectorAll("[data-conversation]").forEach((button) => button.addEventListener("click", () => {
  showChat(false);
  if (button.dataset.conversation !== "潮汐與月球引力") {
    byId("transcript").querySelector(".question").textContent = "幫我整理這篇文章的重點";
  }
}));
byId("historySearch").addEventListener("input", (event) => {
  let matches = 0;
  document.querySelectorAll("[data-conversation]").forEach((button) => {
    button.hidden = !button.dataset.conversation.includes(event.target.value.trim());
    if (!button.hidden) matches++;
  });
  byId("noResults").hidden = matches > 0;
});
byId("appearanceButton").addEventListener("click", () => {
  const dark = document.documentElement.dataset.appearance !== "dark";
  document.documentElement.dataset.appearance = dark ? "dark" : "light";
  byId("appearanceButton").textContent = dark ? "淺色外觀" : "深色外觀";
  byId("appearanceButton").setAttribute("aria-pressed", String(dark));
});
byId("pageButton").addEventListener("click", () => {
  const enabled = byId("pageButton").getAttribute("aria-pressed") !== "true";
  byId("pageButton").setAttribute("aria-pressed", String(enabled));
  byId("pageButton").querySelector("small").textContent = enabled ? "目前的頁面" : "不附上頁面";
});
byId("prompt").addEventListener("input", () => {
  byId("sendButton").disabled = !byId("prompt").value.trim();
});
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
  byId("prompt").value = button.dataset.prompt;
  byId("sendButton").disabled = false;
  byId("prompt").focus();
}));
document.querySelectorAll("[data-model]").forEach((button) => button.addEventListener("click", () => {
  byId("modelButton").firstChild.textContent = `${button.dataset.model} `;
  closeMenus();
  byId("modelButton").focus();
}));
document.querySelectorAll("[data-attachment]").forEach((button) => button.addEventListener("click", () => {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.textContent = `${button.dataset.attachment} ×`;
  chip.setAttribute("aria-label", `移除示意附件：${button.dataset.attachment}`);
  chip.addEventListener("click", () => {
    chip.remove();
    byId("attachments").hidden = !byId("attachments").children.length;
  });
  if (byId("attachments").children.length < 4) byId("attachments").append(chip);
  byId("attachments").hidden = false;
  closeMenus();
  byId("attachButton").focus();
}));
function notice(message) {
  byId("notice").textContent = message;
  byId("notice").hidden = false;
}
byId("transcript").addEventListener("click", (event) => {
  if (event.target.closest("#copyButton")) notice("這是外觀樣稿，沒有改動你的剪貼簿。");
});
byId("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const question = byId("prompt").value.trim();
  if (!question) return;
  byId("empty").hidden = true;
  byId("transcript").hidden = false;
  const message = document.createElement("div");
  message.className = "question";
  message.textContent = question;
  byId("transcript").append(message);
  byId("transcript").scrollTop = byId("transcript").scrollHeight;
  byId("prompt").value = "";
  byId("sendButton").disabled = true;
  notice("僅預覽問題的顯示方式；沒有送出至 AI。");
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".popover") && !triggers.some((id) => byId(id).contains(event.target))) closeMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const openIndex = popovers.findIndex((id) => !byId(id).hidden);
  closeMenus();
  if (openIndex >= 0) byId(triggers[openIndex]).focus();
  else if (!byId("history").hidden) { showHistory(false); byId("historyButton").focus(); }
});
