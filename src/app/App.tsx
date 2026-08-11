import { Suspense, useLayoutEffect, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import {
  ContactShadows,
  Environment,
  GradientTexture,
  Lightformer,
  OrbitControls,
} from "@react-three/drei";
import { BackSide, type RectAreaLight } from "three";
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

          {/* IBL, and on this asset it is not a garnish — it is what makes the
              deck visible at all.

              The body is one material (`lambert1`) whose metallic-roughness map
              reads metalness 1 at roughness ~0: a mirror. A mirror has no
              diffuse term, so ambientLight and the RectAreaLights below do
              almost nothing for it; it shows only what surrounds it. The deck
              is the only object in the scene, so every direction that isn't
              covered here reflects the bare background and the silver control
              plate renders black — taking the dark baked lettering
              (Technics / 33 / 45 / SPEED CONTROL / the pitch scale) down with
              it, because that text is dark-on-light and needs the plate bright
              to have any contrast.

              So the environment is a closed room, not a few panels: the sphere
              guarantees no reflection direction is ever black, which is what
              makes the text hold up at *every* camera angle rather than only
              where a Lightformer happens to land. The Lightformers stay on top
              of it for the sculpted highlights. `resolution` is up from 128
              because a near-mirror shows the cubemap's own pixels. */}
          <Environment resolution={256} environmentIntensity={0.55}>
            <mesh scale={100}>
              <sphereGeometry args={[1, 32, 24]} />
              {/* BackSide: seen from the inside. stops[0] lands on the sphere's
                  top, so the list runs ceiling → horizon → floor. The floor is
                  dark grey rather than black on purpose — a black floor puts
                  the blackout back for anything facing down. */}
              <meshBasicMaterial side={BackSide} toneMapped={false}>
                <GradientTexture
                  attach="map"
                  stops={[0, 0.42, 0.62, 1]}
                  colors={["#fdf6ec", "#dfe6f2", "#8d96a6", "#4a5158"]}
                />
              </meshBasicMaterial>
            </mesh>
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
