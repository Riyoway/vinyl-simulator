/**
 * 針と溝の接触 — **溝が要求する加速度を、針が出せるかどうか。**
 *
 * 信号系での位置は「溝変位の差分（＝壁の速度）」と「カートリッジ」の間。
 *
 * ```
 *   溝(変位) → 差分 → [接触モデル] → 幾何行列・共振（cartridge） → RIAA再生
 *                      ↑ ここ
 * ```
 *
 * ## 何を判定しているのか
 *
 * 45/45の壁は互いに**直交する**。だから針にかかる力を壁の法線へ射影すると、
 * 左右の項が消えて壁ごとに独立した1次元の問題になる（これがこのモジュールが
 * 壁を別々に評価してよい理由であり、手抜きではない）。
 *
 * 壁の法線方向でつり合いを書くと、接触力は
 *
 * ```
 *   N = m·a + VTF/√2            （a = その壁が要求する加速度）
 * ```
 *
 * 壁は押すことしかできない（N ≥ 0）ので、
 *
 * ```
 *   a < −VTF/(√2·m)  になった瞬間に針は壁から離れる
 * ```
 *
 * 針圧が大きいほど、針先が軽いほど、離れにくい。**これがトラッキング能力の
 * 定義そのもの**であり、後付けの補正ではない。
 *
 * 離れている間、針を溝へ戻すのは針圧とカンチレバーだけなので、隙間 g は
 *
 * ```
 *   g̈ = −a − VTF/(√2·m) − ω₀²g − 2ζω₀ġ        ω₀ = 1/√(m·C)
 * ```
 *
 * に従い、g が 0 へ戻ったところで非弾性に着地する。**離れる瞬間の g̈ は
 * ちょうど（能力 − 要求）なので、しきい値をまたいだ瞬間に段差が出ない** —
 * 要求が能力を超えたぶんだけ、連続に歪む。
 *
 * ## 座標の向き（ここを間違えると縦と横が入れ替わる）
 *
 * 溝バッファは 45/45 の慣習（**L = R が横方向**）で壁を持っている。壁の物理的な
 * 法線は互いに向き合っているので、右壁の物理量は保存値の**符号を反転**したもの
 * になる（`cartridge.ts` の `vertical = (wL − wR)/√2` から出る）。判定と積分は
 * 物理側で行い、出力で戻す。
 *
 * この符号のおかげで、
 *
 * - 横方向の盤では、左壁と右壁が**互いに逆の半周期**で離れる（片側だけ歪まない）
 * - 針が浮くこと（縦方向）は**逆相**として出る。実機のミストラッキングと同じ
 * - 正転・逆転は役割が入れ替わるだけで、離れる量は変わらない
 *
 * ## 数値について
 *
 * **実在カートリッジの値は書かない。** 既定は `IDEAL_STYLUS`（質量ゼロ）で、
 * このとき入力をビット単位でそのまま返す — 質量のない針はどんな溝も追えるし、
 * 落としても鳴らない。実機の値が分かった時点で `StylusParameters` へ入れれば、
 * 構造は既にある。
 */

/** 針と溝の関係を決める5つ。**既定は理想で、推測値は一つも入っていない。** */
export interface StylusParameters {
  /** 針圧 N（VTF）。1.5gf なら 0.0147。 */
  trackingForce: number;
  /**
   * 実効針先質量 kg。**0 が理想** — 質量がなければ力も要らない。
   * この値が 0 か非有限のとき、モデル全体がバイパスされる。
   */
  stylusMass: number;
  /** カンチレバーのコンプライアンス m/N。大きいほど柔らかい。 */
  compliance: number;
  /** 減衰比 ζ。1 が臨界減衰。 */
  damping: number;
  /**
   * フルスケール（1kHzで振幅1）の変調に対応する**片壁の速度 m/s**。
   *
   * 溝バッファは無次元なので、力の話をするにはどこか一箇所で物理量へ結びつける
   * 必要がある。**較正用の目盛りであって、カートリッジの仕様ではない。**
   */
  referenceVelocity: number;
}

