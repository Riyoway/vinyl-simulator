/**
 * レベル校正とオーバーロード — **溝の振れと、出ていく数字を結ぶ。**
 *
 * ```
 *   cartridge mechanical output（溝の単位）
 *      → カートリッジ感度による電圧化        mV/(cm/s) の1点で物理量へ結ぶ
 *      → カートリッジ／ケーブル負荷           `cartridge.ts` の電気負荷
 *      → フォノ段の入力                      **クリックとミストラッキングが飽和するのはここ**
 *      → RIAA 再生特性                       `riaa.ts`
 *      → フォノ段のゲイン                     ここまでが**物理**（ライン基準 1.0）
 *      → ライン出力                          **反りと低域が飽和するのはここ**
 *      → デジタル出力の校正                   **ライン基準を dBFS のどこへ置くか**
 *      → 透過セーフティ段                     通常は1ビットも触らない。最後の砦
 * ```
 *
 * **ユーザー音量や将来のスピーカーゲインはここに入れない。** あれは聴く側の都合、
 * ここは盤と機械の話である。`digitalCalibrationDb` は**録音レベルの取り決め**で、
 * 鳴らすたびに動かすものではない。
 *
 * ## 基準は**3つある。混ぜてはならない**
 *
 * ```
 *   ① 物理基準   1kHz・横方向 5cm/s（標準カッティングレベル）＝ 溝の壁 1.0単位
 *   ② ライン基準 その盤がフォノ段から出す大きさ ＝ 1.0（＝ LINE_REFERENCE_VOLTS）
 *   ③ デジタル   ライン基準を dBFS のどこへ置くか ＝ **digitalCalibrationDb**
 * ```
 *
 * ①と②は**物理**であって、カートリッジの感度とフォノ段のゲインが決める。③は
 * **録音レベルの取り決め**で、物理には何の関係も無い —— ここを分けていないと
 * 「標準カッティングレベル＝フルスケール」になり、**普通の音楽が天井に張り付く**。
 *
 * | 量 | 基準での値 | どこで決まるか |
 * |---|---|---|
 * | 溝の変位 1単位 | 0.737µm（48kHz） | `REFERENCE_WALL_VELOCITY / grooveSampleRate` |
 * | 溝の壁の速度 1単位 | 3.54cm/s（片壁） | `REFERENCE_WALL_VELOCITY`（`stylus.ts`） |
 * | 横方向の速度 | 5cm/s（両壁が同相） | 上の √2 倍 |
 * | カートリッジ出力 | 25mV | 横方向 5cm/s × 感度 |
 * | **ライン出力** | **1.0**（＝ライン基準） | フォノ段のゲイン 32.04dB。**ここまでが物理** |
 * | **デジタル出力** | **−6 dBFS** | `digitalCalibrationDb`。**ここからが取り決め** |
 *
 * つまり **0 dBFS は横方向 10cm/s** にあたる。実機のカッティングでもピークは
 * 5cm/s の 2〜3倍まで振れるので、この置き方は実際の盤と同じ余裕になる。
 *
 * ## なぜ 5cm/s を 0 dBFS へ置いてはならないか（実測）
 *
 * RIAA の録音→再生は**振幅では戻るが位相は戻らない**。マスタリングで潰された
 * クレストがその位相回転で作り直されるので、**RMS はそのままピークだけが上がる**。
 *
 * | マスターの詰め方 | 素材 crest | RMS の変化 | **ピークの変化** |
 * |---|---|---|---|
 * | 緩い | 7.0dB | −0.05dB | **+0.23dB** |
 * | 標準 | 5.2dB | −0.15dB | **+1.46dB** |
 * | 強い | 3.5dB | −0.32dB | **+2.55dB** |
 * | 極端 | 2.5dB | −0.47dB | **+3.13dB** |
 *
 * 単一の正弦では起きない（全帯域で ≤ 0dB）。**密な音楽でだけ起きる**ので、
 * 正弦だけで較正すると必ず取りこぼす。実測の最大 +3.13dB に対して
 * `digitalCalibrationDb = −6dB` を置き、セーフティの天井は −1dBFS —— 通常音楽の
 * 最悪でも天井の **1.9dB 下**に収まる。
 *
 * ## 飽和は「実際に過大を受けた段」だけ
 *
 * 段ごとに見ている量が違うので、何が来たかで**飽和する段が変わる**。
 *
 * | 何が来たか | どの段が受けるか | なぜ |
 * |---|---|---|
 * | 傷・クリック | **フォノ段の入力** | RIAA より前は高域が持ち上がったまま。実機のプリアンプが tick で詰まるのと同じ |
 * | ミストラッキング | **フォノ段の入力** | 壁から離れた針が出す速度の跳ね |
 * | 反り・低域 | **ライン出力** | RIAA の後は低域が持ち上がる。振り切るのは出力段 |
 * | ハム | どこも飽和しない | 小さいので、混ざるだけ |
 *
 * **どの段も、閾値より下では厳密に素通しである。** 常時掛かる waveshaper は1つも
 * 無く、飽和した回数と量は telemetry に出る。
 *
 * ## 低域を黙って消さない
 *
 * DC も subsonic も**最終段では触らない**。反りが出す 0.55Hz は物理の結果であって、
 * 隠すものではない。取りたい人のために `rumbleFilterHz` を持つが、**既定は 0（無し）**
 * で、実機のプリアンプの rumble スイッチと同じく**明示的に入れたときだけ**効く。
 *
 * ## 数値について
 *
 * 感度もフォノ段のゲインも実在機種を名乗るものではない。既定の `REFERENCE_LEVELS`
 * は「標準カッティングレベルが 0 dBFS」という取り決めそのもので、そこでは
 * **利得 1・飽和ゼロ・セーフティ不動作**である。
 *
 * Web Audio にも Three.js にも依存しない。空間オーディオはライン出力が確定した後に
 * 繋ぐものなので、ここには入れない。
 */

