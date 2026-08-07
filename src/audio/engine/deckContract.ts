/**
 * スレッド境界の契約。**両側が import してよい唯一の共有モジュール。**
 *
 * ここが分かれていないと、名前を知るためだけにメインスレッドが worklet 本体を
 * 評価してしまい、`AudioWorkletProcessor is not defined` で落ちる（実際に踏んだ）。
 * 値も型もこちらに置き、worklet 本体からは何も import しない。
 */

import type { GrooveZone } from "../../physics/groove";
import type { MotorState } from "../../physics/platterMotor";
import type { CutLayout, CutRegion } from "./cutLayout";
import type { RecordCondition } from "./recordCondition";
import type { WearParameters } from "./wear";
import type { LevelParameters } from "./levels";

export const DECK_PROCESSOR = "deck-processor";

/**
 * 連続入力は AudioParam で渡す。postMessage のキューを通らないので遅延が小さく、
 * 共有メモリと違ってヘッダー設定（COOP/COEP）も要らない。
 *
 * ponytail: 手の角速度はメインスレッドがフレーム時計で微分して送っている。
 * 上限は「ポインター1フレーム分の遅れ」。SharedArrayBuffer を入れる段で、
 * 角度を送って音声側が固定窓で微分する形へ移す（audio-engine.md 8.4）。
 */
export const DECK_PARAMS = [
  "motorRequested",
  "targetRpm",
  /** 手が触れているか。0 と非接触は別物なので速度と分ける。 */
  "handContact",
  "handAngularVelocity",
  "stylusContact",
  /** `armHeld` のときだけ入力として効く。それ以外は螺旋が半径を決める。 */
  "stylusRadius",
  /** アームが掴まれているか。1 = user、0 = follow。 */
  "armHeld",
  /**
   * スピンドルから見た針先の方位角 rad。盤面の欠陥の索引にだけ使う。
   * 半径と違って **follow 中も入力**である（螺旋は方位角を知らない）。
   */
  "stylusAzimuth",
  /**
   * 針が降りてくる速さ m/s（≥0）。**接触が立ち上がった瞬間にだけ読まれる。**
   * 落下中は毎フレーム更新され、着地後もそのまま保持される。
   */
  "stylusLandingSpeed",
] as const;

export type DeckParam = (typeof DECK_PARAMS)[number];

/** 音声スレッド → メインスレッド。間引いて約60Hzで送る。 */
export interface DeckTelemetryMessage {
  /** 音声クロック上の取得時刻。描画側の外挿の基準。 */
  audioTime: number;
  phiUnwrapped: number;
  phiWrapped: number;
  omega: number;
  motorState: MotorState;
  programCursor: number;
  /** 盤という物体の上での位置（音源に依存しない）。 */
  zone: GrooveZone;
  /** 螺旋上の位置（回転数）。アーム位置とカーソルの共通の親。 */
  revolutions: number;
  /** 螺旋が針を運んだ半径 m。**follow 中のアーム位置の正本。** */
  stylusRadius: number;
  /** 切られた中身での位置。program / lead-out / locked の判定はこちら。 */
  cutRegion: CutRegion;
  /**
   * 針がいま**レコードのどこにいるか**。溝の中心からの距離 m と、盤に固定された
   * 角度 rad（0〜2π）。**盤面描画はこの座標で欠陥を描けば音と一致する。**
   */
  recordRadius: number;
  recordAngle: number;
  /** その点の盤面の高さ m（反り）。 */
  surfaceHeight: number;
  /** 直近サンプルで針が壁から浮いていたか。非接触とは別物。 */
  mistracking: boolean;
  /** 接触を失ったサンプル数の累計。決定論的でブロック長に依らない。 */
  contactLossSamples: number;
  /**
   * Drive領域の外乱トルク rad/s²、成分ごと。**時間由来（wow / flutter）と回転角
   * 由来（転流リプル）を分けたまま出す。** 畳むとどちらの性質も読めなくなる。
   *
   * 転流リプルは**駆動中にしか出ない**ので、静的な cogging torque とは別物である
   * （コアレスのダイレクトドライブとして、真の cogging は 0）。
   */
  driveWowTorque: number;
  driveFlutterTorque: number;
  driveCommutationRippleTorque: number;
  /**
   * その外乱が実際に作った速度偏差（公称速度に対する比）。**音声側でピークを
   * 捉えてある** — この間引き（約60Hz）では速い flutter を生では追えないため。
   */
  driveSpeedRatio: number;
  /**
   * 溝の摩耗の**概要だけ**（`wear.ts` の `WearSummary`）。生の摩耗の場は音声
   * スレッドに置いたままで、ここには数値しか出さない —— 盤1枚で数MBある場を
   * 60Hz で運ぶ理由が無い。
   */
  wearPlays: number;
  wearPeak: number;
  wearMean: number;
  /**
   * 出ていく信号のレベルと、段ごとの飽和（`levels.ts`）。**基準設定の音楽では
   * 飽和もセーフティも 0 のまま**なので、0 以外が出ていたら何かが過大である。
   */
  levelPeak: number;
  levelTruePeak: number;
  levelRms: number;
  levelInputPeakMv: number;
  levelLinePeak: number;
  levelInputOverloads: number;
  levelOutputOverloads: number;
  /**
   * セーフティ段。**「いま」と「最大」と「時間率」と「回数」を分けて出す。**
   * 混ぜると「一度下がった」と「常時下がっている」が区別できない（`levels.ts`）。
   */
  levelSafetyReductionDb: number;
  levelSafetyMaxReductionDb: number;
  levelSafetyDutyRatio: number;
  levelSafetyEvents: number;
}

