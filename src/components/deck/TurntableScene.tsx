import { useState } from "react";
import type { ResolvedTurntable } from "../../model/manifest";
import { PlatterDrive } from "./PlatterDrive";
import { RecordLabel } from "./RecordLabel";
import { Turntable } from "./Turntable";
import { TurntableControls } from "./TurntableControls";

export function TurntableScene() {
  const [parts, setParts] = useState<ResolvedTurntable | null>(null);

  return (
    <group>
      <Turntable onReady={setParts} />
      {parts && (
        <>
          <TurntableControls parts={parts} />
          <PlatterDrive parts={parts} />
          <RecordLabel parts={parts} />
        </>
      )}
    </group>
  );
}
