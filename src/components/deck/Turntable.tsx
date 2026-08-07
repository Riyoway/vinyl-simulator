import { use, useEffect, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import type { Group, Mesh } from "three";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  COLLIDER_LAYER,
  loadManifest,
  resolveTurntable,
  type ResolvedTurntable,
} from "../../model/manifest";

export function Turntable({
  onReady,
}: {
  onReady?: (parts: ResolvedTurntable) => void;
}) {
  const manifest = use(loadManifest());
  const gltf = useGLTF(manifest.model);
  const scene = useMemo(() => clone(gltf.scene) as Group, [gltf.scene]);

  // Throws naming any node the manifest promises but the GLB lacks.
  const parts = useMemo(
    () => resolveTurntable(scene, manifest),
    [scene, manifest],
  );

  useEffect(() => {
    // Colliders move to their own layer: not drawn by the camera or the shadow
    // passes, still hit by a raycaster that enables the layer. Materials stay
    // exactly as GLTFLoader made them (rdd.md 5.6 / 5.9 / 29.7).
    const colliders = new Set<Mesh>(Object.values(parts.colliders));
    for (const collider of colliders) collider.layers.set(COLLIDER_LAYER);

    // The tonearm has no HIT_* proxy in the asset, so its own meshes are what
    // the pointer grabs. `enable`, not `set`: they keep layer 0 and stay drawn.
    for (const grabbable of [parts.nodes.tonearmMesh, parts.nodes.headshell]) {
      grabbable.layers.enable(COLLIDER_LAYER);
    }

    scene.traverse((object) => {
      if (!(object as Mesh).isMesh || colliders.has(object as Mesh)) return;
      object.castShadow = true;
      object.receiveShadow = true;
    });

    onReady?.(parts);
  }, [scene, parts, onReady]);

  return <primitive object={scene} position={[0, 0, 0]} scale={1} />;
}

useGLTF.preload("/models/turntable.glb");
