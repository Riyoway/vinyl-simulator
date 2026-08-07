/**
 * 有限な針先形状によるトレーシング歪み — **針は点ではなく面で溝に触れる。**
 *
 * ```
 *   溝壁変位 → [針先形状による空間サンプリング] → 差分 → 接触モデル → …
 *               ↑ ここ
 * ```
 *
 * ## ローパスでもwaveshaperでもない
 *
 * トレーシング歪みは「高域が落ちる」ことでも「振幅が非線形に潰れる」ことでもない。
 * **丸い針先が、自分より曲率のきつい谷へ入れない**という幾何そのものである。
 *
 * ```
 *          ○ ← 針先（半径 a）
 *      ___/ \___          谷が針より鋭いと、針は両側の山に乗って
 *     /  谷に入れない \       谷底へ届かない
 * ```
 *
 * 山は針が届くので**そのまま**、谷だけが浅くなる。だから
 *
 * - 波形が**非対称に歪む**（偶数次高調波が出る）。ローパスでは絶対にこうならない
 * - 歪むかどうかは振幅ではなく**曲率**で決まる。同じ振幅でも波長が短ければ歪む
 * - 追える溝では**1サンプルも変わらない**。「effectが薄くかかる」ということがない
 *
 * ## 針先中心の軌跡は、溝の膨張（morphological dilation）である
 *
 * 半径 a の円が壁の外側を転がるとき、その中心は
 *
 * ```
 *   center(x) = max  [ wall(x + u) + √(a² − u²) ]        |u| ≤ a
 *                u
 * ```
 *
 * を辿る。**`max` が本質**で、これがあるから山は保たれ谷だけが埋まる。線形な
 * 演算では書けない（畳み込みなら山も谷も同じだけ鈍る）。
 *
 * 実装は「理想の点針が読む値」との**差**だけを求める。
 *
 * ```
 *   excess(x) = max[ wall(x+u) + c(u) ] − wall(x)          c(u) = √(a²−u²) − a
 * ```
 *
 * `a = 0` なら窓が潰れて `c(0) = 0`、`excess ≡ 0` になる。**理想の針では
 * 既存の帯域制限読み出しがそのまま残り、出力はビット単位で一致する。**
 *
 * ## 内周ほど歪む理由も、この幾何から出る
 *
 * 窓の幅 `a` は**距離**（メートル）で決まっているのに、溝の1サンプルが表す距離は
 * 線速度で決まる。
 *
 * ```
 *   1サンプルの距離 = ω_cut · r / grooveSampleRate
 * ```
 *
 * 内周では `r` が小さいので同じ距離により多くのサンプルが入る＝**同じ音声周波数の
 * 空間波長が短くなり、針の窓に対して相対的に鋭くなる**。内周歪みは別に実装する
 * ものではなく、ここから自動的に出る。
 *
 * ## 針先形状
 *
 * 効くのは**溝に沿った方向の曲率半径**だけである。横方向の寸法は溝の中でどの高さに
 * 座るかを決めるので、pinch effect の側に効く。
 *
 * | 形状 | `scanningRadius`（溝方向） | `transverseRadius`（横方向） |
 * |---|---|---|
 * | **conical**（丸針） | 大きい＝同じ | 同じ |
 * | **elliptical**（楕円針） | **小さい** | 大きい |
 * | **line-contact**（ラインコンタクト） | **さらに小さい** | さらに大きい |
 *
 * 楕円針やラインコンタクト針が高域に強いのは、この1つ目の数字が小さいからである。
 * **2つの半径を別々に持つことが、3種類を表現できることそのもの。**
 *
 * ## pinch effect も同じ幾何から
 *
 * カッターは**接線方向に対して向きを固定**して溝を切る。だから溝が横に振れている
 * ところでは、溝の進行方向に垂直に測った幅が `cosθ` だけ狭くなる（θ は溝の進行
 * 方向が接線方向となす角）。45°のV溝では幅が狭まることは底が上がることと同じなので、
 * 針は持ち上がる。
 *
 * ```
 *   tanθ    = d(横方向変位)/d(距離)          ← 空間微分。時間微分ではない
 *   持ち上がり = √2 · transverseRadius · (1 − cosθ)
 * ```
 *
 * `1 − cosθ` は θ の偶関数なので、**変調の2倍の周波数**で出る。実機の pinch effect
 * が2倍音として現れるのはこれである。垂直成分なので L−R（逆相）へ入る。
 *
 * ## 数値について
 *
 * **実在針の寸法は書かない。** 既定は `IDEAL_STYLUS_TIP`（半径ゼロ＝点で読む針）で
 * 完全バイパス。実機の値が分かった時点で2つの半径へ入れれば、構造は既にある。
 */

