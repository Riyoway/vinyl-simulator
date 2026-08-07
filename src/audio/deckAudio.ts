/**
 * メインスレッド側の窓口。音声スレッドの正本に**入力を渡し、テレメトリを
 * 受け取る**だけで、物理は一切持たない。
 *
 * 生成は一度きり: AudioContext も AudioWorkletNode も、最初のユーザー操作で
 * 作られたあとは寿命いっぱい生き続ける。再生・停止・逆転・音源の載せ替えで
 * ノードを作り直さない（audio-engine.md 1 / 8）。
 */

import { getAudioContext, peekAudioContext } from "./audioContext";
import {
  DECK_PARAMS,
  DECK_PROCESSOR,
  type DeckConditionMessage,
  type DeckGrooveMessage,
  type DeckParam,
  type DeckTelemetryMessage,
  type DeckLevelsMessage,
  type DeckWearMessage,
} from "./engine/deckContract";
import {
  levelParametersFor,
  type LevelPresetName,
} from "./engine/levels";
import {
  wearParametersFor,
  type WearPresetName,
} from "./engine/wear";
import { useDeckStore } from "../store/useDeckStore";
import type { DiscShapeParameters } from "./engine/discShape";
import type { StylusParameters } from "./engine/stylus";
import type { MainsHz } from "./engine/hum";
import {
  cuttingParametersFor,
  type CuttingParameters,
  type CuttingPresetName,
} from "./engine/cutterHead";
import {
  recordConditionFor,
  type RecordCondition,
  type RecordConditionName,
  type RecordSpec,
} from "./engine/recordCondition";
import type { TonearmVerticalParameters } from "../physics/tonearm";
// Vite が worklet とその import をひとまとめにして URL をくれる。
// AudioWorkletGlobalScope 側の import 解決に依存しないのが要点。
//
// **worklet 本体からは値を import しない。** 名前を知るためだけに評価すると
// メインスレッドで `AudioWorkletProcessor is not defined` になる（実際に踏んだ）。
import processorUrl from "./engine/deckProcessor.worklet.ts?worker&url";
import { cutToGroove } from "./engine/cutting";
import {
  CUT,
  createCutLayout,
  type CutLayout,
  type CutRegion,
} from "./engine/cutLayout";
import { planGroovePitch } from "./engine/pitchControl";
import {
  manufactureGroove,
  manufacturingParametersFor,
  manufacturingSeedFrom,
  type ManufacturingParameters,
  type ManufacturingPresetName,
} from "./engine/manufacturing";
import type { GrooveZone } from "../physics/groove";
import { radPerSecToRpm, type MotorState } from "../physics/platterMotor";

export interface DeckInputs {
  motorRequested: boolean;
  /** ピッチ・トリム適用済み。 */
  targetRpm: number;
  /** null は非接触、0 は押さえて止めている。 */
  handAngularVelocity: number | null;
  stylusContact: boolean;
  /** アームを掴んでいる間だけ入力として効く。 */
  stylusRadius: number;
  /** 掴まれているか。false の間、半径は音声側からの出力になる。 */
  armHeld: boolean;
  /**
   * 針が降りてくる速さ m/s（≥0）。着地の過渡音の元で、**接触が立ち上がった
   * 瞬間にだけ**読まれる。そっと置けば 0。
   */
  landingSpeed: number;
  /**
   * スピンドルから見た針先の方位角 rad。盤面の欠陥がどの点に当たるかを決める。
   * **半径と違って follow 中も入力**（螺旋は方位角を知らない）。
   */
  stylusAzimuth: number;
}

/**
 * 音声スレッドから届いた最新の状態。**プレーンオブジェクト**で、`motorTelemetry`
 * や `handInput` と同じ扱い — 毎フレーム読まれるのでReact stateにしない。
 *
 * `audioTime` は音声クロック上の取得時刻。描画はこれと現在の音声時刻の差から
 * 角度を外挿する。
 */