import {
  createBiquadState,
  highPass,
  processBiquad,
  resetBiquadState,
  type Biquad,
} from "./riaa";

/* ------------------------------------------------------------------ *
 * 基準
 * ------------------------------------------------------------------ */

/** 標準カッティングレベルの横方向速度 cm/s。**すべての単位の起点。** */
export const REFERENCE_LATERAL_CM_PER_SEC = 5;

/**
 * ライン基準の電圧 V。**基準の盤（横5cm/s）がフォノ段から出す大きさ**で、
 * dBFS のどこへ置くかは別の話である（`digitalCalibrationDb`）。
 */
export const LINE_REFERENCE_VOLTS = 1;

/**
 * **デジタル出力の校正の既定 dB。** ライン基準（＝横5cm/s）を dBFS のどこへ置くか。
 *
 * −6dB は「**0 dBFS ＝ 横方向 10cm/s**」という取り決めで、実測した密なマスターの
 * ピーク復元（最大 +3.13dB）に対して天井まで 2.9dB、セーフティ（−1dBFS）まで
 * 1.9dB を残す。**0 にすれば従来どおり**（5cm/s ＝ 0 dBFS）。
 */
export const DIGITAL_CALIBRATION_DB = -6;

/** 溝の壁 1単位が出すカートリッジ電圧 V。 */
export const voltsPerGrooveUnit = (sensitivityMvPerCmPerSec: number) =>
  (REFERENCE_LATERAL_CM_PER_SEC * sensitivityMvPerCmPerSec) / 1000;

/**
 * そのカートリッジで基準の盤が **0 dBFS** になるフォノ段のゲイン dB。
 *
 * 出力の小さいカートリッジほど大きなゲインが要る、という当たり前のことを式に
 * したもの。**プリセットはこれで作る**ので、感度を変えても基準レベルは動かない
 * （動くのは入力側の余裕のほう）。
 */
export const phonoGainForReference = (sensitivityMvPerCmPerSec: number) =>
  20 *
  Math.log10(LINE_REFERENCE_VOLTS / voltsPerGrooveUnit(sensitivityMvPerCmPerSec));

/* ------------------------------------------------------------------ *
 * パラメータ
 * ------------------------------------------------------------------ */

