(() => {
  const key = document.body.dataset.relayKey;
  delete document.body.dataset.relayKey;
  const frame = document.getElementById("provider");
  document.getElementById("load").addEventListener("click", () => {
    document.getElementById("status").textContent = "正在載入；頁框載入不代表登入或對話已驗證。";
    frame.src = `/?__safai_key=${encodeURIComponent(key)}`;
  });
})();
