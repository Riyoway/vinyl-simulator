/**
 * 製造・転写工程 — **ラッカー盤から、実際に手に取るプレス盤まで。**
 *
 * カッターが切ったのは**ラッカー1枚**である。店に並ぶ盤はそれではなく、金属原盤へ
 * 何度も転写し、スタンパーでPVCを押した**コピーのコピー**である。工程ごとに形は
 * 少しずつ失われ、隣の溝が滲む。
 *
 * ```
 *   post-cutter lacquer groove
 *      ↓ 隣接溝の転写            pre/post-echo。**溝間隔（可変pitch map）で決まる**
 *      ↓ metal mastering        ラッカー → メタルマスター（**ネガ**）
 *      ↓ stamper                電鋳の世代。**1回ごとに極性が反転する**
 *      ↓ vinyl pressing         PVCの粘弾性。丸まり・高域損失・強い溝での局所変形
 *   final pressed groove         ← **再生側へ渡すのはこれだけ**
 *      ↓
 *   有限針先・接触モデル（再生側。このモジュールを知らない）
 * ```
 *
 * ## 出力に足すエフェクトではない
 *
 * ここでやるのは**溝の形そのものの変形**である。再生側に置くと、
 *
 * - 逆再生すると劣化が逆に掛かる（盤はもうプレスされている）
 * - 針を替えると転写の損失が変わる（実機では変わらない）
 * - エコーが再生速度に貼り付く（実際は**盤上の距離**に貼り付いている）
 *
 * どれも実機と違う。`cutterHead.ts` が「切る側」で言っているのと同じ理由である。
 *
 * ## 時間軸のローパスではない
 *
 * 転写で失われるのは**空間的に細かい形**である。溝1サンプルが表す距離は
 *
 * ```
 *   1サンプルの距離 = ω_cut · r / grooveSampleRate      （48k/33⅓ で外周 10.6µm、内周 4.2µm）
 * ```
 *
 * なので、**同じ 3µm の分解能でも内周では 0.7サンプルぶん、外周では 0.3サンプルぶん**に
 * しかならない。結果として同じ音声周波数が内周ほど強く失われる。**係数ではなく幾何**で、
 * `stylusTip.ts` の内周歪みと出どころは同じである（あちらは針先、こちらは材料）。
 *
 * ## 極性が反転すること自体が非線形性を生む
 *
 * 材料は**自分の曲率より鋭い谷へ入れない**（`stylusTip.ts` と同じ膨張＝dilation）。
 * ところが転写のたびに凹凸が入れ替わるので、**埋まるのは山と谷が1回おき**になる。
 *
 * ```
 *   ラッカー(+)  谷が埋まる
 *   メタル(−)    山が埋まる（＝ラッカーの谷側が戻らないまま、山が削られる）
 *   マザー(+)    谷が埋まる
 *   スタンパー(−) 山が埋まる
 *   ビニール(+)  谷が埋まる
 * ```
 *
 * 線形なフィルタでは絶対に作れない非対称（偶数次高調波）がここから出る。**金属パーツが
 * 必ず奇数枚**なのもここで、偶数枚だとプレス盤がネガになる＝再生できない盤になる。
 *
 * ## 盤面の欠陥とは二重計上しない
 *
 * `surface.ts`（粗さ・埃・傷）は**製造された後の盤に起きたこと**で、こちらは
 * **製造そのもの**である。同じ「劣化」を2回数えないよう、このモジュールは
 * `surface` が持つ量を1つも持たない（逆も同じ）。
 *
 * ## 数値について
 *
 * **実在プラントの値は書かない。** 既定は `IDEAL_MANUFACTURING`（転写ゼロ・
 * エコーゼロ）で、そのとき `manufactureGroove` は**渡された配列をそのまま返す**
 * ——溝バッファはカット直後とビット単位で一致する。
 *
 * Web Audio にも Three.js にも依存しない。
 */

import { rpmToRadPerSec } from "../../physics/platterMotor";
import { CUT, grooveSpacingAt, radiusAtRevolution, type CutLayout } from "./cutLayout";
import { REFERENCE_WALL_VELOCITY } from "./stylus";

/* ------------------------------------------------------------------ *
 * パラメータ
 * ------------------------------------------------------------------ */

/**
 * 1回の転写。**メタルマスターも、マザーも、スタンパーも同じ工程**なので同じ型で持つ。
 */
