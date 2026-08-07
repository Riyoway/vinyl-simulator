import { Suspense, useLayoutEffect, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import {
  ContactShadows,
  Environment,
  Lightformer,
  OrbitControls,
} from "@react-three/drei";
import type { RectAreaLight } from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { TurntableScene } from "../components/deck/TurntableScene";
import { COLLIDER_LAYER } from "../model/manifest";
import { SceneErrorBoundary } from "./SceneErrorBoundary";
import { TrackLoader } from "./TrackLoader";
import { InfoPanel } from "./InfoPanel";

// RectAreaLight needs its BRDF LUTs initialised once before use.
RectAreaLightUniformsLib.init();

const AIM: [number, number, number] = [0, 0.14, 0];

// A RectAreaLight aimed at the deck. RectAreaLights don't cast shadows and are
// one-sided (they emit from their front face toward wherever they look).
function AreaLight(props: {
  color: string;
  intensity: number;
  width: number;
  height: number;
  position: [number, number, number];
}) {
  const ref = useRef<RectAreaLight>(null);
  useLayoutEffect(() => {
    ref.current?.lookAt(AIM[0], AIM[1], AIM[2]);
  });
  return (
    <rectAreaLight
      ref={ref}
      color={props.color}
      intensity={props.intensity}
      width={props.width}
      height={props.height}
      position={props.position}
    />
  );
}

export default function App() {
  return (
    <main className="app">
     <SceneErrorBoundary>
      <Canvas
        camera={{
          position: [0.55, 0.45, 0.7],
          fov: 40,
          near: 0.01,
          far: 100,
        }}
        gl={{ toneMappingExposure: 1.0 }}
        onCreated={({ raycaster }) => {
          // Collider layer ONLY: layer 0 is dropped, so no visible mesh can
          // ever come back as a hit — even from intersectObjects(scene).
          raycaster.layers.set(COLLIDER_LAYER);
        }}
      >
        {/* Dark charcoal so the black body doesn't merge into the background. */}
        <color attach="background" args={["#141619"]} />

        {/* Very weak base fill — lifts the deepest blacks only. */}
        <ambientLight intensity={0.18} />

        {/* KEY — large soft warm area light, upper-left-front, raking across. */}
        <AreaLight
          color="#ffd7b0"
          intensity={2.4}
          width={3.2}
          height={2.4}
          position={[-1.15, 1.25, 1.05]}
        />

        {/* FILL — cool, right-front, opens the shadow side and lifts the front
            control plate so the engraved labels read against the silver. */}
        <AreaLight
          color="#dce6ff"
          intensity={1.7}
          width={3.2}
          height={2.2}
          position={[1.35, 0.8, 1.35]}
        />

        {/* RIM — weak blue from behind-above, draws edges on cover/arm/rim. */}
        <AreaLight
          color="#8fa8ff"
          intensity={1.6}
          width={2.6}
          height={1.1}
          position={[0.2, 1.35, -2.0]}
        />

        <Suspense fallback={null}>
          <TurntableScene />

          {/* Low, soft IBL so the metal (silver plate, knobs, cover) has
              something to reflect and doesn't read as flat black. Broad
              Lightformers = no thin reflection strips. */}
          <Environment resolution={128} environmentIntensity={0.18}>
            <Lightformer
              form="rect"
              intensity={1.0}
              color="#fff2e2"
              position={[-1.5, 2.4, 1.5]}
              scale={[7, 5, 1]}
              rotation={[-Math.PI / 3, 0, 0]}
            />
            <Lightformer
              form="rect"
              intensity={0.6}
              color="#cdd8ff"
              position={[0, 1.8, -3.2]}
              scale={[6, 3, 1]}
            />
          </Environment>

          {/* Soft contact shadow (RectAreaLights can't cast one). */}
          <ContactShadows
            position={[0, 0.001, 0]}
            scale={1.4}
            resolution={1024}
            blur={2.6}
            far={0.6}
            opacity={0.5}
            color="#000000"
          />
        </Suspense>

        <OrbitControls
          makeDefault
          enableDamping
          target={[0, 0.15, 0]}
          minDistance={0.3}
          maxDistance={5}
        />
      </Canvas>
     </SceneErrorBoundary>
      <TrackLoader />
      <InfoPanel />
    </main>
  );
}