export interface LevelParameters {
  /** カートリッジの感度 mV/(cm/s)（1kHz・横方向）。MM は 4〜6、MC は 0.2〜0.5。 */
  cartridgeSensitivity: number;
  /** フォノ段のゲイン dB（1kHz）。 */
  phonoGainDb: number;
  /**
   * フォノ段の入力が飽和する電圧 mV（ピーク）。**RIAA より前**なので、高域の
   * 尖ったものほどここへ効く。**無限で無し。**
   */
  inputOverloadMv: number;
  /**
   * ライン出力段の余裕 dB（0 dBFS から上へ）。ここを超えると出力段が飽和する。
   * **無限で無し。**
   */
  outputHeadroomDb: number;
  /**
   * 低域を切るフィルタ Hz。**0 で無し（既定）。** 実機のプリアンプの rumble
   * スイッチと同じで、**入れたときだけ**効く。物理段（反り・ランブル）はこれとは
   * 無関係に動く。
   */
  rumbleFilterHz: number;
  /**
   * **ライン基準を dBFS のどこへ置くか。** 物理には触らない取り決めで、感度と
   * フォノ段のゲインの積（＝ライン基準まで）は1dBも動かさない。
   *
   * **0 なら従来どおり**（横5cm/s ＝ 0 dBFS）で、出力はビット単位で一致する。
   * **ユーザー音量ではない。**
   */
  digitalCalibrationDb: number;
  /**
   * 最後のセーフティ段が働き始める dBFS。**0 未満に保つこと** —— 0 に置くと
   * destination のハードクリップと同じ位置になり、守る意味が無い。
   * ここより下では1ビットも触らない。
   */
  safetyCeilingDbfs: number;
  /** セーフティ段が戻る時定数 秒。 */
  safetyReleaseSeconds: number;
}

/**
 * **基準の設定。** 標準カッティングレベルが 0 dBFS で、利得の積は厳密に 1。
 *
 * この設定では入力もラインもセーフティも1度も働かず、**この段を入れる前と出力が
 * ビット単位で一致する**。
 */
export const REFERENCE_LEVELS: LevelParameters = {
  /** 標準的なMM。 */
  cartridgeSensitivity: 5,
  /** 25mV を 1.0 へ。**利得の積がちょうど 1 になる値。** */
  phonoGainDb: phonoGainForReference(5),
  /**
   * 200mV ピーク（≒141mV rms）。よくあるMMフォノ段の規格の桁である。
   *
   * 基準の盤（25mV）に対して **+18dB**、フルスケールの 10kHz（約120mV）でも
   * まだ 4.4dB 残る —— **音楽では飽和せず、深い傷でだけ詰まる。**
   */
  inputOverloadMv: 200,
  /** +12dB。**低域が振り切るのはここ**だが、普通の盤では届かない。 */
  outputHeadroomDb: 12,
  /** 既定は無し。**低域を黙って消さない。** */
  rumbleFilterHz: 0,
  /** 横5cm/s を −6dBFS へ。**0 dBFS ＝ 横10cm/s。** */
  digitalCalibrationDb: DIGITAL_CALIBRATION_DB,
  /**
   * −1dBFS。**フルスケールの手前**に置く —— 0 dBFS に置くと destination の
   * ハードクリップと同じ位置になり、守っていることにならない。通常音楽の最悪
   * （−2.9dBFS）から 1.9dB 上にあるので、**普通の盤では一度も働かない。**
   */
  safetyCeilingDbfs: -1,
  safetyReleaseSeconds: 0.05,
};

/** 選べるレベル設定。**この並びがそのまま UI の並びになる。** */
export const LEVEL_PRESETS = [
  { name: "reference", label: "Reference (MM, unity)" },
  { name: "hot", label: "Hot phono stage (+6dB)" },
  { name: "low-output", label: "Low-output MC + high gain" },
] as const;

export type LevelPresetName = (typeof LEVEL_PRESETS)[number]["name"];

export function levelParametersFor(name: LevelPresetName): LevelParameters {
  switch (name) {
    case "reference":
      return REFERENCE_LEVELS;

    /**
     * **ゲインを 6dB 上げただけ。** 盤も針も同じなので、変わるのは出ていく大きさと
     * 出力段の余裕だけ —— 入力側の余裕は1dBも変わらない（あちらはゲインより前）。
     */
    case "hot":
      return {
        ...REFERENCE_LEVELS,
        phonoGainDb: REFERENCE_LEVELS.phonoGainDb + 6,
      };

    /**
     * **出力の小さいMCへ、それに見合ったゲインを掛けた組み合わせ。** 基準レベルは
     * 同じ 0 dBFS に戻るが、**入力側の余裕は大きく増える**（同じ 200mV の入力段に
     * 2mV しか入らないので）。実機で MC がクリックに強いのはこれである。
     */
    case "low-output": {
      const sensitivity = 0.4;
      return {
        ...REFERENCE_LEVELS,
        cartridgeSensitivity: sensitivity,
        phonoGainDb: phonoGainForReference(sensitivity),
      };
    }
  }
}