export const deckTelemetry = {
  audioTime: Number.NaN,
  phiUnwrapped: 0,
  phiWrapped: 0,
  omega: 0,
  currentRpm: 0,
  motorState: "stopped" as MotorState,
  programCursor: Number.NaN,
  zone: "outside" as GrooveZone,
  revolutions: 0,
  /** 螺旋が針を運んだ半径 m。掴んでいない間のアーム位置の正本。 */
  stylusRadius: Number.NaN,
  cutRegion: "lead-in" as CutRegion,
  /**
   * 針がいるレコード座標。溝の中心からの距離 m と盤に固定された角度 rad。
   * **盤面描画はこの座標で描けば音と一致する。**
   */
  recordRadius: Number.NaN,
  recordAngle: 0,
  /** その点の盤面の高さ m（反り）。 */
  surfaceHeight: 0,
  /** 針が壁から浮いている＝ミストラッキング中。非接触とは別物。 */
  mistracking: false,
  /** 接触を失ったサンプル数の累計。 */
  contactLossSamples: 0,
  /**
   * Drive領域の外乱トルク rad/s²、成分ごと。**時間由来（wow / flutter）と回転角
   * 由来（転流リプル）は別の量**なので、畳まずに持つ。
   */
  driveWowTorque: 0,
  driveFlutterTorque: 0,
  driveCommutationRippleTorque: 0,
  /** 実際に出た速度偏差（公称速度に対する比）。音声側でピークを捉えた値。 */
  driveSpeedRatio: 0,
  /**
   * 溝の摩耗の概要。**生の摩耗の場は音声スレッドにある**（数MBあるので運ばない）。
   * Zustand へはここからさらに間引いて渡す（`useDeckStore.discWear`）。
   */
  wearPlays: 0,
  wearPeak: 0,
  wearMean: 0,
  /**
   * 出ていく信号のレベルと、段ごとの飽和（`levels.ts`）。**基準設定の音楽では
   * どれも 0 のまま**なので、0 以外が出ていたら何かが過大である。
   */
  levelPeak: 0,
  levelTruePeak: 0,
  levelRms: 0,
  levelInputPeakMv: 0,
  levelLinePeak: 0,
  levelInputOverloads: 0,
  levelOutputOverloads: 0,
  /** **いま**削っている量 dB。0 なら不動作。 */
  levelSafetyReductionDb: 0,
  /** その最大値。**リセットするまで下がらない。** */
  levelSafetyMaxReductionDb: 0,
  /** 実効作動時間率（0〜1）。削っていたサンプル ÷ 通したサンプル。 */
  levelSafetyDutyRatio: 0,
  /** 作動イベント数。**サンプル数ではない。** */
  levelSafetyEvents: 0,
};

let node: AudioWorkletNode | null = null;
let starting: Promise<void> | null = null;
/** ノードが出来る前に来た盤。出来しだい載せる。 */
let pendingGroove: {
  walls: Float32Array[];
  sampleRate: number;
  layout: CutLayout;
} | null = null;
let armed = false;

const params = new Map<DeckParam, AudioParam>();

