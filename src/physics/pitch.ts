/**
 * Speed corrections: the pitch fader and the two SPEED CONTROL trims.
 *
 * Pure and dependency-free for the same reason as platterMotor: the effective
 * rpm is what the AudioWorklet will resample against once audio owns the clock
 * (rdd.md 4.2 / 9). The fader's travel lives here too so the view has one place
 * to read it from and the deterministic check can assert the millimetres.
 */

export const PITCH = {
  /** ±8 %, as printed on the panel. */
  max: 0.08,
  /**
   * Metres from the printed 0 to the printed ±8: how far the cap's index line
   * travels at full deflection.
   *
   * The marks live in the panel texture, so this cannot come from the GLB's
   * geometry. Measured off the render instead: moving the cap a known 12mm
   * shifted it 45px in a top-down screenshot (3.75 px/mm — cross-checked
   * against the 35.7mm Start/Stop base ring at 130px), and the printed 0→8
   * span measures 242px. It is deliberately NOT bounded by the slot or the
   * cap's bounding box: the cap rides over the panel and only its guide runs
   * inside the slot, so overhanging the slot ends is correct.
   */
  travelMetres: 0.0645,
  /**
   * Where the printed 0 is, as a signed distance from the cap's rest pose in the
   * asset — measured along the same axis these offsets are expressed in (the
   * pitch collider's local +X). The asset does not park the cap on the zero
   * mark, and the value is read off the cap's index line (the gold/dark edge,
   * 8mm off the cap's centre) rather than the centre, so both land here.
   *
   * Solved from two readings of the printed scale: the cap read +0.75 of a mark
   * at one setting and +1.54 at another 6.05mm away, which puts the printed zero
   * 27.15mm from the rest pose (and confirms 8.06mm per mark independently).
   * **The rest pose sits at about +3.4 on the printed scale**, i.e. already past
   * zero on the plus side — so zero lies 27.15mm back down the scale, and this
   * is negative.
   */
  zeroOffsetMetres: -0.02715,
  /**
   * Centre detent: anything inside this reads as exactly 0, so the platter can
   * be put back on the nominal speed without pixel-perfect dragging. 0.002 is
   * 0.2 % of pitch, i.e. the middle 0.3 mm of the slot.
   */
  snap: 0.002,
};

/** The trust boundary for pitch: pointer maths and presets both come through here. */
export function clampPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return 0;
  if (Math.abs(pitch) < PITCH.snap) return 0;
  return Math.min(Math.max(pitch, -PITCH.max), PITCH.max);
}

/**
 * Where the cap sits for a value: metres from its rest pose in the asset, along
 * the pitch collider's local +X.
 *
 * **The printed scale runs with that axis: +8 is the +X end, −8 the −X end.**
 * Both directions of the conversion come from here, so the sign cannot disagree
 * between "where to draw the cap" and "what the cap under the pointer reads" —
 * which is exactly how the two ends once ended up swapped while the round trip
 * still looked self-consistent.
 */
export function pitchToOffsetMetres(pitch: number): number {
  return (
    PITCH.zeroOffsetMetres + (clampPitch(pitch) / PITCH.max) * PITCH.travelMetres
  );
}

/** Inverse of the above: what a point along the slot reads as. */
export function offsetMetresToPitch(metres: number): number {
  return ((metres - PITCH.zeroOffsetMetres) / PITCH.travelMetres) * PITCH.max;
}

/**
 * SPEED CONTROL trims. One per selectable speed, each a small correction to the
 * nominal rpm — the calibration a deck's service trimmer performs, which the
 * pitch fader then works on top of. Separate from pitch: the fader is a
 * performance control, these are set once and left alone.
 */
export const SPEED_TRIM = {
  /** Fully deflected, a trim shifts its speed by this fraction (±2 %). */
  max: 0.02,
  /** Knob rotation at full deflection: ±135°, i.e. 270° end to end. */
  maxAngleRadians: (135 * Math.PI) / 180,
};

/** The trust boundary for a trim, mirroring clampPitch. */
export function clampTrim(trim: number): number {
  if (!Number.isFinite(trim)) return 0;
  return Math.min(Math.max(trim, -SPEED_TRIM.max), SPEED_TRIM.max);
}

/** Knob angle for a trim value, radians. Clockwise from above is positive trim. */
export function trimToAngleRadians(trim: number): number {
  return (clampTrim(trim) / SPEED_TRIM.max) * SPEED_TRIM.maxAngleRadians;
}

/** Inverse: how much trim a given knob rotation is worth. */
export function angleRadiansToTrim(angle: number): number {
  return (angle / SPEED_TRIM.maxAngleRadians) * SPEED_TRIM.max;
}

/**
 * What the motor actually chases. `targetRpm` itself is never rewritten — the
 * selector stays on 33⅓ or 45, the trim calibrates that nominal speed, and
 * pitch is a multiplier on top of the calibrated value.
 */
export function effectiveTargetRpm(
  targetRpm: number,
  pitch: number,
  trim = 0,
): number {
  return targetRpm * (1 + clampTrim(trim)) * (1 + clampPitch(pitch));
}