/* ------------------------------------------------------------------ *
 * 計測
 * ------------------------------------------------------------------ */

/** DEV表示と検証が読む値。**すべて数値で、そのまま telemetry へ乗る。** */
export interface LevelTelemetry {
  /** 出ていく信号のピーク（線形・両ch の大きいほう）。PPM と同じ速さで落ちる。 */
  peak: number;
  /**
   * サンプル間まで見たピーク（線形）。**4点補間を3つの中間位置で見た推定**で、
   * BS.1770 の 4倍オーバーサンプルそのものではない（下の注記）。
   */
  truePeak: number;
  /** 実効値（線形・300ms の指数平均）。 */
  rms: number;
  /** フォノ段の入力のピーク mV。**クリックが見えるのはここ。** */
  inputPeakMv: number;
  /** セーフティ段より前のライン出力のピーク（線形）。 */
  linePeak: number;
  /** 段ごとの飽和**サンプル数**の累計。**決定論的。** */
  inputOverloads: number;
  outputOverloads: number;
  /**
   * **いま**セーフティ段が削っている量 dB（0 なら不動作）。
   *
   * 最大値ホールドと分けてあるのが要点である —— 混ぜると「一度 −6dB まで下がった」
   * と「いま −6dB 下がっている」が区別できず、**常時掛かっているように見える**。
   */
  safetyReductionDb: number;
  /** その最大値。`resetMeters` を呼ぶまで下がらない（**明示的なリセット**）。 */
  safetyMaxReductionDb: number;
  /**
   * **実効作動時間率**（0〜1）。`resetMeters` からの累計で、
   * 「削っていたサンプル ÷ 通したサンプル」。
   *
   * **作動の判定は `gain !== 1` ではない。** 1極のリリースは厳密な 1 へ 1.3秒
   * かからないと戻らないので、その尾まで数えると 0.6% の過大が 100% に見える。
   * **0.01dB を超えて削っているときだけ**作動と数える（`SAFETY_ACTIVE_DB`）。
   */
  safetyDutyRatio: number;
  /**
   * **作動イベント数。** 不動作から作動へ移った回数で、サンプル数ではない。
   * 「1回の過大」が 1 と数えられる。
   */
  safetyEvents: number;
  /** 上2つの分母。通したサンプル数の累計。 */
  processedSamples: number;
}

/**
 * ピークの落ち方 dB/s。放送用ピークメーターの慣習に合わせてある（速く上がって
 * ゆっくり落ちる）。**計測だけの話で、音には触らない。**
 */
const PEAK_FALL_DB_PER_SECOND = 20;
/** 実効値の指数平均の時定数 秒。 */
const RMS_SECONDS = 0.3;

/**
 * **ここを超えて削っているときだけ「作動」と数える** dB。
 *
 * 0.01dB は可聴限界のはるか下で、リリースの尾（1極なので厳密な 1 へは戻らない）を
 * 作動として数えないための境目である。**音には一切関係しない** —— 削る量そのものは
 * 尾まで含めてそのまま掛かる。
 */
const SAFETY_ACTIVE_DB = 0.01;
const SAFETY_ACTIVE_GAIN = Math.pow(10, -SAFETY_ACTIVE_DB / 20);

/**
 * 4点補間の係数（Catmull-Rom）を 1/4・1/2・3/4 で評価したもの。
 *
 * ponytail: BS.1770 の 4倍オーバーサンプルは 48タップ要る。ここは**3点だけ**なので
 * ナイキスト近くの跳ね上がりは拾い切れず、**下振れの推定**である。正確な true peak
 * が要るようになったら、この表を windowed-sinc の位相表へ差し替えること。
 */
const INTERPOLATION = [
  // t = 0.25, 0.5, 0.75 での [x−1, x0, x1, x2] の重み
  [-0.0703125, 0.8671875, 0.2265625, -0.0234375],
  [-0.0625, 0.5625, 0.5625, -0.0625],
  [-0.0234375, 0.2265625, 0.8671875, -0.0703125],
] as const;

/* ------------------------------------------------------------------ *
 * 実装
 * ------------------------------------------------------------------ */

const clamp = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, low), high) : fallback;

const dbToLinear = (db: number) => Math.pow(10, db / 20);

/**
 * 限界に近づくほど連続的に潰す。**ハードクリップではない**（`cutterHead.ts` と
 * 同じ形で、閾値より下では厳密に 1）。
 */