async function createNode(): Promise<void> {
  const context = getAudioContext();
  await context.audioWorklet.addModule(processorUrl);

  const created = new AudioWorkletNode(context, DECK_PROCESSOR, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    // 溝の壁は2本。1chしか無いと右壁が左を上書きしてしまう。
    outputChannelCount: [2],
  });

  for (const name of DECK_PARAMS) {
    const param = created.parameters.get(name);
    if (param) params.set(name, param);
  }

  created.port.onmessage = (event: MessageEvent) => {
    const data = event.data as Partial<DeckTelemetryMessage>;
    deckTelemetry.audioTime = data.audioTime ?? Number.NaN;
    deckTelemetry.phiUnwrapped = data.phiUnwrapped ?? 0;
    deckTelemetry.phiWrapped = data.phiWrapped ?? 0;
    deckTelemetry.omega = data.omega ?? 0;
    deckTelemetry.currentRpm = radPerSecToRpm(deckTelemetry.omega);
    deckTelemetry.motorState = data.motorState ?? "stopped";
    deckTelemetry.programCursor = data.programCursor ?? Number.NaN;
    deckTelemetry.zone = data.zone ?? "outside";
    deckTelemetry.revolutions = data.revolutions ?? 0;
    deckTelemetry.stylusRadius = data.stylusRadius ?? Number.NaN;
    deckTelemetry.cutRegion = data.cutRegion ?? "lead-in";
    deckTelemetry.recordRadius = data.recordRadius ?? Number.NaN;
    deckTelemetry.recordAngle = data.recordAngle ?? 0;
    deckTelemetry.surfaceHeight = data.surfaceHeight ?? 0;
    deckTelemetry.mistracking = data.mistracking ?? false;
    deckTelemetry.contactLossSamples = data.contactLossSamples ?? 0;
    deckTelemetry.driveWowTorque = data.driveWowTorque ?? 0;
    deckTelemetry.driveFlutterTorque = data.driveFlutterTorque ?? 0;
    deckTelemetry.driveCommutationRippleTorque =
      data.driveCommutationRippleTorque ?? 0;
    deckTelemetry.driveSpeedRatio = data.driveSpeedRatio ?? 0;
    deckTelemetry.wearPlays = data.wearPlays ?? 0;
    deckTelemetry.wearPeak = data.wearPeak ?? 0;
    deckTelemetry.wearMean = data.wearMean ?? 0;
    deckTelemetry.levelPeak = data.levelPeak ?? 0;
    deckTelemetry.levelTruePeak = data.levelTruePeak ?? 0;
    deckTelemetry.levelRms = data.levelRms ?? 0;
    deckTelemetry.levelInputPeakMv = data.levelInputPeakMv ?? 0;
    deckTelemetry.levelLinePeak = data.levelLinePeak ?? 0;
    deckTelemetry.levelInputOverloads = data.levelInputOverloads ?? 0;
    deckTelemetry.levelOutputOverloads = data.levelOutputOverloads ?? 0;
    deckTelemetry.levelSafetyReductionDb = data.levelSafetyReductionDb ?? 0;
    deckTelemetry.levelSafetyMaxReductionDb = data.levelSafetyMaxReductionDb ?? 0;
    deckTelemetry.levelSafetyDutyRatio = data.levelSafetyDutyRatio ?? 0;
    deckTelemetry.levelSafetyEvents = data.levelSafetyEvents ?? 0;
    publishWear();
  };

  created.connect(context.destination);
  node = created;

  if (pendingGroove !== null) {
    sendGroove(pendingGroove);
    pendingGroove = null;
  }
  // ノードが出来る前に盤の状態が選ばれていることもある。両側を揃え直す。
  sendCondition();

  if (import.meta.env.DEV) {
    (globalThis as { deckAudio?: unknown }).deckAudio = {
      context,
      node: created,
      telemetry: deckTelemetry,
      // いま載っている盤の指紋と、効いている状態。**関数で読む** — どちらも
      // 差し替わるので、値を写すと古い盤の話になる。
      discSeed: () => discSeed,
      condition: () => condition,
      // 焼いたほうと効かせるほうを1つの形で（`RecordSpec`）。
      record: deckRecordSpec,
    };
  }
}

function sendGroove(groove: {
  walls: Float32Array[];
  sampleRate: number;
  layout: CutLayout;
}) {
  if (node === null) return;
  const message: DeckGrooveMessage = { type: "groove", ...groove };
  // 転送してコピーを増やさない。同じ ArrayBuffer を2回渡すと例外になるので、
  // モノラル（両壁が同じ配列）でも一度だけ transfer する。
  const buffers = new Set(groove.walls.map((wall) => wall.buffer));
  node.port.postMessage(message, [...buffers]);
}

/**
 * 最初のユーザー操作で音声を起こす仕掛けを張る。
 *
 * **物理は音声クロックで動くので、resume するまで盤は回らない。** この機種に
 * 電源スイッチが無い以上、最初の操作が通電に当たる（audio-engine.md 11.2 段階B）。
 */
