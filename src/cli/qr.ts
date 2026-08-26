import qrcode from "qrcode-terminal";

/** Render a compact QR code suitable for an interactive terminal prompt. */
export function terminalQrCode(value: string): string {
  let output = "";
  qrcode.generate(value, { small: true }, (code) => {
    output = code;
  });
  return output;
}
