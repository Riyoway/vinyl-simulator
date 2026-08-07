/**
 * 非理想なカッターヘッドとカッティング制約 — **Record領域、ロード時に一度きり。**
 *
 * ```
 *   PCM ─▶ 前処理 ─▶ RIAA録音 ─▶ ヘッドの機械応答 ─▶ 溝の制約 ─▶ 積分 ─▶ 溝壁の変位
 *          （超低域        （速度に      （帯域・共振・      （速度・変位・
 *           除去＋          なる）        減衰・             加速度を壁ごとに）
 *           低域モノラル化）              クロストーク）
 * ```
 *
 * **出力に掛けるコンプレッサーでも waveshaper でもない。** ここで変形した波形は
 * そのまま溝バッファに焼かれる。**綺麗な針で再生しても元には戻らない** —— 実際の
 * レコードで、カッティングで失われたものが再生機を変えても戻らないのと同じである。
 * 再生側 DSP はこのモジュールの存在を知らない。
 *
 * ## なぜ再生側ではないのか
 *
 * カッティングの制約は**盤に刻まれた事実**であって、針の性質ではない。再生側に
 * 置くと、
 *
 * - 針やカートリッジを替えると歪みが変わってしまう（実機では変わらない）
 * - 逆再生すると制限が逆に掛かる（盤はもう切られている）
 * - 同じ盤を2回鳴らすと違う音になりうる（リミッタは状態を持つ）
 *
 * どれも実機と違う。**溝に焼く**というのは、これらが起きないことそのものである。
 *
 * ## 限界は半径で変わる
 *
 * 溝は「時間の波形」ではなく**盤に刻まれた形**なので、限界は**距離**で決まる。
 * 線速度 `v = ω_cut · r` を通して、時間領域の限界へ翻訳される:
 *
 * | 物理的な限界 | 単位 | 時間領域では |
 * |---|---|---|
 * | 溝の傾き `dy/dx` | 無次元 | **速度限界 = v · slopeLimit** |
 * | 溝の曲率 `d²y/dx²` | 1/m | **加速度限界 = v² · curvatureLimit** |
 * | 隣の溝との間隔 | m | **変位限界**（半径に依らない） |
 *
 * だから**内周ほど厳しい**。33⅓rpm で外周 146mm の線速度は 0.51m/s、リードアウト
 * 59mm では 0.21m/s しかないので、同じ高域信号でも速度の余裕は 2.5倍、加速度の
 * 余裕は 6.2倍違う。45で切れば全体に緩む。**これは係数ではなく幾何である。**
 *
 * ## 数値について
 *
 * **実在機種の値は書かない。** 既定は `IDEAL_CUTTING`（限界は無限、ヘッドは素通し）
 * で、この設定では現在の溝バッファと**ビット単位で一致**する。プリセットの値は
 * 「その現象がどのくらいの寸法で起きるか」から置いた初期値で、調整される前提の
 * 目盛りである。
 */

import { rpmToRadPerSec } from "../../physics/platterMotor";
import type { PitchControlParameters } from "./pitchControl";
import {
  createBiquadState,
  highPass,
  processBiquad,
  resetBiquadState,
  type Biquad,
} from "./riaa";
import { REFERENCE_WALL_VELOCITY } from "./stylus";

/* ------------------------------------------------------------------ *
 * パラメータ
 * ------------------------------------------------------------------ */

/**
 * カッティングアンプとヘッドの機械応答。
 *
 * ヘッドは駆動コイルと可動部を持つ機械なので、帯域も共振もある。**フィードバックが
 * 掛かっているぶん実機の共振は浅い**が、無くはない。
 */
export interface CutterHeadParameters {
  /** 低域側の限界 Hz。駆動系が追えなくなるところ。**0 で無し。** */
  lowHz: number;
  /** 主共振 Hz。可動部の質量とサスペンションで決まる。**0 で無し。** */
  resonanceHz: number;
  /** その鋭さ。フィードバックが掛かるほど小さい。 */
  resonanceQ: number;
  /**
   * 左右コイル間の漏れ（線形比）。**0 が理想。** カッティング側のクロストークは
   * 盤に焼かれるので、**再生側のクロストーク（`cartridge.ts`）とは別物**である。
   */
  crosstalk: number;
}

