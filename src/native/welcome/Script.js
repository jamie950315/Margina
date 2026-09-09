"use strict";

function show(enabled, modernSettings) {
  const settings = modernSettings === false ? "偏好設定" : "設定";
  const status = document.querySelector("#extension-status");
  const text = status.querySelector(".status-text");
  document.querySelector(".settings-name").textContent = settings;
  document.querySelector(".open-preferences").textContent = `開啟 Safari 擴充功能${settings}`;
  if (enabled === true) {
    status.dataset.state = "on";
    text.textContent = "擴充功能已啟用，回到 Safari 即可開始使用。";
  } else if (enabled === false) {
    status.dataset.state = "off";
    text.textContent = `擴充功能尚未啟用，請在 Safari ${settings}中開啟。`;
  } else {
    status.dataset.state = "unknown";
    text.textContent = `尚未確認擴充功能狀態，可到 Safari ${settings}中查看。`;
  }
}

window.show = show;

document.querySelector(".open-preferences").addEventListener("click", () => {
  try {
    const controller = window.webkit?.messageHandlers?.controller;
    if (!controller || typeof controller.postMessage !== "function") throw new Error("Native settings unavailable");
    controller.postMessage("open-preferences");
  } catch {
    const status = document.querySelector("#extension-status");
    status.dataset.state = "error";
    status.querySelector(".status-text").textContent = "無法直接開啟設定，請到 Safari 的擴充功能設定中啟用 SafAI。";
  }
});
