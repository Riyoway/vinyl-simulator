import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  Box3,
  Matrix4,
  Quaternion,
  Vector3,
  type Mesh,
  type Object3D,
  type Ray,
} from "three";
import {
  buildControlResolver,
  type ControlId,
  type ResolvedTurntable,
} from "../../model/manifest";
import { usePointerControls } from "../../interaction/usePointerControls";
import {
  deckDiscShape,
  deckPlatterAngle,
  deckStylus,
  deckTonearm,
} from "../../audio/deckAudio";
import {
  recordPointAt,
  warpHeightAt,
  type RecordPoint,
} from "../../audio/engine/discShape";
import { SPIN_ABOUT_WORLD_UP } from "../../physics/platterMotor";
import {
  createTonearmVertical,
  liftAngleForSurface,
  stepTonearmFall,
  type LiftFall,
} from "../../physics/tonearm";
import {
  angleRadiansToTrim,
  offsetMetresToPitch,
  pitchToOffsetMetres,
  trimToAngleRadians,
} from "../../physics/pitch";
import { GROOVE, grooveZoneAt, groovePositionAt } from "../../physics/groove";
import {
  handInput,
  stylusTelemetry,
  useDeckStore,
  type TrimKey,
} from "../../store/useDeckStore";

const PRESS_DEPTH = 0.0015; // 1.5mm (rdd.md 5.7)
const PRESS_RATE = 22; // exponential easing, frame-rate independent

/**
 * Below this the pointer ray is nearly parallel to the panel and the
 * intersection is numerically useless, so the fader keeps its last value
 * instead of leaping to the horizon.
 */
const PITCH_MIN_INCIDENCE = 0.05;

/**
 * A right-handed rotation about the knob's own up axis is anticlockwise seen
 * from above, and anticlockwise is a negative trim, so the two run opposite.
 */
const KNOB_CLOCKWISE = -1;
/** Closer than this to the spindle the pointer's angle is noise, so ignore it. */
const KNOB_MIN_GRAB_RADIUS = 0.002;
/** Same idea for the record, scaled to a 12" disc: inside the label, ignore it. */
const RECORD_MIN_GRAB_RADIUS = 0.01;
/** Landed-on-the-surface tolerance, radians. 1e-4 rad is 0.02mm at the tip. */
const CONTACT_EPSILON = 1e-4;


/**
 * Holds a latching button cap at one of two heights along its own "down" axis.
 * `latched` is the logical state, not the pointer state: a cancelled press
 * leaves the logic unchanged, so the cap settles back where it was. The rest
 * pose is captured once and every frame is written from it, so moves never
 * accumulate. The axis is measured from the parent's world matrix rather than
 * assuming which local axis survived the Y-up conversion (rdd.md 5.7).
 *
 * The rest pose is captured in a layout effect, and no frame may write before
 * it: React defers passive effects past the next paint, so a render-loop tick
 * can land between mount and a plain useEffect — early enough to write an
 * uninitialised rest pose over the node's real one.
 */
function useLatchAnimation(node: Object3D, latched: boolean) {
  const rest = useRef(new Vector3());
  const axis = useRef(new Vector3());
  const progress = useRef(0);
  const measured = useRef(false);
  const captured = useRef(false);

  useLayoutEffect(() => {
    rest.current.copy(node.position);
    progress.current = 0;
    measured.current = false;
    captured.current = true;
    const restPose = rest.current.clone();
    return () => {
      captured.current = false;
      node.position.copy(restPose);
    };
  }, [node]);

  useFrame((_, delta) => {
    if (!captured.current) return;

    if (!measured.current) {
      const toLocal = new Matrix4();
      if (node.parent) toLocal.copy(node.parent.matrixWorld).invert();
      axis.current.set(0, -1, 0).transformDirection(toLocal).normalize();
      measured.current = true;
    }

    const target = latched ? 1 : 0;
    if (progress.current === target) return;

    const step = 1 - Math.exp(-delta * PRESS_RATE);
    progress.current += (target - progress.current) * step;
    if (Math.abs(target - progress.current) < 1e-4) progress.current = target;

    node.position
      .copy(rest.current)
      .addScaledVector(axis.current, PRESS_DEPTH * progress.current);
  });
}

/**
 * Drags the pitch cap along its slot and returns the drag handler.
 *
 * The travel axis is the fader's local X (the Blender rig's axis, preserved
 * through the glTF conversion); it and the panel normal are read off the
 * collider's world matrix so the maths works in whatever frame the scene is in.
 * Screen pixels never enter it: the pointer ray is intersected with the panel
 * plane and that point is projected onto the slot, so the cap tracks the
 * pointer at any camera angle or zoom.
 *
 * Position is written absolutely from the GLB's own rest pose every frame, so
 * drags never accumulate.
 */