function softGain(ratio: number, knee: number): number {
  if (!(ratio > knee)) return 1;
  const span = 1 - knee;
  if (!(span > 0)) return knee / ratio;
  return (knee + span * Math.tanh((ratio - knee) / span)) / ratio;
}

/** 飽和の膝。ここより下は1ビットも変わらない。 */
const SATURATION_KNEE = 0.8;

export interface OutputChain {
  /** 直近の段の出力。割り当てを避けるため、ここに書く。 */
  readonly left: number;
  readonly right: number;
  readonly telemetry: LevelTelemetry;
  /** 基準の盤（1kHz・横5cm/s）が出す電圧 mV。表示と検証が読む。 */
  readonly referenceMillivolts: number;
  /** 利得の積。**1 なら出力はビット単位で素通し。** */
  readonly netGain: number;
  configure(parameters: LevelParameters, sampleRate: number): void;
  /**
   * **フォノ段の入力。** RIAA より前に呼ぶ。
   *
   * 溝の単位のまま返す（電圧は判定と表示のためだけに作る）ので、飽和していない
   * 限り**入力がそのまま出てくる**。
   */
  input(left: number, right: number): void;
  /**
   * **RIAA の後。** 低域フィルタ（任意）→ フォノ段のゲイン → ライン出力 →
   * セーフティ段まで通し、計測もここで行う。
   *
   * @param humLeft フォノ段より後で混じる電気ハム。**ゲインの後に足す**ので、
   *   ゲインを上げてもこれは大きくならない（`hum.ts` の注入点の表）。
   */
  output(left: number, right: number, humLeft: number, humRight: number): void;
  /** 計測だけ 0 へ。**設定も音も触らない。** */
  resetMeters(): void;
  /** 段の記憶（低域フィルタとセーフティ）を落とす。盤の載せ替えとシーク。 */
  reset(): void;
}