/**
 * 周波数依存の低域モノラル化（elliptical EQ）。
 *
 * 低い周波数で縦（L−R）が大きいと、針が溝から浮くか、逆に溝底を突き抜ける。
 * カッティングでは**低域だけ縦成分を減らして横へ寄せる**。横成分（L+R）には
 * 触らないので、モノラルの音源では1サンプルも変わらない。
 */
export interface LowFrequencyMonoParameters {
  /** この周波数より下の縦成分を落とす Hz。**0 で無し。** */
  hz: number;
  /** どれだけ落とすか。0 で無し、1 で完全にモノラル。 */
  amount: number;
}

/**
 * 溝そのものの限界。**壁ごとに評価する。**
 *
 * 3つとも「盤に刻まれた形」の制約で、時間領域へは線速度を通して翻訳される
 * （冒頭の表）。**無限が理想**で、そのとき評価そのものが走らない。
 */
export interface GrooveLimitParameters {
  /** 溝の傾き `dy/dx` の上限（無次元）。速度限界 = 線速度 × これ。 */
  slopeLimit: number;
  /** 溝の曲率の上限 1/m。加速度限界 = 線速度² × これ。 */
  curvatureLimit: number;
  /** 片壁の変位の上限 m。隣の溝と当たらない範囲。 */
  maxDisplacement: number;
  /**
   * 限界の何割から圧縮を始めるか（0〜1）。**ここより下は1ビットも変わらない。**
   * 1 に近いほどハードリミッタに近づく（が、決してハードクリップはしない）。
   */
  knee: number;
  /** 掛かった圧縮が戻る時定数 秒。 */
  releaseSeconds: number;
}

/**
 * カッティング側の高域リミッタ / ディエッサー。
 *
 * **高域にしか効かない。** 強い歯擦音や шум のような、速度・加速度の限界を高域だけで
 * 食い潰す成分を抑えるためのもので、全帯域のリミッタ（`GrooveLimitParameters`）とは
 * 別に持つ。閾値より下では帯域分割ごと素通しする。
 */
export interface HighFrequencyLimiterParameters {
  /** どこから上を見るか Hz。**0 で無し。** */
  hz: number;
  /** 高域成分の片壁速度の閾値 m/s。**無限で無し。** */
  threshold: number;
  /** 圧縮を始める割合（0〜1）。 */
  knee: number;
  /** 戻る時定数 秒。 */
  releaseSeconds: number;
}

/**
 * **溝へ焼き込まれる設定一式。** これを変えたら音源から切り直しになる
 * （`recordCondition.ts` の `RecordSpec` を参照）。
 */
export interface CuttingParameters {
  head: CutterHeadParameters;
  lowFrequency: LowFrequencyMonoParameters;
  limits: GrooveLimitParameters;
  highFrequency: HighFrequencyLimiterParameters;
  /**
   * 可変ピッチのプレビュー制御（`pitchControl.ts`）。**null は一定ピッチ**で、
   * そのとき螺旋の割り付けは従来と完全に一致する。
   *
   * **これは信号を変えない。** 決めるのは溝の位置だけなので、`isIdealCutting`
   * （＝波形がビット一致するか）とは別の軸である。
   */
  pitch: PitchControlParameters | null;
}

/**
 * 理想のカッティング。**限界は無限、ヘッドは素通し、低域も触らない。**
 *
 * この設定では `cutToGroove` が従来の経路をそのまま通り、溝バッファは
 * **ビット単位で以前と一致する**。実機の値は入っていない。
 */
export const IDEAL_CUTTING: CuttingParameters = {
  pitch: null,
  head: { lowHz: 0, resonanceHz: 0, resonanceQ: Math.SQRT1_2, crosstalk: 0 },
  lowFrequency: { hz: 0, amount: 0 },
  limits: {
    slopeLimit: Number.POSITIVE_INFINITY,
    curvatureLimit: Number.POSITIVE_INFINITY,
    maxDisplacement: Number.POSITIVE_INFINITY,
    knee: 0.8,
    releaseSeconds: 0.05,
  },
  highFrequency: {
    hz: 0,
    threshold: Number.POSITIVE_INFINITY,
    knee: 0.8,
    releaseSeconds: 0.02,
  },
};

