/**
 * 可変速・正逆再生のためのバンド制限リサンプラー。
 *
 * 溝の上を任意の速度で、前にも後ろにも、止まる寸前でも走る針を1つの式で扱う。
 * カットオフは**通過速度に追随**し、1倍を超えたぶんだけ下がるので、スクラッチで
 * 折り返しが噴き出さない（audio-engine.md 6.1 / 検証 #8）。
 *
 * ## なぜ「位置の純関数」なのか
 *
 * 内部に信号の履歴を持たない。位置と速度だけから毎回すべての係数を作る。
 * 逆走・ジャンプ・停止がある以上、履歴を持つ補間器（IIR・状態付きFIR）は
 * 定義できない。**ブロック境界を跨ぐ連続性は「状態を持ち越すこと」ではなく
 * 「状態を持たないこと」で保証される。**
 *
 * ## 実時間安全
 *
 * 係数表はモジュール評価時に一度だけ作る（`addModule` の時点であり、
 * `process()` は一度も走っていない）。作業用配列も生成時に確保する。
 * **process中の割り当てはゼロ。**
 */

const HALF_TAPS = 12;
/** 1タップあたりの表の分割数。表の隣同士は線形補間で埋める。 */
const SUBDIVISIONS = 128;
/**
 * Kaiser窓の β。24タップで阻止域が十分深くなる値。上げるほど阻止域は深く、
 * 遷移域は広くなる。
 */
const KAISER_BETA = 9;
/**
 * 引き伸ばしの上限。|再生比| がこれを超えるぶんは折り返しが戻ってくるが、
 * 1サンプルあたりのタップ数を有界に保つほうを取る（実時間安全）。
 *
 * ponytail: 上限は 8倍（= 最大192タップ）。手の角速度の上限 40rad/s は公称
 * 33⅓（3.49rad/s）の約11.5倍なので、全力のスクラッチの一瞬だけこの上限に
 * 当たる。そこが耳に付くなら、上限を上げるのではなく多段間引きへ替える。
 */
const MAX_STRETCH = 8;

/** 1サンプルあたり最大タップ数。作業用配列の大きさを決める。 */
const MAX_TAPS = 2 * HALF_TAPS * MAX_STRETCH + 2;

const TABLE_LENGTH = HALF_TAPS * SUBDIVISIONS + 2;

/** 変形ベッセル関数 I0。Kaiser窓のためだけに使う（表の生成時のみ）。 */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 32; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    // I0 は必ず1以上なので、絶対値で打ち切って構わない。
    if (term < 1e-18) break;
  }
  return sum;
}

/**
 * 窓関数付き sinc の表。x はタップ単位（1.0 = 入力1サンプル分）。
 *
 * カットオフはちょうどナイキスト（sinc の零点が整数位置に来る）。ここを
 * 下げると公称速度での再生が鈍り、上げると意味を成さない。速度に応じた
 * 帯域制限は、この表を**引き伸ばして読む**ことで行う。
 */
const KERNEL = (() => {
  const table = new Float32Array(TABLE_LENGTH);
  const normalisation = besselI0(KAISER_BETA);
  for (let i = 0; i < TABLE_LENGTH; i++) {
    const x = i / SUBDIVISIONS;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const u = x / HALF_TAPS;
    const window =
      u >= 1 ? 0 : besselI0(KAISER_BETA * Math.sqrt(1 - u * u)) / normalisation;
    table[i] = sinc * window;
  }
  return table;
})();

/** 表を線形補間して引く。x >= 0（カーネルは偶関数なので絶対値で入れる）。 */
function kernelAt(x: number): number {
  const scaled = x * SUBDIVISIONS;
  const index = scaled | 0;
  if (index >= TABLE_LENGTH - 1) return 0;
  const fraction = scaled - index;
  const a = KERNEL[index];
  return a + (KERNEL[index + 1] - a) * fraction;
}

export interface Resampler {
  /**
   * 1出力サンプル分の係数を作る。**チャンネルごとには呼ばない** —
   * カーソルも位相もLとRで共有しており、違うのは読む配列だけ。
   *
   * `rateAbs` は「出力1サンプルあたり溝を何サンプル進むか」の絶対値。
   * 1を超えたぶんだけカットオフが下がる。符号は関係ない（正逆対称）。
   */
  prepare(position: number, rateAbs: number): void;
  /** 直前の `prepare` の係数で1本の壁を読む。 */
  sample(wall: Float32Array): number;
  /** 現在の係数が覆う入力サンプル数。検証と診断用。 */
  readonly taps: number;
}

export function createResampler(): Resampler {
  const weights = new Float32Array(MAX_TAPS);
  let first = 0;
  let count = 0;
  let normalise = 0;

  return {
    get taps() {
      return count;
    },

    prepare(position, rateAbs) {
      // 遅い側（1倍以下）は引き伸ばさない。もとの帯域のままで良く、
      // 必要なのは補間だけ。速い側だけカットオフを 1/rate へ下げる。
      const stretch =
        rateAbs > 1 ? Math.min(rateAbs, MAX_STRETCH) : 1;
      const scale = 1 / stretch;
      const half = HALF_TAPS * stretch;

      first = Math.ceil(position - half);
      const last = Math.floor(position + half);
      count = Math.min(last - first + 1, MAX_TAPS);

      let sum = 0;
      for (let k = 0; k < count; k++) {
        const w = kernelAt(Math.abs(first + k - position) * scale);
        weights[k] = w;
        sum += w;
      }
      // 係数の総和で割るので、位相にも引き伸ばし量にも関係なく直流利得は
      // ちょうど1になる。振幅の速度依存は上位（× 再生比）の仕事であり、
      // ここでは持たない。
      normalise = sum === 0 ? 0 : 1 / sum;
    },

    sample(wall) {
      // 溝の外は 0 として読む（端の値を引き延ばさない）。総和は端の外まで
      // 含めて割るので、端では自然に減衰して切れる — クリックが出ない。
      const from = first < 0 ? -first : 0;
      const to = Math.min(count, wall.length - first);
      let acc = 0;
      for (let k = from; k < to; k++) {
        acc += weights[k] * wall[first + k];
      }
      return acc * normalise;
    },
  };
}

/** 検証と診断のための実測値。 */
export const RESAMPLER_SHAPE = {
  halfTaps: HALF_TAPS,
  subdivisions: SUBDIVISIONS,
  kaiserBeta: KAISER_BETA,
  maxStretch: MAX_STRETCH,
  maxTaps: MAX_TAPS,
};