export interface TransferParameters {
  /**
   * この転写が再現できない空間波長 m。**これより細かい形は失われる。**
   * 電鋳の結晶粒と密着の限界そのもの。**0 で無し。**
   */
  resolution: number;
  /**
   * 材料が入り込めない谷の曲率半径 m。**0 で無し。**
   *
   * **極性で向きが変わる。** ネガを取るときに埋まるのは、元の盤の山にあたる側である。
   */
  fillRadius: number;
  /**
   * 寸法誤差の幅（比）。めっき浴も温度も毎回違うので、世代ごとにわずかに違う倍率と
   * 分解能になる。**seed から決まる**ので同じ盤なら毎回同じ。**0 で無し。**
   */
  tolerance: number;
}

/**
 * PVCの応答。**金属と違って粘弾性なので、押し当てた形がそのまま残らない。**
 */
export interface VinylParameters {
  /** プレスで再現できない空間波長 m。金属より粗い。**0 で無し。** */
  resolution: number;
  /** 材料が入り込めない谷の曲率半径 m。**0 で無し。** */
  fillRadius: number;
  /**
   * **ここを超える溝の傾きから局所変形が始まる**（無次元の空間傾き `dy/dx`）。
   * 大きく振れているところほど樹脂が戻るので、**強い溝でだけ**丸まりが増える。
   * **∞ で無し。**
   */
  yieldSlope: number;
  /** 超えたぶんで丸まりを何倍まで広げるか。0 で無し。 */
  relaxation: number;
}

/**
 * 隣接する溝からの転写 — **pre-echo と post-echo。**
 *
 * ラッカーの上でも、めっきの応力でも、プレスの樹脂流動でも起きる。共通しているのは
 * **隣の溝との距離で決まる**ことなので、`CutLayout` の pitch map を正本にする。
 */
export interface GrooveEchoParameters {
  /**
   * **内側の隣**（次の1回転）から漏れる比。針はそこへ**後から**着くので、
   * これが**先に聞こえる ＝ pre-echo**。**0 で無し。**
   */
  preGain: number;
  /** **外側の隣**（前の1回転）から漏れる比 ＝ post-echo。**0 で無し。** */
  postGain: number;
  /**
   * 結合が間隔でどれだけ強くなるか（指数）。2 なら間隔が半分で4倍。
   * 基準は一定ピッチの 136µm（`CUT.programPitch`）。
   */
  exponent: number;
  /** 漏れた形の空間的な鈍り m。**材料越しに滲むので細かい形は伝わらない。** */
  smoothing: number;
  /**
   * 縦（深さ）方向の結合の割合。**横は隣の溝と向き合う方向、縦は下の材料へ向かう
   * 方向**なので、同じにはならない。1 で同じ、0 で横だけ。
   */
  verticalShare: number;
}

/**
 * **盤1枚ぶんの製造条件。** 変えたら製造からやり直し（＝溝の作り直し）で、
 * 再生側へは送らない。
 */
export interface ManufacturingParameters {
  /**
   * ラッカーからスタンパーまでの金属パーツの枚数。**必ず奇数**（偶数だとプレス盤が
   * ネガになる）。1 ならラッカーから直接スタンパー、3 なら
   * メタルマスター → マザー → スタンパーの三段。
   */
  generations: number;
  transfer: TransferParameters;
  vinyl: VinylParameters;
  echo: GrooveEchoParameters;
}

/**
 * **何もしない製造。** カッターが切ったラッカーがそのまま盤になる、という
 * ありえない条件で、この設定では溝バッファがカット直後とビット単位で一致する。
 */
export const IDEAL_MANUFACTURING: ManufacturingParameters = {
  generations: 1,
  transfer: { resolution: 0, fillRadius: 0, tolerance: 0 },
  vinyl: {
    resolution: 0,
    fillRadius: 0,
    yieldSlope: Number.POSITIVE_INFINITY,
    relaxation: 0,
  },
  echo: {
    preGain: 0,
    postGain: 0,
    exponent: 2,
    smoothing: 0,
    verticalShare: 0.3,
  },
};

const positive = (value: number) => Number.isFinite(value) && value > 0;

/** **溝の形を1ビットも変えない製造か。** true なら配列がそのまま返る。 */
export function isIdealManufacturing(p: ManufacturingParameters): boolean {
  return (
    !positive(p.transfer.resolution) &&
    !positive(p.transfer.fillRadius) &&
    !positive(p.transfer.tolerance) &&
    !positive(p.vinyl.resolution) &&
    !positive(p.vinyl.fillRadius) &&
    !positive(p.echo.preGain) &&
    !positive(p.echo.postGain)
  );
}

/* ------------------------------------------------------------------ *
 * プリセット
 * ------------------------------------------------------------------ */

