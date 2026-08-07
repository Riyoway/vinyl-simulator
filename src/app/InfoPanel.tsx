import { useEffect, useState, type ReactNode } from "react";
import {
  deckConditionName,
  deckCuttingName,
  deckLevelsName,
  deckManufacturingName,
  deckTelemetry,
  deckWearName,
  resetDeckLevelMeters,
  resetDeckWear,
  setDeckCondition,
  setDeckCutting,
  setDeckLevels,
  setDeckManufacturing,
  setDeckWear,
} from "../audio/deckAudio";
import {
  CUTTING_PRESETS,
  type CuttingPresetName,
} from "../audio/engine/cutterHead";
import {
  MANUFACTURING_PRESETS,
  type ManufacturingPresetName,
} from "../audio/engine/manufacturing";
import { WEAR_PRESETS, type WearPresetName } from "../audio/engine/wear";
import { LEVEL_PRESETS, type LevelPresetName } from "../audio/engine/levels";
import {
  RECORD_CONDITIONS,
  type RecordConditionName,
} from "../audio/engine/recordCondition";
import { effectiveTargetRpm } from "../physics/pitch";
import {
  activeTrim,
  motorTelemetry,
  stylusTelemetry,
  useDeckStore,
} from "../store/useDeckStore";

const POLL_MS = 200;
const DEV = import.meta.env.DEV;

const dbfs = (value: number) =>
  value > 1e-6 ? (20 * Math.log10(value)).toFixed(1) : "−∞";
const degrees = (radians: number) => ((radians * 180) / Math.PI).toFixed(1);

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="info-group">
      <h2>{title}</h2>
      <dl>{children}</dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Preset<T extends string>({
  label,
  value,
  options,
  onPick,
  onReset,
}: {
  label: string;
  value: T;
  options: readonly { readonly name: T; readonly label: string }[];
  onPick: (next: T) => void;
  onReset?: () => void;
}) {
  return (
    <Row label={label}>
      <select value={value} onChange={(e) => onPick(e.target.value as T)}>
        {options.map((entry) => (
          <option key={entry.name} value={entry.name}>
            {entry.label}
          </option>
        ))}
      </select>
      {onReset && (
        <button type="button" onClick={onReset}>
          reset
        </button>
      )}
    </Row>
  );
}

/**
 * 右上の Info パネル。**既定は閉じている** — デッキを見るのが主目的の画面で、
 * 数字が常に乗っているべきではない（HANDOFF §12 C）。
 *
 * 盤とデッキの状態は音声スレッドが正本なので、ここは読むだけで何も持たない。
 * 毎フレーム変わる値は購読せず 200ms でサンプリングする（`motorTelemetry` /
 * `stylusTelemetry` / `deckTelemetry` を React state にすると再描画が follow の
 * フレームに乗る）。
 */