export function armDeckAudio(): void {
  if (armed) return;
  armed = true;

  const wake = () => {
    starting ??= createNode().catch((error: unknown) => {
      console.error("deck audio failed to start", error);
      starting = null;
    });
    void getAudioContext().resume();
  };

  // capture 段で拾う。デッキの操作は canvas 内で止まることがあるため。
  window.addEventListener("pointerdown", wake, { capture: true });
  window.addEventListener("keydown", wake, { capture: true });
}

/** 毎フレーム呼ばれる。値が動いていないパラメータは触らない。 */
export function sendDeckInputs(inputs: DeckInputs): void {
  if (node === null) return;
  const set = (name: DeckParam, value: number) => {
    const param = params.get(name);
    if (param && param.value !== value && Number.isFinite(value)) {
      param.value = value;
    }
  };

  set("motorRequested", inputs.motorRequested ? 1 : 0);
  set("targetRpm", inputs.targetRpm);
  set("handContact", inputs.handAngularVelocity === null ? 0 : 1);
  set("handAngularVelocity", inputs.handAngularVelocity ?? 0);
  set("stylusContact", inputs.stylusContact ? 1 : 0);
  set("stylusRadius", inputs.stylusRadius);
  set("armHeld", inputs.armHeld ? 1 : 0);
  set("stylusLandingSpeed", inputs.landingSpeed);
  set("stylusAzimuth", inputs.stylusAzimuth);
}

/**
 * 盤を切って音声スレッドへ渡す。
 *
 * カッティング（RIAA録音特性＋積分）は**メインスレッドで一度だけ**行う。
 * 音声スレッドでやればブロックを落とし、毎ブロックやるのは論外。
 *
 * ponytail: 10分の音源で数百ミリ秒このスレッドを占める。読み込み中の表示は
 * 出ているので今は許容している。長尺で引っかかるようなら Worker へ出す
 * （`cutToGroove` は Web Audio に依存しないのでそのまま動く）。
 */
export function loadGrooveIntoDeck(
  buffer: AudioBuffer | null,
  /**
   * この盤の seed。**音源の中身から決まる**ので、同じファイルなら毎回同じ盤に
   * なる（`discSeedFromBytes`）。ハッシュを取るのは読み込み側で、ここは受け取る
   * だけ — 盤を降ろすとき（`buffer === null`）は使われない。
   */
  discSeedForDisc = 0,
): void {
  if (buffer === null) {
    const off: DeckGrooveMessage = { type: "groove" };
    if (node !== null) node.port.postMessage(off);
    else pendingGroove = null;
    // 切り直す元が無くなった。次の盤が来るまで再カッティングはできない。
    source = null;
    return;
  }

  // **新しい盤には新しい seed。** 中身から決まっているので、同じ音源を載せ直せば
  // 同じ盤が出てくる（埃も反りの向きも前と同じ場所）。盤を替えたときだけ変わる。
  discSeed = discSeedForDisc;
  // 切り直しの元。`AudioBuffer` はカッティングで壊れないので参照を持つだけで、
  // `trackRuntime` が持っているのと同じ1つである（二重に抱えない）。
  source = buffer;
  cutAndSend(buffer);
  // **溝の後に送る。** 盤面の欠陥は螺旋の割り付けを見て作られるので、盤が載って
  // からでないと新しい seed で作り直せない（`deckEngine.loadGroove`）。
  setDeckCondition(condition.preset);
}

/**
 * いま選ばれている盤とデッキの状態。**メインスレッド側の正本。**
 *
 * 音声スレッドへは同じものを1通で送る。盤の形と針はこちらも同じ純関数で使う
 * （支持面の高さとアームの姿勢）ので、2つに分かれた値を持つと針が浮いているのに
 * 音が出る。**既定は `clean` ＝9段すべて理想で、完全バイパス。**
 */
let condition: RecordCondition = recordConditionFor("clean", 0, 50);

/**
 * いま載っている盤の seed。**盤ごとに固定**で、同じ音源なら埃も反りも同じ場所に
 * 出る。音源が変わるまで動かないので、針を上げ下げしても配置は変わらない。
 */
let discSeed = 0;