/** メインスレッド → 音声スレッド。溝の載せ替え。 */
export interface DeckGrooveMessage {
  type: "groove";
  /** 省略は「盤を降ろす」。 */
  walls?: Float32Array[];
  sampleRate?: number;
  /**
   * この盤の螺旋の割り付け。**可変ピッチでは音源の中身から決まる**ので、音声
   * スレッド側では作れない（`pitchControl.ts`）——だから溝と一緒に運ぶ。
   *
   * アームの自動追従も、針を降ろしたときのシークも、演奏領域の終わりも、
   * **全部これ1つを正本にする**。省略されたときだけ音声側が一定ピッチで作る。
   */
  layout?: CutLayout;
}

/**
 * メインスレッド → 音声スレッド。**盤とデッキの非理想パラメータ、一式まとめて。**
 *
 * 9つのモデル（盤面・盤の形・針・針先・カートリッジ・アーム・wow/flutter・ランブル・
 * ハム）を**1通で運ぶ**。段ごとに分けて送ると、届いた順に半分だけ適用された状態で
 * 1ブロック鳴ってしまう — 新しい針で古い盤を読む瞬間が存在してはならない。
 *
 * **盤の形と針は両側が同じ値を持たなければならない。** 接触判定の支持面の高さと
 * アームの縦方向の姿勢はメインスレッドが同じ関数で解いて画面に出しているので、
 * 食い違えば見えているアームと音が別のことを言う（`deckAudio.ts` が正本を持つ）。
 */
export interface DeckConditionMessage {
  type: "condition";
  condition: RecordCondition;
}

/**
 * メインスレッド → 音声スレッド。**摩耗の進み方と、製造直後への巻き戻し。**
 *
 * `condition` と分けてあるのは寿命が違うからである —— あちらは鳴らすたびに効く
 * 設定、こちらは**盤に溜まっていく状態**への操作で、`reset` は履歴を捨てる。
 */
export interface DeckWearMessage {
  type: "wear";
  parameters?: WearParameters;
  /** true なら製造直後の盤へ戻す。 */
  reset?: boolean;
}

/**
 * メインスレッド → 音声スレッド。**レベル校正と飽和の設定。**
 *
 * 盤にもデッキにも属さない**再生系の設定**なので、`condition` とも `wear` とも
 * 別便で運ぶ。`resetMeters` は計測だけを 0 へ戻す（音には触らない）。
 */
export interface DeckLevelsMessage {
  type: "levels";
  parameters?: LevelParameters;
  resetMeters?: boolean;
}

export type DeckInboundMessage =
  | DeckGrooveMessage
  | DeckConditionMessage
  | DeckWearMessage
  | DeckLevelsMessage;
