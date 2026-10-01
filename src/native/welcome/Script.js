"use strict";

const welcomeLocalization = window.MarginaWelcomeLocalization;
document.documentElement.lang = welcomeLocalization.language;
for (const element of document.querySelectorAll("[data-message]")) {
  element.textContent = welcomeLocalization.text(element.dataset.message);
}
document.querySelector(".steps").setAttribute("aria-label", welcomeLocalization.text("stepsLabel"));

function show(enabled, modernSettings) {
  const settings = welcomeLocalization.text(modernSettings === false ? "preferences" : "settings");
  const status = document.querySelector("#extension-status");
  const text = status.querySelector(".status-text");
  document.querySelector(".step-enable").textContent = welcomeLocalization.text("stepEnable", { settings });
  document.querySelector(".open-preferences").textContent = welcomeLocalization.text("openPreferences", { settings });
  const state = enabled === true ? "on" : enabled === false ? "off" : "unknown";
  status.dataset.state = state;
  text.textContent = welcomeLocalization.text(state === "on" ? "enabled" : state === "off" ? "disabled" : "unknown", { settings });
}

window.show = show;
show();

document.querySelector(".open-preferences").addEventListener("click", () => {
  try {
    const controller = window.webkit?.messageHandlers?.controller;
    if (!controller || typeof controller.postMessage !== "function") throw new Error("Native settings unavailable");
    controller.postMessage("open-preferences");
  } catch {
    const status = document.querySelector("#extension-status");
    status.dataset.state = "error";
    status.querySelector(".status-text").textContent = welcomeLocalization.text("bridgeError");
  }
});
