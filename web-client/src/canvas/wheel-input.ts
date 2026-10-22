type WheelInput = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'timeStamp'> & {
  wheelDeltaY?: number;
};

/** WheelEvent has no device type. Keep precise scroll bursts distinct from notches. */
export function createWheelInputClassifier() {
  let trackpadUntil = -Infinity;
  return (event: WheelInput, pixelRatio = 1): 'pan' | 'zoom' => {
    if (event.deltaMode !== 0) return 'zoom';
    const precise = () => {
      trackpadUntil = event.timeStamp + 200;
      return 'pan' as const;
    };
    if (event.deltaX !== 0) return precise();
    const legacy = event.wheelDeltaY;
    if (legacy && event.deltaY && Math.sign(legacy) !== Math.sign(event.deltaY)) {
      // macOS Chromium encodes continuous scrolling at -3 legacy units/pixel,
      // including fast, purely vertical trackpad strokes and their momentum.
      if (Math.abs(legacy + 3 * event.deltaY) <= 1) return precise();
      const notches = Math.abs(legacy * pixelRatio) / 120;
      if (notches >= 1 && Math.abs(notches - Math.round(notches)) < 0.01) return 'zoom';
    }
    if (Math.abs(event.deltaY) < 50 || !Number.isInteger(event.deltaY)) return precise();
    return event.timeStamp < trackpadUntil ? precise() : 'zoom';
  };
}
