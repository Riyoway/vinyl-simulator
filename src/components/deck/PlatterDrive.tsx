import { useEffect, useLayoutEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Matrix4, Quaternion, Vector3 } from "three";
import type { ResolvedTurntable } from "../../model/manifest";
import {
  armDeckAudio,
  deckAudioTime,
  deckTelemetry,
  sendDeckInputs,
} from "../../audio/deckAudio";
import { effectiveTargetRpm } from "../../physics/pitch";
import { SPIN_ABOUT_WORLD_UP } from "../../physics/platterMotor";
import { yawForRadius } from "../../physics/tonearm";
import {
  activeTrim,
  handInput,
  motorTelemetry,
  stylusTelemetry,
  useDeckStore,
} from "../../store/useDeckStore";

const TWO_PI = Math.PI * 2;

/**
 * How far the followed arm must move before the store is written, in radians.
 * 1e-4 rad is 0.02mm at the stylus — invisible — and it keeps the groove's
 * 0.136mm per revolution from re-rendering React on every single frame.
 */
const FOLLOW_EPSILON = 1e-4;

/** Shortest way round, so crossing the ±π seam is not a full-turn spike. */
function wrapToPi(angle: number): number {
  return ((((angle + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

/**
 * Sends the deck's inputs to the audio thread and draws what comes back.
 *
 * **No physics runs here.** ω, φ and the groove cursor live in the
 * AudioWorklet and nowhere else, so this component integrates nothing — it
 * gathers pointer-side inputs, hands them over, and poses PIVOT_PLATTER from
 * the telemetry (audio-engine.md 8.1). Two integrators would drift apart
 * within seconds and the record would slide against its own audio.
 *
 * RECORD_ROOT sits under PIVOT_PLATTER in the GLB, so the record, its labels
 * and HIT_RECORD all inherit this one rotation.
 */
export function PlatterDrive({ parts }: { parts: ResolvedTurntable }) {
  const platter = parts.nodes.platter;

  const rest = useRef(new Quaternion());
  const axis = useRef(new Vector3(0, 1, 0));
  const spin = useRef(new Quaternion());
  const measured = useRef(false);
  const captured = useRef(false);
  /** The hand's angle last frame; NaN whenever nobody is holding the record. */
  const lastHandAngle = useRef(Number.NaN);

  // The deck has no power switch, so the first interaction is what powers it:
  // until the AudioContext runs there is no audio clock, and with no clock the
  // platter genuinely cannot turn (audio-engine.md 11.2 stage B).
  useEffect(() => {
    armDeckAudio();
  }, []);

  // Layout effect, and nothing spins before it: React defers passive effects
  // past the next paint, so the render loop can tick first and write an
  // uninitialised rest pose over the node's real one.
  useLayoutEffect(() => {
    rest.current.copy(platter.quaternion);
    measured.current = false;
    captured.current = true;
    const restPose = rest.current.clone();
    return () => {
      captured.current = false;
      platter.quaternion.copy(restPose);
    };
  }, [platter]);

  // The single-rotation assumption above is load-bearing: shout if the asset
  // ever changes so the record would need its own drive from this runtime.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let node = parts.nodes.recordRoot.parent;
    while (node && node !== platter) node = node.parent;
    if (!node) {
      console.warn(
        "RECORD_ROOT is no longer a descendant of PIVOT_PLATTER — it needs to be driven from the same telemetry",
      );
    }
  }, [parts, platter]);

  useFrame((_, delta) => {
    if (!captured.current) return;

    if (!measured.current) {
      // Spindle axis = world up, expressed in the pivot's own frame. Measured
      // rather than assumed, since the Y-up conversion may reorient it.
      const toLocal = new Matrix4().copy(platter.matrixWorld).invert();
      axis.current.set(0, 1, 0).transformDirection(toLocal).normalize();
      measured.current = true;
    }

    const store = useDeckStore.getState();

    // Contact is the press itself, not the movement: a hand resting on a
    // spinning record stops it, and that is a hand angle that is not changing.
    // Differentiating against the frame clock is what makes that fall out, and
    // it stays on this side so the feel is exactly what it was before the
    // physics moved (audio-engine.md 8.4 moves it across with the SAB work).
    let handAngularVelocity: number | null = null;
    if (store.pressedControlId === "record") {
      const angle = handInput.angle;
      if (Number.isFinite(angle)) {
        handAngularVelocity = Number.isFinite(lastHandAngle.current)
          ? wrapToPi(angle - lastHandAngle.current) / Math.max(delta, 1e-4)
          : 0;
        lastHandAngle.current = angle;
      } else {
        handAngularVelocity = 0;
      }
    } else {
      // Let go: the platter simply keeps the ω it already has. Both angles are
      // dropped so the next grab starts from wherever the pointer lands rather
      // than jumping the width of the gap since the last one.
      lastHandAngle.current = Number.NaN;
      handInput.angle = Number.NaN;
    }

    // The arm is an input only while a hand is on it. Let go and the groove
    // takes over — the spiral carries the stylus inward and this side just
    // poses the arm to match (audio-engine.md 10.2).
    const armHeld = store.pressedControlId === "tonearm";

    sendDeckInputs({
      motorRequested: store.motorRequested,
      // The selector's speed, trimmed for that speed, with the fader on top.
      targetRpm: effectiveTargetRpm(
        store.targetRpm,
        store.pitch,
        activeTrim(store),
      ),
      handAngularVelocity,
      stylusContact: store.stylusContact,
      stylusRadius: stylusTelemetry.radius,
      armHeld,
      // Latched at touchdown by the arm's own loop, and read on the audio
      // thread's rising edge — the drop's transient comes from the speed the
      // arm actually fell at, not from a stand-in.
      landingSpeed: stylusTelemetry.landingSpeed,
      // Where the tip is around the spindle. The groove's own radius comes back
      // from the audio side, but nothing over there knows which way the arm is
      // pointing — and the record's dust and scratches sit under a bearing, not
      // under a radius alone.
      stylusAzimuth: stylusTelemetry.azimuth,
    });

    // Follow the cut: the layout says which radius this many revolutions have
    // reached, and the arm goes there. Never the other way round — a radius
    // read back into the engine would close a loop and make the arm chase
    // itself. The write is thresholded because 0.136mm per revolution is far
    // finer than a frame, and every write is a React render.
    if (!armHeld && store.stylusContact) {
      const yaw = yawForRadius(deckTelemetry.stylusRadius);
      if (yaw !== null && Math.abs(yaw - store.tonearmYaw) > FOLLOW_EPSILON) {
        store.setTonearmYaw(yaw);
      }
    }

    // Extrapolate from the newest snapshot — φ + ω·Δt against the audio clock,
    // recomputed from scratch every frame. Nothing accumulates here, so this
    // is not a second integrator: it only fills the gap between the 60Hz
    // telemetry and this frame, which is what keeps the label from juddering.
    const now = deckAudioTime();
    const since = now - deckTelemetry.audioTime;
    const angle =
      Number.isFinite(since) && since >= 0 && since < 0.5
        ? deckTelemetry.phiWrapped + deckTelemetry.omega * since
        : deckTelemetry.phiWrapped;

    platter.quaternion
      .copy(rest.current)
      .multiply(
        spin.current.setFromAxisAngle(axis.current, angle * SPIN_ABOUT_WORLD_UP),
      );

    store.setMotorState(deckTelemetry.motorState); // no-op unless it changed
    motorTelemetry.currentRpm = deckTelemetry.currentRpm;
  });

  return null;
}
