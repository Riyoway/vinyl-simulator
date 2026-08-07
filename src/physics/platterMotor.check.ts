/**
 * Deterministic self-check for the pure physics: stepPlatterMotor and the pitch
 * mapping. No test framework — compile and run it directly:
 *
 *   npm run check:physics
 *
 * which is:
 *
 *   npx tsc --ignoreConfig src/physics/platterMotor.ts src/physics/pitch.ts \
 *     src/physics/tonearm.ts src/physics/groove.ts \
 *     src/physics/platterMotor.check.ts \
 *     --outDir <tmp> --module commonjs --target es2022
 *   node <tmp>/platterMotor.check.js
 *
 * `--ignoreConfig` is required: naming files on the command line while a
 * tsconfig.json is present is an error (TS5112) without it.
 */
import {
  PITCH,
  SPEED_TRIM,
  angleRadiansToTrim,
  clampPitch,
  clampTrim,
  effectiveTargetRpm,
  offsetMetresToPitch,
  pitchToOffsetMetres,
  trimToAngleRadians,
} from "./pitch";
import {
  IDEAL_TONEARM,
  TONEARM,
  TONEARM_GEOMETRY,
  clampTonearmLift,
  clampTonearmYaw,
  createTonearmVertical,
  effectiveMassToPivotInertia,
  liftAngleForSurface,
  stepTonearmFall,
  type LiftFall,
  type TonearmSuspension,
  type TonearmVertical,
  type TonearmVerticalParameters,
} from "./tonearm";
import { GROOVE, grooveZoneAt, groovePositionAt } from "./groove";
import {
  MOTOR_TUNING,
  radPerSecToRpm,
  rpmToRadPerSec,
  stepPlatterMotor,
  type MotorInput,
  type MotorRuntime,
} from "./platterMotor";
import {
  createWowFlutter,
  IDEAL_WOW_FLUTTER,
  torqueForSpeedRatio,
  type WowFlutterParameters,
} from "./wowFlutter";

const TARGET_RPM = 33.333;
let failures = 0;