/**
 * 電源周波数。**地域で決まる設定**で、このデッキの性質ではない（`hum.ts`）。
 *
 * ponytail: 選ばせる UI がまだ無いので 50 を置いてあるだけで、**既定の主張ではない**。
 * 設定が出来たら `setDeckCondition` と一緒にここを動かす。
 */
const MAINS_HZ: MainsHz = 50;

export const deckConditionName = (): RecordConditionName => condition.preset;

/** メインスレッドがアームと接触を解くのに使う3つ。正本は `condition`。 */
export const deckDiscShape = (): DiscShapeParameters => condition.shape;
export const deckStylus = (): StylusParameters => condition.stylus;
export const deckTonearm = (): TonearmVerticalParameters => condition.tonearm;

/* ------------------------------------------------------------------ *
 * 摩耗 — **盤に溜まっていく状態**
 * ------------------------------------------------------------------ */

let wearPreset: WearPresetName = "none";

export const deckWearName = (): WearPresetName => wearPreset;

/**
 * 摩耗の進み方を選ぶ。**溜まったぶんは消えない** —— 減った盤は減ったままである
 * （製造直後へ戻すのは `resetDeckWear`）。
 */
export function setDeckWear(preset: WearPresetName): void {
  wearPreset = preset;
  sendWear({ parameters: wearParametersFor(preset) });
}

/** **製造直後の盤へ戻す。** 溝そのものは元から不変なので、捨てるのは跡だけ。 */
export function resetDeckWear(): void {
  sendWear({ reset: true });
  deckTelemetry.wearPlays = 0;
  deckTelemetry.wearPeak = 0;
  deckTelemetry.wearMean = 0;
  publishWear();
}

function sendWear(message: Omit<DeckWearMessage, "type">): void {
  if (node === null) return;
  node.port.postMessage({ type: "wear", ...message } satisfies DeckWearMessage);
}

/**
 * 概要を Zustand へ。**変わったときだけ書く。**
 *
 * telemetry は約60Hzで届くが、摩耗は1回の再生で 1e-4 しか動かない。毎回書けば
 * 描画のたびに再レンダリングが走るだけなので、0.1% 刻みで丸めた値が変わった
 * ときにだけ通す（離散的な状態は遷移時のみ、という置き場所の規則どおり）。
 */
let publishedWear = -1;
function publishWear(): void {
  const step = Math.round(deckTelemetry.wearMean * 1000);
  if (step === publishedWear) return;
  publishedWear = step;
  useDeckStore.getState().setDiscWear({
    plays: deckTelemetry.wearPlays,
    peak: deckTelemetry.wearPeak,
    mean: deckTelemetry.wearMean,
  });
}

/* ------------------------------------------------------------------ *
 * レベル校正 — **再生系の設定。盤にもデッキにも属さない**
 * ------------------------------------------------------------------ */

let levelsPreset: LevelPresetName = "reference";

export const deckLevelsName = (): LevelPresetName => levelsPreset;

/**
 * レベル校正を選び直す。**鳴っている途中でも差し替えられる**（変わるのは次の
 * ブロックから読まれる係数だけ）。`reference` へ戻せば利得1・飽和ゼロに戻る。
 */
export function setDeckLevels(preset: LevelPresetName): void {
  levelsPreset = preset;
  sendLevels({ parameters: levelParametersFor(preset) });
}

/** 計測だけ 0 へ。**設定にも音にも触らない。** */
export function resetDeckLevelMeters(): void {
  sendLevels({ resetMeters: true });
}

function sendLevels(message: Omit<DeckLevelsMessage, "type">): void {
  if (node === null) return;
  node.port.postMessage({ type: "levels", ...message } satisfies DeckLevelsMessage);
}

function sendCondition(): void {
  if (node === null) return;
  const message: DeckConditionMessage = { type: "condition", condition };
  node.port.postMessage(message);
}

/**
 * 盤とデッキの状態を選び直す。**9段が同時に入れ替わる。**
 *
 * 角度も位置もカーソルも触らないので、鳴っている途中で切り替えても盤は回り続け、
 * 音が跳ぶことはない（変わるのは次のブロックから読まれる係数だけ）。`clean` へ
 * 戻せば完全バイパスへ戻る。
 */
