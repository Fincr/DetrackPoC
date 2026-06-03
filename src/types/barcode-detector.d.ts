// Ambient types for the native BarcodeDetector API (Chromium shape) — not yet
// in lib.dom. https://developer.mozilla.org/docs/Web/API/BarcodeDetector
interface DetectedBarcode {
  rawValue: string
  format: string
}

declare class BarcodeDetector {
  constructor(options?: { formats?: string[] })
  static getSupportedFormats(): Promise<string[]>
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}

interface Window {
  BarcodeDetector?: typeof BarcodeDetector
}