/** 選べる製造。**この並びがそのまま UI の並びになる。** */
export const MANUFACTURING_PRESETS = [
  { name: "ideal", label: "Ideal / Lacquer" },
  { name: "pressed", label: "Pressed (3-step)" },
  { name: "late-pressing", label: "Late pressing (tired stamper)" },
] as const;

export type ManufacturingPresetName =
  (typeof MANUFACTURING_PRESETS)[number]["name"];

/**
 * 製造条件を1組作る。**実在プラントを名乗るものではない。**
 *
 * `pressed` の値の出どころ:
 *
 * | | 値 | 根拠 |
 * |---|---|---|
 * | 金属パーツ 3枚 | メタルマスター → マザー → スタンパー | 量産の標準的な三段 |
 * | 転写の分解能 1.5µm | 外周で 0.14サンプル、内周で 0.36サンプル | 電鋳の結晶粒の桁。**内周でだけ効く** |
 * | 谷の曲率 2.5µm | | **溝自身の曲率に届いたところでだけ**埋まる（高い音・大きい振幅・内周） |
 * | 寸法誤差 0.3% | | 世代ごとのめっき条件のばらつき |
 * | PVC の分解能 3µm | 内周で 0.7サンプル | 金属より粗い |
 * | 降伏傾き 0.08 | カッターの `slopeLimit` 0.22 の約1/3 | **大きく振れた溝でだけ**樹脂が戻る。6kHz を目一杯切った溝で −0.53dB、静かな溝では −0.20dB のまま |
 * | エコー −46dB / −52dB | 136µm での結合 | pre が強いのは実機と同じ |
 */
export function manufacturingParametersFor(
  name: ManufacturingPresetName,
): ManufacturingParameters {
  switch (name) {
    case "ideal":
      return IDEAL_MANUFACTURING;

    case "pressed":
      return {
        generations: 3,
        transfer: { resolution: 1.5e-6, fillRadius: 2.5e-6, tolerance: 0.003 },
        vinyl: {
          resolution: 3e-6,
          fillRadius: 3e-6,
          yieldSlope: 0.08,
          relaxation: 2.5,
        },
        echo: {
          // 隣の溝が 136µm にいるときの漏れ。**pre のほうが強い。**
          preGain: 10 ** (-46 / 20),
          postGain: 10 ** (-52 / 20),
          exponent: 2,
          smoothing: 6e-6,
          verticalShare: 0.3,
        },
      };

    /**
     * **何万枚も押したあとのスタンパー。** 金属パーツを増やして（マザーから
     * スタンパーを取り直した）、分解能と谷埋まりが悪化した状態。**限界そのものは
     * 同じ材料なので、変えるのは工程の数と荒れ方だけ。**
     */
    case "late-pressing": {
      const base = manufacturingParametersFor("pressed");
      return {
        ...base,
        generations: 5,
        transfer: { resolution: 2.4e-6, fillRadius: 4e-6, tolerance: 0.006 },
        vinyl: {
          ...base.vinyl,
          resolution: 4.5e-6,
          fillRadius: 5e-6,
          yieldSlope: 0.06,
          relaxation: 3,
        },
        echo: {
          ...base.echo,
          preGain: 10 ** (-40 / 20),
          postGain: 10 ** (-46 / 20),
        },
      };
    }
  }
}

/* ------------------------------------------------------------------ *
 * seed
 * ------------------------------------------------------------------ */

/**
 * 盤の seed → **その盤を作った工程の seed。**
 *
 * 別系統にするのではなく**派生させる**のが要点である。同じ音源からは同じ盤が
 * 出来なければならないが、めっきのばらつきを埃の配置と同じ数から引くと、
 * 「埃を増やしたら転写誤差も変わる」ことになる（`surface.ts` とは別の counter）。
 */
export function manufacturingSeedFrom(discSeed: number): number {
  let x = (Number.isFinite(discSeed) ? discSeed | 0 : 0) ^ 0x4d616e75;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return (x ^ (x >>> 15)) | 0;
}

/** counter-based hash → [0,1)。**実行時の乱数を引かない**（`discShape.ts` と同じ形）。 */
function hash01(seed: number, counter: number): number {
  let x = (seed ^ Math.imul(counter | 0, 0x9e3779b1)) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x = (x ^ (x >>> 15)) >>> 0;
  return x / 4294967296;
}

/* ------------------------------------------------------------------ *
 * 空間の道具
 * ------------------------------------------------------------------ */

/** 空間ガウスの σ の上限（溝サンプル）。1サンプルあたりの仕事を有界に保つ。 */
const MAX_SIGMA = 8;
/**
 * 3タップを重ねる回数の上限。
 *
 * ponytail: σ が 1.4サンプルを超えると中域の落ち方が真のガウスより緩くなる。
 * ナイキストでの応答は何回でも厳密なので、効き始めと効き切りは合っている。
 * 足りなくなったら上げること（1回ぶんが配列1パス）。
 */
