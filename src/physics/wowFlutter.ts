/**
 * Drive領域の速度変動 — **モーターが出す外乱トルク**。
 *
 * ```
 *   Drive領域   モーターと手 → ω, φ            ← 本モジュールはここへ1項足すだけ
 *   Record領域  盤の形（偏心・反り）・盤面の欠陥
 *   Pickup領域  接触・カートリッジ・RIAA
 * ```
 *
 * **再生比（playbackRate）を後から揺らしてはならない。** それは「盤は一定で
 * 回っているのに音だけずれる」という、実機には存在しない状態を作る。ここが出すのは
 * トルクだけで、速度がどう動くかはサーボと摩擦が決める。結果として動いた ω と φ が
 * **音声・アーム・描画すべての正本**になり、後段は何も知らなくてよい。
 *
 * この構造から自動的に出るもの:
 *
 * - サーボが外乱を打ち消そうとするので、**低い周波数ほど抑え込まれる**
 *   （`|Δω| = τ / √(G² + ω²)`）。実機の速度変動が中域で目立つのと同じ理由。
 * - START/STOP・正転・逆転・手回しは**同じトルクの和**を通る。分岐は無い。
 * - 盤の回転が変われば溝を読む速さも変わる。カーソルは Δφ から出ているので、
 *   音程の揺れは**別に書かなくても出る**。
 *
 * ## 3つの成分を分ける理由
 *
 * | 成分 | 索引 | 実機での出どころ |
 * |---|---|---|
 * | **wow** | **時間** | ベルト・プーリー・アイドラの周期。数百ms〜数秒 |
 * | **flutter** | **時間** | より速い機械振動。数十ms |
 * | **commutationRipple** | **回転角 φ** | 転流に伴う駆動トルクの脈動。**駆動しているあいだだけ**出て、盤が止まれば進まず、逆転すれば逆に辿る |
 *
 * **時間由来の揺らぎと回転角由来のものを混ぜてはならない。** 盤を手で止めたとき、
 * wow と flutter は時計と一緒に進み続けるが、転流リプルは止まる。逆回転させれば
 * それだけが逆順に辿られる。1つの数字に畳むと、この違いが消える。
 *
 * ## cogging ではなく commutation ripple である理由
 *
 * 本来の **cogging torque は静的**である。鉄心と磁極の間に働くので、電流が流れて
 * いなくても——つまりモーターを止めていても——存在し、手で回せば引っかかりとして
 * 感じられる。ここで出しているのは**駆動中の枝にしか入らない**脈動であり、それは
 * cogging ではなく**転流に伴う駆動トルクの脈動**である。
 *
 * このデッキは**コアレスのダイレクトドライブ相当**として扱う。コアレスの
 * モーターには引っかかる鉄心が無いので、**真の cogging torque は 0**（モデルを
 * 持たない）。もし将来コア付きを模すなら、それは駆動中かどうかに関係なく効く
 * 別の項として足すことになる — この項の振幅を上げて代用してはならない。
 *
 * なお**1回転周期の wow は偏心（Record領域・`discShape.ts`）であって、ここではない**。
 * プーリーは盤よりずっと速く回っているので、ベルト由来の wow は盤の回転角に固定
 * されない。
 *
 * ## 決定論
 *
 * トルクは **(時刻, 回転角) の純関数**で、状態を持たない。乱数も時計も引かず、
 * 位相と周波数は seed のハッシュだけから決まる。だから
 *
 * - 同じ seed とパラメータなら、いつ・どのブロック長で呼んでも同じ値
 * - ブロックの切り方に依らない（呼び出し回数を数える器が無い）
 *
 * ## 平均RPMと位相をドリフトさせないこと
 *
 * 成分はすべて**直流を持たない正弦**である。積分しても有界にしかならないので、
 * 平均RPMも長期の位相も動かない。**ランダムウォークや積分ノイズを足さないこと** —
 * それは wow ではなくドリフトであり、30分再生すると盤が別の場所を向く。
 *
 * 振幅は `maxMotorAccel` で頭打ちにしてある。サーボの片側が飽和すると、直流の無い
 * 外乱が整流されて平均速度がずれるため。
 */

import { MOTOR_TUNING, rpmToRadPerSec } from "./platterMotor";

const TWO_PI = Math.PI * 2;

/** 時間由来の成分（wow / flutter）。**0 で完全バイパス。** */
export interface WowFlutterBand {
  /**
   * 外乱トルクの振幅 rad/s²（I = 1 なので N·m ではない）。**0 が理想。**
   *
   * 速度変動の%ではないことに注意 — サーボが周波数ごとに違う量だけ抑え込むので、
   * %で指定したいときは `torqueForSpeedRatio()` を通すこと。
   */
  torque: number;
  /** 帯の中心周波数 Hz。 */
  hz: number;
  /** 重ねる正弦の本数。1 なら純音、増やすほど帯になる。 */
  components: number;
}

