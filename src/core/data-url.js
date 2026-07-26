export function dataUrlToBlob(value) {
  const dataUrl = String(value ?? "");
  const match = /^data:([^;,]*)(;[^,]*)?,([\s\S]*)$/i.exec(dataUrl);
  if (!match) throw new TypeError("需要有效的 data URL");

  const mimeType = match[1] || "application/octet-stream";
  const parameters = match[2] || "";
  const payload = match[3];
  let bytes;

  if (/(?:^|;)base64(?:;|$)/i.test(parameters)) {
    const binary = atob(payload.replace(/\s+/g, ""));
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }

  return new Blob([bytes], { type: mimeType });
}
