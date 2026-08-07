/**
 * RIAA特性と、その係数を作るための最小限の道具。
 *
 * **係数は一つも直接書かない。** 標準時定数を双一次変換にかけて生成する。
 * サンプルレートが変われば係数も変わるので、直書きした数値は必ずどこかの
 * レートで間違いになる。
 *
 * Web Audio にも Three.js にも依存しない。カッティング（オフライン）でも
 * 再生（音声スレッド）でも同じ実装を使う。
 */

/**
 * RIAAの標準時定数、秒。
 *
 * t1 / t2 / t3 が規格そのもの。`neumann` は規格ではなく**カッティング側の
 * 事実**で、録音特性は 2122Hz から上を 6dB/oct で持ち上げ続ける形をしており、
 * そのままでは実現できない（無限に上がるアンプは無い）。実機のラサ盤用アンプが
 * 50kHz に極を持つのと同じものを入れて有限にする。
 *
 * 再生側はこれを補正しない — 実機の RIAA イコライザーも補正しないので、往復の
 * 残差（20kHzで約 +0.6dB）は**実際のレコードにも乗っている誤差**である。
 */
export const RIAA_TIME_CONSTANTS = {
  /** 3180µs = 50.05Hz */
  t1: 3180e-6,
  /** 318µs = 500.5Hz */
  t2: 318e-6,
  /** 75µs = 2122Hz */
  t3: 75e-6,
  /** 3.18µs = 50.05kHz。カッティングアンプ側の極（Neumann pole）。 */
  neumann: 3.18e-6,
};

/** 正規化の基準。RIAA特性は 1kHz で 0dB と定義される。 */
const REFERENCE_HZ = 1000;

/** 双一次変換後の2次セクション。a0 は 1 に正規化済み。 */
export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * アナログ2次伝達関数を双一次変換で離散化する。
 *
 *     H(s) = (b0 + b1·s + b2·s²) / (a0 + a1·s + a2·s²)
 *
 * 周波数のプリワープはしない。RIAAの折れ点（50Hz / 500Hz / 2122Hz）はどれも
 * ナイキストから十分離れており、変換誤差は可聴帯域の上端でだけ効く（検証で
 * 実測している）。
 */
function bilinear(
  analog: { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number },
  sampleRate: number,
): Biquad {
  const k = 2 * sampleRate;
  const kk = k * k;

  const den = analog.a0 + analog.a1 * k + analog.a2 * kk;
  return {
    b0: (analog.b0 + analog.b1 * k + analog.b2 * kk) / den,
    b1: (2 * analog.b0 - 2 * analog.b2 * kk) / den,
    b2: (analog.b0 - analog.b1 * k + analog.b2 * kk) / den,
    a1: (2 * analog.a0 - 2 * analog.a2 * kk) / den,
    a2: (analog.a0 - analog.a1 * k + analog.a2 * kk) / den,
  };
}

/** |H(e^{jω})|。検証と正規化に使う。 */
export function biquadMagnitude(
  filter: Biquad,
  frequency: number,
  sampleRate: number,
): number {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);

  const numRe = filter.b0 + filter.b1 * cos1 + filter.b2 * cos2;
  const numIm = -(filter.b1 * sin1 + filter.b2 * sin2);
  const denRe = 1 + filter.a1 * cos1 + filter.a2 * cos2;
  const denIm = -(filter.a1 * sin1 + filter.a2 * sin2);

  return Math.hypot(numRe, numIm) / Math.hypot(denRe, denIm);
}

export const biquadResponseDb = (
  filter: Biquad,
  frequency: number,
  sampleRate: number,
) => 20 * Math.log10(biquadMagnitude(filter, frequency, sampleRate));

/** 1kHz が 0dB になるように分子を揃える。 */
function normaliseAtReference(filter: Biquad, sampleRate: number): Biquad {
  const gain = biquadMagnitude(filter, REFERENCE_HZ, sampleRate);
  if (!(gain > 0) || !Number.isFinite(gain)) return filter;
  return { ...filter, b0: filter.b0 / gain, b1: filter.b1 / gain, b2: filter.b2 / gain };
}

/**
 * 再生特性（ディエンファシス）。**規格どおりの3定数**で、Neumann極は補正しない。
 *
 *     H(s) = (1 + s·t2) / ((1 + s·t1)(1 + s·t3))
 *
 * カートリッジの出力（速度）に、時間領域で掛ける。**盤の回転速度で時定数を
 * 変えない**ので、公称速度から外れると録音特性と噛み合わなくなる — 33⅓盤を45で
 * 回したときの音色の変化は、この不一致から自動的に出る。
 */
export function riaaPlayback(sampleRate: number): Biquad {
  const { t1, t2, t3 } = RIAA_TIME_CONSTANTS;
  return normaliseAtReference(
    bilinear(
      { b0: 1, b1: t2, b2: 0, a0: 1, a1: t1 + t3, a2: t1 * t3 },
      sampleRate,
    ),
    sampleRate,
  );
}

/**
 * 録音特性（プリエンファシス）。再生特性の逆に、カッティング側の極を足したもの。
 *
 *     H(s) = (1 + s·t1)(1 + s·t3) / ((1 + s·t2)(1 + s·neumann))
 *
 * Neumann極が要るのは実現性の問題であり、数値上の都合ではない。これが無いと
 * 分子だけ2次・分母1次の非プロパーな伝達関数になり、双一次変換でナイキストに
 * 零点が乗る。その逆フィルタは単位円上に極を持ち、**発振する**。
 */
export function riaaRecording(sampleRate: number): Biquad {
  const { t1, t2, t3, neumann } = RIAA_TIME_CONSTANTS;
  return normaliseAtReference(
    bilinear(
      {
        b0: 1,
        b1: t1 + t3,
        b2: t1 * t3,
        a0: 1,
        a1: t2 + neumann,
        a2: t2 * neumann,
      },
      sampleRate,
    ),
    sampleRate,
  );
}

/**
 * 2次バターワースのハイパスフィルタ（RBJ）。カッティング前段の超低域除去用。
 *
 * カッティングでこれが要るのは、変位が速度の積分だからである。数十Hz以下が
 * 残っていると溝の振幅が際限なく大きくなり、実機ならカッターヘッドが飛ぶ。
 */
export function highPass(frequency: number, sampleRate: number): Biquad {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const cosw = Math.cos(w);
  const alpha = Math.sin(w) / Math.SQRT2; // Q = 1/√2（バターワース）
  const a0 = 1 + alpha;
  return {
    b0: (1 + cosw) / 2 / a0,
    b1: -(1 + cosw) / a0,
    b2: (1 + cosw) / 2 / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** 1チャンネルぶんのフィルタ状態。転置Direct Form II（丸め誤差が溜まりにくい）。 */
export interface BiquadState {
  s1: number;
  s2: number;
}

export const createBiquadState = (): BiquadState => ({ s1: 0, s2: 0 });

export function processBiquad(
  filter: Biquad,
  state: BiquadState,
  input: number,
): number {
  const output = filter.b0 * input + state.s1;
  state.s1 = filter.b1 * input - filter.a1 * output + state.s2;
  state.s2 = filter.b2 * input - filter.a2 * output;
  return output;
}

export function resetBiquadState(state: BiquadState): void {
  state.s1 = 0;
  state.s2 = 0;
}

/** 配列をその場で通す。オフラインのカッティング用。 */
export function filterInPlace(filter: Biquad, samples: Float32Array): void {
  const state = createBiquadState();
  for (let i = 0; i < samples.length; i++) {
    samples[i] = processBiquad(filter, state, samples[i]);
  }
}