export function setDeckCondition(preset: RecordConditionName): void {
  condition = recordConditionFor(preset, discSeed, MAINS_HZ);
  sendCondition();
}

/* ------------------------------------------------------------------ *
 * カッティング側 — **溝に焼かれるほう**
 * ------------------------------------------------------------------ */

/**
 * この盤をどう切ったか。**再生側（`condition`）と型が分かれている理由は
 * `RecordSpec` に書いてある** —— こちらは変えると切り直しになる。
 *
 * **音声スレッドへは送らない。** 送るものが1つも無い（結果は溝そのものに入って
 * いる）。再生側がこの設定を知る必要は無く、知ってはならない。
 */
let cutting: CuttingParameters = cuttingParametersFor("ideal");
let cuttingPreset: CuttingPresetName = "ideal";

/**
 * この盤をどう**作った**か。切った後の工程（`manufacturing.ts`）で、こちらも
 * 溝に焼かれる —— 変えれば作り直しになる。**音声スレッドへは送らない。**
 */
let manufacturing: ManufacturingParameters = manufacturingParametersFor("ideal");
let manufacturingPreset: ManufacturingPresetName = "ideal";

/**
 * 切り直しの元。**`trackRuntime.buffer` と同じ1つ**を指しているだけで、複製は
 * 持たない（10分の音源で数百MBある）。盤を降ろすと null に戻る。
 */
let source: AudioBuffer | null = null;

export const deckCuttingName = (): CuttingPresetName => cuttingPreset;
export const deckManufacturingName = (): ManufacturingPresetName =>
  manufacturingPreset;

/** DEV表示用。**焼くほうと効かせるほうを1つの形で見る**（`RecordSpec`）。 */
export const deckRecordSpec = (): RecordSpec => ({
  cutting,
  manufacturing,
  playback: condition,
});

/**
 * いま載っている音源を、いまのカッティング設定で切って音声スレッドへ渡す。
 *
 * 順序が要点である:
 *
 * ```
 *   ① プレビュー解析 → 回転ごとのピッチ    ← 切る前の信号を先読みする
 *   ② 螺旋の割り付け（CutLayout）          ← 半径はここで決まる
 *   ③ カッティング                        ← ②の半径で限界が決まる（§7.12）
 *   ④ 製造・転写                          ← ③のラッカーを盤にする（§7.15）
 *   ⑤ 溝と割り付けを一緒に送る             ← 音声側は②を作り直さない
 * ```
 */
function cutAndSend(buffer: AudioBuffer): void {
  const channels: Float32Array[] = [];
  for (let i = 0; i < Math.min(2, buffer.numberOfChannels); i++) {
    channels.push(buffer.getChannelData(i));
  }

  const layout = planCutLayout(channels, buffer);
  // ここで盤を切る。RIAA録音特性・ヘッド・溝の限界を通して積分し、溝壁の
  // **変位**にする。`cutToGroove` は新しい配列を返すので、`AudioBuffer` 側は
  // 無傷のまま残る（だから何度でも切り直せる）。
  const lacquer = cutToGroove(channels, buffer.sampleRate, {
    parameters: cutting,
    layout,
  });
  // **切ったのはラッカー1枚。** 金属原盤への転写とプレスを通して、実際に手へ渡る
  // 盤の溝にする。隣接溝の pre/post-echo もここで焼き込まれる。**割り付けは
  // 触らない**（半径↔回転数の正本は②のまま）。
  const walls = manufactureGroove(
    lacquer,
    buffer.sampleRate,
    layout,
    manufacturing,
    manufacturingSeedFrom(discSeed),
  );
  const groove = { walls, sampleRate: buffer.sampleRate, layout };
  if (node === null) pendingGroove = groove;
  else sendGroove(groove);

  if (import.meta.env.DEV && !layout.fit.fits) {
    console.warn(
      layout.fit.impossible
        ? `[cut] does not fit: needs ${(layout.fit.required * 1000).toFixed(1)}mm ` +
            `of ${(layout.fit.available * 1000).toFixed(1)}mm — no level reduction can save it`
        : `[cut] does not fit: needs ${(layout.fit.required * 1000).toFixed(1)}mm ` +
            `of ${(layout.fit.available * 1000).toFixed(1)}mm — cut ` +
            `${layout.fit.levelReductionDb.toFixed(1)}dB lower to hold the pitch`,
    );
  }
  // **収束しなかったことを黙って飲み込まない。** 溝は最後の収容確認で守られて
  // いるが、詰まり方は最適ではない（`pitchControl.ts` の PITCH_SOLVER）。
  if (import.meta.env.DEV && !layout.fit.converged) {
    console.warn(
      `[cut] pitch map did not settle in ${layout.fit.iterations} iterations — ` +
        `last move ${(layout.fit.residual * 1e6).toFixed(2)}µm/rev`,
    );
  }
}

