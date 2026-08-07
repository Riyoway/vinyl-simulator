/**
 * デッキの正本。**omega / phiUnwrapped / phiWrapped / programCursor はここにしか
 * 無い。** メインスレッドは操作入力を送り、テレメトリを受け取って描くだけ
 * （audio-engine.md 8.1 / 11.2 段階B）。
 *
 * 物理は音声クロックで進む。1レンダークォンタム = 128サンプル = 48kHzで2.667ms、
 * これが唯一の時計であり、rAF は一切関与しない。タブが背面に回ってフレームが
 * 止まっても、盤は正しく回り続ける。
 *
 * 入力は AudioParam で受ける。postMessage のキューを通らないぶん遅延が小さく、
 * 共有メモリのようにヘッダー設定（COOP/COEP）も要らない。**離散イベントは
 * 溝バッファの受け渡しだけ**で、そちらは port を使う。
 */

import {
  DECK_PROCESSOR,
  type DeckInboundMessage,
  type DeckTelemetryMessage,
} from "./deckContract";
import { createDeckEngine } from "./deckEngine";
import { createGrooveBuffer } from "./grooveBuffer";

// AudioWorkletGlobalScope の最小宣言。@types/audioworklet は足さない。
declare const AudioWorkletProcessor: {
  new (): { readonly port: MessagePort };
};
declare function registerProcessor(name: string, processorCtor: unknown): void;
declare const sampleRate: number;
declare const currentTime: number;

/** テレメトリの間引き。約60Hz — 描画がそれ以上速く読んでも意味がない。 */
const REPORT_EVERY_BLOCKS = 6;

type ParamMap = Record<string, Float32Array>;

/** k-rate パラメータは長さ1。念のため空でも落ちないようにする。 */
const read = (params: ParamMap, name: string, fallback: number) => {
  const values = params[name];
  return values !== undefined && values.length > 0 ? values[0] : fallback;
};

class DeckProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "motorRequested", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "targetRpm", defaultValue: 33.333, minValue: 0, maxValue: 200, automationRate: "k-rate" },
      // 手は「触れているか」と「どれだけ回しているか」の2本。0 と非接触は
      // 別物なので、1本にまとめない（押さえて止めている = 接触かつ 0）。
      { name: "handContact", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "handAngularVelocity", defaultValue: 0, minValue: -100, maxValue: 100, automationRate: "k-rate" },
      { name: "stylusContact", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "stylusRadius", defaultValue: 0.1969, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "armHeld", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "stylusLandingSpeed", defaultValue: 0, minValue: 0, maxValue: 10, automationRate: "k-rate" },
      { name: "stylusAzimuth", defaultValue: 0, minValue: -7, maxValue: 7, automationRate: "k-rate" },
    ];
  }

  private readonly engine = createDeckEngine({ sampleRate });
  private blocksSinceReport = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data as DeckInboundMessage;
      if (data.type === "groove") {
        // 載せ替えはノードを作り直さない。同じプロセッサが盤だけ差し替える。
        this.engine.loadGroove(
          data.walls === undefined || data.sampleRate === undefined
            ? null
            : createGrooveBuffer(data.walls, data.sampleRate),
          // 割り付けは切った側が決めている。**ここで作り直さない。**
          data.layout ?? null,
        );
      } else if (data.type === "condition") {
        // **盤とデッキの状態を一度に。** ブロックとブロックの間で全段が入れ替わる
        // ので、新しい針で古い盤を読む瞬間が存在しない（deckContract.ts）。
        // 順序は結果に効かない — どれも次のブロックまで読まれない設定である。
        const next = data.condition;
        // 盤に属するもの。偏心と反りはメインスレッドが同じ値で支持面を計算する。
        this.engine.setSurface(next.surface);
        this.engine.setDiscShape(next.shape);
        // 針とアーム。カンチレバーは1本なので、アーム側の共振も同じ compliance から
        // 引き直される（setStylus / setTonearm のどちらが先でも同じ結果になる）。
        this.engine.setStylus(next.stylus);
        this.engine.setTonearm(next.tonearm);
        this.engine.setStylusTip(next.stylusTip);
        this.engine.setCartridge(next.cartridge);
        // デッキに属するもの。盤を替えても変わらない。
        this.engine.setWowFlutter(next.wowFlutter);
        this.engine.setRumble(next.rumble);
        this.engine.setHum(next.hum);
      } else if (data.type === "wear") {
        // **摩耗は盤に溜まっている状態**なので、`condition` とは別便で運ぶ。
        // 進み方の差し替えでは溜まったぶんを消さない（消すのは reset だけ）。
        if (data.parameters !== undefined) this.engine.setWear(data.parameters);
        if (data.reset === true) this.engine.resetWear();
      } else if (data.type === "levels") {
        // レベル校正。**盤にもデッキにも属さない再生系の設定**なので別便。
        if (data.parameters !== undefined) this.engine.setLevels(data.parameters);
        if (data.resetMeters === true) this.engine.resetLevelMeters();
      }
    };
  }

  process(_inputs: unknown, outputs: Float32Array[][], parameters: ParamMap) {
    const output = outputs[0];
    if (output === undefined || output.length === 0) return true;
    const left = output[0];
    const right = output[1] ?? output[0];

    const handContact = read(parameters, "handContact", 0) >= 0.5;

    this.engine.process(
      {
        frames: left.length,
        motorRequested: read(parameters, "motorRequested", 0) >= 0.5,
        targetRpm: read(parameters, "targetRpm", 33.333),
        // null（触れていない）と 0（押さえて止めている）の区別は物理の入口が
        // 依存している契約。ここで潰さない。
        handAngularVelocity: handContact
          ? read(parameters, "handAngularVelocity", 0)
          : null,
        stylusContact: read(parameters, "stylusContact", 0) >= 0.5,
        stylusRadius: read(parameters, "stylusRadius", 0.1969),
        armIntent: read(parameters, "armHeld", 0) >= 0.5 ? "user" : "follow",
        landingSpeed: read(parameters, "stylusLandingSpeed", 0),
        stylusAzimuth: read(parameters, "stylusAzimuth", 0),
      },
      left,
      right,
    );

    if (++this.blocksSinceReport >= REPORT_EVERY_BLOCKS) {
      this.blocksSinceReport = 0;
      const state = this.engine.state;
      const wear = this.engine.wearSummary();
      const levels = this.engine.levelTelemetry();
      const telemetry: DeckTelemetryMessage = {
        // 音声クロック上の時刻。描画側はこれと ctx.currentTime の差で
        // 角度を外挿する（積分ではない — PlatterDrive の注記を参照）。
        audioTime: currentTime,
        phiUnwrapped: state.phiUnwrapped,
        phiWrapped: state.phiWrapped,
        omega: state.omega,
        motorState: state.motorState,
        programCursor: state.programCursor,
        zone: state.zone,
        revolutions: state.revolutions,
        stylusRadius: state.stylusRadius,
        cutRegion: state.cutRegion,
        recordRadius: state.recordRadius,
        recordAngle: state.recordAngle,
        surfaceHeight: state.surfaceHeight,
        mistracking: state.mistracking,
        contactLossSamples: state.contactLossSamples,
        driveWowTorque: state.driveWowTorque,
        driveFlutterTorque: state.driveFlutterTorque,
        driveCommutationRippleTorque: state.driveCommutationRippleTorque,
        driveSpeedRatio: state.driveSpeedRatio,
        // **概要だけ。** 摩耗の場そのものはこちらに置いたまま。
        wearPlays: wear.plays,
        wearPeak: wear.peak,
        wearMean: wear.mean,
        levelPeak: levels.peak,
        levelTruePeak: levels.truePeak,
        levelRms: levels.rms,
        levelInputPeakMv: levels.inputPeakMv,
        levelLinePeak: levels.linePeak,
        levelInputOverloads: levels.inputOverloads,
        levelOutputOverloads: levels.outputOverloads,
        levelSafetyReductionDb: levels.safetyReductionDb,
        levelSafetyMaxReductionDb: levels.safetyMaxReductionDb,
        levelSafetyDutyRatio: levels.safetyDutyRatio,
        levelSafetyEvents: levels.safetyEvents,
      };
      this.port.postMessage(telemetry);
    }

    // 決して false を返さない。返した瞬間にプロセッサは回収され、
    // 盤の状態ごと消える。
    return true;
  }
}

registerProcessor(DECK_PROCESSOR, DeckProcessor);
