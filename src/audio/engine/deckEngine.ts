/**
 * DSPコア第一段 — 盤の回転から溝を読む。
 *
 * audio-engine.md の骨格のうち、いま通っているのは次の経路だけ:
 *
 *   盤の物理（既存 stepPlatterMotor）→ ΔphiUnwrapped → programCursor → 補間 → × 再生比
 *
 * ランブル・ハムはまだ無い。それらが入る場所は
 * audio-engine.md 7.1 の並びで決まっており、この段の前後に差し込む。
 *
 * **Web Audio に依存しない。** AudioWorkletProcessor はこのコアのアダプタに
 * なる予定で、まだ結線していない（audio-engine.md 9.1 / 11.2 段階A）。
 *
 * 座標は3つあり、混ぜてはならない:
 *
 *   phiUnwrapped   連続角度。ラップしない。**カーソル前進の唯一の源。**
 *   phiWrapped     0〜2π。盤の回転角そのもの。描画の外挿が読む。
 *   recordRadius   レコード座標。盤の回転・アームの振れ・偏心を畳んだ「盤の上の
 *   recordAngle    どこか」で、盤面欠陥と反りの索引（discShape.ts）。
 *   programCursor  溝バッファ上の連続位置（ソースサンプル）。
 *
 * phiUnwrapped だけがカーソルを動かす。phiWrapped からカーソルを作ってはならず
 * （1回転ごとに巻き戻る）、カーソルから phi を作ってもならない（シークで角度が
 * 飛ぶ）。
 */

import { GROOVE, grooveZoneAt, type GrooveZone } from "../../physics/groove";
import {
  createCutLayout,
  cursorAtRevolution,
  cutRegionAt,
  radiusAtRevolution,
  revolutionsAtRadius,
  type CutLayout,
  type CutRegion,
} from "./cutLayout";
import {
  rpmToRadPerSec,
  stepPlatterMotor,
  type MotorRuntime,
  type MotorState,
} from "../../physics/platterMotor";
import {
  createTonearmVertical,
  IDEAL_TONEARM,
  type TonearmVerticalParameters,
} from "../../physics/tonearm";
import {
  createWowFlutter,
  IDEAL_WOW_FLUTTER,
  type WowFlutterParameters,
} from "../../physics/wowFlutter";
import type { GrooveBuffer } from "./grooveBuffer";
import { createResampler } from "./resampler";
import {
  createBiquadState,
  processBiquad,
  resetBiquadState,
  riaaPlayback,
} from "./riaa";
import {
  createCartridge,
  IDEAL_CARTRIDGE,
  type CartridgeParameters,
} from "./cartridge";
import { createStylus, IDEAL_STYLUS, type StylusParameters } from "./stylus";
import {
  createStylusTip,
  IDEAL_STYLUS_TIP,
  sampleGrooveWall,
  type StylusTipParameters,
} from "./stylusTip";
import {
  CLEAN_SURFACE,
  createSurface,
  type SurfaceParameters,
} from "./surface";
import {
  createOutputChain,
  REFERENCE_LEVELS,
  type LevelParameters,
  type LevelTelemetry,
} from "./levels";
import {
  createGrooveWear,
  NO_WEAR,
  WEAR_CELL_SAMPLES,
  wearRounding,
  type WearParameters,
  type WearSummary,
} from "./wear";
import { createRumble, IDEAL_RUMBLE, type RumbleParameters } from "./rumble";
import { createHum, IDEAL_HUM, type HumParameters } from "./hum";
import {
  FLAT_DISC,
  isFlatDisc,
  labRadiusFor,
  recordPointAt,
  warpHeightAt,
  type DiscShapeParameters,
  type RecordPoint,
} from "./discShape";
import { REFERENCE_WALL_VELOCITY } from "./stylus";

const TWO_PI = Math.PI * 2;

/**
 * 物理を進める粒度。AudioWorkletのレンダークォンタムと同じ128に固定する。
 *
 * 呼び出し側のブロック長に関係なくこの粒度で刻むので、4096サンプルを1回で
 * 渡しても128×32回で渡してもビット単位で同じ出力になる（audio-engine.md 9.4 #1）。
 * 検証で最初に確かめるのがこれ。
 */
export const PHYSICS_CHUNK_FRAMES = 128;

/** 最短で π 進むブロックは角度差分の符号を失う。128フレームでは遠く及ばない。 */
const MAX_CHUNK_RADIANS = Math.PI;

export interface DeckEngineConfig {
  /** 出力側のサンプルレート。溝側のレートとは独立。 */
  sampleRate: number;
}

export interface DeckEngineInput {
  frames: number;
  /** START/STOPの意図。既存 MotorInput と同じ意味。 */
  motorRequested: boolean;
  /** ピッチとSPEED CONTROLトリムを適用済みの目標RPM。 */
  targetRpm: number;
  /** 手の角速度。null は非接触、0 は「押さえて止めている」。 */
  handAngularVelocity: number | null;
  /** 針が溝に降りているか。 */
  stylusContact: boolean;
  /**
   * 針先とスピンドルの水平距離 m。
   *
   * **`armIntent === "user"` のときだけ入力**として効く。それ以外は螺旋が
   * 半径を決めるので、この値は無視される（audio-engine.md 10.2）。
   */
  stylusRadius: number;
  /**
   * アームを誰が動かしているか。`"user"` は掴まれている間だけ。
   *
   * `"follow"` の間、半径は**入力ではなく出力**になる。この一方向性が再生位置と
   * アーム位置の帰還を断つ唯一の仕掛けであり、不感帯や平滑化で誤魔化さない。
   */
  armIntent: "user" | "follow";
  /**
   * スピンドルから見た針先の方位角 rad。アームを振ると変わる。
   *
   * 盤面のどの点が針の下にあるかは、盤の回転角だけでは決まらない — 針もスピンドルの
   * まわりを動くので、**盤面の欠陥はこれと `phiUnwrapped` の差で索引する**
   * （surface.ts）。溝の読み出しには関与しない。
   */
  stylusAzimuth: number;
  /**
   * 針が降りた瞬間の着地速度 m/s（≥0）。**接触が立ち上がったブロックでだけ
   * 読まれる。** 過渡音の大きさはこの値そのもので、そっと置けば 0 になる。
   */
  landingSpeed: number;
}

export interface DeckEngineState {
  /** 既存の物理がそのまま持つ角度と角速度。エンジンが所有する。 */
  readonly motor: MotorRuntime;
  phiUnwrapped: number;
  phiWrapped: number;
  /**
   * 螺旋上の位置（回転数）。0 が演奏領域の始まり、負がリードイン。
   * **アーム位置とカーソルの両方がここから導かれる正本。**
   */
  revolutions: number;
  /** 溝バッファ上の位置。**NaN は「どこでもない」**（演奏領域の外）。 */
  programCursor: number;
  /** 螺旋が針を運んだ半径 m。`armIntent === "follow"` のときアームの正本。 */
  stylusRadius: number;
  /** 螺旋のどこにいるか。盤の形（`zone`）ではなく、切られた中身での位置。 */
  cutRegion: CutRegion;
  /** 直前ブロックの接触状態。立ち上がりでだけシークする。 */
  contact: boolean;
  /** 直近チャンクの平均角速度 rad/s。テレメトリと再生比の元。 */
  omega: number;
  /** 既存の物理が返す離散フェーズ。描画とUIはこれをテレメトリ経由で読む。 */
  motorState: MotorState;
  /**
   * 盤という**物体の形**の上でどこにいるか（どこに溝を切れるか）。すべての盤で
   * 同じで、音源に依存しない。実際に何が切られているかは `cutRegion`。
   */
  zone: GrooveZone;
  /** 装填中の盤の割り付け。盤が無ければ null。 */
  layout: CutLayout | null;
  /**
   * 針がいま**レコードのどこにいるか**。溝の中心からの距離 m と、盤に固定された
   * 角度 rad（0〜2π）。**音声・盤面欠陥・将来の盤面描画が共有する座標**で、盤の
   * 回転・アームの振れ・偏心がすべて畳み込まれている（`discShape.ts`）。
   */
  recordRadius: number;
  recordAngle: number;
  /** その点の盤面の高さ m（反り）。接触判定の支持面はこのぶん上下する。 */
  surfaceHeight: number;
  /** 直近サンプルで針が壁から浮いていたか＝ミストラッキング中。 */
  mistracking: boolean;
  /**
   * 接触を失ったサンプル数の累計（壁ごとに数える）。**決定論的で、ブロック長に
   * 依らない。** 検証もUIもこれ1本で「どれだけ追えていないか」を読める。
   */
  contactLossSamples: number;
  /**
   * Drive領域の外乱トルク rad/s²、**成分ごと**。時間由来の2つと回転角由来の1つ
   * （転流リプル。静的な cogging ではない）を分けたまま出す（`wowFlutter.ts`）。
   * 理想設定ではどれも 0。
   */
  driveWowTorque: number;
  driveFlutterTorque: number;
  driveCommutationRippleTorque: number;
  /**
   * その外乱が**実際に作った速度偏差**（公称速度に対する比）。山を捉えて緩やかに
   * 落とすので、テレメトリが間引かれても速い flutter が見える。公称速度に乗って
   * いないあいだ（起動・制動・手回し）は数えない。
   */
  driveSpeedRatio: number;
}