const MAX_BLUR_PASSES = 4;
/** 谷埋まりの窓を片側何点で刻むか。窓は普通1サンプルより狭い。 */
const MAX_FILL_STEPS = 16;
/** 金属パーツの上限。これ以上の世代を数える意味が無い。 */
const MAX_GENERATIONS = 15;
/** 隣接溝の結合が発散しないための最小の材料厚み m。 */
const MIN_WALL_THICKNESS = 8e-6;

/**
 * **空間的な鈍り。** 幅 σ（メートル）のガウスで撫でた形を、溝の格子の上で作る。
 *
 * ```
 *   1回ぶん   h = [a, 1−2a, a]      H(ω) = 1 − 2a(1−cos ω)
 *   n 回重ねて                       H(ω)^n  →  exp(−t(1−cos ω))     t = σ²（溝サンプル²）
 *   a = (1 − exp(−2t/n)) / 4        ← **ナイキストでは何回でも厳密に exp(−2t)**
 * ```
 *
 * **窓ではなく応答で書くのが要点。** 転写の分解能は 1〜4µm で、溝の1サンプル
 * （外周 10.6µm・内周 4.2µm）より**細かい**。窓として畳み込むと係数が中心の1点に
 * 潰れて「何も起きない」ことになるが、実際には格子より細かい形を撫でることが
 * ナイキスト付近の応答をちゃんと下げる。**外周でだけ効かない**という誤りは
 * ここから出る。
 *
 * - `t = 0` で `a = 0` ＝ **完全な素通し**（`× gain` のみ）。分解能ゼロのビット一致は
 *   この1点から出る
 * - 係数の総和は厳密に 1 なので**直流利得は 1**。積分した変位を扱っているので、
 *   ここがずれると盤が反る
 * - **左右対称なので位相は回らない。** 溝を逆から読んでも同じ形である
 */
/**
 * @param sigma **1回転ごとの** σ（溝サンプル）。半径は1回転の中で 0.25% も動かない
 *   ので、係数はその粒度で作れば足りる（`cutting.ts` の半径の刻み方と同じ）。
 * @param yieldSlope 降伏傾き。有限なら**その場の空間傾きで σ を広げる**（PVCの局所
 *   変形）。∞ なら1回転ぶんの係数を作り直さずに回る。
 */
function blurInto(
  src: Float32Array,
  dst: Float32Array,
  frames: number,
  sigma: Float64Array,
  metresPerSample: Float64Array,
  perRevolution: number,
  passes: number,
  gain: number,
  yieldSlope: number,
  relaxation: number,
  unitsToMetres: number,
): void {
  const widening = Number.isFinite(yieldSlope) && relaxation > 0;
  let revolution = -1;
  let nextRevolutionAt = 0;
  let base = 0;
  let coefficient = 0;
  let slopeScale = 0;

  for (let i = 0; i < frames; i++) {
    if (i >= nextRevolutionAt) {
      revolution = Math.min(sigma.length - 1, revolution + 1);
      nextRevolutionAt =
        perRevolution > 0 ? (revolution + 1) * perRevolution : frames;
      base = sigma[revolution];
      // 一定なら係数は1回転につき1度でよい。
      coefficient = base > 0 ? (1 - Math.exp((-2 * base * base) / passes)) / 4 : 0;
      slopeScale = unitsToMetres / metresPerSample[revolution];
    }

    let a = coefficient;
    if (widening && base > 0) {
      // 空間の傾き `dy/dx`（無次元）。**中心差分なので向きに依らない。**
      const ahead = i + 1 < frames ? src[i + 1] : 0;
      const behind = i - 1 >= 0 ? src[i - 1] : 0;
      const slope = ((ahead - behind) / 2) * slopeScale;
      const excess = Math.abs(slope) / yieldSlope - 1;
      if (excess > 0) {
        const widened = base * (1 + relaxation * Math.tanh(excess));
        a = (1 - Math.exp((-2 * widened * widened) / passes)) / 4;
      }
    }
    if (a === 0) {
      dst[i] = src[i] * gain;
      continue;
    }
    const before = i - 1 >= 0 ? src[i - 1] : 0;
    const after = i + 1 < frames ? src[i + 1] : 0;
    dst[i] = (src[i] + a * (before + after - 2 * src[i])) * gain;
  }
}

