/**
 * 電源ハムと電磁誘導ノイズ — **Pickup領域の電気ノイズ。**
 *
 * ```
 *   溝(変位) ＋ 盤面欠陥 ＋ 反り ＋ ランブル → 差分 → 接触
 *                                                    ↓
 *                                    幾何行列 → 機械共振（カートリッジ前半）
 *                                                    ↓
 *                        ＋ cartridgeInduction ←──────┤  コイルへの誘導
 *                                                    ↓
 *                                      電気負荷（カートリッジ後半）
 *                                                    ↓
 *                        ＋ cableHum ＋ groundLoop ←──┤  配線とアースループ
 *                                                    ↓
 *                                              RIAA再生特性
 *                                                    ↓
 *                        ＋ electronicsHum ←──────────┤  フォノ段以後
 *                                                    ↓
 *                                                  出力
 * ```
 *
 * ## 機械振動と混ぜてはならない
 *
 * ハムは**電気的に混入する**のであって、盤や針が揺れているのではない。溝の変位へ
 * 足すと、
 *
 * - 盤を止めれば消えてしまう（実機のハムは止めても鳴る）
 * - 針を上げれば消えてしまう（同上）
 * - 接触モデルの追従限界を食う（電圧が針を飛ばすことはない）
 * - 逆再生で逆順に辿られる（電源は逆再生されない）
 *
 * どれも実機と違う。**ランブル（`rumble.ts`）とは入る場所が違う** — あちらは
 * 構造振動なので溝の変位、こちらは電気なので信号の後段である。
 *
 * ## 3つの注入点が別々である理由
 *
 * | | 入る場所 | 電気負荷 | RIAA再生特性 |
 * |---|---|---|---|
 * | **cartridgeInduction** | コイルへの誘導。**機械応答の後、電気負荷の前** | **かかる** | **かかる** |
 * | **cableHum** / **groundLoop** | 配線とアースループ。**電気負荷の後、RIAA の前** | かからない | **かかる** |
 * | **electronicsHum** | フォノ段以後の電源リプルなど。**RIAA の後** | かからない | かからない |
 *
 * RIAA再生特性は 50Hz を 1kHz に対して約 +17dB 持ち上げるので、**同じ大きさで
 * 混入しても、前段ほど大きく聞こえる**。実機で入力段のシールドとアースが重要な
 * のはこれが理由であり、ここでは経路を分けるだけでその差が出る。
 * **ある段の振幅で別の段を代用しないこと。**
 *
 * **コイルに誘導された電圧は電気負荷を通る。** コイルのインダクタンスと負荷が
 * 作る共振は、その電圧がどこで生まれたかを区別しない — 針が動かした電圧と
 * まったく同じ扱いになる。だから注入点は電気負荷の**前**であって後ではない。
 * 配線から入るものはコイルの後ろなので、その共振を受けない。
 *
 * ## 成分を分ける
 *
 * | 成分 | 周波数 | 実機での出どころ |
 * |---|---|---|
 * | **fundamental** | `mainsHz`（50 / 60） | トランスの漏れ磁束、誘導 |
 * | **rectifier** | `2 × mainsHz`（100 / 120） | **全波整流のリプル。基音とは別の経路** |
 * | **harmonics** | `3× 以上` | 飽和した鉄心、非線形負荷 |
 *
 * 整流成分を基音の高調波として扱わないこと。**出どころが違うので、比率は装置ごとに
 * 独立**である（整流だけ大きいこともあれば、その逆もある）。
 *
 * ## `mainsHz` に既定を焼き込まない
 *
 * 50Hz か 60Hz かは**地域で決まる設定**であって、このデッキの性質ではない。
 * `IDEAL_HUM` が持っている値は「振幅が 0 なので効いていない」ものにすぎず、
 * どちらかを既定として主張していない。使う側が必ず選ぶこと。
 *
 * ## 針を上げてもハムは残る
 *
 * コイルは磁界の中にあり、配線はフォノ段へ繋がったままなので、**針が溝から
 * 離れても誘導は止まらない**。エンジンは機械系が何も出さない状態でもこの経路を
 * 回す。**ここが「盤を止めれば消えるもの」との決定的な違い**である。
 *
 * ## まだ入っていないもの
 *
 * 空気中を伝わるモーター音、部屋の響き。どちらもこのモジュールの担当ではない。
 */

const TWO_PI = Math.PI * 2;