const finite = (value: number) => Number.isFinite(value) && value > 0;

/** ヘッドが何もしないか。 */
const headIsIdeal = (head: CutterHeadParameters) =>
  !finite(head.lowHz) && !finite(head.resonanceHz) && !(Math.abs(head.crosstalk) > 0);

/** 低域モノラル化が効かないか。 */
const lowFrequencyIsIdeal = (low: LowFrequencyMonoParameters) =>
  !finite(low.hz) || !(low.amount > 0);

/** 溝の限界がどれも無限か。 */
const limitsAreIdeal = (limits: GrooveLimitParameters) =>
  !finite(limits.slopeLimit) &&
  !finite(limits.curvatureLimit) &&
  !finite(limits.maxDisplacement);

/** 高域リミッタが効かないか。 */
const highFrequencyIsIdeal = (hf: HighFrequencyLimiterParameters) =>
  !finite(hf.hz) || !finite(hf.threshold);

/**
 * **何も変えないカッティングか。** true のとき `cutToGroove` は従来の経路を通り、
 * 溝バッファはビット単位で一致する。
 */
export function isIdealCutting(parameters: CuttingParameters): boolean {
  return (
    headIsIdeal(parameters.head) &&
    lowFrequencyIsIdeal(parameters.lowFrequency) &&
    limitsAreIdeal(parameters.limits) &&
    highFrequencyIsIdeal(parameters.highFrequency)
  );
}

/* ------------------------------------------------------------------ *
 * プリセット
 * ------------------------------------------------------------------ */

/** 選べるカッティング。**この並びがそのまま UI の並びになる。** */
export const CUTTING_PRESETS = [
  { name: "ideal", label: "Ideal / Reference" },
  { name: "lathe", label: "Lathe (conservative)" },
  { name: "hot", label: "Hot cut (loud)" },
] as const;

export type CuttingPresetName = (typeof CUTTING_PRESETS)[number]["name"];

/**
 * カッティングの設定を1組作る。**実在機種を名乗るものではない。**
 *
 * `lathe` の値の出どころ:
 *
 * | | 値 | 根拠 |
 * |---|---|---|
 * | 傾き上限 0.22 | 速度限界 0.112m/s（外周）〜0.045m/s（リードアウト） | 横方向で 16cm/s〜6.4cm/s。標準カッティングレベル（横 5cm/s）に対して外周で 3倍、リードアウトでは 1.3倍しか余裕が無い |
 * | 曲率上限 1/12µm | 加速度限界 21,600m/s²（外周）〜3,540m/s²（リードアウト） | 再生針が辿れる曲率の目安。**内周でだけ効く**のはここ |
 * | 変位上限 40µm | ピッチ 136µm/rev の 1/3 弱 | 隣の溝と当たらない範囲。RIAA が低域を下げるので普通は当たらない |
 * | 縦のモノラル化 200Hz | | 低域の縦振幅を抑える古典的な処置 |
 * | 主共振 20kHz / Q1.0 | | フィードバックの掛かったヘッドの浅い山。実測で 10〜18kHz が +0.2〜+1.2dB、20kHz でちょうど 0dB |
 */