export interface WowFlutterParameters {
  /** デッキごとの seed。**盤の seed とは別物**（盤を替えてもモーターは同じ）。 */
  seed: number;
  /** 低周波の wow。時間由来。 */
  wow: WowFlutterBand;
  /** 短周期の flutter。時間由来。 */
  flutter: WowFlutterBand;
  /**
   * 転流に伴う駆動トルクの脈動。**回転角に固定**され、時間では進まない。
   *
   * **cogging ではない。** 静的な cogging torque は駆動していなくても働くが、
   * これは駆動中の枝にしか入らない（冒頭の「cogging ではなく〜」を参照）。
   */
  commutationRipple: {
    /** 外乱トルクの振幅 rad/s²。**0 が理想。** */
    torque: number;
    /** 1回転あたりの山の数。転流回数に相当する。 */
    cyclesPerRevolution: number;
  };
}

/**
 * 揺れないモーター。**この設定では1項も足さず、出力はビット単位で変わらない。**
 *
 * 周波数と転流回数は「帯がどこにあるか」を示す構造上の既定にすぎず、**実機を測った
 * 値ではない**。振幅が 0 なので、どれも効いていない。実機の値が分かった時点で
 * `torque` に入れれば、構造はもうここにある。
 *
 * **真の cogging torque はここに無い。** コアレスのダイレクトドライブとして扱うので
 * 0 であり、項そのものを持たない。
 */
export const IDEAL_WOW_FLUTTER: WowFlutterParameters = {
  seed: 0,
  wow: { torque: 0, hz: 3, components: 3 },
  flutter: { torque: 0, hz: 25, components: 3 },
  commutationRipple: { torque: 0, cyclesPerRevolution: 24 },
};

/**
 * counter-based hash。同じ (seed, counter) からは常に同じ値が出る。
 *
 * ponytail: `discShape.ts` に同じものがある。Record領域のモジュールを Drive領域から
 * import すると、盤を替えるとモーターが変わるように読めてしまうので写した。
 * 3つ目の利用者が出たら共有モジュールへ出すこと。
 */
function driveHash(seed: number, counter: number): number {
  let x = (seed ^ Math.imul(counter | 0, 0x9e3779b1)) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

const clamp = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, low), high) : fallback;

/** 帯の広がり。中心周波数の ±35% に散らす。 */
const BAND_SPREAD = 0.35;
/** 重ねられる本数の上限。1サンプルあたりの仕事を有界に保つ。 */
const MAX_COMPONENTS = 8;

/**
 * 物理はモーターが 1/240 秒ごとに解く。その半分より速い成分は表現できないので、
 * 時間由来の帯はそこで頭打ちにする（120Hz）。
 */
const MAX_TIME_HZ = 120;

export interface WowFlutter {
  /** 理想設定なら true。このとき `torqueAt` は厳密に 0 を返す。 */
  readonly bypassed: boolean;
  /** 直近の `torqueAt` の内訳 rad/s²。**telemetry がこの3つを別々に出す。** */
  readonly wowTorque: number;
  readonly flutterTorque: number;
  readonly commutationRippleTorque: number;
  /** 3つの和。モーターへ渡すのはこれ1つ。 */
  readonly torque: number;
  configure(parameters: WowFlutterParameters): void;
  /**
   * 外乱トルク rad/s²。**位置の純関数で、状態を持たない。**
   *
   * @param seconds 音声クロック上の絶対時刻（累積フレーム / サンプルレート）
   * @param angle   盤の回転角 rad。**転流リプルだけがこれを見る。**
   */
  torqueAt(seconds: number, angle: number): number;
}

