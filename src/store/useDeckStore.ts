import { create } from "zustand";
import type { TrackInfo } from "../audio/trackSource";
import type { ControlId } from "../model/manifest";
import { clampPitch, clampTrim } from "../physics/pitch";
import { clampTonearmLift, clampTonearmYaw } from "../physics/tonearm";
import type { GrooveZone } from "../physics/groove";
import type { MotorState } from "../physics/platterMotor";

/** The deck runs at the two speeds its selector is printed with — 78 is out of scope (rdd.md 3.2). */
export type TargetRpm = 33.333 | 45;

/** The two speeds the deck's "45 / 33" selector switches between. */
const SELECTABLE_RPM: TargetRpm[] = [33.333, 45];

/**
 * Serialisable UI state only — no Object3D/Mesh references (those stay in the
 * scene graph) and nothing that changes every frame, so React never re-renders
 * on the render loop. The authoritative physics/transport state will live in
 * the AudioWorklet later (rdd.md 4.2 / 31).
 */
/** Which SPEED CONTROL trim a knob writes. Left knob is 45, right is 33⅓. */
export type TrimKey = "trim33" | "trim45";

/** Whether a record is on the deck, and how that attempt went. */
export type TrackStatus = "empty" | "loading" | "ready" | "error";

/**
 * How much of the record has been worn away by playing it. Plain numbers, so
 * this can be saved next to the track's other facts; the shape it describes
 * lives in the audio thread.
 */
export interface DiscWear {
  /** Sides played: contact distance / this side's groove length. */
  plays: number;
  /** Worst-worn spot on the disc, 0..1. */
  peak: number;
  /** Average over the whole side, 0..1. */
  mean: number;
}

export interface DeckState {
  hoveredControlId: ControlId | null;
  pressedControlId: ControlId | null;
  /**
   * Bumped on every press. Drag handlers compare it to know a new grab has
   * started: they cannot ask React, whose effects may not have run yet when the
   * next press arrives, and a stale grab reference makes a control jump.
   */
  pressSeq: number;

  /** The operator's intent, not the motor's actual condition. */
  motorRequested: boolean;
  /** Discrete phase, written only on transitions. */
  motorState: MotorState;
  targetRpm: TargetRpm;
  /**
   * Fader deflection, −0.08…+0.08. Currently only ever 0: the drag is not
   * wired up, so nothing moves CTRL_PITCH from its pose in the GLB.
   */
  pitch: number;
  /**
   * SPEED CONTROL trims, −0.02…+0.02 each. Held independently and applied one
   * at a time: only the trim belonging to the selected speed reaches the motor.
   */
  trim33: number;
  trim45: number;
  /**
   * Arm angle in radians from its pose in the GLB: 0 on the rest, negative
   * swung in over the record. Stylus contact and seeking are not wired yet.
   */
  tonearmYaw: number;
  /**
   * Arm lift in radians above its pose in the GLB: 0 is down, positive is a
   * hand holding it up. Released, it falls back to 0 — this deck has no cueing
   * lever to park it. Only transient (a drag or a 0.3s drop) ever writes it.
   */
  tonearmLift: number;
  /**
   * Whether the stylus is resting on the record's surface. Physical state, not
   * a rendering detail: audio will gate on it. False on the arm rest, false
   * whenever the arm is held above the disc.
   */
  stylusContact: boolean;
  /**
   * Which part of the disc the stylus tip is over, from its distance to the
   * spindle alone. Discrete and written only on transitions, like motorState —
   * the continuous radius lives in stylusTelemetry.
   */
  grooveZone: GrooveZone;

  /**
   * How worn the record on the deck is. **Summary only** — the wear field
   * itself is a couple of megabytes of Float32Array living in the audio
   * thread (audio/engine/wear.ts), and nothing unserialisable belongs in
   * here. Written on transitions, like motorState: the audio side reports at
   * ~60Hz but a single play only moves this by 1e-4, so deckAudio passes it
   * through when the rounded value actually changes.
   *
   * `plays` counts sides played (contact distance / this side's groove
   * length), not button presses — scrubbing back and forth wears the record
   * exactly as much as the distance covered.
   */
  discWear: DiscWear;