/** 選べる電源周波数。**どちらも既定ではない** — 地域で決まる設定である。 */
export const MAINS_FREQUENCIES = [50, 60] as const;
export type MainsHz = (typeof MAINS_FREQUENCIES)[number];

/**
 * 1つの注入点が持つ成分。**基音・整流・高調波は出どころが違うので別々に持つ。**
 * 振幅はフルスケールに対する比（無次元）。**0 で無し。**
 */
export interface HumComponents {
  /** `mainsHz` そのもの。トランスからの誘導。 */
  fundamental: number;
  /** `2 × mainsHz`。**全波整流のリプルで、基音の高調波ではない。** */
  rectifier: number;
  /** `3 × mainsHz` から上。1/k で重み付けする。 */
  harmonics: number;
  /** 高調波を何本重ねるか。 */
  harmonicCount: number;
}

export interface HumParameters {
  /** 個体ごとの seed。位相はここからだけ決まる。 */
  seed: number;
  /** 電源周波数 Hz。**50 / 60 を選ぶ。既定として焼き込まない。** */
  mainsHz: MainsHz;
  /**
   * カートリッジのコイルへの誘導。**機械応答の後、電気負荷の前**に入るので、
   * コイルの負荷共振と RIAA の両方を受ける。
   */
  cartridgeInduction: HumComponents & {
    /**
     * アーム位置で誘導の強さがどれだけ変わるか（0〜1）。カートリッジが内周へ
     * 寄るほどモーターとトランスに近づく。
     */
    positionSensitivity: number;
    /**
     * 盤の回転角で誘導の強さがどれだけ変わるか（0〜1）。プラッターマグネットの
     * 漏れ磁束は回転と一緒に向きを変える。
     */
    platterSensitivity: number;
    /**
     * 左右コイルの向き rad。**45°(π/4) で左右が完全に等しくなり**、そこから
     * 外れるほど振幅が偏り、0 と π/2 では片方が消える。符号が反転すれば位相も
     * 反転する — 45/45 のコイルは直交しているので、1つの磁界を2つの向きへ
     * 射影しただけでこうなる。
     */
    coilAngleRadians: number;
  };
  /**
   * 配線（シェルリード・フォノケーブル）への誘導。**電気負荷の後、RIAA再生の
   * 前**に入る。コイルの後ろなので**負荷共振は受けない**が、RIAA は受ける。
   */
  cableHum: HumComponents;
  /**
   * グラウンドループ。`cableHum` と同じ位置（電気負荷の後・RIAA の前）に入り、
   * **左右に共通成分を持てる**のが違い。アース線は1本なので、左右へ同じものが
   * 乗る。
   */
  groundLoop: HumComponents & {
    /** 1 で左右完全に同相、0 で無相関。 */
    commonMode: number;
  };
  /** フォノ段以後の電気ノイズ。**RIAA再生特性より後**なのでそのまま出る。 */
  electronics: HumComponents;
}

/** 何も混入しないデッキ。**この設定では1サンプルも足されない。** */
export const IDEAL_HUM: HumParameters = {
  seed: 0,
  // 振幅が 0 なので効いていない。**どちらかを既定として主張していない。**
  mainsHz: 50,
  cartridgeInduction: {
    fundamental: 0,
    rectifier: 0,
    harmonics: 0,
    harmonicCount: 3,
    positionSensitivity: 0,
    platterSensitivity: 0,
    coilAngleRadians: Math.PI / 4,
  },
  cableHum: { fundamental: 0, rectifier: 0, harmonics: 0, harmonicCount: 3 },
  groundLoop: {
    fundamental: 0,
    rectifier: 0,
    harmonics: 0,
    harmonicCount: 3,
    commonMode: 1,
  },
  electronics: { fundamental: 0, rectifier: 0, harmonics: 0, harmonicCount: 3 },
};

/**
 * counter-based hash。**乱数を引かない。**
 *
 * ponytail: `discShape.ts` / `wowFlutter.ts` / `rumble.ts` と同じもの。4つ目なので、
 * 次に触るときは共有モジュールへ出すこと。
 */
function humHash(seed: number, counter: number): number {
  let x = (seed ^ Math.imul(counter | 0, 0x9e3779b1)) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

const clamp = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, low), high) : fallback;

/** 重ねられる高調波の上限。1サンプルあたりの仕事を有界に保つ。 */
const MAX_HARMONICS = 16;
/** 振幅の上限。どんな設定でも出力を撒き散らさない。 */
const MAX_AMPLITUDE = 4;

