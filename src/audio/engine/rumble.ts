/**
 * ランブルと構造伝播振動 — **針が読むのは絶対振動ではなく相対変位である。**
 *
 * ```
 *                    軸受け（回転角と速さ）        モーター（駆動中だけ）
 *                              \                  /
 *                               \                /
 *                            振動源（横方向・垂直方向）
 *                            /                    \
 *              platterPath  /                      \  tonearmPath
 *        筐体共振 → 防振材 /                        \ 筐体共振 → 防振材
 *                        ↓                          ↓
 *                  盤面の動き                  カートリッジ本体の動き
 *                        \                          /
 *                         \______   相対変位   ____/
 *                                      ↓
 *                             溝の変位へ足す（差分より前）
 * ```
 *
 * ## 出力へ低域ノイズを足してはならない
 *
 * 後段に足したノイズは、盤を止めても・逆に回しても同じように鳴り続け、針を
 * 上げても消えない。それは「レコード風エフェクト」であってランブルではない。
 *
 * **ランブルが聞こえるのは、盤とカートリッジが違う動き方をするからである。**
 * デッキ全体が剛体として同じだけ揺れれば、針と溝の相対位置は変わらないので
 * 出力は厳密に 0 になる。この打ち消しは後から書いた条件ではなく、2経路の差を
 * 取るという構造そのものから出る（同じ伝達関数を両経路に入れれば 0 になることを
 * 検査で押さえてある）。
 *
 * ## 信号系での位置
 *
 * ```
 *   溝(変位) ＋ 盤面欠陥 ＋ 反り ＋ **ランブル** → 差分 → 接触モデル → …
 *                                    ↑ ここ
 * ```
 *
 * **差分と接触モデルより前**でなければならない。理由は2つある。
 *
 * - 針が実際に揺すられている以上、**それは追従限界を食う**。振動が大きければ
 *   ミストラッキングが起きる — 接触モデルの後ろに置くとこれが出ない。
 * - 溝と同じ変位なので、速度依存も止まったときの挙動も、既存の差分がそのまま
 *   面倒を見る。**専用の分岐は1つも要らない。**
 *
 * ## 2つの振動源
 *
 * | 源 | 索引 | いつ出るか |
 * |---|---|---|
 * | **bearing** | **回転角 φ** ×（速さ） | 盤が回っていれば常に。**手回しでも出る** |
 * | **motor** | **時間** | **駆動中だけ**（`motorRequested`） |
 *
 * 軸受けの荒れはスピンドルに固定された形なので、**回転角で索引する** — 同じ
 * ところを通れば同じ音がして、逆に回せば逆順に辿る。振幅は速さに比例し、
 * **止まれば厳密に 0**（止まった軸受けは鳴らない）。
 *
 * モーター振動は `wowFlutter.ts` の**転流リプルとは別のパラメータ**である。
 * あちらは回転を揺らすトルク、こちらは筐体を揺らす力で、伝わり方も出方も違う。
 * 片方の振幅でもう片方を代用しないこと。
 *
 * ## 停止したら厳密な無音
 *
 * 励振が 0 になってもフィルタは鳴り続けるので、鳴り止んだところで状態ごと
 * 0 へ落とす。**単精度の出力に届かなくなった時点で切る**ので、そこから先は
 * 何を足しても値が変わらない（`stylus.ts` の着地残響と同じ扱い）。
 *
 * ## まだ入っていないもの
 *
 * 電源ハム、空気中を伝わるモーター音、部屋の響き。**どれも Pickup 領域であって
 * ここではない** — 針を上げても鳴り続けるものは、溝の変位に足してはならない。
 */

import { rpmToRadPerSec } from "../../physics/platterMotor";
import {
  createBiquadState,
  processBiquad,
  resetBiquadState,
  type Biquad,
  type BiquadState,
} from "./riaa";

const TWO_PI = Math.PI * 2;

/**
 * 振動が構造を伝わるときの形。**筐体共振と防振材の2段**で、どちらも2次の
 * ローパス（質量とばね1組ぶん）である。
 *
 * 直流利得はちょうど1、極は常に単位円の内側 — Q をいくつにしても発散しない。
 */