/**
 * **谷埋まり。** 半径 a の円が転がって入れる範囲だけが再現される
 * （morphological dilation・`stylusTip.ts` と同じ幾何）。
 *
 * ```
 *   filled(x) = max [ w(x+u) + √(a²−u²) − a ]        |u| ≤ a
 * ```
 *
 * **`max` が本質。** 線形な畳み込みなら山も谷も同じだけ鈍るが、これは**山を残して
 * 谷だけを浅くする**。だから非対称に歪み、偶数次高調波が出る。
 *
 * @param polarity +1 なら谷が埋まり、−1 なら**山が埋まる**（ネガを取るとき）。
 */
function fillInto(
  src: Float32Array,
  dst: Float32Array,
  frames: number,
  polarity: number,
  sigma: Float64Array,
  metresPerSample: Float64Array,
  perRevolution: number,
  unitsToMetres: number,
): void {
  // 窓の刻み。**半径で決まる量は1回転につき1度だけ**作り直す。窓の各点の整数
  // オフセットと端数もそこで決まる（1回転の中では動かない）。
  let revolution = -1;
  let nextRevolutionAt = 0;
  let steps = 0;
  const aheadOffset = new Int32Array(MAX_FILL_STEPS);
  const aheadFrac = new Float64Array(MAX_FILL_STEPS);
  const behindOffset = new Int32Array(MAX_FILL_STEPS);
  const behindFrac = new Float64Array(MAX_FILL_STEPS);
  const drops = new Float64Array(MAX_FILL_STEPS);

  for (let i = 0; i < frames; i++) {
    if (i >= nextRevolutionAt) {
      revolution = Math.min(sigma.length - 1, revolution + 1);
      nextRevolutionAt =
        perRevolution > 0 ? (revolution + 1) * perRevolution : frames;
      const half = sigma[revolution];
      steps = half > 0 ? Math.max(2, Math.min(MAX_FILL_STEPS, Math.ceil(half * 2))) : 0;
      // 円の落ち込みを溝の単位へ直す係数。
      const sagitta = metresPerSample[revolution] / unitsToMetres;
      for (let k = 1; k <= steps; k++) {
        const u = (k / steps) * half;
        const forward = Math.floor(u);
        const backward = Math.floor(-u);
        aheadOffset[k - 1] = forward;
        aheadFrac[k - 1] = u - forward;
        behindOffset[k - 1] = backward;
        behindFrac[k - 1] = -u - backward;
        drops[k - 1] = (Math.sqrt(Math.max(0, half * half - u * u)) - half) * sagitta;
      }
    }
    if (steps === 0) {
      dst[i] = src[i];
      continue;
    }

    let best = polarity * src[i];
    for (let k = 0; k < steps; k++) {
      const drop = drops[k];
      // 窓は1サンプルより狭いことが多い（分解能は距離で決まる）ので、
      // 前後1点ずつの線形補間で読む。溝の外は 0（`resampler.ts` と同じ約束）。
      const forward = i + aheadOffset[k];
      if (forward >= 0 && forward + 1 < frames) {
        const f = aheadFrac[k];
        const raised =
          polarity * (src[forward] * (1 - f) + src[forward + 1] * f) + drop;
        if (raised > best) best = raised;
      } else if (drop > best) best = drop;

      const backward = i + behindOffset[k];
      if (backward >= 0 && backward + 1 < frames) {
        const f = behindFrac[k];
        const lifted =
          polarity * (src[backward] * (1 - f) + src[backward + 1] * f) + drop;
        if (lifted > best) best = lifted;
      } else if (drop > best) best = drop;
    }
    dst[i] = polarity * best;
  }
}

/* ------------------------------------------------------------------ *
 * 製造
 * ------------------------------------------------------------------ */

/**
 * **ラッカーの溝を、プレス盤の溝にする。** 音源ロード時に一度きり。
 *
 * @param walls  カッティング直後の壁（`cutToGroove` の戻り）。**書き換えない。**
 * @param layout その盤の割り付け。**隣接溝の距離と半径の正本**で、ここでは変更しない
 * @param seed   `manufacturingSeedFrom(discSeed)`
 *
 * 返るのは**プレス盤の壁だけ**である。途中の世代は誰も持たない（実機でも手元に
 * 残るのは盤だけである）。
 *
 * ponytail: 工程1つが配列1パスで、`pressed`（金属3枚）で9パス通る。実測は
 * 180秒のステレオで約2.8秒・作業用に溝2枚ぶん。**既定の理想では1パスも走らない**
 * ので通常は 0ms である。長尺で引っかかるならカッティングごと Worker へ出すこと
 * （`cutToGroove` も本関数も Web Audio に依存していない）。先に効くのは谷埋まりで、
 * 全体の3割を使っている。
 */
