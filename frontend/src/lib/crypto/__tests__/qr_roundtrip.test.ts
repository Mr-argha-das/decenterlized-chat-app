import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jsQR from "jsqr";
import QRCode from "qrcode";

function parseRelayChatQrUri(raw: string): string {
  let cleaned = raw.trim();
  for (const prefix of [
    "relaychat://",
    "relaychat:",
    "web+relaychat://",
    "web+relaychat:",
  ]) {
    if (cleaned.toLowerCase().startsWith(prefix)) {
      cleaned = cleaned.slice(prefix.length).replace(/^\/+/, "");
      break;
    }
  }
  return cleaned.trim().toLowerCase();
}

describe("RelayChat Contact QR Code Generator + Scanner Roundtrip", () => {
  it("encodes relaychat:rahul@chatapp.in into a QR matrix and decodes it back via jsQR", () => {
    const uri = "relaychat:rahul@chatapp.in";
    const qr = QRCode.create(uri, { errorCorrectionLevel: "M" });

    const moduleCount = qr.modules.size;
    const scale = 6;
    const quietZone = 4;
    const width = (moduleCount + quietZone * 2) * scale;
    const rgba = new Uint8ClampedArray(width * width * 4);

    // Fill white background
    rgba.fill(255);

    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        const isDark = qr.modules.get(row, col);
        if (!isDark) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = (col + quietZone) * scale + dx;
            const py = (row + quietZone) * scale + dy;
            const idx = (py * width + px) * 4;
            rgba[idx] = 17;
            rgba[idx + 1] = 27;
            rgba[idx + 2] = 33;
            rgba[idx + 3] = 255;
          }
        }
      }
    }

    const decoded = jsQR(rgba, width, width);
    assert.ok(decoded, "jsQR should decode the generated QR pixel buffer");
    assert.equal(decoded.data, uri);
    assert.equal(parseRelayChatQrUri(decoded.data), "rahul@chatapp.in");
  });
});