export function InfoPanel() {
  const [open, setOpen] = useState(false);

  const hovered = useDeckStore((s) => s.hoveredControlId);
  const pressed = useDeckStore((s) => s.pressedControlId);
  const motorRequested = useDeckStore((s) => s.motorRequested);
  const motorState = useDeckStore((s) => s.motorState);
  const targetRpm = useDeckStore((s) => s.targetRpm);
  const pitch = useDeckStore((s) => s.pitch);
  const trim = useDeckStore(activeTrim);
  const tonearmYaw = useDeckStore((s) => s.tonearmYaw);
  const tonearmLift = useDeckStore((s) => s.tonearmLift);
  const stylusContact = useDeckStore((s) => s.stylusContact);
  const grooveZone = useDeckStore((s) => s.grooveZone);
  const discWear = useDeckStore((s) => s.discWear);
  const effective = effectiveTargetRpm(targetRpm, pitch, trim);

  // 選択を映すだけ。正本は音声スレッド側にある。
  const [condition, setCondition] = useState<RecordConditionName>(deckConditionName);
  const [cutting, setCutting] = useState<CuttingPresetName>(deckCuttingName);
  const [made, setMade] = useState<ManufacturingPresetName>(deckManufacturingName);
  const [wear, setWear] = useState<WearPresetName>(deckWearName);
  const [levels, setLevels] = useState<LevelPresetName>(deckLevelsName);

  const [frame, setFrame] = useState({
    currentRpm: 0,
    radius: Number.NaN,
    groovePosition: null as number | null,
    mistracking: false,
    contactLoss: 0,
    peak: 0,
    truePeak: 0,
    rms: 0,
    inputMv: 0,
    inputOverloads: 0,
    lineOverloads: 0,
    safetyDb: 0,
    safetyMaxDb: 0,
    safetyDuty: 0,
    safetyEvents: 0,
  });
  useEffect(() => {
    const id = setInterval(
      () =>
        setFrame({
          currentRpm: motorTelemetry.currentRpm,
          radius: stylusTelemetry.radius,
          groovePosition: stylusTelemetry.groovePosition,
          mistracking: deckTelemetry.mistracking,
          contactLoss: deckTelemetry.contactLossSamples,
          peak: deckTelemetry.levelPeak,
          truePeak: deckTelemetry.levelTruePeak,
          rms: deckTelemetry.levelRms,
          inputMv: deckTelemetry.levelInputPeakMv,
          inputOverloads: deckTelemetry.levelInputOverloads,
          lineOverloads: deckTelemetry.levelOutputOverloads,
          safetyDb: deckTelemetry.levelSafetyReductionDb,
          safetyMaxDb: deckTelemetry.levelSafetyMaxReductionDb,
          safetyDuty: deckTelemetry.levelSafetyDutyRatio,
          safetyEvents: deckTelemetry.levelSafetyEvents,
        }),
      POLL_MS,
    );
    return () => clearInterval(id);
  }, []);

  return (
    <div
      className="info"
      // 自動確認が閉じたままでも状態を読めるように、常に載せておく。
      data-hud={[
        hovered ?? "-",
        pressed ?? "-",
        motorRequested,
        motorState,
        targetRpm,
        pitch.toFixed(4),
        trim.toFixed(4),
        tonearmYaw.toFixed(4),
        tonearmLift.toFixed(4),
        stylusContact,
        grooveZone,
        frame.currentRpm.toFixed(2),
        frame.mistracking,
        frame.contactLoss,
        condition,
        cutting,
        made,
        wear,
        discWear.plays.toFixed(2),
        levels,
        `${frame.inputOverloads},${frame.lineOverloads}`,
        frame.safetyEvents,
        frame.safetyDuty.toFixed(3),
      ].join("|")}
    >
      <button
        type="button"
        className="info__toggle"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {open ? "close" : "info"}
      </button>

      {open && (
        <div className="info__panel">
          <Group title="Audio">
            <Row label="Peak">{dbfs(frame.peak)} dBFS</Row>
            <Row label="True peak">{dbfs(frame.truePeak)} dBFS</Row>
            <Row label="RMS">{dbfs(frame.rms)} dBFS</Row>
          </Group>

          <Group title="Motor">
            <Row label="State">{motorState}</Row>
            <Row label="Speed">{frame.currentRpm.toFixed(2)} rpm</Row>
            <Row label="Target">{effective.toFixed(3)} rpm</Row>
            <Row label="Pitch">
              {pitch >= 0 ? "+" : "−"}
              {(Math.abs(pitch) * 100).toFixed(2)} %
            </Row>
            <Row label={`Trim (${targetRpm === 45 ? "45" : "33"})`}>
              {trim >= 0 ? "+" : "−"}
              {(Math.abs(trim) * 100).toFixed(2)} %
            </Row>
          </Group>

          <Group title="Stylus">
            <Row label="Contact">{stylusContact ? "on record" : "lifted"}</Row>
            <Row label="Tracking">
              {frame.mistracking ? "mistracking" : "tracking"}
            </Row>
            <Row label="Losses">{frame.contactLoss} smp</Row>
            <Row label="Arm yaw">{degrees(tonearmYaw)} °</Row>
            <Row label="Arm lift">{degrees(tonearmLift)} °</Row>
          </Group>

          <Group title="Record">
            <Row label="Zone">{grooveZone}</Row>
            <Row label="Radius">
              {Number.isFinite(frame.radius)
                ? (frame.radius * 1000).toFixed(1)
                : "—"}{" "}
              mm
            </Row>
            <Row label="Position">
              {frame.groovePosition === null
                ? "—"
                : (frame.groovePosition * 100).toFixed(1)}{" "}
              %
            </Row>
            <Row label="Plays">{discWear.plays.toFixed(2)}</Row>
            <Row label="Wear peak">{(discWear.peak * 100).toFixed(1)} %</Row>
            <Row label="Wear mean">{(discWear.mean * 100).toFixed(2)} %</Row>
          </Group>

          <Group title="Level">
            <Row label="Phono in">{frame.inputMv.toFixed(1)} mV</Row>
            <Row label="Input ovl">{frame.inputOverloads} smp</Row>
            <Row label="Line ovl">{frame.lineOverloads} smp</Row>
          </Group>

          <Group title="Safety">
            <Row label="Reduction">{frame.safetyDb.toFixed(2)} dB</Row>
            <Row label="Max">{frame.safetyMaxDb.toFixed(2)} dB</Row>
            <Row label="Active">{(frame.safetyDuty * 100).toFixed(2)} %</Row>
            <Row label="Events">{frame.safetyEvents}</Row>
          </Group>

          {/* 盤とデッキの作り分け。デバッグ用ではなくユーザーが選ぶものなので
              本番でも出す。DEV限定は下の Dev だけ。 */}
          <Group title="Presets">
            <Preset
              label="Cut"
              value={cutting}
              options={CUTTING_PRESETS}
              onPick={(next) => {
                setCutting(next);
                setDeckCutting(next);
              }}
            />
            <Preset
              label="Press"
              value={made}
              options={MANUFACTURING_PRESETS}
              onPick={(next) => {
                setMade(next);
                setDeckManufacturing(next);
              }}
            />
            <Preset
              label="Wear"
              value={wear}
              options={WEAR_PRESETS}
              onPick={(next) => {
                setWear(next);
                setDeckWear(next);
              }}
              onReset={resetDeckWear}
            />
            <Preset
              label="Levels"
              value={levels}
              options={LEVEL_PRESETS}
              onPick={(next) => {
                setLevels(next);
                setDeckLevels(next);
              }}
              onReset={resetDeckLevelMeters}
            />
            <Preset
              label="Condition"
              value={condition}
              options={RECORD_CONDITIONS}
              onPick={(next) => {
                setCondition(next);
                setDeckCondition(next);
              }}
            />
          </Group>

          {DEV && (
            <Group title="Dev">
              <Row label="Hover">{hovered ?? "—"}</Row>
              <Row label="Pressed">{pressed ?? "—"}</Row>
            </Group>
          )}
        </div>
      )}
    </div>
  );
}