export function manufactureGroove(
  walls: readonly Float32Array[],
  sampleRate: number,
  layout: CutLayout,
  parameters: ManufacturingParameters,
  seed: number,
): Float32Array[] {
  // **理想では触らない。** 配列をそのまま返すので、モノラルは1本のままで、
  // 溝バッファはカット直後とビット単位で一致する。
  if (isIdealManufacturing(parameters)) return walls as Float32Array[];
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`manufacturing: sample rate must be positive, got ${sampleRate}`);
  }

  const source = walls[0];
  if (!source || source.length === 0) return walls as Float32Array[];
  const sourceRight = walls[1] ?? source;
  const frames = Math.min(source.length, sourceRight.length);

  // **モノラルも2本の壁へ展開する**（`cutting.ts` の非理想側と同じ理由。同じ配列を
  // 2回指したままでは、片方だけ書き換えることになる）。
  let currentLeft = new Float32Array(frames);
  let currentRight = new Float32Array(frames);
  currentLeft.set(source.subarray(0, frames));
  currentRight.set(sourceRight.subarray(0, frames));
  let scratchLeft = new Float32Array(frames);
  let scratchRight = new Float32Array(frames);

  /** 1段まわして入れ替える。**確保するのは最初の2組だけ。** */
  const pass = (
    run: (
      srcLeft: Float32Array,
      srcRight: Float32Array,
      dstLeft: Float32Array,
      dstRight: Float32Array,
    ) => void,
  ) => {
    run(currentLeft, currentRight, scratchLeft, scratchRight);
    const usedLeft = currentLeft;
    const usedRight = currentRight;
    currentLeft = scratchLeft;
    currentRight = scratchRight;
    scratchLeft = usedLeft;
    scratchRight = usedRight;
  };

  /* --- 半径から決まる量。**1回転の中では一定**（0.25%も動かない） --- */
  const perRevolution = layout.samplesPerRevolution;
  const revolutions =
    perRevolution > 0 ? Math.max(1, Math.ceil(frames / perRevolution)) : 1;
  const omegaCut = rpmToRadPerSec(layout.cutRpm);
  /** 変位1単位が表すメートル（`cutterHead.ts` / `surface.ts` と同じ較正点）。 */
  const unitsToMetres = REFERENCE_WALL_VELOCITY / sampleRate;
  /** 溝1サンプルが表す**進行方向の距離** m。**内周ほど小さい。** */
  const metresPerSample = new Float64Array(revolutions);
  const spacing = new Float64Array(revolutions);
  for (let k = 0; k < revolutions; k++) {
    const radius = radiusAtRevolution(layout, k);
    metresPerSample[k] = Math.max(1e-12, (omegaCut * radius) / sampleRate);
    spacing[k] = grooveSpacingAt(layout, k);
  }
  /**
   * 距離 m → 1回転ごとの σ（溝サンプル）。**これが空間処理の入口。**
   *
   * 表にしてから渡す。1サンプルごとに関数を呼ぶと、この段だけで実測 3倍遅くなった。
   */
  const sigmaFor = (metres: number) => {
    const table = new Float64Array(revolutions);
    for (let k = 0; k < revolutions; k++) {
      table[k] = Math.min(MAX_SIGMA, metres / metresPerSample[k]);
    }
    return table;
  };
  /** 最内周（＝σが最大になるところ）を基準に、3タップを何回重ねるか決める。 */
  const passesFor = (metres: number) => {
    const worst = metres / metresPerSample[revolutions - 1];
    return Math.min(
      MAX_BLUR_PASSES,
      Math.max(1, Math.ceil(2 * Math.min(MAX_SIGMA, worst) ** 2)),
    );
  };
  /** 空間的に鈍らせる。**倍率は最後の1回にだけ掛ける**（何度も掛けない）。 */
  const blur = (
    sigma: Float64Array,
    passes: number,
    gain: number,
    yieldSlope = Number.POSITIVE_INFINITY,
    relaxation = 0,
  ) => {
    for (let p = 0; p < passes; p++) {
      const scale = p === passes - 1 ? gain : 1;
      pass((sl, sr, dl, dr) => {
        const run = (src: Float32Array, dst: Float32Array) =>
          blurInto(
            src, dst, frames, sigma, metresPerSample, perRevolution,
            passes, scale, yieldSlope, relaxation, unitsToMetres,
          );
        run(sl, dl);
        run(sr, dr);
      });
    }
  };
  /** 谷埋まり。極性はここで受け取る。 */
  const fill = (sigma: Float64Array, polarity: number) => {
    pass((sl, sr, dl, dr) => {
      const run = (src: Float32Array, dst: Float32Array) =>
        fillInto(
          src, dst, frames, polarity, sigma, metresPerSample, perRevolution,
          unitsToMetres,
        );
      run(sl, dl);
      run(sr, dr);
    });
  };

  /* --- ① 隣接溝の転写（ラッカーの上で起きる） --- */
  const echo = parameters.echo;
  if (positive(echo.preGain) || positive(echo.postGain)) {
    const sigma = sigmaFor(Math.max(0, echo.smoothing));
    pass((sl, sr, dl, dr) =>
      echoInto(sl, sr, dl, dr, frames, perRevolution, {
        echo,
        spacing,
        sigma,
        unitsToMetres,
      }),
    );
  }

  /* --- ② 金属パーツ。**1枚ごとに極性が反転する** --- */
  const generations = metalGenerations(parameters.generations);
  const transfer = parameters.transfer;
  const transferFill = positive(transfer.fillRadius)
    ? sigmaFor(transfer.fillRadius)
    : null;
  for (let g = 1; g <= generations; g++) {
    // g 枚目の極性。1枚目（メタルマスター）が必ずネガ。
    const polarity = g % 2 === 1 ? -1 : 1;
    // 世代ごとのばらつき。**seed から決まるので同じ盤なら毎回同じ。**
    const spread = clamp01(transfer.tolerance);
    const scale = 1 + spread * (hash01(seed, g * 2) * 2 - 1);
    const grain = Math.max(0, transfer.resolution) *
      (1 + spread * (hash01(seed, g * 2 + 1) * 2 - 1));

    if (transferFill !== null) fill(transferFill, polarity);
    if (positive(grain) || scale !== 1) {
      blur(sigmaFor(grain), passesFor(grain), scale);
    }
  }

  /* --- ③ プレス。**最後の反転でポジへ戻る**（金属パーツが奇数枚だから） --- */
  const vinyl = parameters.vinyl;
  const pressPolarity = generations % 2 === 1 ? 1 : -1;
  if (positive(vinyl.fillRadius)) {
    fill(sigmaFor(vinyl.fillRadius), pressPolarity);
  }
  if (positive(vinyl.resolution)) {
    // **強い溝ほど余計に丸まる。** 樹脂は急な形ほど押し戻すので、降伏傾きを超えた
    // ぶんだけ σ が広がる。**超えていない溝では σ は基準のままで、レベルには一切
    // 触らない**（出力に掛けるコンプレッサーではない）。
    //
    // **重ねる回数は基準の σ だけで決める。** 降伏の設定で決めると、降伏に
    // 届いていない静かな溝の丸まりまで変わってしまう。
    blur(
      sigmaFor(vinyl.resolution),
      passesFor(vinyl.resolution),
      1,
      positive(vinyl.yieldSlope) ? vinyl.yieldSlope : Number.POSITIVE_INFINITY,
      Math.max(0, vinyl.relaxation),
    );
  }

  return [currentLeft, currentRight];
}

