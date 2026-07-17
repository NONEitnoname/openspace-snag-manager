const { computeCropRect } = require('../public/app');

/* The DOM/canvas/getDisplayMedia parts of the capture cannot run without a browser, but
   the geometry that decides which pixels are kept is pure — and it is the part that,
   wrong, would attach the wrong region of the screen to a finding. */

test('a 1:1 capture keeps exactly the viewer rect', () => {
  const rect = { left: 66, top: 346, width: 869, height: 558 };
  const crop = computeCropRect(rect, { width: 1512, height: 950 }, { width: 1512, height: 950 });
  expect(crop).toEqual({ x: 66, y: 346, width: 869, height: 558 });
});

test('a HiDPI frame scales the rect by the device pixel ratio', () => {
  // A 2x frame of a 1512x950 viewport: every coordinate doubles.
  const rect = { left: 100, top: 200, width: 400, height: 300 };
  const crop = computeCropRect(rect, { width: 1512, height: 950 }, { width: 3024, height: 1900 });
  expect(crop).toEqual({ x: 200, y: 400, width: 800, height: 600 });
});

test('a rect running past the frame edge is clamped, never over-read', () => {
  const rect = { left: 1400, top: 900, width: 400, height: 400 }; // extends beyond 1512x950
  const crop = computeCropRect(rect, { width: 1512, height: 950 }, { width: 1512, height: 950 });
  expect(crop.x + crop.width).toBeLessThanOrEqual(1512);
  expect(crop.y + crop.height).toBeLessThanOrEqual(950);
});

test('a negative offset (viewer scrolled above the fold) is clamped to zero', () => {
  const rect = { left: -50, top: -120, width: 800, height: 600 };
  const crop = computeCropRect(rect, { width: 1512, height: 950 }, { width: 1512, height: 950 });
  expect(crop.x).toBe(0);
  expect(crop.y).toBe(0);
});

test('a rect too small to be a real capture is rejected so the full frame is staged instead', () => {
  const tiny = { left: 10, top: 10, width: 20, height: 500 }; // 20px wide < 40px floor
  expect(computeCropRect(tiny, { width: 1512, height: 950 }, { width: 1512, height: 950 })).toBeNull();
  const shrunk = { left: 10, top: 10, width: 500, height: 500 };
  // A viewer that computes under 40px after downscaling also falls back.
  expect(computeCropRect(shrunk, { width: 1512, height: 950 }, { width: 100, height: 63 })).toBeNull();
});