/**
 * 標準的なカッティングレベル（1kHz・横方向 5cm/s）の**片壁ぶん**。
 *
 * 横方向は両壁が同相で動くので、片壁は 1/√2。レベルの取り決めであって、
 * 実機カートリッジから採った数値ではない。
 */
export const REFERENCE_WALL_VELOCITY = 0.05 * Math.SQRT1_2;

/**
 * 理想の針。**質量ゼロ・力は無限・カンチレバーは無限に柔らかい。**
 *
 * この設定でモデルは完全にバイパスされ、壁の速度がそのまま通る。針を降ろしても
 * 過渡音は出ない — 運動量のない針は着地しても何も起こさない。実機の値を入れた
 * 瞬間に、追従限界も着地音も同時に現れる。
 */
export const IDEAL_STYLUS: StylusParameters = {
  trackingForce: Number.POSITIVE_INFINITY,
  stylusMass: 0,
  compliance: Number.POSITIVE_INFINITY,
  damping: 1,
  referenceVelocity: REFERENCE_WALL_VELOCITY,
};

const clamp = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, low), high) : fallback;

/**
 * 針圧のうち、片壁の法線方向に効くぶん。
 *
 * 鉛直の針圧を、鉛直から±45°にある2枚の壁の法線へ分配すると VTF/√2 になる。
 * **幾何であって、カートリッジ固有の数値ではない。**
 */
const WALL_FORCE_FRACTION = Math.SQRT1_2;

/** 着地の鉛直速度が片壁の法線へ落ちる割合。同じ45°。 */
const LANDING_TO_WALL = Math.SQRT1_2;

/** 右壁の物理的な向きは保存値の逆。上の「座標の向き」を参照。 */
const WALL_SIGN = [1, -1] as const;

export interface Stylus {
  /** 理想設定なら true。このとき `process` は入力をそのまま返す。 */
  readonly bypassed: boolean;
  /** 直近の `process` の出力。割り当てを避けるため、ここに書く。 */
  readonly left: number;
  readonly right: number;
  /** 直近サンプルでどちらかの壁から離れていたか＝ミストラッキング中。 */
  readonly airborne: boolean;
  /**
   * **壁ごとの**接触の有無。摩耗（`wear.ts`）は片方の壁だけを削れるので、
   * まとめた `airborne` では足りない。**判定は既にあるものをそのまま出すだけ**で、
   * 接触モデルの挙動は1ビットも変わらない。
   */
  readonly airborneLeft: boolean;
  readonly airborneRight: boolean;
  /** 接触を失ったサンプル数の累計（壁ごとに数える）。決定論的。 */
  readonly contactLossSamples: number;
  /** 追従できる加速度の限界（溝の単位/s²）。理想なら Infinity。 */
  readonly trackingLimit: number;
  configure(parameters: StylusParameters): void;
  /**
   * 針を降ろす。`speed` は**実際の着地速度 m/s**（≥0）。
   *
   * 針先は溝に当たった瞬間に止まるが、**カートリッジ本体はまだ降りている**。
   * その差を吸収するのはカンチレバーであり、コイルが拾うのはそのたわみの速度
   * ——着地速度から始まって、共振周波数で鳴りながら減衰する。速度0でそっと
   * 置けば何も起きない。
   */
  land(speed: number): void;
  /** 壁の速度を受け取り、針先が実際に出す速度を `left` / `right` へ書く。 */
  process(left: number, right: number): void;
  /** 接触の記憶を落とす。針を上げたときと、溝の別の場所へ跳んだとき。 */
  reset(): void;
}