/** 金属パーツは**必ず奇数枚**。偶数だとプレス盤がネガになる（＝再生できない）。 */
function metalGenerations(requested: number): number {
  const rounded = Number.isFinite(requested) ? Math.round(requested) : 1;
  const bounded = Math.min(MAX_GENERATIONS, Math.max(1, rounded));
  return bounded % 2 === 1 ? bounded : bounded + 1;
}

const clamp01 = (value: number) =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/**
 * **隣接溝の転写 — pre-echo / post-echo。**
 *
 * 隣の溝は螺旋上でちょうど1回転ぶん先／後にある。カーソルは回転数の一次関数
 * （`cursorAtRevolution`）なので、**盤上の隣は溝バッファ上で
 * `samplesPerRevolution` サンプル離れた場所**である —— 固定の時間ディレイでは
 * なく、その盤の割り付けそのものから出る距離である。
 *
 * ```
 *   針の進む向き ──▶
 *      外側の隣（前の回転）      いま切っている溝      内側の隣（次の回転）
 *      i − samplesPerRevolution        i          i + samplesPerRevolution
 *          ↓ post-echo                              ↓ pre-echo（**先に聞こえる**）
 * ```
 *
 * 結合の強さは**残った材料の厚み**で決まる。溝間隔が狭いほど、隣が大きく振れて
 * いるほど薄い。
 *
 * ```
 *   厚み   = 溝間隔 − 2 × 隣の横方向変位      （両方が振れるので2倍）
 *   結合   = gain × (136µm / 厚み)^exponent
 * ```
 *
 * **可変ピッチなら回転ごとに間隔が違う**ので、同じ音でも開いている場所では弱く、
 * 詰まっている場所では強く漏れる。
 *
 * 焼き込まれた形なので、**再生側にディレイは1つも無い**。正転・逆転は同じ形を
 * 逆から読むだけであり、45で回せばエコーの実時間間隔もそのぶん短くなる。
 */