  /**
   * The loaded track's serialisable facts, or null when the deck is empty. The
   * AudioBuffer and the File behind it stay in `trackRuntime` (audio/
   * trackSource) — nothing unserialisable belongs in here.
   */
  track: TrackInfo | null;
  trackStatus: TrackStatus;
  /** Ready for the screen as-is. Null unless `trackStatus === "error"`. */
  trackError: string | null;

  setHoveredControl: (id: ControlId | null) => void;
  pressControl: (id: ControlId) => void;
  releaseControl: (id: ControlId) => void;
  cancelInteraction: () => void;
  requestMotorToggle: () => void;
  toggleTargetRpm: () => void;
  setPitch: (pitch: number) => void;
  setTrim: (which: TrimKey, trim: number) => void;
  setTonearmYaw: (yaw: number) => void;
  /** `floor` is whatever surface is under the stylus right now, in radians. */
  setTonearmLift: (lift: number, floor?: number) => void;
  setStylusContact: (contact: boolean) => void;
  setGrooveZone: (zone: GrooveZone) => void;
  setDiscWear: (wear: DiscWear) => void;
  beginTrackLoad: () => void;
  setTrack: (track: TrackInfo) => void;
  setTrackError: (message: string) => void;
  setMotorState: (state: MotorState) => void;
}

/** The trim that is live right now — the other knob's value just sits there. */
export const activeTrim = (state: DeckState): number =>
  state.targetRpm === 45 ? state.trim45 : state.trim33;

/**
 * Dev-only readout for values that change every frame. Deliberately a plain
 * object: writing it must never schedule a React render.
 */
export const motorTelemetry = { currentRpm: 0 };

/**
 * Where a hand on the record currently sits, in radians about the spindle in a
 * world-fixed frame — NaN until a pointer has landed on the record.
 *
 * Deliberately a plain object, like motorTelemetry: this changes with every
 * pointer move and is read by the render loop, so it must never be React state.
 * The interaction layer writes the angle; the drive turns it into an angular
 * velocity against its own frame clock, which is what makes holding the record
 * still (no movement, so no angle change) stop it.
 */
export const handInput = { angle: Number.NaN };

/**
 * Where the stylus tip is on the disc, per frame. A plain object for the same
 * reason as motorTelemetry: swinging the arm changes this continuously.
 *
 * `radius` is the horizontal distance from the tip to the spindle, in metres,
 * and every position question is answered from it — NaN until the asset has
 * been measured, which is a missing measurement rather than a missing place.
 *
 * `groovePosition` is 0…1 across the recorded programme, and **null** whenever
 * there is nothing to play there: outside the program area, or with the stylus
 * off the record (rdd.md 10.5). Null, not NaN, because "no position" is a
 * different fact from "a position that failed to compute" — and because null
 * survives a `=== null` test where NaN quietly passes `< 0 || > 1`.
 *
 * `azimuth` is the tip's bearing about the spindle, in radians, signed the same
 * way the platter turns — so "which bit of the record is under the stylus" is
 * `azimuth − platterAngle`. The arm sweeps about 14° from the outer groove to
 * the inner one, which is why the disc's own rotation is not the whole story.
 *
 * `recordRadius` / `recordAngle` are the same point expressed in the record's own
 * frame — off the groove's centre rather than the spindle's, so an eccentric disc
 * is accounted for — and `surfaceHeight` is how high the record is there. This is
 * the coordinate system the audio thread indexes dust, scratches and warp by, so
 * anything that draws on the record should use it too.
 *
 * `landingSpeed` is how fast the tip was coming down when it last touched the
 * record, in metres per second — the impact the audio thread turns into a
 * needle-drop transient. It is latched at the touchdown, not published live:
 * the fall's velocity is already zero by the time the frame that landed it has
 * finished, so reading it afterwards would always give a silent, gentle drop.
 */
export const stylusTelemetry: {
  radius: number;
  groovePosition: number | null;
  landingSpeed: number;
  azimuth: number;
  recordRadius: number;
  recordAngle: number;
  surfaceHeight: number;
} = {
  radius: Number.NaN,
  groovePosition: null,
  landingSpeed: 0,
  azimuth: Number.NaN,
  recordRadius: Number.NaN,
  recordAngle: 0,
  surfaceHeight: 0,
};