/**
 * 針先の接触面。**2つの曲率半径だけで conical / elliptical / line-contact を
 * 表現する**（冒頭の表）。
 */
export interface StylusTipParameters {
  /**
   * **溝に沿った方向**の接触面の曲率半径 m。トレーシング歪みを決める唯一の寸法。
   * **0 が理想** — 点で読む針は歪まない。
   */
  scanningRadius: number;
  /**
   * **溝を横切る方向**の曲率半径 m。溝の中で座る高さを決めるので、pinch effect の
   * 大きさに効く。**0 で pinch なし。**
   */
  transverseRadius: number;
}

/**
 * 点で読む理想の針。**この設定では窓が潰れ、既存の読み出しが1ビットも変わらない。**
 *
 * プリセット（conical / elliptical / line-contact）はこの形のまま値を入れれば作れる。
 * **推測した寸法は置いていない。**
 */
export const IDEAL_STYLUS_TIP: StylusTipParameters = {
  scanningRadius: 0,
  transverseRadius: 0,
};

const clamp = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, low), high) : fallback;

/** 針先の寸法の上限 m。1mm を超える針先は無い。 */
const MAX_RADIUS = 1e-3;
/** 窓の半幅の上限（溝サンプル）。1サンプルあたりの仕事を有界に保つ。 */
const MAX_HALF_SAMPLES = 64;
/** 窓を片側何点で刻むか。窓が広いほど細かく刻む。 */
const MIN_STEPS = 3;
const MAX_STEPS = 24;
/** pinch の傾きを測る中心差分の幅（溝サンプル）。 */
const SLOPE_DELTA = 0.5;

/**
 * 溝の外は 0 として読む（`resampler.ts` と同じ約束）。
 *
 * **膨張は「点で読む針との差」として使う**ので、ここと中心の読みが同じ基底で
 * 揃ってさえいればよい。帯域制限された本読みはエンジン側がそのまま持っている。
 */
export function sampleGrooveWall(wall: Float32Array, at: number): number {
  const index = Math.floor(at);
  if (index < 0 || index + 1 >= wall.length) return 0;
  const frac = at - index;
  return wall[index] * (1 - frac) + wall[index + 1] * frac;
}

/**
 * **針先が実際に触れる局所盤面形状。**
 *
 * ここに入ってよいのは**盤に固定された形**だけである — 切られた溝、表面粗さ、
 * 埃、傷。針先はそれらを面で撫でるので、**埃も傷も針先半径で丸められる**。
 *
 * 入れてはならないもの（どれも「盤の上の形」ではない）:
 *
 * | | なぜ違うか |
 * |---|---|
 * | **warp / dish** | 盤全体の巨視的な形。アームの支持面であって、針先が撫でる凹凸ではない |
 * | **eccentricity** | レコード座標そのものの変換。**どこを読むか**を決めるだけで、局所形状ではない |
 * | **rumble** | プラッターとアームの相対振動。盤に刻まれていない |
 * | **hum** | 電気。そもそも形ではない |
 *
 * これらは針先の窓を通した**後**に、相対変位として足す。針先で丸めてしまうと、
 * 盤が上下しただけで高域が失われるという実機に無い挙動になる。
 */
export interface LocalGrooveProfile {
  /** 直近の `readAt` の結果。割り当てを避けるため、ここに書く。 */
  readonly left: number;
  readonly right: number;
  /** 針の中心から溝サンプルで `offset` だけ離れた点の局所形状を読む。 */
  readAt(offset: number): void;
}

export interface StylusTip {
  /** 理想設定なら true。このとき出力はすべて厳密に 0。 */
  readonly bypassed: boolean;
  /**
   * 理想の点針との**差**。壁ごとに別々に評価する（別の面なので当然）。
   * 追える溝では厳密に 0 で、そこでは出力が1ビットも変わらない。
   */
  readonly left: number;
  readonly right: number;
  /** pinch による垂直方向の持ち上がり（壁と同じ単位）。**常に 0 以上。** */
  readonly vertical: number;
  configure(parameters: StylusTipParameters): void;
  /**
   * 局所盤面形状を針先の形で読む。**位置の純関数で、状態を持たない。** 逆走しても
   * 同じ位置からは同じ値が返り、ブロックの切り方にも速度にも依らない。
   *
   * @param profile 針が触れる**盤に固定された形**だけを返すもの（上の注記）
   * @param metresPerSample 溝1サンプルが表す進行方向の距離 m。**内周ほど小さい**
   * @param unitsToMetres 変位1単位が表すメートル
   */
  read(
    profile: LocalGrooveProfile,
    metresPerSample: number,
    unitsToMetres: number,
  ): void;
}