function usePitchFader(node: Object3D, collider: Mesh) {
  const rest = useRef(new Vector3());
  const colliderRest = useRef(new Vector3());
  const axisLocal = useRef(new Vector3());
  const colliderAxisLocal = useRef(new Vector3());
  const axisWorld = useRef(new Vector3());
  const planeNormal = useRef(new Vector3());
  const restWorld = useRef(new Vector3());
  const scratch = useRef(new Vector3());
  const measured = useRef(false);
  const applied = useRef(Number.NaN);
  const captured = useRef(false);
  /** Pitch minus pointer position at grab time — keeps the cap from jumping. */
  const grabOffset = useRef<number | null>(null);

  // A layout effect, not a plain one: React defers passive effects past the
  // next paint, so the render loop would otherwise get a tick in first and
  // write an uninitialised rest pose (the origin) over the node's real one —
  // which then gets captured as "rest" and the cap is gone for good.
  useLayoutEffect(() => {
    // Captured once per node and cached on it. Re-reading node.position on a
    // remount (Fast Refresh, or this hook running again) would latch whatever
    // displaced position the cap happened to be at as the new rest, and the
    // drift would never come back. The GLB's own pose is the only rest pose.
    const cached = node.userData.pitchRestPosition as Vector3 | undefined;
    if (cached) rest.current.copy(cached);
    else {
      node.userData.pitchRestPosition = rest.current.copy(node.position).clone();
    }

    // HIT_PITCH is a sibling of the pivot in the asset, so it does not inherit
    // the cap's movement — it has to be carried along, or the grab area stays
    // behind at the rest pose while the cap slides away from it.
    const cachedHit = collider.userData.pitchRestPosition as Vector3 | undefined;
    if (cachedHit) colliderRest.current.copy(cachedHit);
    else {
      collider.userData.pitchRestPosition = colliderRest.current
        .copy(collider.position)
        .clone();
    }

    measured.current = false;
    applied.current = Number.NaN;
    captured.current = true;
    const restPose = rest.current.clone();
    const colliderRestPose = colliderRest.current.clone();
    // Dev-only handle: `pitchNode.position` is the fastest way to tell a cap
    // that moved from a cap that stopped being drawn.
    if (import.meta.env.DEV) {
      (globalThis as { pitchNode?: Object3D }).pitchNode = node;
    }
    return () => {
      captured.current = false;
      node.position.copy(restPose);
      collider.position.copy(colliderRestPose);
    };
  }, [node, collider]);

  /**
   * The press this offset belongs to. Comparing the store's counter, rather
   * than clearing it from a React effect, is what stops a fast re-grab from
   * inheriting the last one's offset and jumping the cap.
   */
  const grabSeq = useRef(-1);

  const measure = useCallback(() => {
    if (measured.current) return;

    // Bring the matrices up to date first. useFrame runs before the renderer
    // updates the world matrices, so on the very first frame these would
    // otherwise still be stale — and inverting a stale (singular) matrix hands
    // back a zero matrix, whose transformDirection().normalize() is NaN. A NaN
    // position does not nudge the cap, it stops drawing it entirely.
    collider.updateWorldMatrix(true, false);
    node.parent?.updateWorldMatrix(true, false);

    axisWorld.current.set(1, 0, 0).transformDirection(collider.matrixWorld);
    planeNormal.current.set(0, 1, 0).transformDirection(collider.matrixWorld);

    const toLocal = new Matrix4();
    if (node.parent) toLocal.copy(node.parent.matrixWorld).invert();
    axisLocal.current.copy(axisWorld.current).transformDirection(toLocal);

    // The collider is a sibling here, but derive its axis from its own parent
    // rather than assuming the two frames stay identical.
    const toColliderLocal = new Matrix4();
    if (collider.parent) {
      toColliderLocal.copy(collider.parent.matrixWorld).invert();
    }
    colliderAxisLocal.current
      .copy(axisWorld.current)
      .transformDirection(toColliderLocal);

    restWorld.current.copy(rest.current);
    node.parent?.localToWorld(restWorld.current);

    // Anything unusable is refused rather than latched: without a trustworthy
    // axis the cap simply stays on its GLB pose.
    const usable =
      Number.isFinite(axisLocal.current.lengthSq()) &&
      axisLocal.current.lengthSq() > 0.5 &&
      Number.isFinite(axisWorld.current.lengthSq()) &&
      Number.isFinite(restWorld.current.lengthSq());
    if (!usable) {
      if (import.meta.env.DEV) {
        console.warn("pitch fader: unusable axis, retrying next frame", {
          axisLocal: axisLocal.current.toArray(),
          axisWorld: axisWorld.current.toArray(),
        });
      }
      axisLocal.current.set(0, 0, 0);
      return;
    }
    measured.current = true;
  }, [collider, node]);

  const onDrag = useCallback(
    (ray: Ray) => {
      measure();

      const incidence = ray.direction.dot(planeNormal.current);
      if (Math.abs(incidence) < PITCH_MIN_INCIDENCE) return;

      const distance =
        scratch.current
          .copy(restWorld.current)
          .sub(ray.origin)
          .dot(planeNormal.current) / incidence;
      if (distance <= 0) return; // panel is behind the pointer

      const alongSlot = scratch.current
        .copy(ray.direction)
        .multiplyScalar(distance)
        .add(ray.origin)
        .sub(restWorld.current)
        .dot(axisWorld.current);

      // Both directions of the scale live in physics/pitch: the offset here is
      // along the collider's local +X, which is the axis those functions are
      // written in. No sign is applied on this side, so there is nowhere for the
      // two to disagree.
      const raw = offsetMetresToPitch(alongSlot);
      const store = useDeckStore.getState();
      if (grabSeq.current !== store.pressSeq) {
        grabSeq.current = store.pressSeq;
        grabOffset.current = store.pitch - raw;
      }
      store.setPitch(raw + (grabOffset.current ?? 0));
    },
    [measure],
  );

  useFrame(() => {
    if (!captured.current) return;
    measure();
    const { pitch } = useDeckStore.getState();
    if (pitch === applied.current) return;

    // Always absolute from the GLB's own pose. The offset is only added when it
    // is a real number and there is a real axis to add it along, so the worst
    // case is a cap that does not move — never one that leaves the deck or
    // stops being drawn.
    node.position.copy(rest.current);
    collider.position.copy(colliderRest.current);
    const offset = pitchToOffsetMetres(pitch);
    if (offset !== 0 && Number.isFinite(offset) && measured.current) {
      node.position.addScaledVector(axisLocal.current, offset);
      collider.position.addScaledVector(colliderAxisLocal.current, offset);
    }
    applied.current = pitch;
  });

  return onDrag;
}