export function createOutputChain(
  parameters: LevelParameters = REFERENCE_LEVELS,
  sampleRate = 48000,
): OutputChain {
  let millivoltsPerUnit = 0;
  let inputOverload = Number.POSITIVE_INFINITY;
  let lineCeiling = Number.POSITIVE_INFINITY;
  let safetyCeiling = 1;
  let safetyRelease = 0;
  /** ライン基準 → デジタル。**1 なら掛け算ごと飛ばす**（従来との一致）。 */
  let calibration = 1;
  /** 作動イベントの立ち上がり検出。 */
  let safetyActive = false;
  let activeSamples = 0;
  let rumbleFilter: Biquad | null = null;
  const rumbleLeft = createBiquadState();
  const rumbleRight = createBiquadState();

  /** セーフティ段のゲイン。**左右で共通**（別々だと音像が動く）。 */
  let safetyGain = 1;
  /** ピークの1サンプルあたりの減衰係数。 */
  let peakFall = 1;
  /** 実効値の指数平均の係数。 */
  let rmsRise = 0;
  let meanSquare = 0;

  // true peak 用の履歴。**音は遅らせない** — 計測が3サンプル遅れて見るだけ。
  const historyLeft = new Float64Array(4);
  const historyRight = new Float64Array(4);

  const telemetry: LevelTelemetry = {
    peak: 0,
    truePeak: 0,
    rms: 0,
    inputPeakMv: 0,
    linePeak: 0,
    inputOverloads: 0,
    outputOverloads: 0,
    safetyReductionDb: 0,
    safetyMaxReductionDb: 0,
    safetyDutyRatio: 0,
    safetyEvents: 0,
    processedSamples: 0,
  };

  const mutable = () =>
    chain as { -readonly [K in keyof OutputChain]: OutputChain[K] };

  /** 履歴を1つ進めて、サンプル間のピークを見る。 */
  function traceTruePeak(history: Float64Array, value: number): number {
    history[0] = history[1];
    history[1] = history[2];
    history[2] = history[3];
    history[3] = value;
    let top = Math.abs(history[2]);
    for (let k = 0; k < INTERPOLATION.length; k++) {
      const w = INTERPOLATION[k];
      const between =
        w[0] * history[0] + w[1] * history[1] + w[2] * history[2] + w[3] * history[3];
      const magnitude = between < 0 ? -between : between;
      if (magnitude > top) top = magnitude;
    }
    return top;
  }

  const chain: OutputChain = {
    left: 0,
    right: 0,
    telemetry,
    referenceMillivolts: 0,
    netGain: 1,

    configure(next, rate) {
      const hz = Number.isFinite(rate) && rate > 0 ? rate : 48000;
      const sensitivity = clamp(next.cartridgeSensitivity, 1e-4, 100, 5);
      millivoltsPerUnit = REFERENCE_LATERAL_CM_PER_SEC * sensitivity;
      inputOverload =
        Number.isFinite(next.inputOverloadMv) && next.inputOverloadMv > 0
          ? next.inputOverloadMv
          : Number.POSITIVE_INFINITY;

      const gain = dbToLinear(clamp(next.phonoGainDb, -40, 120, 0));
      const volts = (millivoltsPerUnit / 1000) * gain;
      let net = volts / LINE_REFERENCE_VOLTS;
      // **ちょうど 1 の設定では厳密に 1 にする。** 基準のビット一致がここに乗って
      // いる（log と pow の往復で 1 ULP ずれるだけなので、そこだけ丸める）。
      if (Math.abs(net - 1) < 1e-9) net = 1;

      lineCeiling = Number.isFinite(next.outputHeadroomDb)
        ? dbToLinear(clamp(next.outputHeadroomDb, -20, 60, 12))
        : Number.POSITIVE_INFINITY;
      safetyCeiling = Number.isFinite(next.safetyCeilingDbfs)
        ? dbToLinear(clamp(next.safetyCeilingDbfs, -40, 24, 0))
        : Number.POSITIVE_INFINITY;
      safetyRelease = Math.exp(
        -1 / Math.max(1, clamp(next.safetyReleaseSeconds, 1e-4, 10, 0.05) * hz),
      );
      // **ライン基準を dBFS のどこへ置くか。** 0dB は掛け算ごと飛ばす。
      const calibrationDb = clamp(next.digitalCalibrationDb, -40, 12, 0);
      calibration = calibrationDb === 0 ? 1 : dbToLinear(calibrationDb);

      // **既定は無し。** 入れたときだけ低域を切る。
      const rumbleHz = clamp(next.rumbleFilterHz, 0, hz * 0.45, 0);
      rumbleFilter = rumbleHz > 0 ? highPass(rumbleHz, hz) : null;

      peakFall = Math.pow(10, -PEAK_FALL_DB_PER_SECOND / (20 * hz));
      rmsRise = 1 - Math.exp(-1 / (RMS_SECONDS * hz));

      const self = mutable();
      self.netGain = net;
      self.referenceMillivolts = millivoltsPerUnit;
      chain.reset();
    },

    input(left, right) {
      const self = mutable();
      // 電圧は**判定と表示のため**に作る。信号は溝の単位のまま流す。
      const magnitude = (left < 0 ? -left : left) > (right < 0 ? -right : right)
        ? (left < 0 ? -left : left)
        : (right < 0 ? -right : right);
      const millivolts = magnitude * millivoltsPerUnit;
      if (millivolts > telemetry.inputPeakMv) telemetry.inputPeakMv = millivolts;
      else telemetry.inputPeakMv *= peakFall;

      if (!(millivolts > inputOverload * SATURATION_KNEE)) {
        // **閾値より下は素通し。** 常時掛かる waveshaper にしない。
        self.left = left;
        self.right = right;
        return;
      }
      // 左右で同じゲイン。別々だと過大入力のたびに音像が動く。
      const gain = softGain(millivolts / inputOverload, SATURATION_KNEE);
      if (gain !== 1) telemetry.inputOverloads += 1;
      self.left = left * gain;
      self.right = right * gain;
    },

    output(left, right, humLeft, humRight) {
      const self = mutable();
      let outLeft = left;
      let outRight = right;

      // ① 低域フィルタ（任意）。**既定は無しで、通らない。**
      if (rumbleFilter !== null) {
        outLeft = processBiquad(rumbleFilter, rumbleLeft, outLeft);
        outRight = processBiquad(rumbleFilter, rumbleRight, outRight);
      }

      // ② フォノ段のゲイン。**基準では厳密に 1 なので掛け算ごと飛ばす。**
      if (chain.netGain !== 1) {
        outLeft *= chain.netGain;
        outRight *= chain.netGain;
      }

      // ③ ライン出力段。**低域が振り切るのはここ。**
      const linePeak = Math.max(
        outLeft < 0 ? -outLeft : outLeft,
        outRight < 0 ? -outRight : outRight,
      );
      if (linePeak > telemetry.linePeak) telemetry.linePeak = linePeak;
      else telemetry.linePeak *= peakFall;
      if (linePeak > lineCeiling * SATURATION_KNEE) {
        const gain = softGain(linePeak / lineCeiling, SATURATION_KNEE);
        if (gain !== 1) {
          telemetry.outputOverloads += 1;
          outLeft *= gain;
          outRight *= gain;
        }
      }

      // ④ フォノ段より後の電気ハム。**ゲインを受けない**（`hum.ts` の注入点）。
      outLeft += humLeft;
      outRight += humRight;

      // ⑤ **デジタル出力の校正。** ここが物理と取り決めの境目で、ライン基準
      //    （＝横5cm/s）を dBFS のどこへ置くかを決める。**0dB なら素通し。**
      if (calibration !== 1) {
        outLeft *= calibration;
        outRight *= calibration;
      }

      // ⑥ セーフティ段。**天井より下では1ビットも触らない。**
      //
      // 同じサンプルへ即座に掛けるので、**出力が天井を超えることは無い**
      // （destination の clamp に頼らない）。
      const peak = Math.max(
        outLeft < 0 ? -outLeft : outLeft,
        outRight < 0 ? -outRight : outRight,
      );
      const target = peak > safetyCeiling ? safetyCeiling / peak : 1;
      // 効くのは即座、戻るのは緩やか。目標が 1 なら 1 のまま。
      safetyGain =
        target < safetyGain
          ? target
          : safetyGain + (target - safetyGain) * (1 - safetyRelease);
      if (safetyGain > 1 - 1e-12) safetyGain = 1;
      if (safetyGain !== 1) {
        outLeft *= safetyGain;
        outRight *= safetyGain;
      }

      // **作動しているかは gain ではなく削っている量で決める。** リリースの尾は
      // 音には残るが、作動時間率と作動回数には数えない（監査の読み違いの元）。
      telemetry.processedSamples += 1;
      if (safetyGain < SAFETY_ACTIVE_GAIN) {
        const reduction = -20 * Math.log10(safetyGain);
        telemetry.safetyReductionDb = reduction;
        if (reduction > telemetry.safetyMaxReductionDb) {
          telemetry.safetyMaxReductionDb = reduction;
        }
        activeSamples += 1;
        if (!safetyActive) {
          safetyActive = true;
          telemetry.safetyEvents += 1;
        }
      } else {
        telemetry.safetyReductionDb = 0;
        safetyActive = false;
      }
      telemetry.safetyDutyRatio = activeSamples / telemetry.processedSamples;

      self.left = outLeft;
      self.right = outRight;

      // ⑥ 計測。**音には触らない。**
      const finalPeak = Math.max(
        outLeft < 0 ? -outLeft : outLeft,
        outRight < 0 ? -outRight : outRight,
      );
      if (finalPeak > telemetry.peak) telemetry.peak = finalPeak;
      else telemetry.peak *= peakFall;
      const between = Math.max(
        traceTruePeak(historyLeft, outLeft),
        traceTruePeak(historyRight, outRight),
      );
      if (between > telemetry.truePeak) telemetry.truePeak = between;
      else telemetry.truePeak *= peakFall;
      meanSquare +=
        ((outLeft * outLeft + outRight * outRight) / 2 - meanSquare) * rmsRise;
      telemetry.rms = Math.sqrt(meanSquare);
    },

    /** **最大値ホールドもここでだけ**下がる（明示的なリセット）。 */
    resetMeters() {
      telemetry.peak = 0;
      telemetry.truePeak = 0;
      telemetry.rms = 0;
      telemetry.inputPeakMv = 0;
      telemetry.linePeak = 0;
      telemetry.inputOverloads = 0;
      telemetry.outputOverloads = 0;
      telemetry.safetyReductionDb = 0;
      telemetry.safetyMaxReductionDb = 0;
      telemetry.safetyDutyRatio = 0;
      telemetry.safetyEvents = 0;
      telemetry.processedSamples = 0;
      activeSamples = 0;
      safetyActive = false;
      meanSquare = 0;
    },

    reset() {
      safetyGain = 1;
      safetyActive = false;
      historyLeft.fill(0);
      historyRight.fill(0);
      resetBiquadState(rumbleLeft);
      resetBiquadState(rumbleRight);
      const self = mutable();
      self.left = 0;
      self.right = 0;
    },
  };

  chain.configure(parameters, sampleRate);
  return chain;
}