function echoInto(
  srcLeft: Float32Array,
  srcRight: Float32Array,
  dstLeft: Float32Array,
  dstRight: Float32Array,
  frames: number,
  perRevolution: number,
  context: {
    echo: GrooveEchoParameters;
    spacing: Float64Array;
    sigma: Float64Array;
    unitsToMetres: number;
  },
): void {
  const { echo, spacing, sigma, unitsToMetres } = context;
  const preGain = Math.max(0, echo.preGain);
  const postGain = Math.max(0, echo.postGain);
  const exponent = Number.isFinite(echo.exponent)
    ? Math.min(6, Math.max(0, echo.exponent))
    : 2;
  const verticalShare = clamp01(echo.verticalShare);

  if (!(perRevolution > 0)) {
    dstLeft.set(srcLeft.subarray(0, frames));
    dstRight.set(srcRight.subarray(0, frames));
    return;
  }

  /** 隣の壁が滲んで伝わった量。左右それぞれに足す値を書き込む。 */
  let leakedLeft = 0;
  let leakedRight = 0;

  /**
   * 隣の溝を材料越しに読んで、こちらの壁へ漏れる量を出す。
   *
   * **細かい形は材料を越えない**ので窓で鈍らせ、**横と縦で結合を分ける**
   * ——横だけが隣の溝と向き合っており、縦は下の材料へ向かう方向である。
   *
   * @param index 隣の溝の整数位置、@param frac その端数。**1回転ぶんの端数は
   *   盤の割り付けから決まる定数**なので、進むのは整数側だけである。
   */
  const leakFrom = (
    index: number,
    frac: number,
    blur: number,
    gap: number,
    gain: number,
  ) => {
    const read = (wall: Float32Array, at: number) =>
      at >= 0 && at + 1 < frames
        ? wall[at] * (1 - frac) + wall[at + 1] * frac
        : 0;
    let left = read(srcLeft, index);
    let right = read(srcRight, index);
    if (blur > 0) {
      // `blurInto` と同じ3タップ。**材料越しなので細かい形は伝わらない。**
      left += blur * (read(srcLeft, index - 1) + read(srcLeft, index + 1) - 2 * left);
      right +=
        blur * (read(srcRight, index - 1) + read(srcRight, index + 1) - 2 * right);
    }
    const lateral = (left + right) * Math.SQRT1_2;
    const vertical = (left - right) * Math.SQRT1_2;
    // 残った材料の厚み。**隣が大きく振れているほど薄い。**
    const thickness = Math.max(
      MIN_WALL_THICKNESS,
      gap - 2 * Math.abs(lateral) * unitsToMetres,
    );
    const strength = gain * Math.pow(CUT.programPitch / thickness, exponent);
    const leakLateral = strength * lateral;
    const leakVertical = strength * verticalShare * vertical;
    leakedLeft += (leakLateral + leakVertical) * Math.SQRT1_2;
    leakedRight += (leakLateral - leakVertical) * Math.SQRT1_2;
  };

  // 隣の溝は1回転ぶん先／後。**端数は盤ごとの定数**なので、毎サンプル floor を
  // 引き直す必要は無い（進むのは整数側だけ）。
  const preBase = Math.floor(perRevolution);
  const preFrac = perRevolution - preBase;
  const postBase = Math.floor(-perRevolution);
  const postFrac = -perRevolution - postBase;

  let revolution = -1;
  let nextRevolutionAt = 0;
  let blur = 0;
  let gap = 0;
  for (let i = 0; i < frames; i++) {
    if (i >= nextRevolutionAt) {
      revolution = Math.min(sigma.length - 1, revolution + 1);
      nextRevolutionAt = (revolution + 1) * perRevolution;
      const variance = sigma[revolution] ** 2;
      blur = variance > 0 ? (1 - Math.exp(-2 * variance)) / 4 : 0;
      gap = spacing[revolution];
    }
    leakedLeft = 0;
    leakedRight = 0;

    // **内側の隣（次の回転）。針は後から着くので、これが先に聞こえる。**
    if (preGain > 0) leakFrom(i + preBase, preFrac, blur, gap, preGain);
    // **外側の隣（前の回転）。**
    if (postGain > 0) leakFrom(i + postBase, postFrac, blur, gap, postGain);

    dstLeft[i] = srcLeft[i] + leakedLeft;
    dstRight[i] = srcRight[i] + leakedRight;
  }
}