/**
 * Turns a SPEED CONTROL trimmer and returns its drag handler.
 *
 * The gesture is the real one: the pointer ray is intersected with the panel
 * plane through the knob's spindle and the knob follows the angle the pointer
 * sweeps around it, 1:1. Tracking the angle's delta between moves rather than
 * its absolute value keeps the ±π seam from ever showing up.
 *
 * Rotation is written absolutely from the GLB's rest orientation, so turns
 * never accumulate. HIT_KNOB_* is a child of the pivot in the asset, so the
 * grab area comes along by itself — unlike the pitch fader's collider.
 */
function useKnobTrim(node: Object3D, collider: Mesh, which: TrimKey) {
  const rest = useRef(new Quaternion());
  const axisLocal = useRef(new Vector3());
  const axisWorld = useRef(new Vector3());
  const centreWorld = useRef(new Vector3());
  const spin = useRef(new Quaternion());
  const hit = useRef(new Vector3());
  const cross = useRef(new Vector3());
  /** Where the pointer last sat around the spindle; null between presses. */
  const grabVector = useRef<Vector3 | null>(null);
  const measured = useRef(false);
  const captured = useRef(false);
  const applied = useRef(Number.NaN);

  useLayoutEffect(() => {
    const cached = node.userData.knobRestQuaternion as Quaternion | undefined;
    if (cached) rest.current.copy(cached);
    else {
      node.userData.knobRestQuaternion = rest.current
        .copy(node.quaternion)
        .clone();
    }

    measured.current = false;
    applied.current = Number.NaN;
    captured.current = true;
    const restPose = rest.current.clone();
    return () => {
      captured.current = false;
      node.quaternion.copy(restPose);
    };
  }, [node]);

  /** Which press the bearing above belongs to — see the pitch fader's note. */
  const grabSeq = useRef(-1);

  const measure = useCallback(() => {
    if (measured.current) return;
    collider.updateWorldMatrix(true, false);
    node.updateWorldMatrix(true, false);

    // The knob turns about world up. Expressed in the pivot's own frame for the
    // rotation, and kept in world for the pointer maths.
    axisWorld.current.set(0, 1, 0);
    const toLocal = new Matrix4().copy(node.matrixWorld).invert();
    axisLocal.current.set(0, 1, 0).transformDirection(toLocal).normalize();
    node.getWorldPosition(centreWorld.current);

    if (!Number.isFinite(axisLocal.current.lengthSq())) {
      axisLocal.current.set(0, 0, 0);
      return;
    }
    measured.current = true;
  }, [collider, node]);

  const onDrag = useCallback(
    (ray: Ray) => {
      measure();
      if (!measured.current) return;

      const incidence = ray.direction.dot(axisWorld.current);
      if (Math.abs(incidence) < PITCH_MIN_INCIDENCE) return;

      const distance =
        hit.current
          .copy(centreWorld.current)
          .sub(ray.origin)
          .dot(axisWorld.current) / incidence;
      if (distance <= 0) return;

      hit.current
        .copy(ray.direction)
        .multiplyScalar(distance)
        .add(ray.origin)
        .sub(centreWorld.current);
      if (hit.current.lengthSq() < KNOB_MIN_GRAB_RADIUS ** 2) return;

      const store = useDeckStore.getState();
      const previous = grabVector.current;
      if (!previous || grabSeq.current !== store.pressSeq) {
        // First move of this press: just take a bearing, don't turn anything.
        grabSeq.current = store.pressSeq;
        grabVector.current = hit.current.clone();
        return;
      }

      const swept = Math.atan2(
        cross.current.crossVectors(previous, hit.current).dot(axisWorld.current),
        previous.dot(hit.current),
      );
      previous.copy(hit.current);

      store.setTrim(
        which,
        store[which] + angleRadiansToTrim(KNOB_CLOCKWISE * swept),
      );
    },
    [measure, which],
  );

  useFrame(() => {
    if (!captured.current) return;
    measure();
    const trim = useDeckStore.getState()[which];
    if (trim === applied.current) return;

    node.quaternion.copy(rest.current);
    const angle = KNOB_CLOCKWISE * trimToAngleRadians(trim);
    if (angle !== 0 && Number.isFinite(angle) && measured.current) {
      node.quaternion.multiply(
        spin.current.setFromAxisAngle(axisLocal.current, angle),
      );
    }
    applied.current = trim;
  });

  return onDrag;
}