/** 1つの成分列。周波数と振幅と位相を並べて持つ。 */
interface Tones {
  rate: Float64Array;
  gain: Float64Array;
  phase: Float64Array;
  /** 2本目の位相。左右を無相関にしたい段だけが使う。 */
  phaseB: Float64Array;
  active: boolean;
}

const EMPTY: Tones = {
  rate: new Float64Array(0),
  gain: new Float64Array(0),
  phase: new Float64Array(0),
  phaseB: new Float64Array(0),
  active: false,
};

/**
 * 成分列を組む。**基音・整流・高調波をそれぞれ別の振幅で並べる。**
 *
 * ナイキストを越える成分は落とす（折り返して別の音になるくらいなら出さない）。
 */
function buildTones(
  components: HumComponents,
  mainsHz: number,
  sampleRate: number,
  seed: number,
  salt: number,
): Tones {
  const limit = sampleRate * 0.45;
  const rate: number[] = [];
  const gain: number[] = [];
  const phase: number[] = [];
  const phaseB: number[] = [];

  const add = (multiple: number, amplitude: number, index: number) => {
    const level = clamp(amplitude, 0, MAX_AMPLITUDE, 0);
    const hz = mainsHz * multiple;
    if (!(level > 0) || !(hz > 0) || hz > limit) return;
    rate.push(TWO_PI * hz);
    gain.push(level);
    phase.push(humHash(seed, salt + index) * TWO_PI);
    phaseB.push(humHash(seed, salt + 0x40 + index) * TWO_PI);
  };

  add(1, components.fundamental, 0);
  // **整流は基音の高調波ではない。** 別の振幅で、別の経路から出る。
  add(2, components.rectifier, 1);
  const count = Math.round(clamp(components.harmonicCount, 0, MAX_HARMONICS, 0));
  for (let k = 1; k <= count; k++) {
    // 3倍から上。高いほど小さいのが実機の形。
    add(2 + k, components.harmonics / k, 2 + k);
  }

  return {
    rate: new Float64Array(rate),
    gain: new Float64Array(gain),
    phase: new Float64Array(phase),
    phaseB: new Float64Array(phaseB),
    active: rate.length > 0,
  };
}

const toneAt = (tones: Tones, phases: Float64Array, t: number) => {
  let sum = 0;
  for (let k = 0; k < tones.rate.length; k++) {
    sum += tones.gain[k] * Math.sin(tones.rate[k] * t + phases[k]);
  }
  return sum;
};

export interface Hum {
  /** 理想設定なら true。このとき出力はすべて厳密に 0。 */
  readonly bypassed: boolean;
  /** **機械応答の後、電気負荷の前**に足すコイルへの誘導。 */
  readonly inductionLeft: number;
  readonly inductionRight: number;
  /** **電気負荷の後、RIAA の前**に足す配線とアースループ。 */
  readonly cableLeft: number;
  readonly cableRight: number;
  /** **RIAA再生特性より後**に足すフォノ段以後の電気ハム。 */
  readonly electronicsLeft: number;
  readonly electronicsRight: number;
  configure(parameters: HumParameters): void;
  /**
   * 1サンプル分を求める。**位置ではなく時刻の純関数**で、状態を持たない。
   *
   * @param seconds     音声クロック上の絶対時刻（累積フレーム / サンプルレート）
   * @param radiusRatio 針先半径 / 盤の半径。アーム位置による変化に使う
   * @param platterAngle 盤の回転角 rad。漏れ磁束の向きに使う
   */
  sample(seconds: number, radiusRatio: number, platterAngle: number): void;
}

