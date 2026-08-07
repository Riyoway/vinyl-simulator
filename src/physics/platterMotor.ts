/**
 * Platter transport, as a pure step function.
 *
 * No Three.js, React or Zustand imports on purpose: this is the piece that
 * moves into the AudioWorklet (and later WASM) once audio becomes the
 * authoritative clock (rdd.md 4.2 / 5.3 / 31). Callers own the runtime.
 *
 * The platter is integrated from separated torque terms, not interpolated
 * towards a target, at normalised inertia I = 1 (so the terms are rad/s²):
 *
 *   angularAcceleration = motor + hand + external − activeBrake − viscousFriction − bearingFriction
 *
 * so scratching, stylus drag and the rest arrive as further terms on the same
 * sum instead of replacing the model. Every term is signed: the platter turns
 * either way, and friction always opposes whichever way it is going.
 *
 * `external` is where wow/flutter and commutation ripple enter (`wowFlutter.ts`). They are
 * torques, never a playback rate applied afterwards: whatever ω and angle come
 * out of this integration are what the audio, the arm and the scene all read.
 */

export type MotorState = "stopped" | "accelerating" | "running" | "braking";

/** Mutable, caller-owned. Never put this in React state or Zustand. */
export interface MotorRuntime {
  angle: number;
  angularVelocity: number;
}

export interface MotorInput {
  deltaSeconds: number;
  /**
   * The operator's START/STOP intent, and the only gate on the motor: the deck
   * has no power switch printed anywhere, so mains is always present
   * (rdd.md 0.1.1).
   */
  motorRequested: boolean;
  targetRpm: number;
  /**
   * The angular velocity a hand on the record is asking for, or null when
   * nobody is touching it. Zero is not the same as null: zero is a hand holding
   * the record still, which is exactly how a record is stopped by hand.
   */
  handAngularVelocity: number | null;
  /**
   * A disturbance the motor itself produces, rad/s² (I = 1 as everywhere here),
   * for wow/flutter and commutation ripple (`wowFlutter.ts`). One more term on
   * the same sum: the servo is told nothing about it in advance, so it can only
   * react to the speed error that results — which is why low frequencies come
   * out suppressed, exactly as on a real deck.
   *
   * Applied while the motor is driving only, which is what makes it drive
   * torque rather than cogging: an unpowered motor still coggs, an unpowered
   * one produces no commutation ripple. Leaving it out of the coasting case
   * also keeps the stop exact — that branch's sign guard assumes friction and
   * the brake are the only terms.
   */
  externalTorque?: number;
}

export interface MotorOutput {
  angle: number;
  angularVelocity: number;
  currentRpm: number;
  state: MotorState;
}

export const MOTOR_TUNING = {
  /**
   * Design targets at 33⅓ RPM, in seconds. Nothing reads these at runtime — the
   * torque constants below were sized to meet them and the deterministic check
   * asserts them. 45 RPM takes proportionally longer, as a real deck does.
   */
  spinUpSeconds: 0.7,
  brakeSeconds: 0.8,

  runningToleranceRpm: 0.15,
  stoppedToleranceRpm: 0.05,

  /**
   * Normalised inertia, I = 1 (dimensionless): every "torque" below is really
   * τ/I, so the units are rad/s², not N·m. Nothing in the model reads a mass or
   * a radius.
   *
   * ponytail: normalised because no term needs a real inertia yet. Give it SI
   * units when hand-contact torque arrives for scratching — I = ½mr² with a
   * 1.5 kg, 0.15 m platter is 0.017 kg·m², so each constant here becomes
   * N·m by multiplying by that, and nothing else changes.
   */
  /** Servo stiffness, 1/s. Loop gain, not the ramp — the ceiling below shapes that. */
  servoGain: 120,
  /** Drive torque ceiling, rad/s². This is what sets the spin-up ramp. */
  maxMotorAccel: 7.5,
  /**
   * Electric brake, rad/s². Held at full strength above the knee so a stop from
   * speed is felt as a deliberate brake, then tapered below it so the platter is
   * handed over to bearing friction instead of being clamped to a halt.
   */
  maxBrakeAccel: 4.5,
  brakeKneeRadPerSec: 0.35,
  /** Speed-proportional bearing/belt drag, 1/s. */
  viscousDrag: 0.3,
  /** Speed-independent bearing drag, rad/s². Ends the coast in finite time. */
  bearingDrag: 0.4,

  /**
   * How firmly a hand couples to the record, 1/s. The platter tracks the hand
   * rather than the other way round, but the coupling is finite, so a hand
   * holding a started deck leaves a slow creep (motorTorque / handGrip, about
   * ⅓ RPM) instead of a dead stop — which is what a slipmat does. Bounded by
   * the substep: handGrip × maxSubstepSeconds must stay well under 2.
   */
  handGrip: 200,
  /**
   * Ceiling on the hand's angular velocity, rad/s. One jittery pointer sample
   * must not hand the platter an absurd speed (this is ~380 RPM, far past any
   * real scratch).
   */
  maxHandRadPerSec: 40,

  /**
   * A backgrounded tab hands back one enormous delta on return. Integrating it
   * would teleport the platter, so a step is never longer than this (at 33⅓ RPM
   * one turn takes 1.8s, so 50ms is at most 10° of travel).
   */
  maxDeltaSeconds: 0.05,
  /**
   * Integration substep. The torque terms are non-linear in ω, so a frame is
   * split into steps no longer than this to keep 20Hz and 144Hz on the same
   * trajectory.
   */
  maxSubstepSeconds: 1 / 240,
};

const TWO_PI = Math.PI * 2;