export interface RumblePathParameters {
  /** この経路の伝達率。**0 なら伝わらない。** */
  gain: number;
  /** 筐体共振 Hz。ここで持ち上がる。 */
  resonanceHz: number;
  /** その鋭さ。大きいほど尖る。 */
  resonanceQ: number;
  /** 防振材の遮断 Hz。ここから上は伝わらない。 */
  isolationHz: number;
  /** その減衰。 */
  isolationQ: number;
}

export interface RumbleParameters {
  /** デッキごとの seed。**盤の seed とは別物。** */
  seed: number;
  /**
   * 軸受け。**回転角に固定され、速さに比例する。** 止まれば厳密に 0 で、
   * 手回しでも逆回しでも同じように出る。
   */
  bearing: {
    /** 変位の振幅 m（片振幅）。**0 で無し。** */
    amplitude: number;
    /** 1回転あたりに重ねる次数。多いほど広帯域になる。 */
    harmonics: number;
  };
  /**
   * モーター振動。**駆動中だけ。** `wowFlutter` の転流リプル（トルク）とは
   * 別のパラメータで、こちらは筐体を揺らす力である。
   */
  motor: {
    /** 変位の振幅 m（片振幅）。**0 で無し。** */
    amplitude: number;
    /** 帯の中心周波数 Hz。 */
    hz: number;
    /** 重ねる正弦の本数。 */
    components: number;
  };
  /** 振動が**盤面**へ届くまでの経路。 */
  platterPath: RumblePathParameters;
  /** 振動が**カートリッジ本体**へ届くまでの経路。 */
  tonearmPath: RumblePathParameters;
}

/**
 * 揺れないデッキ。**振幅がどちらも 0 なので完全バイパス**で、溝には1ビットも
 * 足されない。
 *
 * 経路の周波数は「筐体と防振材がどのあたりにあるか」を示す構造上の既定にすぎず、
 * **実機を測った値ではない**。実測値が分かった時点で `amplitude` に入れれば、
 * 構造はもうここにある。
 */
export const IDEAL_RUMBLE: RumbleParameters = {
  seed: 0,
  bearing: { amplitude: 0, harmonics: 12 },
  motor: { amplitude: 0, hz: 30, components: 3 },
  platterPath: {
    gain: 1,
    resonanceHz: 45,
    resonanceQ: 4,
    isolationHz: 120,
    isolationQ: 0.7,
  },
  tonearmPath: {
    gain: 0.6,
    resonanceHz: 70,
    resonanceQ: 3,
    isolationHz: 90,
    isolationQ: 0.7,
  },
};

/**
 * counter-based hash。**乱数を引かない。**
 *
 * ponytail: `discShape.ts` / `wowFlutter.ts` と同じもの。3つ目になったので、
 * 次に触るときに共有モジュールへ出すこと。
 */
function rumbleHash(seed: number, counter: number): number {
  let x = (seed ^ Math.imul(counter | 0, 0x9e3779b1)) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

const clamp = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, low), high) : fallback;

/**
 * RBJ の2次ローパス。**直流利得は 1、極は常に単位円の内側。**
 *
 * 質量とばね1組の伝達率そのものなので、筐体にも防振材にも同じ形が使える。
 * 周波数はナイキストの手前へ、Q は正の有限値へ丸めるので、**どんな設定でも
 * 安定である**。
 */