export function cuttingParametersFor(name: CuttingPresetName): CuttingParameters {
  switch (name) {
    case "ideal":
      return IDEAL_CUTTING;

    case "lathe":
      return {
        /**
         * 可変ピッチ。静かなところは 80µm、振れる場所は最大 300µm まで開く
         * （固定ピッチの基準は 136µm）。`maxChangePerRevolution` は送り機構の
         * 追従限界そのもので、3回転あれば端から端まで動ける。
         */
        pitch: {
          previewRevolutions: 1,
          minPitch: 80e-6,
          maxPitch: 300e-6,
          maxChangePerRevolution: 80e-6,
          // 隣り合う2本がそれぞれ振れるので、中心間には両方ぶんが要る。
          displacementGain: 2,
          // 縦は隣とぶつかる向きではない。効きはするが横ほどではない。
          verticalWeight: 0.5,
          lowHz: 150,
          lowWeight: 0.5,
        },
        head: {
          lowHz: 15,
          resonanceHz: 20000,
          resonanceQ: 1,
          // −32dB。カッティング側の漏れで、盤に焼かれる。
          crosstalk: 10 ** (-32 / 20),
        },
        lowFrequency: { hz: 200, amount: 1 },
        limits: {
          slopeLimit: 0.22,
          curvatureLimit: 1 / 12e-6,
          maxDisplacement: 40e-6,
          knee: 0.8,
          releaseSeconds: 0.05,
        },
        highFrequency: {
          hz: 4000,
          // 外周の速度限界のおよそ半分。歯擦音の山でだけ触る高さ。
          threshold: 0.055,
          knee: 0.75,
          releaseSeconds: 0.02,
        },
      };

    /**
     * **大きく切った盤。** 限界そのものは同じ機械なので変えない —— 変えるのは
     * 送り込む量ではなく**どこから絞り始めるか**で、knee を下げて早くから当てる。
     * 高域は 6dB 低いところから見る。
     */
    case "hot": {
      const lathe = cuttingParametersFor("lathe");
      return {
        ...lathe,
        limits: { ...lathe.limits, knee: 0.55, releaseSeconds: 0.08 },
        highFrequency: { ...lathe.highFrequency, threshold: 0.028, knee: 0.6 },
      };
    }
  }
}

/* ------------------------------------------------------------------ *
 * 実装
 * ------------------------------------------------------------------ */

const clamp = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, low), high) : fallback;

/**
 * 共振を持つ2次ローパス（RBJ）。直流利得はちょうど1で、`hz` 付近に `q` の山。
 *
 * ponytail: `cartridge.ts` / `rumble.ts` にも同じ形がある。3つ目なので、次に
 * 触るときは `riaa.ts` へ出すこと（あちらが Biquad の土台と決めてある）。
 */
function resonantLowPass(hz: number, q: number, sampleRate: number): Biquad {
  const frequency = clamp(hz, 1, sampleRate * 0.49, sampleRate * 0.25);
  const quality = clamp(q, 0.05, 40, Math.SQRT1_2);
  const w = (2 * Math.PI * frequency) / sampleRate;
  const cosw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * quality);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cosw) / 2 / a0,
    b1: (1 - cosw) / a0,
    b2: (1 - cosw) / 2 / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * **限界に近づくほど連続的に潰す。** ハードクリップではない。
 *
 *   r ≤ knee            → 1（**1ビットも変えない**）
 *   r > knee            → (knee + (1−knee)·tanh((r−knee)/(1−knee))) / r
 *
 * 括弧の中は knee で値も傾きも連続に繋がり、r をいくら上げても 1 に漸近する
 * ——つまり**出力は限界を超えない**が、超えた量に応じて連続に歪む。
 */
function softGain(ratio: number, knee: number): number {
  if (!(ratio > knee)) return 1;
  const span = 1 - knee;
  if (!(span > 0)) return knee / ratio;
  return (knee + span * Math.tanh((ratio - knee) / span)) / ratio;
}

/** 1サンプルぶんの左右。割り当てを避けるため、ここに書く。 */
export interface CuttingChain {
  readonly left: number;
  readonly right: number;
  /**
   * 前処理の後段（低域モノラル化）。**RIAA より前**に呼ぶ。
   * 理想設定なら入力をそのまま返す。
   */
  preprocess(left: number, right: number): void;
  /**
   * ヘッドの機械応答と溝の制約。**RIAA の後**に呼ぶ。
   *
   * @param radius その瞬間に切っている半径 m。**限界はここから決まる。**
   */
  cut(left: number, right: number, radius: number): void;
  /** 直近の総合ゲイン（1 なら無加工）。検証と計測が読む。 */
  readonly gain: number;
  /** 制限が掛かったサンプル数の累計。**決定論的。** */
  readonly limitedSamples: number;
}

/**
 * カッティングチェーンを1本作る。**盤1枚につき1つ**で、状態を持つ（フィルタと
 * リミッタの記憶）。同じ入力からは必ず同じ出力が出る。
 *
 * @param cutRpm この盤を切る回転数。線速度を通して限界に効く。
 */