export function createStylus(
  sampleRate: number,
  initial: StylusParameters = IDEAL_STYLUS,
): Stylus {
  const dt = 1 / sampleRate;

  /** 追従できる加速度の限界。溝の単位/s²。 */
  let maxAccel = Number.POSITIVE_INFINITY;
  /** ω₀²。離れている針を溝へ引き戻すカンチレバーの項。 */
  let omegaSquared = 0;
  /** 2ζω₀。速度に比例する減衰。 */
  let damping = 0;
  /** 着地速度 m/s を、片壁の法線方向の溝単位へ直す係数。 */
  let landingScale = 0;

  // 壁ごとの状態。**物理側**（右壁は符号を戻した側）で持つ。
  const previous = new Float64Array(2);
  const gap = new Float64Array(2);
  const gapRate = new Float64Array(2);
  const touching = [true, true];
  /** 着地でたわんだカンチレバーの残響。溝とは無関係に鳴って減衰する。 */
  const ring = new Float64Array(2);
  const ringRate = new Float64Array(2);
  /** 変位を読み直した直後は差分が意味を持たない。最初の1サンプルは加速度0。 */
  let primed = false;
  let airborne = false;
  let losses = 0;

  /**
   * 片壁を1サンプル進める。**物理側の速度**を受け取り、針先の速度を返す。
   *
   * 接触している間はここが素通しなので、追従できる溝では出力が1ビットも
   * 変わらない。
   */
  function step(wall: number, u: number): number {
    const accel = (u - previous[wall]) * sampleRate;
    previous[wall] = u;

    // 着地の残響。**溝を追えているかとは無関係**で、鳴っていなければ 0 のまま
    // 何も足さない。減衰を陰的に扱うので、ζ をいくつにしても発散しない。
    let sounding = 0;
    if (ringRate[wall] !== 0 || ring[wall] !== 0) {
      const rate =
        (ringRate[wall] - omegaSquared * ring[wall] * dt) / (1 + damping * dt);
      const deflection = ring[wall] + rate * dt;
      if (Number.isFinite(rate) && Number.isFinite(deflection)) {
        ringRate[wall] = rate;
        ring[wall] = deflection;
      } else {
        ringRate[wall] = 0;
        ring[wall] = 0;
      }
      sounding = ringRate[wall];
      // 単精度の出力に届かなくなったら止める。無音を厳密に保つため。
      if (Math.abs(sounding) < 1e-9 && Math.abs(ring[wall]) < 1e-9) {
        ringRate[wall] = 0;
        ring[wall] = 0;
      }
    }

    if (touching[wall]) {
      // 壁は押すことしかできない。押す力が要らなくなった時点で離れる。
      if (accel >= -maxAccel) return u + sounding;
      touching[wall] = false;
      gap[wall] = 0;
      gapRate[wall] = 0;
    }

    // 浮いている間、針を戻すのは針圧とカンチレバーだけ。減衰は陰的に扱うので、
    // ζ をいくら大きくしても行き過ぎない。
    let rate =
      (gapRate[wall] + (-maxAccel - accel - omegaSquared * gap[wall]) * dt) /
      (1 + damping * dt);
    let separation = gap[wall] + rate * dt;

    if (!Number.isFinite(separation) || !Number.isFinite(rate)) {
      // どんな設定を入れられても値を撒き散らさない。溝へ戻して仕切り直す。
      separation = 0;
      rate = 0;
    }

    losses += 1;
    if (separation > 0) {
      gap[wall] = separation;
      gapRate[wall] = rate;
      airborne = true;
      return u + rate + sounding;
    }

    // 溝へ戻った。跳ね返らせない — 弾ませると軽いミストラッキングでも
    // 針が浮きっぱなしになる。
    gap[wall] = 0;
    gapRate[wall] = 0;
    touching[wall] = true;
    return u + sounding;
  }

  const stylus: Stylus = {
    bypassed: true,
    left: 0,
    right: 0,
    airborne: false,
    airborneLeft: false,
    airborneRight: false,
    contactLossSamples: 0,
    trackingLimit: Number.POSITIVE_INFINITY,

    configure(parameters) {
      const force = Math.max(parameters.trackingForce, 0);
      const mass = Math.max(parameters.stylusMass, 0);
      const reference = clamp(
        parameters.referenceVelocity,
        1e-6,
        1,
        REFERENCE_WALL_VELOCITY,
      );

      // 溝の単位/s² へ直した追従限界。質量0（＝理想）なら Infinity になり、
      // 下の bypass 判定がそれを拾う。
      maxAccel = (force * WALL_FORCE_FRACTION) / (mass * reference);

      // カンチレバーの共振。周波数はナイキストの十分手前、減衰は正の有限値へ
      // 丸めるので、**どんな設定でも積分が発散しない**。
      const naturalHz = 1 / (2 * Math.PI * Math.sqrt(mass * parameters.compliance));
      const hz = clamp(naturalHz, 1, sampleRate / 8, sampleRate / 8);
      const zeta = clamp(parameters.damping, 0.02, 20, 1);
      const omega = 2 * Math.PI * hz;
      omegaSquared = omega * omega;
      damping = 2 * zeta * omega;
      landingScale = LANDING_TO_WALL / reference;

      const self = stylus as { bypassed: boolean; trackingLimit: number };
      // 質量ゼロ、あるいは無限の針圧 — どちらも「どんな溝でも追える」。
      // **針圧0はここに入れない。** 追従能力0は「常に離れている」であって、
      // 「常に追える」ではない。
      self.bypassed = !Number.isFinite(maxAccel);
      self.trackingLimit = maxAccel;
      stylus.reset();
    },

    land(speed) {
      if (stylus.bypassed) return;
      stylus.reset();
      if (!Number.isFinite(speed) || speed <= 0) return;
      // 針先が止まった時点でのカンチレバーの相対速度。両壁とも同じ符号
      // ——鉛直の動きなので、保存側では逆相（＝縦方向）として出る。
      const impact = Math.abs(speed) * landingScale;
      ringRate[0] = -impact;
      ringRate[1] = -impact;
    },

    process(left, right) {
      const self = stylus as {
        left: number;
        right: number;
        airborne: boolean;
        airborneLeft: boolean;
        airborneRight: boolean;
        contactLossSamples: number;
      };
      if (stylus.bypassed) {
        self.left = left;
        self.right = right;
        self.airborne = false;
        self.airborneLeft = false;
        self.airborneRight = false;
        return;
      }

      // 右壁は物理的な向きへ直してから判定し、出力で戻す。
      const physicalLeft = WALL_SIGN[0] * left;
      const physicalRight = WALL_SIGN[1] * right;

      if (!primed) {
        previous[0] = physicalLeft;
        previous[1] = physicalRight;
        primed = true;
      }

      airborne = false;
      self.left = WALL_SIGN[0] * step(0, physicalLeft);
      self.right = WALL_SIGN[1] * step(1, physicalRight);
      self.airborne = airborne;
      // 壁ごと。**離れているのは片方だけ**ということが普通に起きる。
      self.airborneLeft = !touching[0];
      self.airborneRight = !touching[1];
      self.contactLossSamples = losses;
    },

    reset() {
      previous[0] = 0;
      previous[1] = 0;
      gap[0] = 0;
      gap[1] = 0;
      gapRate[0] = 0;
      gapRate[1] = 0;
      ring[0] = 0;
      ring[1] = 0;
      ringRate[0] = 0;
      ringRate[1] = 0;
      touching[0] = true;
      touching[1] = true;
      primed = false;
      airborne = false;
      const self = stylus as {
        left: number;
        right: number;
        airborne: boolean;
        airborneLeft: boolean;
        airborneRight: boolean;
      };
      self.left = 0;
      self.right = 0;
      self.airborne = false;
      self.airborneLeft = false;
      self.airborneRight = false;
    },
  };

  stylus.configure(initial);
  return stylus;
}

/** 針圧 gf → N。実機の表記（1.5g など）から入れるとき用。 */
export const gramsForceToNewtons = (grams: number) => grams * 9.80665e-3;

/** コンプライアンス（cu = 10⁻⁶ cm/dyne）→ m/N。カタログ値から入れるとき用。 */
export const complianceUnitsToMetresPerNewton = (cu: number) => cu * 1e-3;