export interface DeckEngine {
  readonly state: DeckEngineState;
  /**
   * 音源の載せ替え。位置は無効化され、次に針を降ろすまで鳴らない。
   *
   * **割り付け（`CutLayout`）は受け取る。** 可変ピッチの盤では螺旋の形が音源の
   * 中身から決まるので、こちら側では作れない（`pitchControl.ts`）。省略された
   * ときだけ、従来どおり一定ピッチで作る。
   */
  loadGroove(groove: GrooveBuffer | null, layout?: CutLayout | null): void;
  /**
   * カートリッジの取り替え。既定は理想（完全バイパス）。
   *
   * 実機の値はまだどこにも書いていない — 分かった時点でここへ渡す
   * （`CartridgeParameters`）。
   */
  setCartridge(parameters: CartridgeParameters): void;
  /**
   * 針の取り替え。既定は理想（質量ゼロ＝完全バイパス）。
   *
   * カートリッジと同じで、**実機の値はまだどこにも書いていない**。分かった
   * 時点でここへ渡す（`StylusParameters`）。
   */
  setStylus(parameters: StylusParameters): void;
  /**
   * 針先の形（トレーシング歪みと pinch effect）。既定は理想＝完全バイパス。
   *
   * **ローパスでも waveshaper でもない。** 丸い針先が自分より曲率のきつい谷へ
   * 入れないという幾何そのもので、追える溝では1ビットも変わらない
   * （`stylusTip.ts`）。**実機の寸法は入っていない。**
   */
  setStylusTip(parameters: StylusTipParameters): void;
  /**
   * トーンアームの縦方向の機械応答。既定は理想（質量ゼロ＝完全バイパス）。
   *
   * **ばねは渡さない。** カンチレバーは `setStylus` の `compliance` 1本だけで、
   * アームはその上に乗る質量として振る舞う（`physics/tonearm.ts`）。この順序
   * なので、`setStylus` を呼び直すとアーム側の共振も自動で引き直される。
   */
  setTonearm(parameters: TonearmVerticalParameters): void;
  /**
   * Drive領域の速度変動（wow / flutter / 転流リプル）。既定は理想＝完全バイパス。
   *
   * **モーターへ渡すのはトルクだけ。** 再生比も溝も触らないので、音程の揺れは
   * 「盤が実際にその速さで回った」結果としてしか出ない（`wowFlutter.ts`）。
   * 掛け替えても回転は連続する — トルクが変わるだけで、角度は跳ばない。
   */
  setWowFlutter(parameters: WowFlutterParameters): void;
  /**
   * ランブルと構造伝播振動。既定は理想＝完全バイパス。
   *
   * **出力へ足すノイズではない。** 盤とカートリッジ本体の相対変位として溝へ
   * 加わるので、剛体として揺れれば厳密に打ち消える（`rumble.ts`）。
   */
  setRumble(parameters: RumbleParameters): void;
  /**
   * 電源ハムと電磁誘導ノイズ。既定は理想＝完全バイパス。
   *
   * **機械振動でも溝の変位でもない。** カートリッジと配線への誘導は RIAA再生より
   * 前、フォノ段以後の電気ノイズは後に入る。**針を上げても止まらない**
   * （`hum.ts`）。`mainsHz` は 50 / 60 の設定項目で、既定は焼き込んでいない。
   */
  setHum(parameters: HumParameters): void;
  /**
   * 盤の状態（表面粗さ・埃・傷）の差し替え。既定は `CLEAN_SURFACE`＝完全バイパス。
   *
   * **盤に属するもの**なので、盤ごとに変えるなら `loadGroove` のたびにその盤の
   * seed で呼び直す。同じ seed なら同じ盤になる。
   */
  setSurface(parameters: SurfaceParameters): void;
  /**
   * 盤の形（偏心・反り）の差し替え。既定は `FLAT_DISC`＝完全バイパス。
   *
   * **メインスレッドと同じ値を持たせること。** 接触判定の支持面の高さは向こうが
   * 同じ関数で計算するので、食い違うと針が浮いているのに音が出る。
   */
  setDiscShape(parameters: DiscShapeParameters): void;
  /**
   * 摩耗の進み方の差し替え。既定は `NO_WEAR`＝完全バイパス。
   *
   * **溜まった摩耗は消えない。** 進み方を変えるだけで、減った盤は減ったままである
   * （製造直後へ戻すのは `resetWear`）。
   */
  setWear(parameters: WearParameters): void;
  /** **製造直後の盤へ戻す。** 摩耗の場も概要も 0 になる。 */
  resetWear(): void;
  /** 摩耗の概要（シリアライズ可能）。**毎回同じオブジェクトを返す。** */
  wearSummary(): WearSummary;
  /** 摩耗の場そのもの。保存・比較用で、**複製しない**。盤が無ければ null。 */
  wearField(): { cellSamples: number; left: Float32Array; right: Float32Array } | null;
  /**
   * カートリッジ出力からライン出力までのレベル校正。既定は `REFERENCE_LEVELS`
   * ＝**利得の積が厳密に 1・どの段も不動作**（`levels.ts`）。
   */
  setLevels(parameters: LevelParameters): void;
  /** ピーク・true peak・実効値・段ごとの飽和回数。**毎回同じオブジェクトを返す。** */
  levelTelemetry(): LevelTelemetry;
  /** 計測だけ 0 へ。設定にも音にも触らない。 */
  resetLevelMeters(): void;
  /** 1ブロック分を書く。outLeft / outRight は input.frames 以上の長さが要る。 */
  process(
    input: DeckEngineInput,
    outLeft: Float32Array,
    outRight: Float32Array,
  ): void;
}