function structuralLowPass(
  hz: number,
  q: number,
  sampleRate: number,
): Biquad {
  const frequency = clamp(hz, 0.5, sampleRate * 0.45, sampleRate * 0.45);
  const quality = clamp(q, 0.1, 20, 0.7);
  const w = (TWO_PI * frequency) / sampleRate;
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

/** 軸受けの振幅が張り付く速さ。手で振り回しても青天井にしない。 */
const MAX_SPEED_RATIO = 4;
/** 単精度の出力に届かない大きさ。ここを割ったら状態ごと切る。 */
const SILENCE_FLOOR = 1e-15;
/** 重ねられる本数の上限。1サンプルあたりの仕事を有界に保つ。 */
const MAX_COMPONENTS = 32;
/** 帯の広がり。中心周波数の ±35% に散らす。 */
const BAND_SPREAD = 0.35;

/** 1経路ぶんの伝達（筐体共振 → 防振材）を、軸ごとの状態と一緒に持つ。 */
interface Path {
  gain: number;
  resonance: Biquad;
  isolation: Biquad;
  resonanceLateral: BiquadState;
  resonanceVertical: BiquadState;
  isolationLateral: BiquadState;
  isolationVertical: BiquadState;
}

export interface Rumble {
  /** 理想設定なら true。このとき `sample` は厳密に 0 を返す。 */
  readonly bypassed: boolean;
  /** 直近の相対変位 m。**盤面 − カートリッジ本体**で、絶対振動ではない。 */
  readonly lateral: number;
  readonly vertical: number;
  /** 内訳。片方だけ動かしたときにどちらが効いたかを見るため。 */
  readonly platterLateral: number;
  readonly tonearmLateral: number;
  /** 構造にまだエネルギーが残っているか。励振を切っても暫くは true。 */
  readonly ringing: boolean;
  /**
   * この条件で何か出るか。**励振も残響も無ければ false。**
   *
   * エンジンの無音判定がこれを読む。「ω=0 だから無音」ではなく、**盤が止まって
   * いても構造が揺れていれば針はそれを読む**ので、ω だけでは決められない。
   */
  active(omega: number, driving: boolean): boolean;
  configure(parameters: RumbleParameters): void;
  /**
   * 1サンプル進める。**位置ではなく状態を持つ**（構造は鳴り続けるものなので、
   * 状態を持たない形には書けない）。刻みは常に1サンプルなので、ブロックの
   * 切り方には依らない。
   *
   * @param seconds 音声クロック上の絶対時刻
   * @param angle   盤の回転角 rad。**軸受けだけがこれを見る。**
   * @param omega   角速度 rad/s。符号は見ない（速さだけが振幅を決める）。
   * @param driving モーターが駆動中か。**モーター振動だけがこれを見る。**
   */
  sample(
    seconds: number,
    angle: number,
    omega: number,
    driving: boolean,
  ): void;
  /** 構造の記憶を落とす。針を上げたときと、無音へ落ちたとき。 */
  reset(): void;
}

export function createRumble(
  sampleRate: number,
  initial: RumbleParameters = IDEAL_RUMBLE,
): Rumble {
  /** 軸受けの次数と、軸ごとの位相。 */
  let bearingOrder = new Int32Array(0);
  let bearingLateralPhase = new Float64Array(0);
  let bearingVerticalPhase = new Float64Array(0);
  let bearingGain = 0;

  /** モーターの角周波数と、軸ごとの位相。 */
  let motorRate = new Float64Array(0);
  let motorLateralPhase = new Float64Array(0);
  let motorVerticalPhase = new Float64Array(0);
  let motorGain = 0;

  /** 公称速度。ここで軸受けの振幅がちょうど `amplitude` になる。 */
  const referenceOmega = rpmToRadPerSec(33.333);

  const makePath = (parameters: RumblePathParameters): Path => ({
    gain: Number.isFinite(parameters.gain) ? parameters.gain : 0,
    resonance: structuralLowPass(
      parameters.resonanceHz,
      parameters.resonanceQ,
      sampleRate,
    ),
    isolation: structuralLowPass(
      parameters.isolationHz,
      parameters.isolationQ,
      sampleRate,
    ),
    resonanceLateral: createBiquadState(),
    resonanceVertical: createBiquadState(),
    isolationLateral: createBiquadState(),
    isolationVertical: createBiquadState(),
  });

  let platter = makePath(IDEAL_RUMBLE.platterPath);
  let tonearm = makePath(IDEAL_RUMBLE.tonearmPath);

  const mutable = () => model as { -readonly [K in keyof Rumble]: Rumble[K] };

  const clearPath = (path: Path) => {
    resetBiquadState(path.resonanceLateral);
    resetBiquadState(path.resonanceVertical);
    resetBiquadState(path.isolationLateral);
    resetBiquadState(path.isolationVertical);
  };

  /** その経路を1サンプル通す。共振 → 防振材の順で、最後に伝達率を掛ける。 */
  const through = (path: Path, lateral: number, vertical: number) => {
    const l = processBiquad(
      path.isolation,
      path.isolationLateral,
      processBiquad(path.resonance, path.resonanceLateral, lateral),
    );
    const v = processBiquad(
      path.isolation,
      path.isolationVertical,
      processBiquad(path.resonance, path.resonanceVertical, vertical),
    );
    return { lateral: l * path.gain, vertical: v * path.gain };
  };

  const quiet = (path: Path) =>
    Math.abs(path.resonanceLateral.s1) < SILENCE_FLOOR &&
    Math.abs(path.resonanceLateral.s2) < SILENCE_FLOOR &&
    Math.abs(path.resonanceVertical.s1) < SILENCE_FLOOR &&
    Math.abs(path.resonanceVertical.s2) < SILENCE_FLOOR &&
    Math.abs(path.isolationLateral.s1) < SILENCE_FLOOR &&
    Math.abs(path.isolationLateral.s2) < SILENCE_FLOOR &&
    Math.abs(path.isolationVertical.s1) < SILENCE_FLOOR &&
    Math.abs(path.isolationVertical.s2) < SILENCE_FLOOR;

  const model: Rumble = {
    bypassed: true,
    lateral: 0,
    vertical: 0,
    platterLateral: 0,
    tonearmLateral: 0,
    ringing: false,

    active(omega, driving) {
      if (model.bypassed) return false;
      // まだ鳴っている構造は、励振を切った後もしばらく針を揺らす。
      if (model.ringing) return true;
      // 軸受けは回っていれば励振する。**駆動しているかは見ない**（手回しでも出る）。
      if (bearingGain > 0 && Number.isFinite(omega) && omega !== 0) return true;
      // モーターは駆動中だけ。**盤が止まっていても電源が入っていれば揺れる。**
      return motorGain > 0 && driving;
    },

    configure(parameters) {
      const seed = Number.isFinite(parameters.seed) ? parameters.seed | 0 : 0;

      // 軸受け: 1回転を割り切る次数だけを使う。**そうしないと1周して戻らない。**
      const bearingAmplitude = clamp(parameters.bearing.amplitude, 0, 1e-2, 0);
      const orders = Math.round(
        clamp(parameters.bearing.harmonics, 1, MAX_COMPONENTS, 1),
      );
      bearingOrder = new Int32Array(orders);
      bearingLateralPhase = new Float64Array(orders);
      bearingVerticalPhase = new Float64Array(orders);
      for (let k = 0; k < orders; k++) {
        // 低い次数ほど密に、上へ行くほど疎に。実機のランブルの形に近い。
        bearingOrder[k] = 2 + Math.round(rumbleHash(seed, 0x400 + k) * 90);
        bearingLateralPhase[k] = rumbleHash(seed, 0x440 + k) * TWO_PI;
        bearingVerticalPhase[k] = rumbleHash(seed, 0x480 + k) * TWO_PI;
      }
      bearingGain = bearingAmplitude > 0 ? bearingAmplitude / orders : 0;

      // モーター: 時間で進む帯。
      const motorAmplitude = clamp(parameters.motor.amplitude, 0, 1e-2, 0);
      const count = Math.round(
        clamp(parameters.motor.components, 1, MAX_COMPONENTS, 1),
      );
      const centre = clamp(parameters.motor.hz, 1, sampleRate * 0.4, 30);
      motorRate = new Float64Array(count);
      motorLateralPhase = new Float64Array(count);
      motorVerticalPhase = new Float64Array(count);
      for (let k = 0; k < count; k++) {
        const offset = (rumbleHash(seed, 0x500 + k) * 2 - 1) * BAND_SPREAD;
        motorRate[k] =
          TWO_PI *
          clamp(centre * (1 + offset), 1, sampleRate * 0.4, centre);
        motorLateralPhase[k] = rumbleHash(seed, 0x540 + k) * TWO_PI;
        motorVerticalPhase[k] = rumbleHash(seed, 0x580 + k) * TWO_PI;
      }
      motorGain = motorAmplitude > 0 ? motorAmplitude / count : 0;

      platter = makePath(parameters.platterPath);
      tonearm = makePath(parameters.tonearmPath);

      const self = mutable();
      self.bypassed = !(bearingGain > 0 || motorGain > 0);
      model.reset();
    },

    sample(seconds, angle, omega, driving) {
      const self = mutable();
      if (model.bypassed) {
        self.lateral = 0;
        self.vertical = 0;
        self.platterLateral = 0;
        self.tonearmLateral = 0;
        self.ringing = false;
        return;
      }

      const t = Number.isFinite(seconds) ? seconds : 0;
      const phi = Number.isFinite(angle) ? angle : 0;
      const speed = Number.isFinite(omega) ? Math.abs(omega) : 0;

      // **軸受けは回転角に固定され、速さに比例する。** 止まれば厳密に 0 で、
      // 正転でも逆転でも手回しでも同じ道を通る（符号を見ていない）。
      let lateral = 0;
      let vertical = 0;
      if (bearingGain > 0 && speed > 0) {
        const scale =
          bearingGain * Math.min(speed / referenceOmega, MAX_SPEED_RATIO);
        for (let k = 0; k < bearingOrder.length; k++) {
          const order = bearingOrder[k];
          lateral += scale * Math.sin(order * phi + bearingLateralPhase[k]);
          vertical += scale * Math.sin(order * phi + bearingVerticalPhase[k]);
        }
      }

      // **モーターは駆動中だけ。** 盤が止まっていても電源が入っていれば振動する。
      if (motorGain > 0 && driving) {
        for (let k = 0; k < motorRate.length; k++) {
          const w = motorRate[k] * t;
          lateral += motorGain * Math.sin(w + motorLateralPhase[k]);
          vertical += motorGain * Math.sin(w + motorVerticalPhase[k]);
        }
      }

      // 励振も構造の残響も無いなら、**厳密に 0**。ここを通れば以降も 0 のまま。
      if (lateral === 0 && vertical === 0 && quiet(platter) && quiet(tonearm)) {
        clearPath(platter);
        clearPath(tonearm);
        self.lateral = 0;
        self.vertical = 0;
        self.platterLateral = 0;
        self.tonearmLateral = 0;
        self.ringing = false;
        return;
      }

      // **同じ振動源を2経路へ。** 両者が同じなら差は厳密に 0 になり、剛体として
      // 揺れたデッキは何も出さない — 打ち消しは構造から出るのであって、後から
      // 書いた条件ではない。
      const atPlatter = through(platter, lateral, vertical);
      const atTonearm = through(tonearm, lateral, vertical);

      let relativeLateral = atPlatter.lateral - atTonearm.lateral;
      let relativeVertical = atPlatter.vertical - atTonearm.vertical;
      if (!Number.isFinite(relativeLateral) || !Number.isFinite(relativeVertical)) {
        // どんな設定を入れられても値を撒き散らさない。構造ごと仕切り直す。
        clearPath(platter);
        clearPath(tonearm);
        relativeLateral = 0;
        relativeVertical = 0;
      }

      self.platterLateral = atPlatter.lateral;
      self.tonearmLateral = atTonearm.lateral;
      self.lateral = relativeLateral;
      self.vertical = relativeVertical;
      // ここを通った以上エネルギーは入っている。上の床を割った時点で false へ戻る。
      self.ringing = true;
    },

    reset() {
      clearPath(platter);
      clearPath(tonearm);
      const self = mutable();
      self.lateral = 0;
      self.vertical = 0;
      self.platterLateral = 0;
      self.tonearmLateral = 0;
      self.ringing = false;
    },
  };

  model.configure(initial);
  return model;
}