export function createWowFlutter(
  initial: WowFlutterParameters = IDEAL_WOW_FLUTTER,
): WowFlutter {
  // 帯ごとの周波数と位相。seed から一度だけ作る。
  let wowRate = new Float64Array(0);
  let wowPhase = new Float64Array(0);
  let wowGain = 0;
  let flutterRate = new Float64Array(0);
  let flutterPhase = new Float64Array(0);
  let flutterGain = 0;
  let rippleCycles = 0;
  let ripplePhase = 0;
  let rippleGain = 0;

  const mutable = () =>
    model as { -readonly [K in keyof WowFlutter]: WowFlutter[K] };

  /** 帯を1つ組む。周波数は中心のまわりへ seed で散らすので、すぐには繰り返さない。 */
  function band(
    parameters: WowFlutterBand,
    seed: number,
    salt: number,
    lowHz: number,
    highHz: number,
  ) {
    const torque = clamp(parameters.torque, 0, MOTOR_TUNING.maxMotorAccel, 0);
    const centre = clamp(parameters.hz, lowHz, highHz, lowHz);
    const count = Math.round(clamp(parameters.components, 1, MAX_COMPONENTS, 1));
    const rate = new Float64Array(count);
    const phase = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      const offset = (driveHash(seed, salt + k) * 2 - 1) * BAND_SPREAD;
      rate[k] = TWO_PI * clamp(centre * (1 + offset), lowHz, highHz, centre);
      phase[k] = driveHash(seed, salt + 0x100 + k) * TWO_PI;
    }
    // 本数で割るので、`torque` は本数を変えても同じ大きさの目盛りでいられる。
    return { rate, phase, gain: torque > 0 ? torque / count : 0 };
  }

  const model: WowFlutter = {
    bypassed: true,
    wowTorque: 0,
    flutterTorque: 0,
    commutationRippleTorque: 0,
    torque: 0,

    configure(parameters) {
      const seed = Number.isFinite(parameters.seed) ? parameters.seed | 0 : 0;

      const wow = band(parameters.wow, seed, 0x100, 0.02, 10);
      wowRate = wow.rate;
      wowPhase = wow.phase;
      wowGain = wow.gain;

      const flutter = band(parameters.flutter, seed, 0x200, 1, MAX_TIME_HZ);
      flutterRate = flutter.rate;
      flutterPhase = flutter.phase;
      flutterGain = flutter.gain;

      rippleGain = clamp(
        parameters.commutationRipple.torque,
        0,
        MOTOR_TUNING.maxMotorAccel,
        0,
      );
      rippleCycles = Math.round(
        clamp(parameters.commutationRipple.cyclesPerRevolution, 1, 200, 1),
      );
      ripplePhase = driveHash(seed, 0x300) * TWO_PI;

      const self = mutable();
      self.bypassed = !(wowGain > 0 || flutterGain > 0 || rippleGain > 0);
      self.wowTorque = 0;
      self.flutterTorque = 0;
      self.commutationRippleTorque = 0;
      self.torque = 0;
    },

    torqueAt(seconds, angle) {
      const self = mutable();
      if (model.bypassed) {
        self.wowTorque = 0;
        self.flutterTorque = 0;
        self.commutationRippleTorque = 0;
        self.torque = 0;
        return 0;
      }

      const t = Number.isFinite(seconds) ? seconds : 0;
      const phi = Number.isFinite(angle) ? angle : 0;

      // **時間由来。** 盤を手で止めても進み続ける。
      let wow = 0;
      if (wowGain > 0) {
        for (let k = 0; k < wowRate.length; k++) {
          wow += Math.sin(wowRate[k] * t + wowPhase[k]);
        }
        wow *= wowGain;
      }
      let flutter = 0;
      if (flutterGain > 0) {
        for (let k = 0; k < flutterRate.length; k++) {
          flutter += Math.sin(flutterRate[k] * t + flutterPhase[k]);
        }
        flutter *= flutterGain;
      }

      // **回転角由来。** 止まれば止まり、逆転すれば逆順に辿る。時計は見ない。
      const ripple =
        rippleGain > 0
          ? rippleGain * Math.sin(rippleCycles * phi + ripplePhase)
          : 0;

      self.wowTorque = wow;
      self.flutterTorque = flutter;
      self.commutationRippleTorque = ripple;
      self.torque = wow + flutter + ripple;
      return self.torque;
    },
  };

  model.configure(initial);
  return model;
}

/**
 * 「公称速度の r 倍だけ速度を揺らしたい」を、外乱トルク rad/s² へ直す。
 *
 * サーボは外乱を打ち消しにかかるので、同じトルクでも周波数によって残る速度変動が
 * 違う。1次のループでは `|Δω| = τ / √(G² + ω²)` なので、その逆を返す。
 *
 * **実機の値そのものではなく較正の目盛り**である。カタログの WRMS をそのまま
 * 入れれば合うわけではない（WRMS は重み付き実効値で、ここは単一成分の片振幅）。
 * 実際に出る量は必ず測ること — 検査はこの式と実測を突き合わせている。
 */
export function torqueForSpeedRatio(
  ratio: number,
  hz: number,
  nominalRpm = 33.333,
): number {
  const omega = TWO_PI * hz;
  return (
    ratio *
    rpmToRadPerSec(nominalRpm) *
    Math.hypot(MOTOR_TUNING.servoGain, omega)
  );
}