export function createCuttingChain(
  parameters: CuttingParameters,
  sampleRate: number,
  cutRpm: number,
): CuttingChain {
  const { head, lowFrequency, limits, highFrequency } = parameters;

  // --- 低域モノラル化（前処理の後段）---
  //
  // **縦成分をハイパスに通す。** 「低域を抜いて引き算する」形にはしない ——
  // 最小位相のフィルタは通過帯域でも位相を回すので、引き算では消えずに
  // 半分残る（60Hz / 200Hz で実測 43% 残った）。落としたいのは縦の低域そのもの
  // なので、縦をハイパスするのが素直で正しい。
  const monoActive = !lowFrequencyIsIdeal(lowFrequency);
  const monoFilter = monoActive ? highPass(lowFrequency.hz, sampleRate) : null;
  const monoState = createBiquadState();
  const monoAmount = clamp(lowFrequency.amount, 0, 1, 0);

  // --- ヘッドの機械応答 ---
  const headActive = !headIsIdeal(head);
  const headLow = finite(head.lowHz) ? highPass(head.lowHz, sampleRate) : null;
  const headResonance = finite(head.resonanceHz)
    ? resonantLowPass(head.resonanceHz, head.resonanceQ, sampleRate)
    : null;
  const headLowLeft = createBiquadState();
  const headLowRight = createBiquadState();
  const headResLeft = createBiquadState();
  const headResRight = createBiquadState();
  const crosstalk = clamp(head.crosstalk, -1, 1, 0);

  // --- 高域リミッタ / ディエッサー ---
  const hfActive = !highFrequencyIsIdeal(highFrequency);
  const hfFilter = hfActive ? highPass(highFrequency.hz, sampleRate) : null;
  const hfLeft = createBiquadState();
  const hfRight = createBiquadState();
  /** 閾値を溝の単位へ。速度1単位 = REFERENCE_WALL_VELOCITY m/s。 */
  const hfThreshold = highFrequency.threshold / REFERENCE_WALL_VELOCITY;
  const hfKnee = clamp(highFrequency.knee, 0, 0.999, 0.8);
  const hfRelease = Math.exp(
    -1 / Math.max(1, clamp(highFrequency.releaseSeconds, 1e-4, 10, 0.02) * sampleRate),
  );
  let hfGain = 1;

  // --- 溝の限界 ---
  const limitsActive = !limitsAreIdeal(limits);
  const knee = clamp(limits.knee, 0, 0.999, 0.8);
  const release = Math.exp(
    -1 / Math.max(1, clamp(limits.releaseSeconds, 1e-4, 10, 0.05) * sampleRate),
  );
  const omegaCut = rpmToRadPerSec(cutRpm);
  /**
   * 単位換算。溝の変位は速度の素朴な累算なので、
   *
   *   速度 1単位   = REFERENCE_WALL_VELOCITY m/s
   *   変位 1単位   = REFERENCE_WALL_VELOCITY / sampleRate m
   *   加速度       = Δ速度単位 × sampleRate × REFERENCE_WALL_VELOCITY m/s²
   */
  const displacementLimit = limits.maxDisplacement * sampleRate / REFERENCE_WALL_VELOCITY;
  let gain = 1;
  let previousLeft = 0;
  let previousRight = 0;
  let displacementLeft = 0;
  let displacementRight = 0;
  let limited = 0;

  const mutable = () =>
    chain as { -readonly [K in keyof CuttingChain]: CuttingChain[K] };

  const chain: CuttingChain = {
    left: 0,
    right: 0,
    gain: 1,
    limitedSamples: 0,

    preprocess(left, right) {
      const self = mutable();
      if (!monoActive || monoFilter === null) {
        self.left = left;
        self.right = right;
        return;
      }
      // 45/45 の関係。**縦だけを触り、横には指1本触れない。**
      const lateral = (left + right) * Math.SQRT1_2;
      const vertical = (left - right) * Math.SQRT1_2;
      const highVertical = processBiquad(monoFilter, monoState, vertical);
      const trimmed = vertical + monoAmount * (highVertical - vertical);
      self.left = (lateral + trimmed) * Math.SQRT1_2;
      self.right = (lateral - trimmed) * Math.SQRT1_2;
    },

    cut(left, right, radius) {
      const self = mutable();
      let l = left;
      let r = right;

      // ── ヘッドの機械応答 ────────────────────────────────────────────
      if (headActive) {
        if (crosstalk !== 0) {
          const mixedLeft = l + crosstalk * r;
          const mixedRight = r + crosstalk * l;
          l = mixedLeft;
          r = mixedRight;
        }
        if (headLow !== null) {
          l = processBiquad(headLow, headLowLeft, l);
          r = processBiquad(headLow, headLowRight, r);
        }
        if (headResonance !== null) {
          l = processBiquad(headResonance, headResLeft, l);
          r = processBiquad(headResonance, headResRight, r);
        }
      }

      // ── 高域リミッタ / ディエッサー ────────────────────────────────
      //
      // **高域帯だけに掛ける。** 閾値より下では帯域を足し戻す演算ごと飛ばすので、
      // 分割・再合成の丸めすら乗らない。
      if (hfFilter !== null) {
        const highLeft = processBiquad(hfFilter, hfLeft, l);
        const highRight = processBiquad(hfFilter, hfRight, r);
        const level = Math.max(Math.abs(highLeft), Math.abs(highRight));
        const target = softGain(level / hfThreshold, hfKnee);
        hfGain = target < hfGain ? target : hfGain + (target - hfGain) * (1 - hfRelease);
        if (hfGain > 1 - 1e-6) hfGain = 1;
        if (hfGain !== 1) {
          l = l - highLeft + highLeft * hfGain;
          r = r - highRight + highRight * hfGain;
        }
      }

      // ── 溝の限界 ───────────────────────────────────────────────────
      //
      // **壁ごとに3つとも評価**し、いちばん厳しいものでゲインを決める。左右へは
      // 同じゲインを掛ける —— 別々に掛けると、限界を守るために音像が動き、
      // 低域モノラル化で消したはずの縦成分が戻ってくる。
      if (limitsActive) {
        // 線速度。**ここが半径と cutRpm の入口。**
        const linear = omegaCut * Math.max(radius, 1e-6);
        const velocityLimit = (linear * limits.slopeLimit) / REFERENCE_WALL_VELOCITY;
        const accelerationLimit =
          (linear * linear * limits.curvatureLimit) /
          (REFERENCE_WALL_VELOCITY * sampleRate);

        let ratio = 0;
        if (Number.isFinite(velocityLimit)) {
          ratio = Math.max(ratio, Math.abs(l) / velocityLimit, Math.abs(r) / velocityLimit);
        }
        if (Number.isFinite(accelerationLimit)) {
          ratio = Math.max(
            ratio,
            Math.abs(l - previousLeft) / accelerationLimit,
            Math.abs(r - previousRight) / accelerationLimit,
          );
        }
        if (Number.isFinite(displacementLimit)) {
          ratio = Math.max(
            ratio,
            Math.abs(displacementLeft + l) / displacementLimit,
            Math.abs(displacementRight + r) / displacementLimit,
          );
        }

        const target = softGain(ratio, knee);
        // 効くのは即座、戻るのは緩やか。**目標が1なら1のまま**なので、限界を
        // 一度も超えない信号は1ビットも変わらない。
        gain = target < gain ? target : gain + (target - gain) * (1 - release);
        if (gain > 1 - 1e-6) gain = 1;
        if (gain !== 1) {
          l *= gain;
          r *= gain;
          limited += 1;
        }
      }

      // 加速度と変位は**切られた後の値**で見る。溝に残るのはこちらである。
      previousLeft = l;
      previousRight = r;
      displacementLeft += l;
      displacementRight += r;

      self.left = l;
      self.right = r;
      self.gain = gain * hfGain;
      self.limitedSamples = limited;
    },
  };

  // 生成直後の状態を揃える（同じ入力から必ず同じ盤が出る）。
  resetBiquadState(monoState);
  resetBiquadState(headLowLeft);
  resetBiquadState(headLowRight);
  resetBiquadState(headResLeft);
  resetBiquadState(headResRight);
  resetBiquadState(hfLeft);
  resetBiquadState(hfRight);

  return chain;
}