/** 最短側で測る。±π の継ぎ目を跨いでも1回転分の跳ねが出ない。 */
function wrapToPi(angle: number): number {
  return ((((angle + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

function wrapToTwoPi(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

/**
 * 盤が deltaPhi だけ回ったとき、溝上をいくつ進むか（ソースサンプル）。
 *
 * 角速度に dt を掛けるのではなく**実際に回った角度**から出す。盤の回転と音声
 * 位置が同じ積分を共有するので、両者は原理的にずれない（audio-engine.md 4.1）。
 * 出力側のサンプルレートが出てこないので、44.1k でも 96k でも音程が変わらない。
 */
export function cursorAdvanceForPhi(
  deltaPhi: number,
  nominalRpm: number,
  grooveSampleRate: number,
): number {
  if (!Number.isFinite(deltaPhi) || nominalRpm <= 0) return 0;
  const samplesPerRevolution = (grooveSampleRate * 60) / nominalRpm;
  return (deltaPhi / TWO_PI) * samplesPerRevolution;
}

export function createDeckEngine(config: DeckEngineConfig): DeckEngine {
  if (!Number.isFinite(config.sampleRate) || config.sampleRate <= 0) {
    throw new Error(`engine: sample rate must be positive, got ${config.sampleRate}`);
  }
  const sampleRate = config.sampleRate;
  // 生成時に一度だけ。作業用配列を抱えているので、ブロックごとに作らない。
  const resampler = createResampler();

  // カートリッジ = 速度変換器。直前に読んだ**変位**を壁ごとに覚えておき、
  // その差分が針の速度になる。ブロックを跨いで持ち越すので、境界で段差が出ない。
  let previousLeft = 0;
  let previousRight = 0;
  /** 変位を読み直した直後は差分が意味を持たない。最初の1サンプルは速度0にする。 */
  let primed = false;
  /**
   * 直前のチャンクが厳密に無音だったか。**無音 fast-path の入口条件。**
   *
   * 「新しい励振が無い」だけでは早く切りすぎる — 反りを追うアーム、着地した
   * カンチレバー、カートリッジの共振、RIAA の尾は、励振が止まった後もしばらく
   * 動いている。動いていれば必ず出力に出るので、**128サンプル続けて厳密に 0**
   * であることが「上流のどれも動いていない」ことの証明になる。
   */
  let quiescent = false;

  // 盤面の欠陥。**溝と同じ「変位」**なので、加わるのは差分より手前。既定は
  // 何も無い盤＝完全バイパス。
  const surface = createSurface();
  let surfaceParameters = CLEAN_SURFACE;

  // 盤そのものの形（偏心・反り）。既定は歪みなし＝座標変換が恒等写像になる。
  let shape: DiscShapeParameters = FLAT_DISC;
  let discIsFlat = true;
  /** レコード座標。チャンクの両端で1回ずつ求め、間は補間する。 */
  const recordStart: RecordPoint = { radius: 0, angle: 0, wobble: 0 };
  const recordEnd: RecordPoint = { radius: 0, angle: 0, wobble: 0 };

  // 針先の形。既定は理想＝完全バイパス（点で読む針は歪まない）。
  const tip = createStylusTip(IDEAL_STYLUS_TIP);

  /**
   * 針先が触れる**局所盤面形状**。溝と盤面の欠陥だけを返し、反り・偏心・ランブル・
   * ハムは含まない（`stylusTip.ts` の `LocalGrooveProfile`）。
   *
   * ponytail: 窓の1点ごとに `surface.sample` を呼ぶので、針先を非理想にすると
   * 1出力サンプルあたり最大49回になる。既定はバイパスなので通常は0回。重くなったら
   * 窓の点数（`MAX_STEPS`）を下げること。
   */
  const localProfile = {
    left: 0,
    right: 0,
    /** チャンクごとに差し替わるもの。 */
    walls: [] as readonly Float32Array[],
    revolutionsPerSample: 0,
    anglePerSample: 0,
    /** サンプルごとに書き換わるもの。針の中心。 */
    position: 0,
    radius: 0,
    angle: 0,
    /** 摩耗が撫でる半幅（溝サンプル）。0 なら摩耗の段ごと通らない。 */
    wearHalf: 0,
    /**
     * **盤に永久に残る形だけ**を読む（溝＋表面粗さ＋傷）。埃は入らない
     * ——取り除ける異物は摩耗の対象ではないので、削る相手にも入らない。
     */
    permanentAt(at: number, offset: number) {
      this.left = sampleGrooveWall(this.walls[0], at);
      this.right = sampleGrooveWall(this.walls[1], at);
      if (surface.bypassed) return;
      surface.sample(
        at * this.revolutionsPerSample,
        this.radius,
        this.angle + offset * this.anglePerSample,
      );
      this.left += surface.permanentLeft;
      this.right += surface.permanentRight;
    },
    readAt(offset: number) {
      const at = this.position + offset;
      // ① 溝と永久的な盤面。**中心と同じ基底で読む**（膨張は差として使うので、
      //    ここが揃っていれば帯域制限された本読みはエンジン側がそのまま持っている）。
      this.permanentAt(at, offset);
      // ② 摩耗による永久変形。**針が通った跡**なので、埃より前・針先より前。
      if (this.wearHalf > 0) {
        const centreLeft = this.left;
        const centreRight = this.right;
        this.permanentAt(at + this.wearHalf, offset + this.wearHalf);
        const aheadLeft = this.left;
        const aheadRight = this.right;
        this.permanentAt(at - this.wearHalf, offset - this.wearHalf);
        wear.severityAt(at);
        this.left =
          centreLeft +
          wearRounding(wear.left, this.wearHalf, this.left, centreLeft, aheadLeft);
        this.right =
          centreRight +
          wearRounding(wear.right, this.wearHalf, this.right, centreRight, aheadRight);
      }
      // ③ 埃。**盤の形ではない**ので摩耗の後に乗る。針先はこれも丸める。
      if (!surface.bypassed && !surface.dustless) {
        surface.sample(
          at * this.revolutionsPerSample,
          this.radius,
          this.angle + offset * this.anglePerSample,
        );
        this.left += surface.dustLeft;
        this.right += surface.dustRight;
      }
    },
  };

  // 針が溝を追えるか。既定は理想＝完全バイパス（質量のない針はどんな溝も追う）。
  const stylus = createStylus(sampleRate, IDEAL_STYLUS);
  let stylusParameters: StylusParameters = IDEAL_STYLUS;

  // **再生履歴による摩耗。** 盤に属する状態で、元の溝バッファは触らない。
  // 既定は `NO_WEAR`＝完全バイパス（減らない盤）。
  const wear = createGrooveWear(NO_WEAR);

  // カートリッジ出力から Web Audio までのレベル校正と飽和。既定は基準設定で、
  // **利得の積が厳密に 1・どの段も不動作**（`levels.ts`）。
  const levels = createOutputChain(REFERENCE_LEVELS, sampleRate);

  // アーム自身の縦方向の運動。**カンチレバーは針側と同じ1本**なので、ばねは
  // `stylusParameters` から渡す（tonearm.ts の「二重計上について」）。
  let armParameters: TonearmVerticalParameters = IDEAL_TONEARM;
  const armVertical = createTonearmVertical(IDEAL_TONEARM, IDEAL_STYLUS);
  /** アームを進める刻み。**常に1サンプル**なので、ブロック長に依らない。 */
  const armStepSeconds = 1 / sampleRate;

  // ランブルと構造伝播振動。**盤とカートリッジの相対変位**として溝へ足す。
  // 既定は理想＝完全バイパス（揺れないデッキ）。
  const rumble = createRumble(sampleRate, IDEAL_RUMBLE);

  // 電源ハムと電磁誘導。**電気なので溝の変位には混ぜない。** 既定は完全バイパス。
  const hum = createHum(sampleRate, IDEAL_HUM);

  // Drive領域の速度変動。既定は理想＝完全バイパス（揺れないモーター）。
  const wowFlutter = createWowFlutter(IDEAL_WOW_FLUTTER);
  /**
   * 外乱の時計。**処理した累積フレーム数**で、秒を足し込まない。整数なので
   * 音声レートでも何千年も厳密で、ブロックの切り方にも依らない。
   *
   * **盤を載せ替えても戻さない。** 別のレコードを載せてもモーターは同じ個体で、
   * 止まりも巻き戻りもしない。
   */
  let driveFrames = 0;
  /**
   * 速度変動テレメトリのピーク保持の減衰（1チャンクあたり）。
   *
   * `state.omega` はメインスレッドへ約60Hzでしか届かないので、生の値では速い
   * flutter が見えない。音声側で山を捉えて緩やかに落とすことで、間引かれても
   * 「いまどれだけ揺れているか」が残る。時定数はおよそ0.5秒。
   */
  const driveDecay = Math.max(0, 1 - PHYSICS_CHUNK_FRAMES / (0.5 * sampleRate));

  /** 外乱の内訳と、それが実際に作った速度偏差をテレメトリへ写す。 */
  function reportDrive(
    targetRpm: number,
    omega: number,
    motorState: MotorState,
  ): void {
    // 揺れないモーターに「揺れ」は無い。サーボの整定誤差は残っているが、それは
    // 外乱が作ったものではないので、ここへ混ぜない。
    if (wowFlutter.bypassed) return;

    state.driveWowTorque = wowFlutter.wowTorque;
    state.driveFlutterTorque = wowFlutter.flutterTorque;
    state.driveCommutationRippleTorque = wowFlutter.commutationRippleTorque;

    // 公称速度に乗っているときだけ意味がある。起動・制動・手回しの偏差は
    // wow/flutter ではないので混ぜない。
    const targetOmega = rpmToRadPerSec(targetRpm);
    const ratio =
      motorState === "running" && targetOmega > 0
        ? Math.abs(omega / targetOmega - 1)
        : 0;
    state.driveSpeedRatio = Math.max(
      ratio,
      state.driveSpeedRatio * driveDecay,
    );
  }

  // 45/45のコイルが針の動きをどう拾うか。既定は理想＝完全バイパス。
  const cartridge = createCartridge(sampleRate, IDEAL_CARTRIDGE);

  // RIAA再生特性。**時間領域の固定フィルタ**で、盤の速度では時定数を変えない。
  const playbackCurve = riaaPlayback(sampleRate);
  const riaaLeft = createBiquadState();
  const riaaRight = createBiquadState();

  function silence(
    outLeft: Float32Array,
    outRight: Float32Array,
    offset: number,
    frames: number,
  ): void {
    outLeft.fill(0, offset, offset + frames);
    outRight.fill(0, offset, offset + frames);
    // 針が溝から離れている以上、次に戻ったときの差分は繋がらない。
    primed = false;
    // 厳密な無音を保つためにイコライザーの余韻も切る。低域の時定数は3.2msなので、
    // 切り落とすのはその程度の尾だけ。カートリッジの共振も同じ理由で落とす。
    //
    // **ハムが混入しているときは落とさない。** そちらはこの後もカートリッジと
    // RIAA を通り続けるので、状態を毎チャンク潰すとブロック長の周期で段差が出る。
    // 代わりに `writeHum` がゼロ入力で進めるので、機械共振は自然に減衰する。
    if (hum.bypassed) {
      resetBiquadState(riaaLeft);
      resetBiquadState(riaaRight);
      cartridge.reset();
    }
    // 溝から離れた針に接触の記憶は無い。次に降ろしたときは着地から始まる。
    stylus.reset();
    // アームも同じ。いま針の下にある盤面へ置き直すので、降ろし直した最初の
    // サンプルが「盤面が一気に動いた」ようには見えない。
    armVertical.reset(state.surfaceHeight);
    // 構造の残響も落とす。溝から離れた針に伝わる先は無い。
    rumble.reset();
  }

  const state: DeckEngineState = {
    motor: { angle: 0, angularVelocity: 0 },
    phiUnwrapped: 0,
    phiWrapped: 0,
    revolutions: 0,
    programCursor: Number.NaN,
    stylusRadius: GROOVE.leadInRadius,
    cutRegion: "lead-in",
    contact: false,
    omega: 0,
    motorState: "stopped",
    zone: "outside",
    layout: null,
    recordRadius: GROOVE.leadInRadius,
    recordAngle: 0,
    surfaceHeight: 0,
    mistracking: false,
    contactLossSamples: 0,
    driveWowTorque: 0,
    driveFlutterTorque: 0,
    driveCommutationRippleTorque: 0,
    driveSpeedRatio: 0,
  };

  let groove: GrooveBuffer | null = null;

  /**
   * アームを掴んで動かしている間の位置。**シーク経路その1。**
   *
   * 針を降ろした瞬間（`seekFromRadius`）とここだけが、半径をカーソルへ効かせる。
   * それ以外で半径から引き直してはならない — 呼んだ瞬間に、螺旋が動かしたアームが
   * カーソルを動かし返す帰還ループになる。
   *
   * 針の下にある溝は、**盤面のどこにいるか**で決まる。螺旋は盤に刻まれているので、
   * 半径が「何周目か」を、盤面の角度が「その周のどこか」を決める。この2つで一意。
   *
   * ```
   *   周の中の位置 = −レコード座標の角度 / 2π
   *   周番号       = 半径が示す回転数のうち、その位置に一番近い整数
   * ```
   *
   * **半径だけからカーソルを引き直してはならない。** 腕を止めていても盤は回って
   * いるのに、ブロックごとに同じ場所へ戻るので、ブロック長の周期（48kHzなら375Hz）で
   * 同じ断片が繰り返される — ブザーそのものの音になる（実際に踏んだ）。腕を止めて
   * 押さえているだけなら、聞こえるのは普通の再生でなければならない。
   *
   * 溝を1本跨いだときだけ周番号が変わり、そこで位置が1周ぶん跳ぶ。跨いだ回数が
   * そのまま擦過音の粒になる（音そのものは未実装・audio-engine.md 10.3）。
   */
  function dragToRadius(record: RecordPoint, deltaPhi: number): void {
    if (state.layout === null) return;
    // 盤が正転すれば溝は前へ進む。カーソルと同じ向きに取るので符号は逆。
    // **レコード座標なので、偏心があればその揺れもここに入っている。**
    const phase = -record.angle / TWO_PI;
    const next =
      Math.round(revolutionsAtRadius(state.layout, record.radius) - phase) + phase;
    // 溝を跨いだか、掴んだ瞬間か。それ以外は連続なので、差分を切らない。
    if (Math.abs(next - state.revolutions - deltaPhi / TWO_PI) > 0.25) {
      primed = false;
      stylus.reset();
    }
    state.revolutions = next;
  }

  /**
   * 針を降ろした瞬間のシーク。**シーク経路その2。**
   *
   * 半径だけを見る（周の中のどこかは見ない）。降ろした瞬間にどの溝の何処へ落ちるかは
   * 物理的には盤の向きで決まるが、ここを盤の向きに繋ぐと「同じ半径へ降ろせば同じ
   * 位置」という再現性が失われる。降りている間の位置は `dragToRadius` と積分が持つ。
   */
  function seekFromRadius(radius: number): void {
    if (state.layout === null) return;
    state.revolutions = revolutionsAtRadius(state.layout, radius);
    // 溝の別の場所へ跳んだので、直前の変位との差分は速度ではない。跳んだ量が
    // そのまま巨大なクリックになるのを防ぐ（着地の過渡音は接触モデルが作る）。
    primed = false;
    stylus.reset();
  }

  function renderChunk(
    input: DeckEngineInput,
    outLeft: Float32Array,
    outRight: Float32Array,
    offset: number,
    frames: number,
  ): void {
    // このチャンクが読む盤を一度だけ掴む。載せ替えはチャンクの途中では起きない。
    const disc = groove;
    const deltaSeconds = frames / sampleRate;

    // **Drive領域の速度変動。** モーターへ渡すのはトルク1項だけで、再生比にも
    // カーソルにも触らない。時間由来（wow / flutter）は音声クロックの絶対時刻で、
    // 回転角由来（転流リプル）は盤の角度で索引する ——**この2つを混ぜない**
    // （wowFlutter.ts）。理想設定ではここを通らず、1ビットも変わらない。
    const disturbance = wowFlutter.bypassed
      ? 0
      : wowFlutter.torqueAt(driveFrames / sampleRate, state.motor.angle);

    // 物理は既存のものをそのまま呼ぶ。MOTOR_TUNING も挙動も触らない。
    const previousWrapped = state.motor.angle;
    const output = stepPlatterMotor(state.motor, {
      deltaSeconds,
      motorRequested: input.motorRequested,
      targetRpm: input.targetRpm,
      handAngularVelocity: input.handAngularVelocity,
      externalTorque: disturbance,
    });
    state.motor.angle = output.angle;
    state.motor.angularVelocity = output.angularVelocity;
    state.motorState = output.state;

    // 盤が止まっていても時計は進む。**モーターを止めても外乱の位相が巻き戻らない**
    // ので、掛け直したときに同じところから続く。
    driveFrames += frames;
    reportDrive(input.targetRpm, output.angularVelocity, output.state);

    // stepPlatterMotor が返すのは 0〜2π へ畳んだ角度なので、増分は最短側で読む。
    // 1チャンクが π を跨がないことが前提: 128フレーム/48kHz で手の上限速度でも
    // 0.11 rad にしかならない。跨いだら符号を失うので、そのときは前進を捨てる
    // （音が飛ぶより止まるほうがまし）。
    const rawDelta = wrapToPi(output.angle - previousWrapped);
    const deltaPhi = Math.abs(rawDelta) >= MAX_CHUNK_RADIANS ? 0 : rawDelta;

    state.phiUnwrapped += deltaPhi;
    state.phiWrapped = wrapToTwoPi(state.phiUnwrapped);
    // 平均角速度。カーソル前進と同じ Δφ から作るので、両者は必ず整合する。
    state.omega = deltaPhi / deltaSeconds;
    // 盤という物体の上でどこにいるか。針が実際にある場所で判定する。
    state.zone = grooveZoneAt(
      input.armIntent === "user" ? input.stylusRadius : state.stylusRadius,
    );

    const layout = state.layout;
    const contact = input.stylusContact && disc !== null && layout !== null;

    // このチャンクの時計と回転角。**構造振動とハムはどちらもここから索引する**
    // ので、機械系が何も出さない経路（下）でも同じ値が使える。
    const secondsBase = (driveFrames - frames) / sampleRate;
    const secondsStep = 1 / sampleRate;
    const phiBase = state.phiUnwrapped - deltaPhi;
    const phiStep = deltaPhi / frames;
    /**
     * アーム位置。誘導ハムの強さが半径で変わる（hum.ts）。
     *
     * 掴まれている間は入力が正本。**螺旋が運んだ位置ではなく、アームが実際に
     * いるところ**でなければ、引きずっているあいだハムが動かない。
     */
    const radiusRatio =
      (input.armIntent === "user" ? input.stylusRadius : state.stylusRadius) /
      GROOVE.discRadius;

    /**
     * **電気ハムだけを書く。** 機械系が何も出さないときでも、コイルは磁界の中に
     * あり配線はフォノ段へ繋がったままなので、**針を上げても誘導は止まらない**。
     * ここが「盤を止めれば消えるもの」との決定的な違いである（hum.ts）。
     */
    const writeHum = (offsetInBlock: number, count: number): void => {
      for (let i = 0; i < count; i++) {
        hum.sample(
          secondsBase + secondsStep * i,
          radiusRatio,
          phiBase + phiStep * i,
        );
        // **鳴っている経路のうち、機械から先だけを通す。** 針は何も出していないが、
        // 機械共振は残っていれば鳴り止むまで進む（ゼロ入力で自然に減衰する）。
        cartridge.processMechanical(0, 0);
        cartridge.processElectrical(
          cartridge.left + hum.inductionLeft,
          cartridge.right + hum.inductionRight,
        );
        // **針が上がっていても段は同じ。** ハムは電気なので、フォノ段もライン段も
        // セーフティも通る（`levels.ts`）。ハムの大きさでは何も飽和しない。
        levels.input(
          cartridge.left + hum.cableLeft,
          cartridge.right + hum.cableRight,
        );
        levels.output(
          processBiquad(playbackCurve, riaaLeft, levels.left),
          processBiquad(playbackCurve, riaaRight, levels.right),
          hum.electronicsLeft,
          hum.electronicsRight,
        );
        outLeft[offsetInBlock + i] = levels.left;
        outRight[offsetInBlock + i] = levels.right;
      }
    };

    // **レコード座標へ移る。** ここから先、盤の上の話はすべてこの座標で行う
    // （盤面欠陥・反り・掴んでいる間の位置）。偏心が無ければ恒等写像で、
    // `radius` と `方位角 − 回転角` がそのまま出てくる。
    //
    // チャンクの両端で1回ずつ求め、間は補間する。角度も半径も1回転周期で滑らかに
    // 変わるだけなので、2.7msの間は直線で足りる。
    const azimuth = Number.isFinite(input.stylusAzimuth) ? input.stylusAzimuth : 0;
    const labRadius =
      input.armIntent === "user" ? input.stylusRadius : state.stylusRadius;
    const phiStart = state.phiUnwrapped - deltaPhi;
    recordPointAt(shape, labRadius, azimuth, phiStart, recordStart);
    recordPointAt(shape, labRadius, azimuth, state.phiUnwrapped, recordEnd);

    // 螺旋を進む。**1回転あたりの移動量は速度に依らない** — 速いか遅いか逆か
    // は Δφ の大きさと符号に出るだけで、1回転で進む距離は同じ。
    if (contact) {
      if (input.armIntent === "user") {
        // 掴まれている間だけ半径が入力。溝を横切って引きずられている状態。
        // **半径は周を選ぶだけで、周の中のどこかは盤の回転が決める**（下記）。
        dragToRadius(recordEnd, deltaPhi);
      } else {
        state.revolutions += deltaPhi / TWO_PI;
      }
    }

    // 針が降りた瞬間はシーク。ここと上の "user" 分岐が、半径がカーソルへ
    // 影響する唯一の経路（audio-engine.md 10.2）。
    if (contact && !state.contact) {
      seekFromRadius(input.stylusRadius);
      // 着地。**実際に落ちてきた速度**から過渡が出る（audio-engine.md 10.3）。
      // 理想の針なら何も起きない。
      stylus.land(input.landingSpeed);
    }
    state.contact = contact;

    if (layout !== null) {
      // ロックドグルーブより先へは進めない。螺旋がそこで終わっているので、
      // 針は同じ溝を回り続ける（外へ出るには持ち上げるしかない）。
      state.revolutions = Math.min(
        Math.max(state.revolutions, layout.leadInRevolutions),
        layout.lockedRevolutions,
      );
      state.cutRegion = cutRegionAt(layout, state.revolutions);
      // **follow 中はここがアーム位置の正本。** メインスレッドはこの半径へ
      // アームを合わせるだけで、逆向きには一切効かない。
      //
      // 螺旋が決めるのは**レコード座標の**半径なので、アームを合わせる先は
      // ワールドの半径へ戻したもの。偏心があれば1回転周期で±offset 揺れる
      // ——これがアームの左右揺れそのものである。
      state.stylusRadius = labRadiusFor(
        shape,
        radiusAtRevolution(layout, state.revolutions),
        azimuth,
        state.phiUnwrapped,
      );
      // **偏心のぶんを足したものが、実際に読んでいる位置。** 螺旋が運んだ位置に
      // 対して1回転周期で前後する — これが wow の正体で、ω は動いていない。
      const cursor = cursorAtRevolution(layout, state.revolutions);
      state.programCursor =
        cursor === null
          ? Number.NaN
          : cursor - (recordEnd.wobble * layout.samplesPerRevolution) / TWO_PI;
    }

    // レコード座標のテレメトリ。盤面描画と音声が同じ点を指せるようにする。
    state.recordRadius = recordEnd.radius;
    state.recordAngle = wrapToTwoPi(recordEnd.angle);
    state.surfaceHeight = warpHeightAt(shape, recordEnd.radius, recordEnd.angle);

    const cursorStart = state.programCursor;
    const silent =
      disc === null ||
      layout === null ||
      !contact ||
      state.cutRegion !== "program" ||
      !Number.isFinite(cursorStart);

    if (silent) {
      // 針が上がっている・盤が無い・演奏領域の外。**機械系は無条件で厳密な無音**
      // で、残響も落とす（溝から離れた針に伝わる先は無い）。
      silence(outLeft, outRight, offset, frames);
      // 溝に触れていない針は「追えていない」のではない。区別する。
      state.mistracking = false;
      // **針が上がったら、溜めかけの摩耗を場へ落とす。** 次に降りたときは別の通過。
      wear.flush();
      // **電気ハムはそれとは別。** 針を上げても混入は止まらない。
      if (!hum.bypassed) writeHum(offset, frames);
      return;
    }

    /**
     * **無音の fast-path。**
     *
     * 「ω = 0 なら無音」ではない。針が出すのは変位の時間変化なので、無音になるのは
     * **何も動いていないとき**であって、盤が止まっていることそのものではない。
     * ω = 0 で溝・盤面欠陥・軸受けランブルが消えるのは、どれも盤の位置で索引されて
     * いて値が変わらなくなるからで、ゲートで切っているのではない。一方モーター振動は
     * 時計で進むので、START のまま盤を押さえれば止まっていても針はそれを読む。
     *
     * **ただし「新しい励振が無い」だけでは早く切りすぎる。** 反りを追っている
     * アーム、着地したカンチレバー、カートリッジの共振、RIAA の尾——どれも励振が
     * 止まった後もしばらく動いており、そこで打ち切ると尾が消える。
     *
     * 判定は2つ。
     *
     * 1. **新しい励振が無い**: `deltaPhi === 0` かつ構造も励振されていない。
     * 2. **どの状態も整定済み**: 直前のチャンクが**1サンプルも 0 以外を出さなかった**。
     *
     * 2 が効くのは、動いている状態は必ず出力に現れるからである — アームが動けば
     * 変位が変わり、カンチレバーやフィルタに残っていれば値が出る。だから
     * 「128サンプル続けて厳密に 0」は、**上流のどれも動いていないことの証明**に
     * なる（転置DF2のバイキャッドなら、入力 0 で出力 0 が続くことは状態が 0 で
     * あることそのものである）。段を増やしてもこの判定は書き換えなくてよい。
     *
     * `primed` を条件に入れているのは、状態が変わりうる操作（着地・シーク・盤や
     * パラメータの差し替え）がすべてそこを false にするため。**入れ替えた直後に
     * 古い「静か」を信じない**ための一手である。
     */
    if (
      quiescent &&
      primed &&
      deltaPhi === 0 &&
      // ハムは電気なので、盤が止まっていようと鳴り続ける。**混入しているなら
      // fast-path には入れない。**
      hum.bypassed &&
      !rumble.active(state.omega, input.motorRequested)
    ) {
      outLeft.fill(0, offset, offset + frames);
      outRight.fill(0, offset, offset + frames);
      state.mistracking = false;
      return;
    }

    const advance = cursorAdvanceForPhi(deltaPhi, layout.cutRpm, disc.sampleRate);
    const step = advance / frames;
    const last = disc.frames - 1;
    const [leftWall, rightWall] = disc.walls;
    // 帯域制限に効くのは「出力1サンプルあたり溝を何サンプル進むか」であって
    // 角速度比ではない。溝と出力でレートが違っても、これなら正しく効く。
    const rateAbs = Math.abs(step);

    // 変位の差分を「1秒あたり」に直す係数。溝と出力のレートが同じなら1で、
    // 公称速度なら差分がそのまま元の速度信号に戻る。
    const velocityScale = sampleRate / disc.sampleRate;

    // 溝上の位置はカーソルから割り戻す（カーソルは回転数の従属変数なので、別の
    // 積分器を持たずに済む）。盤面の座標はチャンクの両端から線形に割る。
    const revolutionsPerSample =
      layout.samplesPerRevolution > 0 ? 1 / layout.samplesPerRevolution : 0;
    const recordRadiusStep = (recordEnd.radius - recordStart.radius) / frames;
    const recordAngleStep = (recordEnd.angle - recordStart.angle) / frames;

    /**
     * 偏心がカーソルへ与えるずれ、サンプル数。
     *
     * **これが wow の正体。** 盤が一定の速さで回っていても、溝の中心がずれていれば
     * 針の下を溝が通る速さは1回転周期で変わる。ω は1ミリラジアンも動かさない。
     */
    const wobbleSamples = -layout.samplesPerRevolution / TWO_PI;
    // `programCursor` はチャンク末の揺れを織り込み済みなので、差だけを足す。
    const wobbleStart = (recordStart.wobble - recordEnd.wobble) * wobbleSamples;
    const wobbleStep = (recordEnd.wobble - recordStart.wobble) * wobbleSamples / frames;

    // 反りは盤面の高さ。溝と同じ「変位」なので、垂直方向として足す。
    const metresToUnits = disc.sampleRate / REFERENCE_WALL_VELOCITY;
    /** 変位1単位が表すメートル。針先の幾何はこれで実寸へ戻す。 */
    const unitsToMetres = 1 / metresToUnits;
    /**
     * 溝1サンプルが表す進行方向の距離 m。**カット時の線速度で決まる**ので、
     * 再生速度では変わらない（盤に刻まれた形は回し方に依らない）。
     * 内周ほど小さく、同じ距離により多くのサンプルが入る。
     */
    const cutOmegaForGeometry = rpmToRadPerSec(layout.cutRpm);
    const grooveMetresPerSample = (radius: number) =>
      (cutOmegaForGeometry * radius) / disc.sampleRate;

    /**
     * 溝サンプル1つぶん進んだときのレコード座標の角度変化。螺旋を1周ぶん辿れば
     * 角度は 2π 戻るので、符号は負。**針先が窓の中で埃や傷を横切れるのはこれが
     * あるからで**、無ければ窓の中ずっと同じ欠陥を見てしまう。
     */
    const recordAnglePerSample = -TWO_PI * revolutionsPerSample;

    // **針先が触れる局所盤面形状。** 溝と盤面の欠陥だけを返す —— 反り・偏心・
    // ランブル・ハムは入らない（`stylusTip.ts` の表）。生成は1チャンクに1回で、
    // 中身はサンプルごとに書き換える。
    localProfile.walls = disc.walls;
    localProfile.revolutionsPerSample = revolutionsPerSample;
    localProfile.anglePerSample = recordAnglePerSample;

    // **摩耗。** 減った盤を読むのにも、これから減らすのにも同じ半幅を使う。
    // 半幅は距離で決まるので、内周ほど広く撫でる（`wear.ts`）。
    const wearActive = !wear.bypassed;
    /** このサンプルで針が溝の上を進む実距離 m。**時間ではなく距離で溜まる。** */
    const metresPerStep = Math.abs(step + wobbleStep);
    /** 逆走。針は前向きに作られているので、戻すほうが削る。 */
    const reverse = step + wobbleStep < 0;


    /** このチャンクが1サンプルも 0 以外を出さなかったか。fast-path の入口条件。 */
    let chunkSilent = true;

    for (let i = 0; i < frames; i++) {
      const position = cursorStart + step * i + (wobbleStart + wobbleStep * i);
      if (position < 0 || position > last) {
        // 溝の端より先。走り切った盤に音は無い（ランアウトは未実装）。
        outLeft[offset + i] = 0;
        outRight[offset + i] = 0;
        primed = false;
        // 針も同じ扱い。ここを飛ばすと、戻ってきた最初のサンプルが巨大な
        // 加速度に見えて接触を失い、状態表示も浮いたままになる。
        stylus.reset();
        continue;
      }
      // 係数は1サンプルにつき一度だけ作り、両壁で共有する。カーソルも位相も
      // 左右で同じで、違うのは読む配列だけ。
      const recordRadius = recordStart.radius + recordRadiusStep * i;
      const recordAngle = recordStart.angle + recordAngleStep * i;

      // ── ① 局所盤面形状。**盤に固定された形だけ**がここに入る。 ───────────
      //
      // 切られた溝と、**盤面の欠陥は溝と同じ変位**なので同じ段にある。差分より
      // 手前にあることが「止まれば無音・逆走すれば逆順・強い欠陥は針を飛ばす」の
      // 全部を担っている（surface.ts）。何も無い盤ならこの分岐ごと通らない。
      resampler.prepare(position, rateAbs);
      let displacementLeft = resampler.sample(leftWall);
      let displacementRight = resampler.sample(rightWall);

      // **永久的な盤面**（表面粗さ・傷）はここ。摩耗はこれごと削る。**埃は取り
      // 分けて後で足す** —— 取り除ける異物は盤の形ではないので、削る相手にしない。
      let dustLeft = 0;
      let dustRight = 0;
      if (!surface.bypassed) {
        surface.sample(
          position * revolutionsPerSample,
          recordRadius,
          recordAngle,
        );
        displacementLeft += surface.permanentLeft;
        displacementRight += surface.permanentRight;
        dustLeft = surface.dustLeft;
        dustRight = surface.dustRight;
      }

      // ── ①b 摩耗による永久変形。**針が通った跡そのもの。** ─────────────────
      //
      // 出力へ掛けるEQではない。溜まっているのは「その場所がどれだけ削れたか」で、
      // 形は読むたびにここで作る —— 曲率のきついところだけが丸まる（`wear.ts`）。
      // 足すのは点で読む針との**差**なので、減っていない盤では厳密に 0 で、
      // 帯域制限された本読みが1ビットも変わらない。
      const wearHalf =
        wearActive && recordRadius > 0
          ? wear.smoothingRadius / grooveMetresPerSample(recordRadius)
          : 0;
      let sharpLeft = 0;
      let sharpRight = 0;
      if (wearHalf > 0) {
        localProfile.radius = recordRadius;
        localProfile.angle = recordAngle;
        localProfile.permanentAt(position, 0);
        const centreLeft = localProfile.left;
        const centreRight = localProfile.right;
        localProfile.permanentAt(position + wearHalf, wearHalf);
        const aheadLeft = localProfile.left;
        const aheadRight = localProfile.right;
        localProfile.permanentAt(position - wearHalf, -wearHalf);
        // 局所の鋭さ。**削る量にも、削れた形にも同じ Δ² が効く。**
        sharpLeft = localProfile.left + aheadLeft - 2 * centreLeft;
        sharpRight = localProfile.right + aheadRight - 2 * centreRight;
        if (wear.worn) {
          wear.severityAt(position);
          displacementLeft += wearRounding(
            wear.left,
            wearHalf,
            localProfile.left,
            centreLeft,
            aheadLeft,
          );
          displacementRight += wearRounding(
            wear.right,
            wearHalf,
            localProfile.right,
            centreRight,
            aheadRight,
          );
        }
      }

      // ── ①c 埃。**取り除ける異物**なので、摩耗の後に乗る。 ─────────────────
      displacementLeft += dustLeft;
      displacementRight += dustRight;

      // ── ② 有限な針先による空間サンプリング。 ───────────────────────────
      //
      // 丸い針先は自分より曲率のきつい谷へ入れないので、山はそのまま残り谷だけが
      // 浅くなる（`stylusTip.ts`）。**撫でる相手は①だけ** — 埃も傷も針先半径で
      // 丸められ、それでも大きければ丸められた後で接触を失う。
      //
      // 返るのは点で読む針との**差**なので、理想の針では厳密に 0 で、既存の
      // 帯域制限読み出しがそのまま残る。窓の幅は**距離**で決まっているのに1
      // サンプルが表す距離は線速度で決まるので、内周ほど広い範囲を覆う
      // ——**内周歪みはここから自動的に出る。**
      if (!tip.bypassed) {
        localProfile.position = position;
        localProfile.radius = recordRadius;
        localProfile.angle = recordAngle;
        // 針先が撫でるのは**摩耗した後の形**。減っていない盤では 0 で、窓の中の
        // 読みは以前と1ビットも変わらない。
        localProfile.wearHalf = wear.worn ? wearHalf : 0;
        tip.read(
          localProfile,
          grooveMetresPerSample(recordRadius),
          unitsToMetres,
        );
        displacementLeft += tip.left;
        displacementRight += tip.right;
        // pinch は垂直方向なので逆相へ。溝と同じ変位なので差分より手前に足す。
        const pinch = tip.vertical * Math.SQRT1_2;
        displacementLeft += pinch;
        displacementRight -= pinch;
      }

      // ── ③ 相対変位。**盤や機構全体の運動で、盤の上の形ではない。** ─────────
      //
      // 針先の窓を通した**後**に足す。ここを①に混ぜると、盤が上下しただけで高域が
      // 失われるという実機に無い挙動になる（`stylusTip.ts` の表）。

      // **反り**: 盤面の高さは垂直方向の変位そのもの。1サンプルごとに引く —
      // チャンク単位で補間すると、その段差がブロック長の周期で聞こえてしまう。
      //
      // ただし**コイルが拾うのは盤面の高さではなく、アームが追従し切れずに
      // カンチレバーへ残ったぶん**である。反りの帯域（0.55〜1.1Hz）は縦共振の
      // はるか下なので、実効質量のあるアームは付いていってしまい、ほとんど何も
      // 残さない（tonearm.ts）。理想のアームでは全量がそのまま返るので、この
      // 経路を入れる前と1ビットも変わらない。
      if (!discIsFlat) {
        armVertical.step(
          warpHeightAt(shape, recordRadius, recordAngle),
          armStepSeconds,
        );
        const vertical =
          armVertical.deflection * metresToUnits * Math.SQRT1_2;
        displacementLeft += vertical;
        displacementRight -= vertical;
      }

      // **ランブル**: 構造を伝わった振動の、盤とカートリッジ本体の**相対変位**。
      // 出力へ足すノイズではないので、ここ——差分と接触モデルより前——に置く。
      // 針が実際に揺すられている以上、大きければ追従限界も食う（rumble.ts）。
      if (!rumble.bypassed) {
        rumble.sample(
          secondsBase + secondsStep * i,
          phiBase + phiStep * i,
          state.omega,
          input.motorRequested,
        );
        // 45/45 の関係の逆。**垂直の擾乱は逆相として出る**（surface.ts と同じ）。
        const lateral = rumble.lateral * metresToUnits;
        const vertical = rumble.vertical * metresToUnits;
        displacementLeft += (lateral + vertical) * Math.SQRT1_2;
        displacementRight += (lateral - vertical) * Math.SQRT1_2;
      }

      if (!primed) {
        previousLeft = displacementLeft;
        previousRight = displacementRight;
        primed = true;
      }

      // **カートリッジ**: 針は溝の変位ではなく、その時間変化を電圧にする。
      // ここに ω を掛けたりはしない — 速く通れば変位の差分がそのぶん大きくなる
      // ので、速度依存は差分そのものから出る。止まれば差は0、逆走すれば符号が
      // 反転する。分岐は要らない（audio-engine.md 5.1）。
      const velocityLeft = (displacementLeft - previousLeft) * velocityScale;
      const velocityRight = (displacementRight - previousRight) * velocityScale;
      previousLeft = displacementLeft;
      previousRight = displacementRight;

      // **接触**: その加速度に針が付いていけるか。付いていける溝では素通しなので、
      // 追えるうちは音が1ビットも変わらない（stylus.ts）。
      stylus.process(velocityLeft, velocityRight);

      // ── 摩耗の蓄積。**読み終わってから削る。** ─────────────────────────────
      //
      // ここで足したぶんは**次の通過から**効く（同じセルの中にいる間は溜めておき、
      // セルを離れるときに落とす）。無次元化は `smoothingRadius` を基準にする
      // ——鋭さも追い切れなさも「摩耗が撫でる大きさに対してどれだけか」で効く。
      if (wearActive && metresPerStep > 0) {
        const spatial = grooveMetresPerSample(recordRadius);
        const scale = unitsToMetres / wear.smoothingRadius;
        wear.accumulate(
          position,
          metresPerStep * spatial,
          WEAR_CELL_SAMPLES * spatial,
          stylusParameters.trackingForce,
          reverse,
          Math.abs(sharpLeft) * scale,
          Math.abs(sharpRight) * scale,
          tip.bypassed ? 0 : Math.abs(tip.left) * scale,
          tip.bypassed ? 0 : Math.abs(tip.right) * scale,
          stylus.airborneLeft,
          stylus.airborneRight,
        );
      }

      // 45/45のコイルが拾う。理想設定ならビット単位で素通しする。**機械応答と
      // 電気負荷を分けて呼ぶ**のは、その間に誘導ハムが入るから（cartridge.ts）。
      cartridge.processMechanical(stylus.left, stylus.right);

      // **電気ハム**: 溝の変位には混ぜない（機械ではないので、盤を止めても針を
      // 上げても消えない）。注入点は3つあり、**どの段より前かで受けるものが違う**
      // ——誘導は電気負荷と RIAA の両方を、配線とアースループは RIAA だけを受け、
      // フォノ段以後は何も受けない（hum.ts）。
      let coilLeft = cartridge.left;
      let coilRight = cartridge.right;
      if (!hum.bypassed) {
        hum.sample(
          secondsBase + secondsStep * i,
          radiusRatio,
          phiBase + phiStep * i,
        );
        coilLeft += hum.inductionLeft;
        coilRight += hum.inductionRight;
      }

      // コイルの負荷共振。針が動かした電圧と誘導された電圧を区別しない。
      cartridge.processElectrical(coilLeft, coilRight);

      let cableLeft = cartridge.left;
      let cableRight = cartridge.right;
      if (!hum.bypassed) {
        cableLeft += hum.cableLeft;
        cableRight += hum.cableRight;
      }

      // **フォノ段の入力。** RIAA より前なので高域が持ち上がったままで、傷や
      // ミストラッキングの尖りが飽和するのはここである（`levels.ts`）。基準設定の
      // 音楽では閾値に届かず、1ビットも変わらない。
      levels.input(cableLeft, cableRight);

      // RIAA再生特性。**出力の時間軸**で回す固定フィルタなので、盤が公称速度から
      // 外れれば録音特性と噛み合わなくなる。その音色変化は実機と同じ理由で出る。
      const riaaOutLeft = processBiquad(playbackCurve, riaaLeft, levels.left);
      const riaaOutRight = processBiquad(playbackCurve, riaaRight, levels.right);

      // フォノ段のゲイン → ライン出力 → セーフティ段。**反りのような低域が
      // 振り切るのはここ**で、電気ハムはゲインの後に混じる。
      levels.output(
        riaaOutLeft,
        riaaOutRight,
        hum.bypassed ? 0 : hum.electronicsLeft,
        hum.bypassed ? 0 : hum.electronicsRight,
      );
      const outputLeft = levels.left;
      const outputRight = levels.right;
      outLeft[offset + i] = outputLeft;
      outRight[offset + i] = outputRight;
      // 動いている状態は必ずここに出る。1サンプルでも 0 以外が出たなら、上流の
      // どれかがまだ動いているということ — fast-path はまだ使えない。
      if (outputLeft !== 0 || outputRight !== 0) chunkSilent = false;
    }
    // このチャンクが厳密に無音だったなら、上流の状態はもう落ちている。
    quiescent = chunkSilent;
    // 接触の状態はサンプル単位で決まるので、ブロックの終わりの姿を報告する。
    // 累計のほうはブロックの切り方に依らない（`reset` は累計を消さない）。
    state.mistracking = stylus.airborne;
    state.contactLossSamples = stylus.contactLossSamples;
    // カーソルは回転数から導かれる従属変数なので、ここでは進めない。
  }

  return {
    state,

    setCartridge(parameters) {
      cartridge.configure(parameters);
      // 特性が変わったので、直前の変位との差分も引き直す。
      primed = false;
    },

    setStylusTip(parameters) {
      tip.configure(parameters);
      // 読む値が変わる。直前の変位との差分は速度ではない。
      primed = false;
    },

    setStylus(parameters) {
      stylusParameters = parameters;
      stylus.configure(parameters);
      // ばねが変わればアームの共振も変わる。**同じ compliance 1本から引く。**
      armVertical.configure(armParameters, parameters);
      primed = false;
    },

    setTonearm(parameters) {
      armParameters = parameters;
      armVertical.configure(parameters, stylusParameters);
      primed = false;
    },

    setWowFlutter(parameters) {
      // 角度も速度も触らない。**トルクが変わるだけ**なので、掛け替えた瞬間に
      // 盤が跳ぶことはない。時計も戻さない（同じモーターが回り続けている）。
      wowFlutter.configure(parameters);
    },

    setRumble(parameters) {
      rumble.configure(parameters);
      // 構造が変われば読む変位も変わる。直前の値との差分は速度ではない。
      primed = false;
    },

    setHum(parameters) {
      hum.configure(parameters);
      // 溝の変位には触っていないので `primed` は落とさない。fast-path の入口は
      // `hum.bypassed` を見ているので、混入し始めればそこで自動的に外れる。
      quiescent = false;
    },

    setDiscShape(parameters) {
      shape = parameters;
      discIsFlat = isFlatDisc(parameters);
      // 盤の形が変われば読む変位も変わる。直前の値との差分は速度ではない。
      primed = false;
      // 平らな盤ではアームを進めないので、置いたままの高さが残る。次の盤面へ
      // 揃え直す（残っていると、反った盤へ替えた瞬間に段差として出る）。
      armVertical.reset(state.surfaceHeight);
    },

    setSurface(parameters) {
      surfaceParameters = parameters;
      surface.configure(
        parameters,
        state.layout,
        groove === null ? sampleRate : groove.sampleRate,
      );
      // 盤面が変われば読んでいる変位も変わる。直前の値との差分は速度ではない。
      primed = false;
    },

    setLevels(parameters) {
      levels.configure(parameters, sampleRate);
      // 段の記憶（低域フィルタとセーフティ）が落ちる。直前の値との差分は速度ではない。
      primed = false;
    },

    levelTelemetry: () => levels.telemetry,
    resetLevelMeters: () => levels.resetMeters(),

    setWear(parameters) {
      wear.flush();
      wear.configure(parameters);
      // **溜まった摩耗は消さない。** 進み方を変えただけで、盤は減ったままである。
      primed = false;
    },

    resetWear() {
      wear.reset();
      primed = false;
    },

    wearSummary: () => wear.summary,
    wearField: () => wear.field,

    loadGroove(next, layout) {
      groove = next;
      // **切った側が決めた割り付けをそのまま使う。** 無ければ一定ピッチで作る
      // （長さとカット速度だけで決まるので、こちら側でも同じものが作れる）。
      state.layout =
        next === null
          ? null
          : (layout ??
            createCutLayout(next.durationSeconds, next.sampleRate));
      // 螺旋の形が変われば、盤面のどこを通るかも変わる。欠陥そのものは (半径・角度)
      // に固定されたままで、seed が同じなら同じ盤である。
      surface.configure(
        surfaceParameters,
        state.layout,
        next === null ? sampleRate : next.sampleRate,
      );
      // **別の盤には別の摩耗がある。** 長さが同じなら場は作り直さないので、
      // 同じ盤を切り直した（`setDeckCutting` など）ときは減ったまま残る。
      wear.load(next === null ? 0 : next.frames, state.layout);
      // 新しい盤の上に古い位置は無い。次に針を降ろすまで鳴らない。
      state.revolutions = 0;
      state.programCursor = Number.NaN;
      state.stylusRadius = GROOVE.leadInRadius;
      state.cutRegion = "lead-in";
      state.contact = false;
      state.mistracking = false;
      primed = false;
      stylus.reset();
      armVertical.reset(state.surfaceHeight);
      rumble.reset();
      resetBiquadState(riaaLeft);
      resetBiquadState(riaaRight);
      // 段の記憶だけ落とす。**計測の累計は消さない** —— 盤を替えたことと、
      // それまでに何回飽和したかは別の話である。
      levels.reset();
    },

    process(input, outLeft, outRight) {
      const frames = Math.max(
        0,
        Math.min(
          Number.isFinite(input.frames) ? Math.floor(input.frames) : 0,
          outLeft.length,
          outRight.length,
        ),
      );

      let done = 0;
      while (done < frames) {
        const chunk = Math.min(PHYSICS_CHUNK_FRAMES, frames - done);
        renderChunk(input, outLeft, outRight, done, chunk);
        done += chunk;
      }
    },
  };
}