export const useDeckStore = create<DeckState>((set) => ({
  hoveredControlId: null,
  pressedControlId: null,
  pressSeq: 0,

  motorRequested: false,
  motorState: "stopped",
  targetRpm: 33.333,
  pitch: 0,
  trim33: 0,
  trim45: 0,
  tonearmYaw: 0,
  tonearmLift: 0,
  stylusContact: false,
  grooveZone: "outside",
  discWear: { plays: 0, peak: 0, mean: 0 },

  track: null,
  trackStatus: "empty",
  trackError: null,

  setHoveredControl: (id) =>
    set((s) => (s.hoveredControlId === id ? s : { hoveredControlId: id })),

  pressControl: (id) =>
    set((s) => ({ pressedControlId: id, pressSeq: s.pressSeq + 1 })),

  // Only the control that is actually held can end the press.
  releaseControl: (id) =>
    set((s) => (s.pressedControlId === id ? { pressedControlId: null } : s)),

  cancelInteraction: () =>
    set((s) => (s.pressedControlId === null ? s : { pressedControlId: null })),

  requestMotorToggle: () =>
    set((s) => ({ motorRequested: !s.motorRequested })),

  // The "45 / 33" selector. Changing speed while running just gives the motor a
  // new target — it ramps there instead of stopping.
  toggleTargetRpm: () =>
    set((s) => {
      const next =
        SELECTABLE_RPM[(SELECTABLE_RPM.indexOf(s.targetRpm) + 1) % SELECTABLE_RPM.length] ??
        SELECTABLE_RPM[0];
      return { targetRpm: next };
    }),

  // Clamped and centre-snapped on the way in, so no caller can put an
  // out-of-range pitch in front of the motor. Held after release: the fader is
  // where the user left it.
  setPitch: (pitch) =>
    set((s) => {
      const next = clampPitch(pitch);
      return s.pitch === next ? s : { pitch: next };
    }),

  // Same trust boundary as setPitch, and the two trims never touch each other.
  setTrim: (which, trim) =>
    set((s) => {
      const next = clampTrim(trim);
      return s[which] === next ? s : ({ [which]: next } as Pick<DeckState, TrimKey>);
    }),

  // Clamped to the arm's real travel: rest at one end, label edge at the other.
  setTonearmYaw: (yaw) =>
    set((s) => {
      const next = clampTonearmYaw(yaw);
      return s.tonearmYaw === next ? s : { tonearmYaw: next };
    }),

  setTonearmLift: (lift, floor = 0) =>
    set((s) => {
      const next = clampTonearmLift(lift, floor);
      return s.tonearmLift === next ? s : { tonearmLift: next };
    }),

  setStylusContact: (contact) =>
    set((s) => (s.stylusContact === contact ? s : { stylusContact: contact })),

  // Same free per-frame call as setMotorState: nobody is notified unless the
  // stylus actually crossed into another part of the disc.
  setGrooveZone: (zone) =>
    set((s) => (s.grooveZone === zone ? s : { grooveZone: zone })),

  setDiscWear: (wear) => set({ discWear: wear }),

  // One record at a time: the old one comes off the moment a new one goes on,
  // so no state can be left describing a track whose buffer has been dropped.
  // The caller disposes the runtime side in the same breath.
  beginTrackLoad: () =>
    set({ track: null, trackStatus: "loading", trackError: null }),

  setTrack: (track) => set({ track, trackStatus: "ready", trackError: null }),

  setTrackError: (message) =>
    set({ track: null, trackStatus: "error", trackError: message }),

  // Returning the same state object means Zustand notifies nobody, so the
  // per-frame call from the render loop is free unless the phase changed.
  setMotorState: (state) =>
    set((s) => (s.motorState === state ? s : { motorState: state })),
}));

// Dev-only handles. Let a control be parked on an exact value while checking it
// against the panel's printing, instead of dragging pixel-perfectly, and let
// the hand's angle be read back without a frame having to run.
if (import.meta.env.DEV) {
  const dev = globalThis as {
    deckStore?: typeof useDeckStore;
    handInput?: typeof handInput;
  };
  dev.deckStore = useDeckStore;
  dev.handInput = handInput;
}
