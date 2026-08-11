import { use, useEffect, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import type { Group, Mesh, MeshStandardMaterial } from "three";
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
  const maxAnisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy());

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
      const mesh = object as Mesh;
      if (!mesh.isMesh || colliders.has(mesh)) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      // The deck's lettering — Technics, 33, 45, Start/Stop and the pitch
      // scale — is baked into a 2048² base-colour map, so it is read at
      // whatever angle the deck is being looked at. The default anisotropy of
      // 1 picks a blurred mip once the surface tilts away and the small type
      // smears; this asks the GPU to sample it properly instead. Sampler
      // state only, shared with the asset's own textures on purpose — nothing
      // about how a material looks head-on changes (rdd.md 5.6 / 5.9).
      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const material of materials) {
        const map = (material as MeshStandardMaterial).map;
        if (map && map.anisotropy < maxAnisotropy) {
          map.anisotropy = maxAnisotropy;
          map.needsUpdate = true;
        }
      }
    });

    onReady?.(parts);
  }, [scene, parts, onReady, maxAnisotropy]);

  return <primitive object={scene} position={[0, 0, 0]} scale={1} />;
}

useGLTF.preload("/models/turntable.glb");
