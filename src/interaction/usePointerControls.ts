import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { Vector2, type Object3D, type Ray } from "three";
import type { ControlId } from "../model/manifest";
import { useDeckStore } from "../store/useDeckStore";

interface PointerControlsOptions {
  /** Collider meshes only — the raycaster is masked to their layer anyway. */
  colliders: Object3D[];
  controlOf: (object: Object3D) => ControlId | null;
  /** Runs only when press and release happen on the same control. */
  onCommit: (id: ControlId) => void;
  /**
   * Every move while a control is held, with the pointer ray for this event.
   * Continuous controls project it themselves — the ray keeps arriving outside
   * the canvas too, because the press holds pointer capture. The ray is reused
   * between calls, so read it, don't keep it.
   */
  onDrag?: (id: ControlId, ray: Ray) => void;
}

/**
 * One pointer pipeline for every control: raycast against colliders, track a
 * press that can only commit where it started, and keep OrbitControls out of
 * the way while a control is held.
 */
export function usePointerControls(options: PointerControlsOptions) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const raycaster = useThree((s) => s.raycaster);
  const controls = useThree((s) => s.controls) as {
    enabled: boolean;
  } | null;

  // Handlers live for the lifetime of the effect; read options through a ref
  // so they never go stale without re-binding listeners.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const canvas = gl.domElement;
    const ndc = new Vector2();
    let draggingCamera = false;
    let capturedPointerId: number | null = null;

    // Whether raycaster.ray belongs to the event just handled — a zero-sized
    // canvas leaves the previous frame's ray in place, which must not be
    // handed to a drag.
    let rayIsCurrent = false;

    const pickControl = (event: PointerEvent): ControlId | null => {
      // Canvas rect, not devicePixelRatio: CSS pixels are what the event uses.
      rayIsCurrent = false;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;

      ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      rayIsCurrent = true;

      for (const hit of raycaster.intersectObjects(
        optionsRef.current.colliders,
        false,
      )) {
        const id = optionsRef.current.controlOf(hit.object);
        if (id) return id;
      }
      return null;
    };

    const applyCursor = () => {
      const { pressedControlId, hoveredControlId } = useDeckStore.getState();
      canvas.style.cursor = draggingCamera
        ? "grabbing"
        : pressedControlId || hoveredControlId
          ? "pointer"
          : "grab";
    };

    const endPress = (commit: boolean, event?: PointerEvent) => {
      const store = useDeckStore.getState();
      const pressed = store.pressedControlId;

      if (pressed) {
        const stillOnTarget =
          commit && event !== undefined && pickControl(event) === pressed;

        if (stillOnTarget) {
          store.releaseControl(pressed);
          optionsRef.current.onCommit(pressed);
        } else {
          store.cancelInteraction();
        }
      }

      if (capturedPointerId !== null) {
        try {
          if (canvas.hasPointerCapture(capturedPointerId)) {
            canvas.releasePointerCapture(capturedPointerId);
          }
        } catch {
          /* pointer already gone */
        }
        capturedPointerId = null;
      }

      draggingCamera = false;
      if (controls) controls.enabled = true;
      applyCursor();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!draggingCamera) {
        // pickControl leaves the raycaster set to this event, so the drag gets
        // the same ray without a second projection.
        const id = pickControl(event);
        const pressed = useDeckStore.getState().pressedControlId;
        useDeckStore.getState().setHoveredControl(id);
        if (pressed && rayIsCurrent) {
          optionsRef.current.onDrag?.(pressed, raycaster.ray);
        }
      }
      applyCursor();
    };

    // Capture phase on window: runs before OrbitControls' own canvas listener,
    // so a press on a control never starts a camera drag.
    const onPointerDownCapture = (event: PointerEvent) => {
      if (event.button !== 0 || event.target !== canvas) return;

      const id = pickControl(event);
      useDeckStore.getState().setHoveredControl(id);

      if (!id) {
        draggingCamera = true;
        applyCursor();
        return;
      }

      useDeckStore.getState().pressControl(id);
      if (controls) controls.enabled = false;
      event.stopPropagation();

      // Capture keeps the release coming back to us even outside the canvas.
      // Not always available (or valid for this pointer id) — never fatal.
      try {
        canvas.setPointerCapture(event.pointerId);
        capturedPointerId = event.pointerId;
      } catch {
        capturedPointerId = null;
      }
      applyCursor();
    };

    const onPointerUp = (event: PointerEvent) => endPress(true, event);
    const onPointerCancel = () => endPress(false);
    const onLostCapture = () => endPress(false);
    const onBlur = () => endPress(false);

    const onPointerLeave = () => {
      if (!useDeckStore.getState().pressedControlId) {
        useDeckStore.getState().setHoveredControl(null);
      }
      applyCursor();
    };

    applyCursor();
    window.addEventListener("pointerdown", onPointerDownCapture, true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("blur", onBlur);
    canvas.addEventListener("lostpointercapture", onLostCapture);
    canvas.addEventListener("pointerleave", onPointerLeave);

    return () => {
      window.removeEventListener("pointerdown", onPointerDownCapture, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onBlur);
      canvas.removeEventListener("lostpointercapture", onLostCapture);
      canvas.removeEventListener("pointerleave", onPointerLeave);

      if (controls) controls.enabled = true;
      canvas.style.cursor = "";
    };
  }, [gl, camera, raycaster, controls]);
}