/**
 * 螺旋の割り付けを決める。**プレビュー制御が無ければ従来の一定ピッチ。**
 *
 * 可変ピッチのときだけ、切る前の信号を丸ごと1回なめて回転ごとの必要間隔を出す
 * （`pitchControl.ts`）。盤に収まらなければ `layout.fit` に理由が入る。
 */
function planCutLayout(
  channels: readonly Float32Array[],
  buffer: AudioBuffer,
): CutLayout {
  const control = cutting.pitch;
  const seconds = buffer.length / buffer.sampleRate;
  if (control === null) {
    return createCutLayout(seconds, buffer.sampleRate, CUT.cutRpm);
  }
  const samplesPerRevolution = (buffer.sampleRate * 60) / CUT.cutRpm;
  const plan = planGroovePitch(
    channels,
    buffer.sampleRate,
    cutting,
    control,
    CUT.cutRpm,
    samplesPerRevolution,
    buffer.length / samplesPerRevolution,
  );
  return createCutLayout(
    seconds,
    buffer.sampleRate,
    CUT.cutRpm,
    plan.pitches,
    plan.fit,
  );
}

/**
 * **切り直す。** 盤を作り直すので、いま鳴っている位置は失われる。
 *
 * 再生側の状態（`setDeckCondition`）と違い、これは**鳴っている途中に差し替える
 * ためのものではない**。長い音源では数百ミリ秒このスレッドを止める。
 *
 * 盤が載っていなければ設定だけ覚えて何もしない。次の `loadGrooveIntoDeck` が
 * その設定で切る。
 */
export function setDeckCutting(preset: CuttingPresetName): void {
  cuttingPreset = preset;
  cutting = cuttingParametersFor(preset);
  recut();
}

/**
 * **作り直す。** 切るところからやり直すので、`setDeckCutting` と同じだけ止まる
 * ——製造だけを差し替えても、元になるラッカーは毎回同じである。
 */
export function setDeckManufacturing(preset: ManufacturingPresetName): void {
  manufacturingPreset = preset;
  manufacturing = manufacturingParametersFor(preset);
  recut();
}

/** 盤が載っていなければ設定だけ覚えて何もしない。次のロードがその設定で切る。 */
function recut(): void {
  if (source === null) return;
  cutAndSend(source);
  // 溝を作り直したので、盤面の欠陥も同じ seed で作り直す（`loadGroove` が
  // 位置を捨てるため、この一手が無いと欠陥の無い盤になる）。
  setDeckCondition(condition.preset);
}

/**
 * いまの盤の回転角 rad。テレメトリの取得時刻から**外挿**した値。
 *
 * 描画も接触判定もこれを読む。毎回最新のスナップショットから作り直すので、
 * 第二の積分器にはならない（PlatterDrive の注記と同じ理由）。
 */
export function deckPlatterAngle(): number {
  const since = deckAudioTime() - deckTelemetry.audioTime;
  return Number.isFinite(since) && since >= 0 && since < 0.5
    ? deckTelemetry.phiWrapped + deckTelemetry.omega * since
    : deckTelemetry.phiWrapped;
}

/** 音声クロックの現在値。無ければ NaN（＝盤は動いていない）。 */
export function deckAudioTime(): number {
  const context = peekAudioContext();
  return context === null ? Number.NaN : context.currentTime;
}