/**
 * Reports where a hand on the record is, as an angle about the spindle.
 *
 * Only the angle is published - the drive differentiates it against the frame
 * clock (see PlatterDrive). Measuring it in a world-fixed basis, not one that
 * turns with the record, is what makes the number the hand's own angular
 * velocity rather than its velocity relative to the groove.
 *
 * Nothing here writes the platter's rotation: the physics owns the angular
 * velocity, and this is only an input to it.
 */
function useRecordDrag(platter: Object3D, collider: Mesh) {
  const axisWorld = useRef(new Vector3());
  const spindleWorld = useRef(new Vector3());
  const basisX = useRef(new Vector3());
  const basisY = useRef(new Vector3());
  const hit = useRef(new Vector3());
  const measured = useRef(false);

  const measure = useCallback(() => {
    if (measured.current) return;
    platter.updateWorldMatrix(true, false);
    collider.updateWorldMatrix(true, false);

    // Spin axis and spindle, both invariant under the platter's own rotation.
    axisWorld.current.set(0, 1, 0);
    platter.getWorldPosition(spindleWorld.current);

    // A basis that does NOT turn with the record, so the angle is absolute.
    basisX.current.set(1, 0, 0).projectOnPlane(axisWorld.current).normalize();
    basisY.current.crossVectors(axisWorld.current, basisX.current).normalize();

    if (!Number.isFinite(basisX.current.lengthSq())) return;
    measured.current = true;
  }, [collider, platter]);

  return useCallback(
    (ray: Ray) => {
      measure();
      if (!measured.current) return;

      const incidence = ray.direction.dot(axisWorld.current);
      if (Math.abs(incidence) < PITCH_MIN_INCIDENCE) return;

      const distance =
        hit.current
          .copy(spindleWorld.current)
          .sub(ray.origin)
          .dot(axisWorld.current) / incidence;
      if (distance <= 0) return;

      hit.current
        .copy(ray.direction)
        .multiplyScalar(distance)
        .add(ray.origin)
        .sub(spindleWorld.current);
      if (hit.current.lengthSq() < RECORD_MIN_GRAB_RADIUS ** 2) return;

      // Signed the same way the platter is: dragging clockwise seen from above
      // is a positive angle, so a clockwise drag asks for a positive omega.
      handInput.angle =
        SPIN_ABOUT_WORLD_UP *
        Math.atan2(
          hit.current.dot(basisY.current),
          hit.current.dot(basisX.current),
        );
    },
    [measure],
  );
}

/**
 * Moves the tonearm: one grab, both axes, and the arm goes where the pointer
 * goes.
 *
 * The point that was grabbed can only travel on a sphere about the arm's pivot,
 * so that is what the pointer is solved against: the ray is intersected with
 * that sphere (or, when it misses, taken at its closest approach, which is the
 * same answer at the boundary and smooth across it). The direction from the
 * pivot to that point gives both angles at once — its bearing swings the arm,
 * its tilt lifts it.
 *
 * Solving both from one intersection is what keeps them apart. Projecting each
 * onto its own plane, as this did first, coupled them badly: the lift's plane
 * turns with the arm, so swinging fed back as judder, and the yaw's plane put
 * the intersection further away as the pointer rose, flinging the arm sideways
 * on a straight-up drag. Reading the ray's own angles instead fixed the coupling
 * but stopped tracking the pointer, since a pixel of mouse is a much smaller
 * angle at the eye than at the arm's pivot.
 *
 * Angles are taken relative to the grab, so the arm never drifts, and pushing
 * past a limit and coming back lands exactly where it should. Rotation is
 * written absolutely from the GLB's rest pose; the lift's floor is whatever the
 * stylus is over (physics/tonearm).
 */