export function createStylusTip(
  initial: StylusTipParameters = IDEAL_STYLUS_TIP,
): StylusTip {
  let scanningRadius = 0;
  let transverseRadius = 0;

  const mutable = () =>
    model as { -readonly [K in keyof StylusTip]: StylusTip[K] };

  /** 窓を1度だけ走って両壁の膨張を同時に求める。溝の読み直しは1回で済む。 */
  let bestLeft = 0;
  let bestRight = 0;

  /**
   * 両壁の膨張。**`max` が山を残し谷だけを埋める。**
   *
   * **左右は別々に最大を取る**（別の面なので、片方の山でもう片方が持ち上がっては
   * ならない）。窓の走査だけを共有している。
   *
   * @param half 窓の半幅（溝サンプル）
   * @param sagitta 円の落ち込みをサンプルから変位単位へ直す係数
   */
  function dilate(
    profile: LocalGrooveProfile,
    half: number,
    steps: number,
    sagitta: number,
  ): void {
    profile.readAt(0);
    // u = 0 では円の落ち込みが 0 なので、中心は必ず候補に入っている。
    const centreLeft = profile.left;
    const centreRight = profile.right;
    bestLeft = centreLeft;
    bestRight = centreRight;

    const halfSquared = half * half;
    for (let k = 1; k <= steps; k++) {
      const u = (k / steps) * half;
      // 円が u だけ離れたところでどれだけ落ちるか。溝の単位へ直して足す。
      const drop = (Math.sqrt(Math.max(0, halfSquared - u * u)) - half) * sagitta;

      profile.readAt(u);
      if (profile.left + drop > bestLeft) bestLeft = profile.left + drop;
      if (profile.right + drop > bestRight) bestRight = profile.right + drop;

      profile.readAt(-u);
      if (profile.left + drop > bestLeft) bestLeft = profile.left + drop;
      if (profile.right + drop > bestRight) bestRight = profile.right + drop;
    }

    bestLeft -= centreLeft;
    bestRight -= centreRight;
  }

  const model: StylusTip = {
    bypassed: true,
    left: 0,
    right: 0,
    vertical: 0,

    configure(parameters) {
      scanningRadius = clamp(parameters.scanningRadius, 0, MAX_RADIUS, 0);
      transverseRadius = clamp(parameters.transverseRadius, 0, MAX_RADIUS, 0);
      const self = mutable();
      self.bypassed = !(scanningRadius > 0 || transverseRadius > 0);
      self.left = 0;
      self.right = 0;
      self.vertical = 0;
    },

    read(profile, metresPerSample, unitsToMetres) {
      const self = mutable();
      if (model.bypassed) {
        self.left = 0;
        self.right = 0;
        self.vertical = 0;
        return;
      }

      const perSample = Number.isFinite(metresPerSample) ? metresPerSample : 0;
      const perUnit = Number.isFinite(unitsToMetres) ? unitsToMetres : 0;
      if (!(perSample > 0) || !(perUnit > 0)) {
        self.left = 0;
        self.right = 0;
        self.vertical = 0;
        return;
      }

      // **トレーシング歪み。** 窓の幅は距離で決まっているので、内周ほど多くの
      // サンプルを覆う＝波長に対して相対的に広くなる。
      if (scanningRadius > 0) {
        const half = Math.min(scanningRadius / perSample, MAX_HALF_SAMPLES);
        const steps = Math.round(clamp(half * 2, MIN_STEPS, MAX_STEPS, MIN_STEPS));
        dilate(profile, half, steps, perSample / perUnit);
        self.left = bestLeft;
        self.right = bestRight;
      } else {
        self.left = 0;
        self.right = 0;
      }

      // **pinch effect。** 溝の進行方向が接線からどれだけ傾いているか（空間微分）
      // だけで決まる。時間微分ではないので、速度を変えても同じところで同じだけ出る。
      if (transverseRadius > 0) {
        profile.readAt(SLOPE_DELTA);
        const ahead = (profile.left + profile.right) * Math.SQRT1_2;
        profile.readAt(-SLOPE_DELTA);
        const behind = (profile.left + profile.right) * Math.SQRT1_2;
        // d(横方向変位 m)/d(距離 m)。無次元の傾き。
        const slope =
          ((ahead - behind) * perUnit) / (2 * SLOPE_DELTA * perSample);
        // 1 − cosθ。θ の偶関数なので**変調の2倍の周波数**で出る。
        const rise =
          Math.SQRT2 * transverseRadius * (1 - 1 / Math.sqrt(1 + slope * slope));
        self.vertical = rise / perUnit;
      } else {
        self.vertical = 0;
      }

      if (!Number.isFinite(self.left)) self.left = 0;
      if (!Number.isFinite(self.right)) self.right = 0;
      if (!Number.isFinite(self.vertical)) self.vertical = 0;
    },
  };

  model.configure(initial);
  return model;
}