function check(label: string, condition: boolean, detail: unknown = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label} ${JSON.stringify(detail)}`);
  }
}

/** Runs the motor for `seconds`, stepping at a fixed rate. */
function run(
  runtime: MotorRuntime,
  seconds: number,
  stepSeconds: number,
  input: Omit<MotorInput, "deltaSeconds">,
) {
  const steps = Math.round(seconds / stepSeconds);
  let last = stepPlatterMotor(runtime, { ...input, deltaSeconds: 0 });
  for (let i = 0; i < steps; i++) {
    last = stepPlatterMotor(runtime, { ...input, deltaSeconds: stepSeconds });
    runtime.angle = last.angle;
    runtime.angularVelocity = last.angularVelocity;
  }
  return last;
}

const spinning = {
  motorRequested: true,
  targetRpm: TARGET_RPM,
  handAngularVelocity: null,
};
const idle = {
  motorRequested: false,
  targetRpm: TARGET_RPM,
  handAngularVelocity: null,
};
/** Same as `input`, but with a hand on the record asking for `omega`. */
const withHand = (input: Omit<MotorInput, "deltaSeconds">, omega: number) => ({
  ...input,
  handAngularVelocity: omega,
});

console.log("stepPlatterMotor");

// Spin-up reaches the target within the quoted time.
{
  const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
  const out = run(runtime, MOTOR_TUNING.spinUpSeconds, 1 / 60, spinning);
  check(
    "reaches target rpm after spinUpSeconds",
    Math.abs(out.currentRpm - TARGET_RPM) <= MOTOR_TUNING.runningToleranceRpm,
    out.currentRpm,
  );
  check("state is running", out.state === "running", out.state);
}

// Braking stops within the quoted time.
{
  const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
  run(runtime, 2, 1 / 60, spinning);
  const mid = run(runtime, 0.2, 1 / 60, idle);
  check("braking state while slowing", mid.state === "braking", mid.state);

  const out = run(runtime, MOTOR_TUNING.brakeSeconds, 1 / 60, idle);
  check("stopped after brakeSeconds", out.state === "stopped", out.state);
  check("rpm is exactly zero once stopped", out.currentRpm === 0, out.currentRpm);
}

// The servo holds the nominal speed instead of drooping under friction —
// this ω becomes the audio playback rate later.
{
  const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
  const out = run(runtime, 2, 1 / 60, spinning);
  check(
    "settles on nominal rpm without droop",
    Math.abs(out.currentRpm - TARGET_RPM) < 0.01,
    out.currentRpm,
  );

  const slower = run(runtime, 2, 1 / 60, { ...spinning, targetRpm: 45 });
  check("tracks a speed change up", Math.abs(slower.currentRpm - 45) < 0.01, slower.currentRpm);
  const back = run(runtime, 2, 1 / 60, spinning);
  check(
    "tracks a speed change down",
    Math.abs(back.currentRpm - TARGET_RPM) < 0.01,
    back.currentRpm,
  );
}

// The brake is speed-dependent: firm from speed, handed over to bearing
// friction near zero rather than clamping the platter to a halt.
{
  const decelAt = (omega: number) => {
    const runtime: MotorRuntime = { angle: 0, angularVelocity: omega };
    const out = stepPlatterMotor(runtime, { ...idle, deltaSeconds: 1 / 240 });
    return (omega - out.angularVelocity) * 240;
  };
  const fromSpeed = decelAt(rpmToRadPerSec(TARGET_RPM));
  const nearRest = decelAt(0.05);
  check("brake is firm at speed", fromSpeed >= 4, fromSpeed);
  check("brake tapers near rest", nearRest < fromSpeed * 0.5, {
    fromSpeed,
    nearRest,
  });
  check("no torque applied at rest", decelAt(0) === 0);
}

// Braking is monotonic and never leaves the platter creeping near zero.
{
  const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
  run(runtime, 2, 1 / 60, spinning);
  let previous = Infinity;
  let monotonic = true;
  let stoppedAfter = Infinity;
  for (let i = 0; i < 120; i++) {
    const out = stepPlatterMotor(runtime, { ...idle, deltaSeconds: 1 / 60 });
    runtime.angle = out.angle;
    runtime.angularVelocity = out.angularVelocity;
    if (out.currentRpm > previous + 1e-9) monotonic = false;
    previous = out.currentRpm;
    if (out.state === "stopped" && stoppedAfter === Infinity) {
      stoppedAfter = (i + 1) / 60;
    }
  }
  check("rpm never rises while braking", monotonic);
  check(
    "stops within brakeSeconds",
    stoppedAfter <= MOTOR_TUNING.brakeSeconds,
    stoppedAfter,
  );
  check("stays stopped", runtime.angularVelocity === 0);
}

// Frame-rate independence: 60Hz vs 144Hz vs one big step.
{
  const results = [1 / 60, 1 / 144, 1 / 20].map((step) => {
    const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
    return run(runtime, 0.5, step, spinning).currentRpm;
  });
  const spread = Math.max(...results) - Math.min(...results);
  check("rpm within 0.05 across step sizes", spread < 0.05, results);

  // Same for the non-linear branch, where the substepping earns its keep.
  // Measured as time-to-stop: comparing rpm at a fixed instant would just
  // measure how the step size rounds, not the trajectory.
  const stopTimes = [1 / 60, 1 / 144, 1 / 20].map((step) => {
    const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
    run(runtime, 2, step, spinning);
    for (let elapsed = 0; elapsed < 5; elapsed += step) {
      const out = stepPlatterMotor(runtime, { ...idle, deltaSeconds: step });
      runtime.angle = out.angle;
      runtime.angularVelocity = out.angularVelocity;
      if (out.state === "stopped") return elapsed + step;
    }
    return Infinity;
  });
  const stopSpread = Math.max(...stopTimes) - Math.min(...stopTimes);
  check(
    "time to stop within 50ms across step sizes",
    stopSpread < 0.05,
    stopTimes,
  );
}

// Left alone, a stop always converges to a full stop and stays there.
{
  const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
  run(runtime, 2, 1 / 60, spinning);
  const out = run(runtime, 5, 1 / 60, idle);
  check("a long stop converges to zero", out.currentRpm === 0, out.currentRpm);
  check("and stays stopped", out.state === "stopped", out.state);
}

// A huge delta (tab restored) cannot jump more than one clamped step.
{
  const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
  run(runtime, 2, 1 / 60, spinning);
  const before = runtime.angle;
  const out = stepPlatterMotor(runtime, { ...spinning, deltaSeconds: 30 });
  const travelled = Math.abs(out.angle - before);
  const maxTravel =
    (runtime.angularVelocity || out.angularVelocity) *
    MOTOR_TUNING.maxDeltaSeconds;
  check(
    "clamped delta keeps the step small",
    travelled <= maxTravel + 1e-9 || travelled <= Math.PI,
    { travelled, maxTravel },
  );
}

// Hammering start/stop never produces NaN, negatives or reverse motion.
{
  const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
  let requested = false;
  let worst = Infinity;
  for (let i = 0; i < 400; i++) {
    requested = !requested;
    const out = stepPlatterMotor(runtime, {
      deltaSeconds: 1 / 60,
      motorRequested: requested,
      handAngularVelocity: null,
      targetRpm: TARGET_RPM,
    });
    runtime.angle = out.angle;
    runtime.angularVelocity = out.angularVelocity;
    worst = Math.min(worst, out.currentRpm);
    if (!Number.isFinite(out.currentRpm) || !Number.isFinite(out.angle)) {
      worst = NaN;
      break;
    }
  }
  check("no NaN and no reverse rotation under toggling", worst >= 0, worst);
  check(
    "angle stays normalised",
    runtime.angle >= 0 && runtime.angle < Math.PI * 2,
    runtime.angle,
  );
}

console.log("\npitch fader");

// Full deflection reaches the printed ±8, measured from the printed zero —
// which is offset from the cap's rest pose in the asset.
{
  const zero = pitchToOffsetMetres(0);
  const plus = pitchToOffsetMetres(PITCH.max);
  const minus = pitchToOffsetMetres(-PITCH.max);
  check("0 sits on the printed zero", zero === PITCH.zeroOffsetMetres, zero);
  check(
    "+8% travels the full span above zero",
    Math.abs(plus - zero - PITCH.travelMetres) < 1e-12,
    plus,
  );
  check(
    "-8% travels the full span below zero",
    Math.abs(minus - zero + PITCH.travelMetres) < 1e-12,
    minus,
  );
  check("the two extremes are symmetric about zero", plus - zero === zero - minus);
  check(
    "the mapping round-trips",
    Math.abs(offsetMetresToPitch(pitchToOffsetMetres(0.05)) - 0.05) < 1e-12,
  );
}

// The sign of the scale. Offsets are along the pitch collider's local +X, and
// the printed +8 is the +X end — get this backwards and the fader still
// round-trips perfectly while running the deck the wrong way.
{
  check(
    "the printed +8 end is further along the axis than the printed −8 end",
    pitchToOffsetMetres(PITCH.max) > pitchToOffsetMetres(0) &&
      pitchToOffsetMetres(0) > pitchToOffsetMetres(-PITCH.max),
    {
      plus: pitchToOffsetMetres(PITCH.max),
      zero: pitchToOffsetMetres(0),
      minus: pitchToOffsetMetres(-PITCH.max),
    },
  );
  // The cap's own travel is unchanged by the sign fix: the asset parks it at
  // +3.4 marks, so the printed zero is 27.15mm back down the scale and the two
  // ends sit where they always did.
  check(
    "the cap still rests where the asset parks it",
    Math.abs(offsetMetresToPitch(0) - (3.4 / 8) * PITCH.max) < 1e-3,
    offsetMetresToPitch(0),
  );
  check(
    "and the two ends are the same two places as before",
    Math.abs(pitchToOffsetMetres(PITCH.max) - 0.03735) < 1e-9 &&
      Math.abs(pitchToOffsetMetres(-PITCH.max) + 0.09165) < 1e-9,
    {
      plus: pitchToOffsetMetres(PITCH.max),
      minus: pitchToOffsetMetres(-PITCH.max),
    },
  );
}

// Both ways round, across the whole slot. The fader is read by intersecting a
// pointer ray with the panel, so the two directions are separate code paths on
// the view side — they have to agree at every point, not just at the ends.
{
  let worstValue = 0;
  let worstMetres = 0;
  let detentedTo = 0;
  for (let i = 0; i <= 200; i++) {
    const pitch = -PITCH.max + (i / 200) * 2 * PITCH.max;
    // value → position → value
    const back = offsetMetresToPitch(pitchToOffsetMetres(pitch));
    worstValue = Math.max(worstValue, Math.abs(back - clampPitch(pitch)));

    // position → value → position, over the same span of the slot
    const metres =
      pitchToOffsetMetres(-PITCH.max) + (i / 200) * PITCH.travelMetres * 2;
    const there = pitchToOffsetMetres(offsetMetresToPitch(metres));
    // Inside the centre detent the trip is deliberately not the identity: the
    // slot's middle 3mm all read as exactly 0 (PITCH.snap), which is the point
    // of having a detent. Everywhere else it must be exact.
    if (Math.abs(offsetMetresToPitch(metres)) < PITCH.snap) {
      detentedTo = Math.max(detentedTo, Math.abs(there - pitchToOffsetMetres(0)));
    } else {
      worstMetres = Math.max(worstMetres, Math.abs(there - metres));
    }
  }
  check("value → position → value agrees everywhere", worstValue < 1e-15, worstValue);
  check(
    "and position → value → position too, outside the centre detent",
    worstMetres < 1e-15,
    worstMetres,
  );
  check("inside it, every position reads as the printed zero", detentedTo === 0);
}

// What the whole thing is for: which way the platter goes.
{
  const nominal = effectiveTargetRpm(33.333, 0);
  const down = effectiveTargetRpm(33.333, offsetMetresToPitch(pitchToOffsetMetres(-PITCH.max)));
  const up = effectiveTargetRpm(33.333, offsetMetresToPitch(pitchToOffsetMetres(PITCH.max)));
  check("the −8 end of the slot slows the platter down", down < nominal, down);
  check("the +8 end speeds it up", up > nominal, up);
  check(
    "by 8% each way, at either selector speed",
    Math.abs(down / nominal - 0.92) < 1e-12 &&
      Math.abs(up / nominal - 1.08) < 1e-12 &&
      Math.abs(effectiveTargetRpm(45, PITCH.max) / 45 - 1.08) < 1e-12 &&
      Math.abs(effectiveTargetRpm(45, -PITCH.max) / 45 - 0.92) < 1e-12,
  );
  // And with a trim on top: the two stack, and neither one flips the other.
  check(
    "a trim does not change which way pitch goes",
    effectiveTargetRpm(33.333, PITCH.max, 0.02) >
      effectiveTargetRpm(33.333, 0, 0.02) &&
      effectiveTargetRpm(33.333, -PITCH.max, -0.02) <
        effectiveTargetRpm(33.333, 0, -0.02),
  );
}

// Effective rpm at the extremes of both selector speeds.
{
  const low = effectiveTargetRpm(33.333, -PITCH.max);
  const high = effectiveTargetRpm(33.333, PITCH.max);
  check("33⅓ at -8% is ~30.666", Math.abs(low - 30.666) < 0.001, low);
  check("33⅓ at +8% is ~36.000", Math.abs(high - 36.0) < 0.001, high);
  check(
    "45 at ±8% is ~41.4 / ~48.6",
    Math.abs(effectiveTargetRpm(45, -PITCH.max) - 41.4) < 0.001 &&
      Math.abs(effectiveTargetRpm(45, PITCH.max) - 48.6) < 0.001,
  );
  check(
    "centre leaves the nominal speed alone",
    effectiveTargetRpm(33.333, 0) === 33.333,
  );
}

// The store's trust boundary: nothing out of range reaches the motor.
{
  check("clamps above range", clampPitch(5) === PITCH.max);
  check("clamps below range", clampPitch(-5) === -PITCH.max);
  check("NaN reads as centre", clampPitch(Number.NaN) === 0);
  check("small values snap to exactly zero", clampPitch(0.0009) === 0);
  check("values outside the detent survive", clampPitch(0.05) === 0.05);
}

console.log("\nhand on the record");

const NOMINAL_OMEGA = rpmToRadPerSec(TARGET_RPM);

// From rest, a hand turns the record either way — and only while it is held.
{
  const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
  const forward = run(runtime, 0.3, 1 / 60, withHand(idle, 4));
  check("a hand turns a stopped record forwards", forward.currentRpm > 30, forward.currentRpm);

  const back: MotorRuntime = { angle: 0, angularVelocity: 0 };
  const backwards = run(back, 0.3, 1 / 60, withHand(idle, -4));
  check("and backwards", backwards.currentRpm < -30, backwards.currentRpm);
  check("reverse is a real negative rpm", backwards.angularVelocity < 0);
}

// A hand laid on a spinning record stops it, and holds it stopped.
{
  const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
  run(runtime, 2, 1 / 60, spinning);
  const held = run(runtime, 0.2, 1 / 60, withHand(spinning, 0));
  check("a hand stops a running platter", Math.abs(held.currentRpm) < 0.5, held.currentRpm);

  const stillHeld = run(runtime, 1, 1 / 60, withHand(spinning, 0));
  check(
    "and the motor cannot pull free of it",
    Math.abs(stillHeld.currentRpm) < 1.5,
    stillHeld.currentRpm,
  );
  // Angles are normalised, so compare the shortest way round.
  const travelled = (a: number, b: number) => {
    const turn = Math.PI * 2;
    return Math.abs((((a - b + Math.PI) % turn) + turn) % turn) - Math.PI;
  };
  const angleWhileHeld = runtime.angle;
  run(runtime, 0.5, 1 / 60, withHand(spinning, 0));
  check(
    "a held record barely moves",
    Math.abs(travelled(runtime.angle, angleWhileHeld)) < 0.05,
    travelled(runtime.angle, angleWhileHeld),
  );
}

// Let go and the physics takes it from whatever ω the hand left behind.
{
  const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
  run(runtime, 0.3, 1 / 60, withHand(idle, 6));
  const released = runtime.angularVelocity;
  check("the hand left it spinning", released > 5);

  const coasting = run(runtime, 0.1, 1 / 60, idle);
  check(
    "released, it coasts down from that ω rather than jumping",
    coasting.angularVelocity < released && coasting.angularVelocity > 0,
    { released, after: coasting.angularVelocity },
  );

  const stopped = run(runtime, 3, 1 / 60, idle);
  check("and still reaches a full stop", stopped.state === "stopped");
}

// Released while the motor is running, it is pulled back to the target.
{
  const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
  run(runtime, 2, 1 / 60, spinning);
  run(runtime, 0.3, 1 / 60, withHand(spinning, -4)); // dragged backwards
  check("a hand can reverse a running platter", runtime.angularVelocity < 0);

  const recovered = run(runtime, 2, 1 / 60, spinning);
  check(
    "letting go recovers the nominal speed",
    Math.abs(recovered.currentRpm - TARGET_RPM) < 0.01,
    recovered.currentRpm,
  );
}

// The motor's torque still counts while a hand is on the record.
{
  const free: MotorRuntime = { angle: 0, angularVelocity: 0 };
  const driven: MotorRuntime = { angle: 0, angularVelocity: 0 };
  const a = run(free, 0.4, 1 / 60, withHand(idle, NOMINAL_OMEGA));
  const b = run(driven, 0.4, 1 / 60, withHand(spinning, NOMINAL_OMEGA));
  check(
    "the same hand gets closer to speed with the motor helping",
    b.currentRpm > a.currentRpm,
    { motorOff: a.currentRpm, motorOn: b.currentRpm },
  );
}

// Nothing about the hand may produce NaN or runaway values.
{
  const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
  let sane = true;
  for (let i = 0; i < 600; i++) {
    const out = stepPlatterMotor(runtime, {
      deltaSeconds: 1 / 60,
      motorRequested: i % 3 === 0,
      targetRpm: TARGET_RPM,
      handAngularVelocity: i % 2 === 0 ? (i % 7) - 3 : null,
    });
    runtime.angle = out.angle;
    runtime.angularVelocity = out.angularVelocity;
    if (!Number.isFinite(out.currentRpm) || !Number.isFinite(out.angle)) {
      sane = false;
      break;
    }
    if (Math.abs(out.angularVelocity) > MOTOR_TUNING.maxHandRadPerSec + 1) {
      sane = false;
      break;
    }
  }
  check("hammering hand and motor together stays finite", sane);
  check(
    "angle stays normalised with reverse in play",
    runtime.angle >= 0 && runtime.angle < Math.PI * 2,
    runtime.angle,
  );

  const absurd = stepPlatterMotor(
    { angle: 0, angularVelocity: 0 },
    {
      deltaSeconds: 1 / 60,
      motorRequested: false,
      targetRpm: TARGET_RPM,
      handAngularVelocity: 1e6,
    },
  );
  check(
    "an absurd hand speed is clamped, not obeyed",
    Math.abs(absurd.angularVelocity) <= MOTOR_TUNING.maxHandRadPerSec,
    absurd.angularVelocity,
  );
}

console.log("\ntonearm yaw");

// The arm's travel: rest at one end, label edge at the other.
{
  const deg = (rad: number) => (rad * 180) / Math.PI;
  check("the rest is the outer limit", TONEARM.maxYawRadians === 0);
  check(
    "the inner limit is the label edge at -43.5°",
    Math.abs(deg(TONEARM.minYawRadians) + 43.5) < 1e-9,
    deg(TONEARM.minYawRadians),
  );
  check("cannot swing past the rest", clampTonearmYaw(1) === 0);
  check(
    "cannot ride onto the label",
    clampTonearmYaw(-Math.PI) === TONEARM.minYawRadians,
  );
  check(
    "anywhere between the two survives",
    clampTonearmYaw(-0.3) === -0.3,
  );
  check("NaN parks it on the rest", clampTonearmYaw(Number.NaN) === 0);
}

// The hand lift, and the drop once it is released.
{
  const deg = (rad: number) => (rad * 180) / Math.PI;
  check(
    "the lift tops out at 5°",
    Math.abs(deg(TONEARM.maxLiftRadians) - 5) < 1e-9,
    deg(TONEARM.maxLiftRadians),
  );
  check("it cannot be pushed below the rest", clampTonearmLift(-1) === 0);
  check(
    "nor lifted past the limit",
    clampTonearmLift(1) === TONEARM.maxLiftRadians,
  );
  check("NaN reads as down", clampTonearmLift(Number.NaN) === 0);

  // Released from full lift, it lands in about the quoted time.
  const drop = (step: number) => {
    let state: LiftFall = { lift: TONEARM.maxLiftRadians, velocity: 0 };
    let elapsed = 0;
    while (state.lift > 0 && elapsed < 5) {
      state = stepTonearmFall(state, step);
      elapsed += step;
    }
    return { elapsed, ...state };
  };
  const at60 = drop(1 / 60);
  check(
    "a released arm lands in about fallSeconds",
    Math.abs(at60.elapsed - TONEARM.fallSeconds) < 0.05,
    at60.elapsed,
  );
  check("and lands exactly down, not below", at60.lift === 0 && at60.velocity === 0);

  const at144 = drop(1 / 144);
  const at20 = drop(1 / 20);
  check(
    "the drop takes the same time at any frame rate",
    Math.abs(at144.elapsed - at60.elapsed) < 0.05 &&
      Math.abs(at20.elapsed - at60.elapsed) < 0.05,
    { at20: at20.elapsed, at60: at60.elapsed, at144: at144.elapsed },
  );

  // It accelerates rather than gliding down at a constant rate.
  let state: LiftFall = { lift: TONEARM.maxLiftRadians, velocity: 0 };
  const first = stepTonearmFall(state, 1 / 60);
  const firstStep = TONEARM.maxLiftRadians - first.lift;
  state = first;
  for (let i = 0; i < 8; i++) state = stepTonearmFall(state, 1 / 60);
  const later = stepTonearmFall(state, 1 / 60);
  check("it falls faster the further it has fallen", state.lift - later.lift > firstStep);

  check(
    "a huge delta cannot slam it through the floor",
    stepTonearmFall({ lift: TONEARM.maxLiftRadians, velocity: 0 }, 30).lift >= 0,
  );
  check(
    "already down, it stays down",
    stepTonearmFall({ lift: 0, velocity: -5 }, 1 / 60).lift === 0,
  );
}

// Contact: the surface under the stylus is the floor, and over the record that
// floor is below the arm's rest pose.
{
  // Geometry as measured off this asset: tip 208.4mm along the arm and 5.1mm
  // below the lift pivot, record top 6.6mm below that pivot.
  const contact = liftAngleForSurface(0.2084, -0.0051, -0.0066);
  check("the contact angle solves", contact !== null);
  check(
    "and it is below the rest pose, not above",
    contact !== null && contact < 0 && contact > -0.02,
    contact,
  );

  const floor = contact ?? 0;
  check("over the record the arm may go below 0", clampTonearmLift(-0.005, floor) === -0.005);
  check("but no further than the surface", clampTonearmLift(-1, floor) === floor);
  check("on the arm rest 0 is still the floor", clampTonearmLift(-1, 0) === 0);
  let dropping: LiftFall = { lift: TONEARM.maxLiftRadians, velocity: 0 };
  let dropSeconds = 0;
  while (dropping.lift > floor && dropSeconds < 5) {
    dropping = stepTonearmFall(dropping, 1 / 60, floor);
    dropSeconds += 1 / 60;
  }
  check(
    "a released arm lands on the record, not on 0",
    dropping.lift === floor && floor < 0,
    dropping.lift,
  );
  check(
    "and takes slightly longer than a drop to the rest",
    dropSeconds > TONEARM.fallSeconds && dropSeconds < TONEARM.fallSeconds + 0.1,
    dropSeconds,
  );
  check(
    "and stays there",
    stepTonearmFall({ lift: floor, velocity: 0 }, 1 / 60, floor).lift === floor,
  );
  check(
    "an unreachable surface reports nothing rather than guessing",
    liftAngleForSurface(0.2084, -0.0051, -5) === null,
  );
  check(
    "a degenerate arm reports nothing too",
    liftAngleForSurface(0, 0, -0.0066) === null,
  );
}

console.log("\ngroove position");

// Every zone, named by the radius the arm reaches it at (rdd.md 10.2).
{
  const mm = (millimetres: number) => millimetres / 1000;
  check("the arm rest is off the disc", grooveZoneAt(mm(196.9)) === "outside");
  check("just past the edge is still off", grooveZoneAt(mm(153)) === "outside");
  check("the edge itself is lead-in", grooveZoneAt(mm(152.4)) === "lead-in");
  check("and so is 150mm", grooveZoneAt(mm(150)) === "lead-in");
  check("the lead-in groove starts the program", grooveZoneAt(mm(146)) === "program");
  check("mid-record is program", grooveZoneAt(mm(100)) === "program");
  check("the lead-out groove ends it", grooveZoneAt(mm(57.5)) === "program");
  check("inside that is the run-out", grooveZoneAt(mm(55)) === "lead-out");
  check("the label edge is the run-out's inner end", grooveZoneAt(mm(50)) === "lead-out");
  check("inside the label there is no groove", grooveZoneAt(mm(40)) === "label");
  check("the spindle is label too", grooveZoneAt(0) === "label");
  check("a radius that never got measured reads as off the disc", grooveZoneAt(Number.NaN) === "outside");
}

// The program area, and only it, maps onto 0…1.
{
  const mm = (millimetres: number) => millimetres / 1000;
  check("the lead-in groove is the start", groovePositionAt(mm(146)) === 0);
  check("the lead-out groove is the end", groovePositionAt(mm(57.5)) === 1);
  const middle = groovePositionAt(mm((146 + 57.5) / 2));
  check("halfway across is halfway through", middle !== null && Math.abs(middle - 0.5) < 1e-12, middle);
  check("outside the disc has no position", groovePositionAt(mm(196.9)) === null);
  check("nor does the lead-in area", groovePositionAt(mm(150)) === null);
  check("nor the run-out", groovePositionAt(mm(55)) === null);
  check("nor the label", groovePositionAt(mm(40)) === null);
  check("nor an unmeasured radius", groovePositionAt(Number.NaN) === null);

  // Nothing in range can escape 0…1, and it only ever runs inwards. Written as
  // `!(inside)` so a NaN — which fails every comparison, including `> 1` —
  // counts as out of range instead of slipping through.
  let monotonic = true;
  let inRange = true;
  let previous = -1;
  for (let r = GROOVE.leadInRadius; r >= GROOVE.leadOutRadius; r -= 0.0001) {
    const position = groovePositionAt(r);
    if (position === null || !(position >= 0 && position <= 1)) inRange = false;
    else if (position < previous) monotonic = false;
    else previous = position;
  }
  check("the whole program area stays within 0…1", inRange);
  check("and advances inwards, never back", monotonic);

  // The absent value is null everywhere — never NaN. Telemetry carries the
  // same convention, so a consumer only ever has to test for null.
  const absent = [196.9, 150, 55, 40, Number.NaN].map((r) =>
    groovePositionAt(r / 1000),
  );
  check(
    "no reachable radius produces NaN",
    absent.every((position) => position === null),
    absent,
  );
}

console.log("\nspeed control trims");

// Full deflection is ±2 % of the nominal speed at ±135°.
{
  const deg = (rad: number) => (rad * 180) / Math.PI;
  check("full trim is ±2%", SPEED_TRIM.max === 0.02);
  check(
    "full deflection is ±135°",
    Math.abs(deg(trimToAngleRadians(SPEED_TRIM.max)) - 135) < 1e-9 &&
      Math.abs(deg(trimToAngleRadians(-SPEED_TRIM.max)) + 135) < 1e-9,
  );
  check("centre is 0°", trimToAngleRadians(0) === 0);
  check(
    "the angle mapping round-trips",
    Math.abs(angleRadiansToTrim(trimToAngleRadians(0.011)) - 0.011) < 1e-12,
  );
  check("clamps above range", clampTrim(1) === SPEED_TRIM.max);
  check("clamps below range", clampTrim(-1) === -SPEED_TRIM.max);
  check("NaN reads as centre", clampTrim(Number.NaN) === 0);
  check(
    "half a turn is half the trim",
    Math.abs(angleRadiansToTrim(SPEED_TRIM.maxAngleRadians / 2) - 0.01) < 1e-12,
  );
}

// The trim calibrates the nominal speed; pitch then works on top of it.
{
  const trimmed = effectiveTargetRpm(TARGET_RPM, 0, SPEED_TRIM.max);
  check("+2% trim lifts 33⅓ to ~34.0", Math.abs(trimmed - 34.0) < 0.001, trimmed);
  check(
    "-2% trim drops 45 to ~44.1",
    Math.abs(effectiveTargetRpm(45, 0, -SPEED_TRIM.max) - 44.1) < 0.001,
  );
  check(
    "trim and pitch compound, not replace",
    Math.abs(
      effectiveTargetRpm(TARGET_RPM, PITCH.max, SPEED_TRIM.max) -
        TARGET_RPM * 1.02 * 1.08,
    ) < 1e-9,
  );
  check(
    "a centred trim changes nothing",
    effectiveTargetRpm(TARGET_RPM, 0, 0) === TARGET_RPM,
  );
  check(
    "an out-of-range trim cannot reach the motor",
    effectiveTargetRpm(TARGET_RPM, 0, 99) ===
      effectiveTargetRpm(TARGET_RPM, 0, SPEED_TRIM.max),
  );
}

// A pitched target is still a target the motor settles on exactly.
{
  const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
  const pitched = effectiveTargetRpm(TARGET_RPM, PITCH.max);
  const out = run(runtime, 2, 1 / 60, { ...spinning, targetRpm: pitched });
  check(
    "motor settles on the pitched target",
    Math.abs(out.currentRpm - pitched) < 0.01,
    out.currentRpm,
  );

  // Pitch moves while stopped must not turn the platter.
  const stopped: MotorRuntime = { angle: 0, angularVelocity: 0 };
  const idleOut = run(stopped, 1, 1 / 60, {
    motorRequested: false,
    handAngularVelocity: null,
    targetRpm: pitched,
  });
  check("pitch does nothing while stopped", idleOut.currentRpm === 0);
  check("and the platter has not moved", stopped.angle === 0, stopped.angle);
}

console.log("\ntonearm vertical response");

/**
 * **実機を測った値ではない。** 桁だけ現実に合わせた試験用の組み合わせで、
 * 実効質量 10g × コンプライアンス 10cu（1e-2 m/N）→ 縦共振 15.9Hz。
 * 共振を決めるのはこの積だけである。
 */
const TEST_ARM: TonearmVerticalParameters = {
  effectiveMass: 0.01,
  pivotInertia: 0,
  damping: 0.1,
};
/** 針圧 1.5gf。静的なたわみは VTF·C = 0.147mm で、これが接触の余裕になる。 */
const TEST_SUSPENSION: TonearmSuspension = {
  compliance: 1e-2,
  trackingForce: 0.0147,
};
/** 針圧が無限＝接触が決して切れない。**線形の応答だけを見たいとき**に使う。 */
const LOADED_SUSPENSION: TonearmSuspension = {
  compliance: 1e-2,
  trackingForce: Number.POSITIVE_INFINITY,
};

const ARM_DT = 1 / 48000;
/** 自由振動が消えるまで。ζω₀ = 10 rad/s なので 3秒で e⁻³⁰。 */
const ARM_SETTLE_SECONDS = 3;

/** 一定周期の盤面 `amplitude·wave(θ)` でアームを駆動し、定常だけを測る。 */
function driveArm(
  arm: TonearmVertical,
  amplitude: number,
  hz: number,
  options: {
    reverse?: boolean;
    wave?: (theta: number) => number;
    dt?: number;
    cycles?: number;
  } = {},
) {
  const dt = options.dt ?? ARM_DT;
  const wave = options.wave ?? Math.sin;
  // 「逆回転」は盤面を逆順に辿ること。θ の符号だけが変わる。
  const sign = options.reverse ? -1 : 1;
  const surfaceAt = (i: number) =>
    amplitude * wave(sign * 2 * Math.PI * hz * i * dt);

  arm.reset(0);
  const settle = Math.ceil(ARM_SETTLE_SECONDS / dt);
  for (let i = 0; i < settle; i++) arm.step(surfaceAt(i), dt);

  const window = Math.ceil((options.cycles ?? 2) / hz / dt);
  const before = arm.contactLossSteps;
  let peakHeight = 0;
  let peakDeflection = 0;
  let squares = 0;
  let finite = true;
  for (let i = settle; i < settle + window; i++) {
    arm.step(surfaceAt(i), dt);
    if (!Number.isFinite(arm.height) || !Number.isFinite(arm.deflection)) {
      finite = false;
    }
    peakHeight = Math.max(peakHeight, Math.abs(arm.height));
    peakDeflection = Math.max(peakDeflection, Math.abs(arm.deflection));
    squares += arm.deflection * arm.deflection;
  }

  return {
    finite,
    /** 盤面に対するアーム自身の追従量。1 なら完全に付いていっている。 */
    heightGain: peakHeight / amplitude,
    /** 盤面に対するカンチレバーのたわみ。**コイルが拾うのはこちら。** */
    deflectionGain: peakDeflection / amplitude,
    deflectionRms: Math.sqrt(squares / window) / amplitude,
    losses: arm.contactLossSteps - before,
  };
}

// 共振周波数は 1/2π√(MC)。**ばねは針側のもの1本しかない。**
{
  const arm = createTonearmVertical(TEST_ARM, TEST_SUSPENSION);
  const expected =
    1 /
    (2 *
      Math.PI *
      Math.sqrt(TEST_ARM.effectiveMass * TEST_SUSPENSION.compliance));
  check(
    "the vertical resonance is 1/2pi sqrt(MC)",
    Math.abs(arm.resonanceHz - expected) < 1e-9,
    arm.resonanceHz,
  );
  check(
    "which for 10g on 10cu lands where a real arm's does",
    Math.abs(arm.resonanceHz - 15.915) < 0.01,
    arm.resonanceHz,
  );
  check(
    "the static sag is the tracking force on that same spring",
    Math.abs(
      arm.staticCompression -
        TEST_SUSPENSION.trackingForce * TEST_SUSPENSION.compliance,
    ) < 1e-12,
    arm.staticCompression,
  );

  // ピボット慣性を入れたときは、そちらが正本。実効質量はその針先換算。
  const byInertia = createTonearmVertical(
    {
      ...TEST_ARM,
      effectiveMass: 99,
      pivotInertia: effectiveMassToPivotInertia(TEST_ARM.effectiveMass),
    },
    TEST_SUSPENSION,
  );
  check(
    "pivot inertia overrides the effective mass, at I / L squared",
    Math.abs(byInertia.effectiveMass - TEST_ARM.effectiveMass) < 1e-12 &&
      Math.abs(byInertia.resonanceHz - arm.resonanceHz) < 1e-9,
    { mass: byInertia.effectiveMass, hz: byInertia.resonanceHz },
  );
  check(
    "and the two ways of saying it agree by construction",
    Math.abs(
      effectiveMassToPivotInertia(1) -
        TONEARM_GEOMETRY.effectiveLength * TONEARM_GEOMETRY.effectiveLength,
    ) < 1e-18,
  );
}

/**
 * 解析解。r = f/f₀。**推測した閾値ではなく、これと突き合わせる。**
 *
 * 盤面 → アームの高さは 2次ローパス、盤面 → カンチレバーのたわみはその補。
 *
 * ```
 *   follow = 1 / |1 − r² + 2jζr|
 *   bend   = |−r² + 2jζr| / |1 − r² + 2jζr| = r·|r + 2jζ| / |1 − r² + 2jζr|
 * ```
 *
 * **共振より下でたわみが落ちる速さは 2ζr — 2次ではなく1次である。**
 * 粘性減衰は速度に比例した力を伝えるので、ばねが効かなくなっても残る。
 * ζ = 0.1・0.55Hz の反りなら 0.7% で、この 1/140 が「アームの実効質量が
 * 無いと超低域を過大に見積もる」ぶんそのものである。
 */
const followGain = (r: number, zeta: number) =>
  1 / Math.hypot(1 - r * r, 2 * zeta * r);
const bendGain = (r: number, zeta: number) =>
  (r * Math.hypot(r, 2 * zeta)) / Math.hypot(1 - r * r, 2 * zeta * r);

/**
 * 許容 2%。**共振より下のたわみは位相差そのもの**（0.53Hz なら 6.8mrad）なので、
 * 積分器の1サンプルぶんの遅れ ωΔt = 6.9e-5 rad がそのまま 1% として出る。
 * モデルの誤差ではなく離散化で、刻みを細かくすれば消える — 下でそれを確かめる。
 */
const matches = (measured: number, expected: number, tolerance = 0.02) =>
  Math.abs(measured - expected) < tolerance * Math.max(expected, 1e-9);

// 応答の形。**ここが「反りには付いていき、音声帯域には付いていかない」の全部。**
{
  const zeta = TEST_ARM.damping;
  const arm = createTonearmVertical(TEST_ARM, LOADED_SUSPENSION);
  const f0 = arm.resonanceHz;

  const below = driveArm(arm, 5e-4, f0 / 30, { cycles: 2 });
  check(
    "far below resonance the arm follows the surface",
    matches(below.heightGain, followGain(1 / 30, zeta)) &&
      Math.abs(below.heightGain - 1) < 0.01,
    below.heightGain,
  );
  check(
    "and the cantilever keeps only the damper's share, 2 zeta r",
    matches(below.deflectionGain, bendGain(1 / 30, zeta)),
    { measured: below.deflectionGain, analytic: bendGain(1 / 30, zeta) },
  );

  const above = driveArm(arm, 5e-7, f0 * 30, { cycles: 4 });
  check(
    "far above resonance the arm's mass holds it still",
    matches(above.heightGain, followGain(30, zeta)) && above.heightGain < 0.005,
    above.heightGain,
  );
  check(
    "so the whole movement is left to the cantilever",
    matches(above.deflectionGain, bendGain(30, zeta)) &&
      Math.abs(above.deflectionGain - 1) < 0.01,
    above.deflectionGain,
  );

  const at = driveArm(arm, 5e-7, f0, { cycles: 4 });
  check(
    "and at resonance it is lifted by 1/2 zeta",
    matches(at.heightGain, 1 / (2 * zeta)),
    at.heightGain,
  );

  // 減衰を上げれば山は下がる。ζ は共振の高さの正本である。
  const damped = createTonearmVertical(
    { ...TEST_ARM, damping: 0.7 },
    LOADED_SUSPENSION,
  );
  const tamed = driveArm(damped, 5e-7, damped.resonanceHz, { cycles: 4 });
  check(
    "more damping flattens that peak",
    tamed.heightGain < at.heightGain / 3 &&
      Math.abs(tamed.heightGain - 1 / (2 * 0.7)) < 0.02,
    { zeta01: at.heightGain, zeta07: tamed.heightGain },
  );

  // 残った1%は離散化。刻みを1/8にすれば1桁縮む。**モデルの誤差ではない。**
  const expected = bendGain(1 / 30, zeta);
  const coarse = Math.abs(below.deflectionGain / expected - 1);
  const fine = driveArm(arm, 5e-4, f0 / 30, { cycles: 2, dt: ARM_DT / 8 });
  const refined = Math.abs(fine.deflectionGain / expected - 1);
  check(
    "the last percent is the integrator's one-sample lag, and it converges",
    refined < coarse / 4 && refined < 0.003,
    { atAudioRate: coarse, eightTimesFiner: refined },
  );
}

// 反りの帯域そのもの。33⅓rpm の1回転 = 0.5555Hz、鞍（2次）で 1.111Hz。
{
  const zeta = TEST_ARM.damping;
  const arm = createTonearmVertical(TEST_ARM, TEST_SUSPENSION);
  const perRevolutionHz = 33.333 / 60;
  const r = perRevolutionHz / arm.resonanceHz;
  // 外周 0.5mm の反り。実測される盤の桁。
  const once = driveArm(arm, 5e-4, perRevolutionHz, { cycles: 2 });
  const saddle = driveArm(arm, 5e-4, perRevolutionHz * 2, { cycles: 2 });

  check(
    "a once-per-revolution warp is carried by the arm, not the cantilever",
    once.heightGain > 0.999 && matches(once.deflectionGain, bendGain(r, zeta)),
    { follows: once.heightGain, bends: once.deflectionGain },
  );
  check(
    "which leaves the coils under a hundredth of the warp, not all of it",
    once.deflectionGain < 0.01,
    once.deflectionGain,
  );
  // 1次なので約2倍。ばねだけで効いているなら4倍になるはずで、そうならない。
  check(
    "and the saddle, an octave up, leaves about twice as much — first order",
    matches(
      saddle.deflectionGain / once.deflectionGain,
      bendGain(2 * r, zeta) / bendGain(r, zeta),
      0.01,
    ),
    { once: once.deflectionGain, saddle: saddle.deflectionGain },
  );
  check(
    "neither of them lifts a properly loaded arm off the record",
    once.losses === 0 && saddle.losses === 0,
    { once: once.losses, saddle: saddle.losses },
  );
}

// 接触損失。**盤面が静的なたわみより深く逃げたら、針は付いていけない。**
{
  const arm = createTonearmVertical(TEST_ARM, TEST_SUSPENSION);
  // 共振より上では腕が動かないので、盤面が VTF·C（0.147mm）より下がった
  // 時点でばねが自由長へ戻る。1mm の振幅なら確実に切れる。
  const fast = driveArm(arm, 1e-3, arm.resonanceHz * 2, { cycles: 4 });
  check("a surface dropping away faster than the arm can follow breaks contact",
    fast.losses > 0, fast.losses);
  check("and nothing goes non-finite while it does", fast.finite);

  // 針圧を上げれば余裕が増える。**これが接触損失の定義そのもの。**
  const heavy = createTonearmVertical(TEST_ARM, {
    compliance: TEST_SUSPENSION.compliance,
    trackingForce: TEST_SUSPENSION.trackingForce * 20,
  });
  const held = driveArm(heavy, 1e-3, heavy.resonanceHz * 2, { cycles: 4 });
  check(
    "more tracking force holds it down on the same warp",
    held.losses < fast.losses,
    { light: fast.losses, heavy: held.losses },
  );

  // 離れる瞬間のたわみはちょうど静的なたわみぶんなので、段差は出ない。
  // **ゆっくり沈めても切れない**（アームが付いていってしまう）ので、切れる速さで
  // 揺らしながら、1サンプルあたりの変化が信号そのものの変化を超えないことを見る。
  const edge = createTonearmVertical(TEST_ARM, TEST_SUSPENSION);
  const hz = edge.resonanceHz * 2;
  const amplitude = 1e-3;
  const smooth = amplitude * 2 * Math.PI * hz * ARM_DT;
  edge.reset(0);
  let jump = 0;
  let previous = edge.deflection;
  let broke = false;
  for (let i = 0; i < 48000; i++) {
    edge.step(amplitude * Math.sin(2 * Math.PI * hz * i * ARM_DT), ARM_DT);
    if (i > 4800) jump = Math.max(jump, Math.abs(edge.deflection - previous));
    previous = edge.deflection;
    if (!edge.touching) broke = true;
  }
  check(
    "and contact is lost without a step in the deflection",
    broke && jump < 3 * smooth,
    { broke, jump, smooth },
  );
}

// 正逆対称。**波形は一致しない** — 減衰のある系は時間反転に対して対称ではない。
// 一致するのは各成分の振幅、つまり実効値である。それが正しい主張であり、
// 「逆再生でも同じ波形が返る」と書いてはならない。
{
  const arm = createTonearmVertical(TEST_ARM, LOADED_SUSPENSION);
  // 反った盤そのものの形: 1次と2次を位相をずらして重ねる。単なる正弦では
  // 時間反転が符号反転と区別できず、検査に中身が無くなる。
  const warp = (theta: number) =>
    Math.sin(theta) + 0.5 * Math.sin(2 * theta + 0.7);
  const hz = 33.333 / 60;
  const forward = driveArm(arm, 5e-4, hz, { wave: warp, cycles: 4 });
  const backward = driveArm(arm, 5e-4, hz, {
    wave: warp,
    cycles: 4,
    reverse: true,
  });
  // 許容は測定側の都合: 窓が周期の整数倍にならないので、端の数サンプルだけ
  // 前後で違うものを含む。モデルの非対称ではない。
  check(
    "playing the same warp backwards gives the same rms deflection",
    Math.abs(forward.deflectionRms - backward.deflectionRms) <
      1e-4 * Math.max(forward.deflectionRms, 1e-9),
    { forward: forward.deflectionRms, backward: backward.deflectionRms },
  );

  // 純粋な正弦なら接触損失の数まで一致する（半周期ごとに対称なので）。
  const loaded = createTonearmVertical(TEST_ARM, TEST_SUSPENSION);
  const one = driveArm(loaded, 1e-3, loaded.resonanceHz * 2, { cycles: 6 });
  const other = driveArm(loaded, 1e-3, loaded.resonanceHz * 2, {
    cycles: 6,
    reverse: true,
  });
  check(
    "and a symmetric warp loses contact for the same number of steps either way",
    one.losses === other.losses && one.losses > 0,
    { forward: one.losses, backward: other.losses },
  );
}

// 刻み幅に依らないこと。音声（20µs）と描画（16.7ms）が同じ答えを出す。
{
  const arm = createTonearmVertical(TEST_ARM, LOADED_SUSPENSION);
  const hz = 33.333 / 60;
  const audio = driveArm(arm, 5e-4, hz, { dt: 1 / 48000, cycles: 2 });
  const doubled = driveArm(arm, 5e-4, hz, { dt: 1 / 96000, cycles: 2 });
  const frames = driveArm(arm, 5e-4, hz, { dt: 1 / 60, cycles: 2 });
  check(
    "halving the step does not move the answer",
    Math.abs(audio.heightGain - doubled.heightGain) < 1e-6,
    { audio: audio.heightGain, doubled: doubled.heightGain },
  );
  check(
    "and a 60fps clock lands on it too, because the model substeps",
    Math.abs(audio.heightGain - frames.heightGain) < 1e-3,
    { audio: audio.heightGain, frames: frames.heightGain },
  );

  // 巨大な delta（背面タブ）でも発散しない。
  const stalled = createTonearmVertical(TEST_ARM, TEST_SUSPENSION);
  stalled.reset(0);
  for (let i = 0; i < 200; i++) stalled.step(5e-4, 10);
  check(
    "a stalled tab cannot blow the arm up",
    Number.isFinite(stalled.height) && Math.abs(stalled.height) < 1,
    stalled.height,
  );
}

// 理想のアーム。**この設定では盤面がそのまま姿勢にもたわみにもなる。**
{
  const ideal = createTonearmVertical(IDEAL_TONEARM, TEST_SUSPENSION);
  check("the ideal arm is bypassed", ideal.bypassed);
  let exact = true;
  for (let i = 0; i < 1000; i++) {
    const surface = 5e-4 * Math.sin(i / 37) + 1e-4 * Math.cos(i / 5);
    ideal.step(surface, ARM_DT);
    if (
      ideal.height !== surface ||
      ideal.deflection !== surface ||
      !ideal.touching
    ) {
      exact = false;
      break;
    }
  }
  check(
    "and passes the surface through bit for bit, on both sides",
    exact && ideal.contactLossSteps === 0,
  );

  // ばねが無限に柔らかい（＝理想の針）なら、質量があっても応答は出ない。
  const noSpring = createTonearmVertical(TEST_ARM, {
    compliance: Number.POSITIVE_INFINITY,
    trackingForce: 0.0147,
  });
  check("an infinitely soft cantilever bypasses it too", noSpring.bypassed);
}

// でたらめな値でも壊れない。
{
  const absurd: TonearmVerticalParameters[] = [
    { effectiveMass: Number.NaN, pivotInertia: 0, damping: 1 },
    { effectiveMass: -1, pivotInertia: 0, damping: 1 },
    { effectiveMass: 1e6, pivotInertia: 0, damping: 0 },
    { effectiveMass: 1e-9, pivotInertia: 0, damping: 1e9 },
    { effectiveMass: 0.01, pivotInertia: Number.NaN, damping: Number.NaN },
    { effectiveMass: 0.01, pivotInertia: -5, damping: -3 },
  ];
  let sane = true;
  let worst: unknown = null;
  for (const parameters of absurd) {
    const arm = createTonearmVertical(parameters, TEST_SUSPENSION);
    for (let i = 0; i < 2000; i++) {
      arm.step(1e-3 * Math.sin(i / 11), ARM_DT);
      if (!Number.isFinite(arm.height) || !Number.isFinite(arm.deflection)) {
        sane = false;
        worst = parameters;
        break;
      }
    }
    if (!sane) break;
  }
  check("no arm setting, however absurd, produces a non-finite value", sane, worst);
}

console.log("\ndrive wow / flutter");

/** The engine's own cadence: one motor step per 128-frame chunk at 48kHz. */
const CHUNK_SECONDS = 128 / 48000;

/**
 * Runs the motor while a caller-supplied disturbance is evaluated once per step,
 * exactly as `deckEngine` does. Returns the whole ω trace so the trajectory can
 * be compared bit for bit.
 */
function runDisturbed(
  seconds: number,
  torqueAt: (time: number, angle: number) => number,
  input: Omit<MotorInput, "deltaSeconds"> = spinning,
) {
  const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
  const steps = Math.round(seconds / CHUNK_SECONDS);
  const omega = new Float64Array(steps);
  const angle = new Float64Array(steps);
  for (let i = 0; i < steps; i++) {
    const out = stepPlatterMotor(runtime, {
      ...input,
      deltaSeconds: CHUNK_SECONDS,
      externalTorque: torqueAt(i * CHUNK_SECONDS, runtime.angle),
    });
    runtime.angle = out.angle;
    runtime.angularVelocity = out.angularVelocity;
    omega[i] = out.angularVelocity;
    angle[i] = out.angle;
  }
  return { runtime, omega, angle };
}

// 外乱ゼロは「外乱なし」と厳密に同じ。**ここが理想設定のビット単位一致の根**。
{
  const bare: MotorRuntime = { angle: 0, angularVelocity: 0 };
  const zeroed: MotorRuntime = { angle: 0, angularVelocity: 0 };
  const steps = Math.round(2 / CHUNK_SECONDS);
  let same = true;
  for (let i = 0; i < steps; i++) {
    const a = stepPlatterMotor(bare, { ...spinning, deltaSeconds: CHUNK_SECONDS });
    const b = stepPlatterMotor(zeroed, {
      ...spinning,
      deltaSeconds: CHUNK_SECONDS,
      externalTorque: 0,
    });
    bare.angle = a.angle;
    bare.angularVelocity = a.angularVelocity;
    zeroed.angle = b.angle;
    zeroed.angularVelocity = b.angularVelocity;
    if (a.angle !== b.angle || a.angularVelocity !== b.angularVelocity) {
      same = false;
      break;
    }
  }
  check("a zero disturbance is bit-identical to no disturbance at all", same);

  // でたらめな値は入口で落とす。
  const absurd: Array<number | undefined> = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    undefined,
  ];
  let sane = true;
  for (const torque of absurd) {
    const runtime: MotorRuntime = { angle: 0, angularVelocity: 0 };
    const out = stepPlatterMotor(runtime, {
      ...spinning,
      deltaSeconds: CHUNK_SECONDS,
      externalTorque: torque,
    });
    if (!Number.isFinite(out.angularVelocity) || !Number.isFinite(out.angle)) {
      sane = false;
    }
  }
  check("NaN, Infinity and undefined all read as no disturbance", sane);

  // モーター自身が出すものなので、モーターより強くはなれない。
  const huge = stepPlatterMotor(
    { angle: 0, angularVelocity: 0 },
    { ...spinning, deltaSeconds: CHUNK_SECONDS, externalTorque: 1e9 },
  );
  const capped = stepPlatterMotor(
    { angle: 0, angularVelocity: 0 },
    {
      ...spinning,
      deltaSeconds: CHUNK_SECONDS,
      externalTorque: MOTOR_TUNING.maxMotorAccel,
    },
  );
  check(
    "an absurd disturbance is capped at the motor's own ceiling",
    huge.angularVelocity === capped.angularVelocity,
    { huge: huge.angularVelocity, capped: capped.angularVelocity },
  );
}

// 向きと、手との足し合わせ。**置き換えではない。**
{
  const push = runDisturbed(0.5, () => 1);
  const pull = runDisturbed(0.5, () => -1);
  const none = runDisturbed(0.5, () => 0);
  check(
    "a positive disturbance leaves the platter running fast, a negative one slow",
    push.omega[push.omega.length - 1] > none.omega[none.omega.length - 1] &&
      pull.omega[pull.omega.length - 1] < none.omega[none.omega.length - 1],
  );

  // 手で押さえたまま外乱を入れても、手のトルクは消えない。
  const held = withHand(spinning, 0);
  const heldQuiet = runDisturbed(0.5, () => 0, held);
  const heldPushed = runDisturbed(0.5, () => 1, held);
  const creep = heldQuiet.omega[heldQuiet.omega.length - 1];
  const pushed = heldPushed.omega[heldPushed.omega.length - 1];
  check(
    "a hand and a disturbance add, they do not replace one another",
    pushed > creep && Math.abs(pushed) < 0.2,
    { creep, pushed },
  );
}

// **止まっているモーターは揺れない。** ここを緩めると STOP が厳密な0に落ちない。
{
  const stopped = runDisturbed(3, () => MOTOR_TUNING.maxMotorAccel, idle);
  check(
    "a stopped motor produces no disturbance, so the stop stays exact",
    stopped.omega[stopped.omega.length - 1] === 0,
    stopped.omega[stopped.omega.length - 1],
  );
}

// モデルそのもの。まず理想＝完全バイパス。
{
  const ideal = createWowFlutter(IDEAL_WOW_FLUTTER);
  check("the ideal motor is bypassed", ideal.bypassed);
  let silent = true;
  for (let i = 0; i < 500; i++) {
    if (ideal.torqueAt(i * 0.01, i * 0.37) !== 0) silent = false;
  }
  check(
    "and never produces a single non-zero torque",
    silent &&
      ideal.wowTorque === 0 &&
      ideal.flutterTorque === 0 &&
      ideal.commutationRippleTorque === 0,
  );
}

/** 試験用。**実機を測った値ではない** — 構造を動かすためだけの大きさ。 */
const TEST_WOW: WowFlutterParameters = {
  seed: 20260803,
  wow: { torque: 0.4, hz: 3, components: 3 },
  flutter: { torque: 0.2, hz: 25, components: 3 },
  commutationRipple: { torque: 0.15, cyclesPerRevolution: 24 },
};

// 3つの成分が本当に分かれていること。**ここがこのモジュールの全体設計。**
{
  const model = createWowFlutter(TEST_WOW);
  check("a motor with any component set is not bypassed", !model.bypassed);

  // 時間由来のものは角度を見ない。
  let timeOnly = true;
  for (let i = 0; i < 400; i++) {
    const t = i * 0.011;
    model.torqueAt(t, 0);
    const a = model.wowTorque;
    const b = model.flutterTorque;
    model.torqueAt(t, 2.4);
    if (model.wowTorque !== a || model.flutterTorque !== b) timeOnly = false;
  }
  check("wow and flutter depend on time alone, never on the angle", timeOnly);

  // 回転角由来のものは時計を見ない。**盤を止めれば転流リプルも止まる。**
  let angleOnly = true;
  for (let i = 0; i < 400; i++) {
    const phi = i * 0.017;
    model.torqueAt(0, phi);
    const a = model.commutationRippleTorque;
    model.torqueAt(123.456, phi);
    if (model.commutationRippleTorque !== a) angleOnly = false;
  }
  check("commutation ripple depends on the angle alone, never on the clock", angleOnly);

  // 逆転すれば同じ山を逆順に辿る。**正逆で厳密に対称。**
  const forward: number[] = [];
  for (let i = 0; i <= 200; i++) {
    model.torqueAt(0, i * 0.01);
    forward.push(model.commutationRippleTorque);
  }
  let mirrored = true;
  for (let i = 200; i >= 0; i--) {
    model.torqueAt(999, i * 0.01);
    if (model.commutationRippleTorque !== forward[i]) mirrored = false;
  }
  check("and retraces them exactly when the platter turns backwards", mirrored);

  // 1回転で元へ戻る。盤に固定されている以上、これが成り立たなければならない。
  model.torqueAt(0, 0.4);
  const atStart = model.commutationRippleTorque;
  model.torqueAt(0, 0.4 + Math.PI * 2);
  check(
    "commutation ripple comes back to the same value one revolution later",
    Math.abs(model.commutationRippleTorque - atStart) < 1e-9,
  );
}

// 決定論と seed。
{
  const a = createWowFlutter(TEST_WOW);
  const b = createWowFlutter(TEST_WOW);
  const other = createWowFlutter({ ...TEST_WOW, seed: TEST_WOW.seed + 1 });
  let same = true;
  let differs = false;
  for (let i = 0; i < 1000; i++) {
    const t = i * 0.003;
    const phi = i * 0.021;
    const one = a.torqueAt(t, phi);
    if (one !== b.torqueAt(t, phi)) same = false;
    if (one !== other.torqueAt(t, phi)) differs = true;
  }
  check("the same seed and parameters give the same torque, every time", same);
  check("and a different seed gives a different motor", differs);

  // 呼ぶ順番も回数も関係ない。**状態を持たないので、ブロックの切り方に依らない。**
  const stateless = createWowFlutter(TEST_WOW);
  const first = stateless.torqueAt(4.25, 1.1);
  for (let i = 0; i < 100; i++) stateless.torqueAt(i, i);
  check(
    "and the torque at one point does not depend on what was asked before",
    stateless.torqueAt(4.25, 1.1) === first,
  );
}

// 平均RPMと位相をドリフトさせないこと。**直流が無いことがその根拠。**
{
  const model = createWowFlutter(TEST_WOW);
  let wowSum = 0;
  let flutterSum = 0;
  let rippleSum = 0;
  let peak = 0;
  const steps = 400000;
  for (let i = 0; i < steps; i++) {
    // 角度は等速で進めた場合を模す。1回転を割り切らない刻みにして、たまたま
    // 山だけを踏み続けることが無いようにする。
    model.torqueAt(i * 1e-3, i * 0.0193);
    wowSum += model.wowTorque;
    flutterSum += model.flutterTorque;
    rippleSum += model.commutationRippleTorque;
    peak = Math.max(peak, Math.abs(model.torque));
  }
  check(
    "wow has no dc component, so the mean speed cannot drift",
    Math.abs(wowSum / steps) < 1e-3,
    wowSum / steps,
  );
  check(
    "nor does flutter",
    Math.abs(flutterSum / steps) < 1e-3,
    flutterSum / steps,
  );
  check(
    "nor does the commutation ripple",
    Math.abs(rippleSum / steps) < 1e-3,
    rippleSum / steps,
  );
  check(
    "and the total stays inside the amplitudes it was given",
    peak <=
      TEST_WOW.wow.torque + TEST_WOW.flutter.torque + TEST_WOW.commutationRipple.torque +
        1e-12,
    peak,
  );
}

// 較正の目盛りが実測と合うこと。**サーボが周波数ごとに違う量だけ抑え込む。**
{
  const hz = 3;
  const ratio = 0.002;
  const torque = torqueForSpeedRatio(ratio, hz, TARGET_RPM);
  const nominal = rpmToRadPerSec(TARGET_RPM);
  const omegaAt = (t: number) => 2 * Math.PI * hz * t;
  const trace = runDisturbed(6, (t) => torque * Math.sin(omegaAt(t)));

  // 起動の過渡を捨ててから、定常の振れ幅だけを見る。
  let low = Infinity;
  let high = -Infinity;
  for (let i = Math.floor(trace.omega.length * 0.5); i < trace.omega.length; i++) {
    low = Math.min(low, trace.omega[i]);
    high = Math.max(high, trace.omega[i]);
  }
  const measured = (high - low) / 2 / nominal;
  check(
    "torqueForSpeedRatio predicts the speed deviation it actually produces",
    Math.abs(measured / ratio - 1) < 0.02,
    { asked: ratio, measured },
  );

  // 同じトルクでも速い成分ほど残る。サーボの追従が間に合わなくなるため。
  const fastTorque = torqueForSpeedRatio(ratio, 30, TARGET_RPM);
  check(
    "and asking for the same deviation higher up needs more torque",
    fastTorque > torque,
    { at3Hz: torque, at30Hz: fastTorque },
  );
}

// 平均速度が動かないことを、モーターを回して直接確かめる。
{
  const model = createWowFlutter(TEST_WOW);
  const disturbed = runDisturbed(20, (t, phi) => model.torqueAt(t, phi));
  const quiet = runDisturbed(20, () => 0);

  const meanOf = (trace: Float64Array) => {
    let sum = 0;
    const from = Math.floor(trace.length * 0.5);
    for (let i = from; i < trace.length; i++) sum += trace[i];
    return sum / (trace.length - from);
  };
  const wobbling = radPerSecToRpm(meanOf(disturbed.omega));
  const steady = radPerSecToRpm(meanOf(quiet.omega));
  check(
    "a wobbling motor still averages the speed it was asked for",
    Math.abs(wobbling - TARGET_RPM) < 0.01 &&
      Math.abs(wobbling - steady) < 0.01,
    { wobbling, steady },
  );
  check(
    "while the instantaneous speed really is moving",
    (() => {
      let low = Infinity;
      let high = -Infinity;
      for (let i = Math.floor(disturbed.omega.length * 0.5); i < disturbed.omega.length; i++) {
        low = Math.min(low, disturbed.omega[i]);
        high = Math.max(high, disturbed.omega[i]);
      }
      return radPerSecToRpm(high - low) > 0.005;
    })(),
  );
}

// でたらめな設定でも壊れない。
{
  const absurd: WowFlutterParameters[] = [
    { seed: Number.NaN, wow: { torque: Number.NaN, hz: Number.NaN, components: Number.NaN }, flutter: { torque: -5, hz: -1, components: 0 }, commutationRipple: { torque: Number.NaN, cyclesPerRevolution: 0 } },
    { seed: 1, wow: { torque: 1e9, hz: 1e9, components: 1e9 }, flutter: { torque: 1e9, hz: 1e9, components: 1e9 }, commutationRipple: { torque: 1e9, cyclesPerRevolution: 1e9 } },
    { seed: -1, wow: { torque: 0.1, hz: 0, components: 2 }, flutter: { torque: 0.1, hz: 0, components: 2 }, commutationRipple: { torque: 0.1, cyclesPerRevolution: -3 } },
  ];
  let sane = true;
  let worst: unknown = null;
  for (const parameters of absurd) {
    const model = createWowFlutter(parameters);
    for (let i = 0; i < 2000; i++) {
      const torque = model.torqueAt(i * 0.004, i * 0.031);
      if (
        !Number.isFinite(torque) ||
        Math.abs(torque) > 3 * MOTOR_TUNING.maxMotorAccel
      ) {
        sane = false;
        worst = parameters;
        break;
      }
    }
    if (!sane) break;
  }
  check("no motor setting, however absurd, produces a wild torque", sane, worst);
}

if (failures > 0) throw new Error(`${failures} check(s) FAILED`);
console.log("\nall checks passed");