function useTonearmDrag(
  yawNode: Object3D,
  liftNode: Object3D,
  headshell: Object3D,
  stylus: Object3D,
  recordMesh: Object3D,
  platter: Object3D,
) {
  const yawRest = useRef(new Quaternion());
  const liftRest = useRef(new Quaternion());
  const yawAxisLocal = useRef(new Vector3());
  const liftAxisLocal = useRef(new Vector3());
  const up = useRef(new Vector3(0, 1, 0));
  const pivotWorld = useRef(new Vector3());
  const armDirection = useRef(new Vector3());
  const liftAxisWorld = useRef(new Vector3());
  const spin = useRef(new Quaternion());
  const fall = useRef<LiftFall>({ lift: 0, velocity: 0 });
  const measured = useRef(false);
  const captured = useRef(false);
  const appliedYaw = useRef(Number.NaN);
  const appliedLift = useRef(Number.NaN);

  /** What the pointer had hold of when the press started. */
  const grab = useRef<{
    seq: number;
    radius: number;
    bearing: number;
    tilt: number;
    yaw: number;
    lift: number;
  } | null>(null);

  /** All measured off the scene once the asset is up — never assumed. */
  const contactAngle = useRef(0);
  const recordRadius = useRef(0);
  const spindleWorld = useRef(new Vector3());
  const stylusWorld = useRef(new Vector3());
  /** The tip in the stylus mesh's own frame — see the note in `measure`. */
  const tipLocal = useRef(new Vector3());
  /**
   * How far the tip sits from the lift pivot along the arm. With the arm near
   * level this is exactly d(tip height)/d(lift angle), so it turns the fall's
   * angular velocity into the tip's descent speed in metres per second.
   */
  const tipReach = useRef(0);
  /** The surface under the stylus right now, in radians of lift. */
  const floor = useRef(0);
  /** Reused so the per-frame record lookup allocates nothing. */
  const recordPoint = useRef<RecordPoint>({ radius: 0, angle: 0, wobble: 0 });
  /** The tip about the lift pivot, and the flat record's height, from `measure`. */
  const tipAlongArm = useRef(0);
  const tipAboveTip = useRef(0);
  const flatSurfaceOffset = useRef(0);
  /**
   * The arm's own vertical motion. A warped surface does not simply carry the
   * arm with it — the arm has mass, and only follows below its resonance
   * (physics/tonearm.ts). The audio thread solves the same model per sample for
   * the cantilever's side of it; this one is here so the pose on screen is the
   * arm's, not the record's. Both run off the same parameters, and with the
   * ideal arm both reduce to "the arm rides the surface" — exactly as before.
   */
  const armVertical = useRef(createTonearmVertical());
  /** Reconfigure only when the deck actually hands over different parts. */
  const armTuning = useRef<{ arm: unknown; suspension: unknown }>({
    arm: null,
    suspension: null,
  });
  /** Whether the record is currently driving the arm at all. */
  const armEngaged = useRef(false);

  useLayoutEffect(() => {
    const cachedYaw = yawNode.userData.yawRestQuaternion as
      | Quaternion
      | undefined;
    if (cachedYaw) yawRest.current.copy(cachedYaw);
    else {
      yawNode.userData.yawRestQuaternion = yawRest.current
        .copy(yawNode.quaternion)
        .clone();
    }

    const cachedLift = liftNode.userData.liftRestQuaternion as
      | Quaternion
      | undefined;
    if (cachedLift) liftRest.current.copy(cachedLift);
    else {
      liftNode.userData.liftRestQuaternion = liftRest.current
        .copy(liftNode.quaternion)
        .clone();
    }

    measured.current = false;
    appliedYaw.current = Number.NaN;
    appliedLift.current = Number.NaN;
    captured.current = true;
    fall.current = { lift: useDeckStore.getState().tonearmLift, velocity: 0 };
    const yawPose = yawRest.current.clone();
    const liftPose = liftRest.current.clone();
    return () => {
      captured.current = false;
      yawNode.quaternion.copy(yawPose);
      liftNode.quaternion.copy(liftPose);
    };
  }, [liftNode, yawNode]);

  const measure = useCallback(() => {
    if (measured.current) return;
    yawNode.updateWorldMatrix(true, false);
    liftNode.updateWorldMatrix(true, false);
    headshell.updateWorldMatrix(true, false);

    yawNode.getWorldPosition(pivotWorld.current);
    headshell
      .getWorldPosition(armDirection.current)
      .sub(pivotWorld.current)
      .projectOnPlane(up.current)
      .normalize();
    // Turning about (arm x up) by a positive angle carries the stylus upward.
    liftAxisWorld.current
      .crossVectors(armDirection.current, up.current)
      .normalize();

    const toYawLocal = new Matrix4().copy(yawNode.matrixWorld).invert();
    yawAxisLocal.current.set(0, 1, 0).transformDirection(toYawLocal).normalize();
    const toLiftLocal = new Matrix4().copy(liftNode.matrixWorld).invert();
    liftAxisLocal.current
      .copy(liftAxisWorld.current)
      .transformDirection(toLiftLocal);

    if (
      !Number.isFinite(yawAxisLocal.current.lengthSq()) ||
      !Number.isFinite(liftAxisLocal.current.lengthSq())
    ) {
      return;
    }

    // Where the tip actually is: the lowest point of the stylus mesh, not the
    // mesh's origin — on this asset those differ by about 3mm, which is twice
    // the gap being measured.
    const tipBox = new Box3().setFromObject(stylus);
    const tip = tipBox.getCenter(new Vector3()).setY(tipBox.min.y);
    // Kept in the mesh's own frame so every frame can have the tip's world
    // position for one matrix multiply, instead of rebuilding the box — and so
    // the groove radius is the tip's, not the mesh origin's, which sit about
    // 3mm apart along the arm.
    tipLocal.current.copy(tip);
    stylus.worldToLocal(tipLocal.current);

    // And what it can land on: the record's top face and how far it reaches.
    const discBox = new Box3().setFromObject(recordMesh);
    recordRadius.current = (discBox.max.x - discBox.min.x) / 2;
    platter.getWorldPosition(spindleWorld.current);

    // The tip's own geometry about the lift pivot, kept so the contact angle can
    // be re-solved every frame: a warped record's surface is not a fixed height,
    // so the angle at which the stylus meets it is not a fixed angle either.
    const fromPivot = tip.sub(pivotWorld.current);
    tipReach.current = fromPivot.dot(armDirection.current);
    tipAlongArm.current = fromPivot.dot(armDirection.current);
    tipAboveTip.current = fromPivot.dot(up.current);
    flatSurfaceOffset.current = discBox.max.y - pivotWorld.current.y;
    contactAngle.current =
      liftAngleForSurface(
        tipAlongArm.current,
        tipAboveTip.current,
        flatSurfaceOffset.current,
      ) ?? 0;

    if (import.meta.env.DEV) {
      // The groove radii are the spec's, not the mesh's. If the asset is ever
      // rescaled these two part company and every zone boundary is wrong, so
      // say so rather than letting it drift silently.
      const drift = recordRadius.current - GROOVE.discRadius;
      if (Math.abs(drift) > 0.002) {
        console.warn(
          `[tonearm] disc measures ${(recordRadius.current * 1000).toFixed(1)}mm but GROOVE.discRadius is ${(GROOVE.discRadius * 1000).toFixed(1)}mm`,
        );
      }
    }
    measured.current = true;
  }, [headshell, liftNode, platter, recordMesh, stylus, yawNode]);

  /**
   * The horizontal distance from the spindle to the stylus tip — the one
   * measurement both "what is under the stylus" and "where on the groove" are
   * answered from. Recomputed every frame because swinging the arm moves it.
   */
  const tipRadius = useCallback(() => {
    stylus.updateWorldMatrix(true, false);
    stylusWorld.current
      .copy(tipLocal.current)
      .applyMatrix4(stylus.matrixWorld);
    return Math.hypot(
      stylusWorld.current.x - spindleWorld.current.x,
      stylusWorld.current.z - spindleWorld.current.z,
    );
  }, [stylus]);

  /**
   * The bearing the pointer is asking for, taken on the upright cylinder the
   * grabbed point travels around. A cylinder, not a sphere: the arm lies close
   * to the sphere's silhouette, where a sideways nudge becomes mostly tilt, and
   * not a flat plane either, whose intersection races off into the distance as
   * the pointer rises and drags the arm sideways with it. On the cylinder,
   * moving the pointer up slides along the wall and leaves the bearing alone.
   */
  const bearingAt = useCallback((ray: Ray, radius: number) => {
    const ox = ray.origin.x - pivotWorld.current.x;
    const oz = ray.origin.z - pivotWorld.current.z;
    const dx = ray.direction.x;
    const dz = ray.direction.z;

    const a = dx * dx + dz * dz;
    if (a < 1e-9) return null; // looking straight down the axis

    const half = (ox * dx + oz * dz) / a;
    const gap = half * half - (ox * ox + oz * oz - radius * radius) / a;
    // On the wall where the pointer is over it, at the closest approach where
    // it is not; the two agree on the silhouette, so crossing it never jumps.
    const distance = gap > 0 ? -half - Math.sqrt(gap) : -half;
    if (!(distance > 0)) return null;

    return Math.atan2(ox + dx * distance, oz + dz * distance);
  }, []);

  /** How far the ray is tilted — the lift's own axis, unaffected by bearing. */
  const tiltOf = (ray: Ray) =>
    Math.asin(Math.min(Math.max(ray.direction.y, -1), 1));

  const onDrag = useCallback(
    (ray: Ray) => {
      measure();
      if (!measured.current) return;

      const store = useDeckStore.getState();
      if (grab.current?.seq !== store.pressSeq) {
        // Take hold: the cylinder is the one through the point being grabbed,
        // found where the pointer meets the arm's own horizontal plane.
        const incidence = ray.direction.y;
        if (Math.abs(incidence) < PITCH_MIN_INCIDENCE) return;
        const toPlane =
          (pivotWorld.current.y - ray.origin.y) / incidence;
        if (!(toPlane > 0)) return;

        const radius = Math.hypot(
          ray.origin.x + ray.direction.x * toPlane - pivotWorld.current.x,
          ray.origin.z + ray.direction.z * toPlane - pivotWorld.current.z,
        );
        const bearing = bearingAt(ray, radius);
        if (bearing === null) return;

        grab.current = {
          seq: store.pressSeq,
          radius,
          bearing,
          tilt: tiltOf(ray),
          yaw: store.tonearmYaw,
          lift: store.tonearmLift,
        };
        return;
      }

      const bearing = bearingAt(ray, grab.current.radius);
      if (bearing === null) return;

      let swung = bearing - grab.current.bearing;
      if (swung > Math.PI) swung -= Math.PI * 2;
      if (swung < -Math.PI) swung += Math.PI * 2;
      const raised = tiltOf(ray) - grab.current.tilt;

      // Relative to the grab, not accumulated, so nothing drifts and a limit
      // hands the arm back exactly where it was.
      store.setTonearmYaw(grab.current.yaw + swung);
      store.setTonearmLift(grab.current.lift + raised, floor.current);
      fall.current = {
        lift: useDeckStore.getState().tonearmLift,
        velocity: 0,
      };
    },
    [bearingAt, measure],
  );

  useFrame((_, delta) => {
    if (!captured.current) return;
    measure();

    const store = useDeckStore.getState();
    // NaN before the asset is measured, which reads as "off the disc" below —
    // the arm starts on its rest, so that is also the truth.
    const radius = measured.current ? tipRadius() : Number.NaN;

    // Where the tip is on the record itself, and how high the record is there.
    // A warped disc has no single "top face": the surface the stylus lands on
    // rises and falls once or twice a turn, and the audio thread reads exactly
    // the same field from exactly the same coordinates (discShape.ts).
    const shape = deckDiscShape();
    const azimuth = measured.current
      ? SPIN_ABOUT_WORLD_UP *
        Math.atan2(
          -(stylusWorld.current.z - spindleWorld.current.z),
          stylusWorld.current.x - spindleWorld.current.x,
        )
      : Number.NaN;
    // How fast the arm is coming down as this frame starts. Read before the
    // steps below, which land the arm and zero the velocity in one go — after
    // them, every drop looks like it was placed by hand.
    const descending = fall.current.velocity;

    // Same parts the audio thread is using. The spring is the stylus's, so its
    // compliance is passed straight through rather than copied — one cantilever,
    // one number (physics/tonearm.ts).
    const armParameters = deckTonearm();
    const suspension = deckStylus();
    if (
      armTuning.current.arm !== armParameters ||
      armTuning.current.suspension !== suspension
    ) {
      armTuning.current = { arm: armParameters, suspension };
      armVertical.current.configure(armParameters, suspension);
    }

    let height = 0;
    if (measured.current && Number.isFinite(azimuth)) {
      const point = recordPointAt(shape, radius, azimuth, deckPlatterAngle(), recordPoint.current);
      height = warpHeightAt(shape, point.radius, point.angle);
      stylusTelemetry.recordRadius = point.radius;
      stylusTelemetry.recordAngle = point.angle;
      stylusTelemetry.surfaceHeight = height;

      // The record only drives the arm once the arm is down on it. Held in the
      // hand, or still falling through air, the arm is somewhere else entirely
      // and the surface has no say — so the model is parked on the current
      // height instead, and picks up the fall's own speed on touchdown.
      const surfaceAngle =
        liftAngleForSurface(
          tipAlongArm.current,
          tipAboveTip.current,
          flatSurfaceOffset.current + height,
        ) ?? contactAngle.current;
      const held = store.pressedControlId === "tonearm";
      if (held || radius > recordRadius.current) {
        armEngaged.current = false;
      } else if (
        !armEngaged.current &&
        store.tonearmLift <= surfaceAngle + CONTACT_EPSILON
      ) {
        armEngaged.current = true;
        armVertical.current.reset(height, descending * tipReach.current);
      }

      if (armEngaged.current) armVertical.current.step(height, delta);
      else armVertical.current.reset(height);

      // **The pose is the arm's own height, not the record's.** With the ideal
      // arm the two are the same value, so this reads exactly as it did before.
      contactAngle.current =
        liftAngleForSurface(
          tipAlongArm.current,
          tipAboveTip.current,
          flatSurfaceOffset.current + armVertical.current.height,
        ) ?? contactAngle.current;
    }
    floor.current = radius <= recordRadius.current ? contactAngle.current : 0;

    // Held, the arm stays where the hand put it; released, gravity takes it
    // down to whatever it is over — the record, or its own rest.
    if (store.pressedControlId === "tonearm") {
      store.setTonearmLift(store.tonearmLift, floor.current);
      fall.current = { lift: store.tonearmLift, velocity: 0 };
    } else if (store.tonearmLift > floor.current) {
      fall.current = stepTonearmFall(
        { lift: store.tonearmLift, velocity: fall.current.velocity },
        delta,
        floor.current,
      );
      store.setTonearmLift(fall.current.lift, floor.current);
    } else if (store.tonearmLift < floor.current) {
      // Swung off the record: the surface under it just stepped up.
      store.setTonearmLift(floor.current, floor.current);
      fall.current = { lift: floor.current, velocity: 0 };
    }

    // Read back rather than trusting the snapshot: the writes above replaced
    // it, and drawing last frame's angle is a frame of lag the eye picks up.
    const { tonearmYaw, tonearmLift } = useDeckStore.getState();
    // On the record and sitting on it — the state audio gates on. The last term
    // is the arm losing the surface without being lifted: a warp dropping away
    // faster than its effective mass can follow. Always true for the ideal arm.
    const contact =
      floor.current < 0 &&
      tonearmLift <= floor.current + CONTACT_EPSILON &&
      armVertical.current.touching;
    // Touchdown: latch the impact. The audio thread reads it on its own rising
    // edge a frame or two later, so it has to still be there — it is held until
    // the next landing rather than cleared when the arm goes up.
    if (contact && !store.stylusContact) {
      stylusTelemetry.landingSpeed = Math.abs(descending) * tipReach.current;
    }
    store.setStylusContact(contact);

    // And where on the disc that is. The zone is horizontal, so it holds with
    // the arm raised; the playback position does not — a stylus that is not in
    // the groove is not anywhere in the recording (rdd.md 10.5).
    store.setGrooveZone(grooveZoneAt(radius));
    stylusTelemetry.radius = radius;
    // Which way the tip lies from the spindle. Signed exactly like the hand on
    // the record — same basis, same SPIN_ABOUT_WORLD_UP — so that subtracting
    // the platter's own angle from it lands on a point fixed to the disc. Get
    // the sense wrong here and swinging the arm would move the surface's
    // defects twice as far instead of holding them still.
    stylusTelemetry.azimuth = azimuth;
    stylusTelemetry.groovePosition = contact ? groovePositionAt(radius) : null;

    if (tonearmYaw !== appliedYaw.current) {
      yawNode.quaternion.copy(yawRest.current);
      if (tonearmYaw !== 0 && Number.isFinite(tonearmYaw)) {
        yawNode.quaternion.multiply(
          spin.current.setFromAxisAngle(yawAxisLocal.current, tonearmYaw),
        );
      }
      appliedYaw.current = tonearmYaw;
    }

    if (tonearmLift !== appliedLift.current) {
      liftNode.quaternion.copy(liftRest.current);
      if (tonearmLift !== 0 && Number.isFinite(tonearmLift)) {
        liftNode.quaternion.multiply(
          spin.current.setFromAxisAngle(liftAxisLocal.current, tonearmLift),
        );
      }
      appliedLift.current = tonearmLift;
    }
  });

  return onDrag;
}