export function createHum(
  sampleRate: number,
  initial: HumParameters = IDEAL_HUM,
): Hum {
  let inductionTones = EMPTY;
  let cableTones = EMPTY;
  let groundTones = EMPTY;
  let electronicsTones = EMPTY;
  let coilLeft = 0;
  let coilRight = 0;
  let positionSensitivity = 0;
  let platterSensitivity = 0;
  let commonMode = 1;

  const mutable = () => model as { -readonly [K in keyof Hum]: Hum[K] };

  const model: Hum = {
    bypassed: true,
    inductionLeft: 0,
    inductionRight: 0,
    cableLeft: 0,
    cableRight: 0,
    electronicsLeft: 0,
    electronicsRight: 0,

    configure(parameters) {
      const seed = Number.isFinite(parameters.seed) ? parameters.seed | 0 : 0;
      // 50 / 60 以外が来ても落ちない。既定へ寄せずに近いほうへ丸める。
      const mains = parameters.mainsHz === 60 ? 60 : 50;

      inductionTones = buildTones(
        parameters.cartridgeInduction,
        mains,
        sampleRate,
        seed,
        0x600,
      );
      cableTones = buildTones(
        parameters.cableHum,
        mains,
        sampleRate,
        seed,
        0x700,
      );
      groundTones = buildTones(
        parameters.groundLoop,
        mains,
        sampleRate,
        seed,
        0x800,
      );
      electronicsTones = buildTones(
        parameters.electronics,
        mains,
        sampleRate,
        seed,
        0x900,
      );

      // **1つの磁界を2つのコイルへ射影する。** 45° で左右が等しくなり、そこから
      // 外れると振幅が偏り、符号が変われば位相が反転する。
      const angle = Number.isFinite(
        parameters.cartridgeInduction.coilAngleRadians,
      )
        ? parameters.cartridgeInduction.coilAngleRadians
        : Math.PI / 4;
      coilLeft = Math.cos(angle);
      coilRight = Math.sin(angle);

      positionSensitivity = clamp(
        parameters.cartridgeInduction.positionSensitivity,
        0,
        1,
        0,
      );
      platterSensitivity = clamp(
        parameters.cartridgeInduction.platterSensitivity,
        0,
        1,
        0,
      );
      commonMode = clamp(parameters.groundLoop.commonMode, 0, 1, 1);

      const self = mutable();
      self.bypassed = !(
        inductionTones.active ||
        cableTones.active ||
        groundTones.active ||
        electronicsTones.active
      );
      self.inductionLeft = 0;
      self.inductionRight = 0;
      self.cableLeft = 0;
      self.cableRight = 0;
      self.electronicsLeft = 0;
      self.electronicsRight = 0;
    },

    sample(seconds, radiusRatio, platterAngle) {
      const self = mutable();
      if (model.bypassed) {
        self.inductionLeft = 0;
        self.inductionRight = 0;
        self.cableLeft = 0;
        self.cableRight = 0;
        self.electronicsLeft = 0;
        self.electronicsRight = 0;
        return;
      }

      const t = Number.isFinite(seconds) ? seconds : 0;

      // **誘導の強さはアームがどこにいるかで変わる。** 内周へ寄るほど強い。
      const radius = clamp(radiusRatio, 0, 2, 1);
      const position = 1 + positionSensitivity * (1 - radius);
      // **盤の回転で漏れ磁束の向きが変わる。** 針を上げていても盤が回っていれば動く。
      const platter =
        1 +
        platterSensitivity *
          Math.cos(Number.isFinite(platterAngle) ? platterAngle : 0);
      const field = position * platter;

      // **コイルへの誘導は1つの波形を2つのコイルへ射影する。** 左右で位相を
      // 別々に振らないのは、磁界が1つしかないからである。
      const induced = inductionTones.active
        ? field * toneAt(inductionTones, inductionTones.phase, t)
        : 0;
      self.inductionLeft = induced * coilLeft;
      self.inductionRight = induced * coilRight;

      // 配線は左右別なので、位相も別で構わない。
      let cableL = 0;
      let cableR = 0;
      if (cableTones.active) {
        cableL += toneAt(cableTones, cableTones.phase, t);
        cableR += toneAt(cableTones, cableTones.phaseB, t);
      }
      // **グラウンドループは左右に共通成分を持つ。** アース線は1本なので、
      // commonMode = 1 なら完全同相になり、差分では厳密に消える。
      if (groundTones.active) {
        const common = toneAt(groundTones, groundTones.phase, t);
        const independent = toneAt(groundTones, groundTones.phaseB, t);
        const shared = commonMode * common;
        cableL += shared + (1 - commonMode) * independent;
        cableR += shared - (1 - commonMode) * independent;
      }
      self.cableLeft = cableL;
      self.cableRight = cableR;

      // フォノ段以後。RIAA の後ろなので、そのまま出力へ乗る。
      if (electronicsTones.active) {
        self.electronicsLeft = toneAt(
          electronicsTones,
          electronicsTones.phase,
          t,
        );
        self.electronicsRight = toneAt(
          electronicsTones,
          electronicsTones.phaseB,
          t,
        );
      } else {
        self.electronicsLeft = 0;
        self.electronicsRight = 0;
      }
    },
  };

  model.configure(initial);
  return model;
}