/**
 * Which way a positive ω actually turns the deck.
 *
 * A record plays clockwise seen from above, so positive ω — normal playback,
 * and the forward direction for audio later — is a *negative* rotation about
 * world up, since that axis is right-handed. Negative ω is the reverse
 * direction. The physics never needs to know this; the scene and the pointer
 * maths both multiply by it, which is what stops the two from disagreeing.
 */
export const SPIN_ABOUT_WORLD_UP = -1;

export const rpmToRadPerSec = (rpm: number) => (rpm * TWO_PI) / 60;
export const radPerSecToRpm = (radPerSec: number) => (radPerSec * 60) / TWO_PI;

/** Sum of the torque terms at one instant, rad/s² (I = 1, see MOTOR_TUNING). */
function angularAcceleration(
  omega: number,
  targetOmega: number,
  driving: boolean,
  hand: number | null,
  external: number,
): number {
  const viscousFriction = MOTOR_TUNING.viscousDrag * omega;
  // Coulomb: opposes whichever way the platter is turning, and is exactly zero
  // at rest, so it holds rather than pushes.
  const bearingFriction = MOTOR_TUNING.bearingDrag * Math.sign(omega);
  // The hand is one more torque, not a replacement: holding a started deck
  // makes the two fight, which is what should happen.
  const handTorque =
    hand === null ? 0 : MOTOR_TUNING.handGrip * (hand - omega);

  if (driving) {
    // The servo feeds the known losses forward, so a settled platter sits on
    // the nominal speed instead of drooping below it — which matters because
    // this ω becomes the audio playback rate.
    const demand =
      viscousFriction +
      bearingFriction +
      MOTOR_TUNING.servoGain * (targetOmega - omega);
    const motorTorque = Math.min(
      Math.max(demand, -MOTOR_TUNING.maxBrakeAccel),
      MOTOR_TUNING.maxMotorAccel,
    );
    const driven =
      motorTorque + handTorque - viscousFriction - bearingFriction;
    // Added after the servo has already committed to its demand, so the loop
    // only ever sees the disturbance as an error to chase. Left out entirely
    // when there is none, so an ideal deck runs the original arithmetic.
    return external === 0 ? driven : driven + external;
  }

  const activeBrakeTorque =
    MOTOR_TUNING.maxBrakeAccel *
    Math.min(1, Math.abs(omega) / MOTOR_TUNING.brakeKneeRadPerSec) *
    Math.sign(omega);
  return handTorque - activeBrakeTorque - viscousFriction - bearingFriction;
}

/** The trust boundary for the disturbance: undefined, NaN and absurd all read as none. */
function clampExternalTorque(torque: number | undefined): number {
  if (torque === undefined || !Number.isFinite(torque)) return 0;
  return Math.min(
    Math.max(torque, -MOTOR_TUNING.maxMotorAccel),
    MOTOR_TUNING.maxMotorAccel,
  );
}

export function stepPlatterMotor(
  runtime: MotorRuntime,
  input: MotorInput,
): MotorOutput {
  const delta = Math.min(
    Math.max(input.deltaSeconds, 0),
    MOTOR_TUNING.maxDeltaSeconds,
  );

  const targetRpm = Math.max(0, input.targetRpm);
  const driving = input.motorRequested;
  const targetOmega = driving ? rpmToRadPerSec(targetRpm) : 0;

  // A hand is only in contact when it hands over a usable number. Clamped here,
  // once, so no pointer glitch can reach the integrator.
  const hand =
    input.handAngularVelocity === null ||
    !Number.isFinite(input.handAngularVelocity)
      ? null
      : Math.min(
          Math.max(input.handAngularVelocity, -MOTOR_TUNING.maxHandRadPerSec),
          MOTOR_TUNING.maxHandRadPerSec,
        );

  // Bounded by the motor's own ceiling: a disturbance is something the motor
  // produces, so it cannot out-push the motor however absurd the setting.
  const external = clampExternalTorque(input.externalTorque);

  let omega = Number.isFinite(runtime.angularVelocity)
    ? runtime.angularVelocity
    : 0;
  let angle = Number.isFinite(runtime.angle) ? runtime.angle : 0;

  const substeps = Math.max(
    1,
    Math.ceil(delta / MOTOR_TUNING.maxSubstepSeconds),
  );
  const h = delta / substeps;
  for (let i = 0; i < substeps; i++) {
    const before = omega;
    omega +=
      angularAcceleration(omega, targetOmega, driving, hand, external) * h;
    if (!Number.isFinite(omega)) omega = 0;

    // Friction and the brake can only stop the platter, never reverse it. A
    // motor or a hand may, so the guard applies to the coasting case only.
    if (
      !driving &&
      hand === null &&
      before !== 0 &&
      Math.sign(omega) !== Math.sign(before)
    ) {
      omega = 0;
    }
    angle += omega * h;
  }

  let currentRpm = radPerSecToRpm(omega);
  let state: MotorState;

  if (driving) {
    state =
      Math.abs(currentRpm - targetRpm) <= MOTOR_TUNING.runningToleranceRpm
        ? "running"
        : "accelerating";
  } else if (
    Math.abs(currentRpm) <= MOTOR_TUNING.stoppedToleranceRpm &&
    hand === null
  ) {
    // Bearing friction already brings ω to zero in finite time; this only trims
    // the last hundredth of an RPM, so nothing visible freezes mid-turn. A hand
    // in contact is exempt: it may be about to turn the record from rest.
    omega = 0;
    currentRpm = 0;
    state = "stopped";
  } else {
    state = "braking";
  }

  angle = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
  if (!Number.isFinite(angle)) angle = 0;

  return { angle, angularVelocity: omega, currentRpm, state };
}