export function TurntableControls({ parts }: { parts: ResolvedTurntable }) {
  // The arm's own meshes stand in for the HIT_* proxy the asset never got, so
  // they are raycast targets alongside the real colliders (Turntable enables
  // the collider layer on them without taking them off the drawn one).
  const armGrabs = useMemo(
    () => [parts.nodes.tonearmMesh, parts.nodes.headshell],
    [parts.nodes],
  );
  const colliders = useMemo(
    () => [...Object.values(parts.colliders), ...armGrabs],
    [parts.colliders, armGrabs],
  );
  const controlOf = useMemo(() => {
    const fromColliders = buildControlResolver(parts.colliders);
    const arm = new Set<Object3D>(armGrabs);
    return (object: Object3D): ControlId | null =>
      arm.has(object) ? "tonearm" : fromColliders(object);
  }, [parts.colliders, armGrabs]);

  // Committed clicks only — press, drag-out release and pointercancel are
  // filtered upstream by usePointerControls.
  const onCommit = useCallback((id: ControlId) => {
    const store = useDeckStore.getState();
    if (id === "speed") store.toggleTargetRpm();
    else if (id === "start-stop") store.requestMotorToggle();
  }, []);

  const dragPitch = usePitchFader(parts.nodes.pitch, parts.colliders.pitch);
  // Left knob trims 45, right knob trims 33⅓ — as printed, which is the
  // opposite of what the old node names suggest.
  const dragKnobLeft = useKnobTrim(
    parts.nodes.knobLeft,
    parts.colliders.knobLeft,
    "trim45",
  );
  const dragKnobRight = useKnobTrim(
    parts.nodes.knobRight,
    parts.colliders.knobRight,
    "trim33",
  );

  const dragRecord = useRecordDrag(parts.nodes.platter, parts.colliders.record);
  const dragTonearm = useTonearmDrag(
    parts.nodes.tonearmYaw,
    parts.nodes.tonearmLift,
    parts.nodes.headshell,
    parts.nodes.stylus,
    parts.nodes.recordMesh,
    parts.nodes.platter,
  );

  const onDrag = useCallback(
    (id: ControlId, ray: Ray) => {
      if (id === "pitch") dragPitch(ray);
      else if (id === "knob-left") dragKnobLeft(ray);
      else if (id === "knob-right") dragKnobRight(ray);
      else if (id === "record") dragRecord(ray);
      else if (id === "tonearm") dragTonearm(ray);
    },
    [dragPitch, dragKnobLeft, dragKnobRight, dragRecord, dragTonearm],
  );

  usePointerControls({ colliders, controlOf, onCommit, onDrag });

  // Both caps latch: they hold the height that matches the logical state.
  // 33 / Stop = raised, 45 / Start = latched (HANDOFF §9).
  const speedLatched = useDeckStore((s) => s.targetRpm === 45);
  const startStopLatched = useDeckStore((s) => s.motorRequested);

  useLatchAnimation(parts.nodes.speedButton, speedLatched);
  useLatchAnimation(parts.nodes.startStopButton, startStopLatched);

  return null;
}
