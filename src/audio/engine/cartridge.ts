/**
 * 45/45ステレオとカートリッジ。**針の動きが電圧になるところ。**
 *
 * 信号系での位置は「溝変位の差分」と「RIAA再生特性」の間。差分が出すのは
 * 針先の速度ベクトルで、それを2つのコイルがどう拾うか、が本モジュールの担当。
 *
 * ```
 *   溝(変位) → 差分 → [幾何行列 → 機械共振 → 電気負荷] → RIAA再生 → 出力
 *                      ↑ ここ
 * ```
 *
 * **機械応答と電気負荷は別々に呼べる**（`processMechanical` / `processElectrical`）。
 * その間に誘導ハムが入るためで、コイルへ誘導された電圧はコイル自身の負荷共振を
 * そこから先で受ける（`hum.ts`）。`process` は2段を続けて呼ぶだけで、分ける前と
 * 1ビットも変わらない。
 *
 * ## 45/45 と幾何行列
 *
 * 溝の左右の壁は互いに直交し、水平から ±45° に切られている。壁の変位
 * `(wL, wR)` と、横方向・垂直方向の成分の関係は45°の回転にすぎない。
 *
 * ```
 *   lateral  = (wL + wR)/√2      横方向（両壁が同相）
 *   vertical = (wL − wR)/√2      垂直方向（逆相）
 * ```
 *
 * **アジマスずれは、この横／垂直平面での回転である。** 2次元の回転は互いに
 * 可換なので、45°の基底変換を挟んでも形は変わらず、**壁の基底のままの回転**として
 * 書ける（導出は上式に代入するだけ）。
 *
 * ```
 *   wL' =  cosψ·wL + sinψ·wR
 *   wR' = −sinψ·wL + cosψ·wR
 * ```
 *
 * したがってアジマスずれ ψ のセパレーションはちょうど `tanψ` になる（1°で−35dB）。
 * 左右感度差とクロストークも定数行列なので、**3つまとめて1つの2×2行列**に畳める。
 * パラメータが変わったときだけ作り直せばよく、1サンプルあたりの仕事は積和4回。
 *
 * ## 数値について
 *
 * **実在機種の値は書かない。** 既定はすべて理想（行列は単位行列、共振なし）で、
 * その状態では入力をビット単位でそのまま返す。実機の値が分かった時点で
 * `CartridgeParameters` に入れれば、構造は既にある。
 */

// Biquadの土台は riaa.ts に置いてある（RIAA以外にも使う汎用部分）。
// RIAAの係数そのものには触れない。
import {
  createBiquadState,
  processBiquad,
  resetBiquadState,
  type Biquad,
} from "./riaa";

/** 2次の共振。機械系にも電気系にも同じ形を使う。 */
export interface Resonance {
  /** 共振周波数 Hz。 */
  hz: number;
  /** 尖鋭度。1/√2 で平坦、大きいほど山が高い。 */
  q: number;
}

export interface CartridgeParameters {
  /**
   * アジマスずれ、ラジアン。カンチレバー軸まわりの傾き。
   * 0 が理想。セパレーションは `tan(azimuth)` になる。
   */
  azimuth: number;
  /** 左右の出力感度。どちらも 1 が理想。 */
  sensitivity: { left: number; right: number };
  /**
   * チャンネル間の漏れ（線形比）。0 が理想。
   * −30dB のセパレーションなら 10^(−30/20) ≒ 0.0316。
   */
  crosstalk: { leftFromRight: number; rightFromLeft: number };
  /**
   * カンチレバーと針先の機械共振（針先質量 × 盤のコンプライアンス）。
   * **null が理想** — 質量ゼロの針は共振しない。
   */
  mechanicalResonance: Resonance | null;
  /**
   * コイルのインダクタンスと負荷（抵抗・容量）が作る電気共振。
   * **null が理想** — 負荷の影響を受けない出力。
   */
  electricalLoad: Resonance | null;
}

/**
 * 理想のカートリッジ。**推測値は一つも入っていない。**
 *
 * この設定でチェーンは完全にバイパスされ、溝に刻んだ L/R がそのまま戻る。
 */
export const IDEAL_CARTRIDGE: CartridgeParameters = {
  azimuth: 0,
  sensitivity: { left: 1, right: 1 },
  crosstalk: { leftFromRight: 0, rightFromLeft: 0 },
  mechanicalResonance: null,
  electricalLoad: null,
};

const clamp = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, low), high) : fallback;

/** 45°を超えると左右が入れ替わる。物理的な意味を失うので、そこで止める。 */
const MAX_AZIMUTH = Math.PI / 4;

/**
 * 共振を持つ2次ローパス（RBJ）。直流利得はちょうど1で、`hz` 付近に `q` の山。
 *
 * `hz` はナイキストの手前、`q` は正の有限値へ丸めるので、**どんな設定を与えても
 * 極は単位円の内側に残る**。極端な値で発振しないことは検証側で叩いている。
 */
function resonantLowPass(resonance: Resonance, sampleRate: number): Biquad {
  const hz = clamp(resonance.hz, 1, sampleRate * 0.49, sampleRate * 0.25);
  const q = clamp(resonance.q, 0.05, 40, Math.SQRT1_2);

  const w = (2 * Math.PI * hz) / sampleRate;
  const cosw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cosw) / 2) / a0,
    b1: (1 - cosw) / a0,
    b2: ((1 - cosw) / 2) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

export interface Cartridge {
  /** 理想設定なら true。このとき `process` は入力をそのまま返す。 */
  readonly bypassed: boolean;
  /** 直近の処理の出力。割り当てを避けるため、ここに書く。 */
  readonly left: number;
  readonly right: number;
  configure(parameters: CartridgeParameters): void;
  /** 針先の速度2成分を受け取り、コイルの出力を `left` / `right` へ書く。 */
  process(left: number, right: number): void;
  /**
   * **機械応答まで**（幾何行列 → 機械共振）。`process` の前半である。
   *
   * 電気負荷と分けてあるのは、**その間に誘導ハムが入る**から（`hum.ts`）。
   * コイルへ誘導された電圧は、コイル自身のインダクタンスと負荷が作る共振を
   * そこから先で受ける — 針の動きと同じ扱いになる。
   */
  processMechanical(left: number, right: number): void;
  /** **電気負荷だけ**。`process` の後半で、`processMechanical` の続き。 */
  processElectrical(left: number, right: number): void;
  /** フィルタの記憶を落とす。無音を厳密に保つために使う。 */
  reset(): void;
}

export function createCartridge(
  sampleRate: number,
  initial: CartridgeParameters = IDEAL_CARTRIDGE,
): Cartridge {
  // 幾何行列。アジマス・感度・クロストークを畳んだもの。
  let m00 = 1;
  let m01 = 0;
  let m10 = 0;
  let m11 = 1;
  let identity = true;

  let mechanical: Biquad | null = null;
  let electrical: Biquad | null = null;
  const mechanicalLeft = createBiquadState();
  const mechanicalRight = createBiquadState();
  const electricalLeft = createBiquadState();
  const electricalRight = createBiquadState();

  const cartridge: Cartridge = {
    bypassed: true,
    left: 0,
    right: 0,

    configure(parameters) {
      const azimuth = clamp(parameters.azimuth, -MAX_AZIMUTH, MAX_AZIMUTH, 0);
      const gainLeft = clamp(parameters.sensitivity.left, 0, 4, 1);
      const gainRight = clamp(parameters.sensitivity.right, 0, 4, 1);
      const leftFromRight = clamp(parameters.crosstalk.leftFromRight, -1, 1, 0);
      const rightFromLeft = clamp(parameters.crosstalk.rightFromLeft, -1, 1, 0);

      // 回転（アジマス）→ 漏れ → 感度 の順に掛けて1枚に畳む。すべて定数なので
      // 順序は結果の解釈の問題であって、計算量には関わらない。
      const cos = Math.cos(azimuth);
      const sin = Math.sin(azimuth);
      m00 = gainLeft * (cos - leftFromRight * sin);
      m01 = gainLeft * (sin + leftFromRight * cos);
      m10 = gainRight * (rightFromLeft * cos - sin);
      m11 = gainRight * (rightFromLeft * sin + cos);
      identity = m00 === 1 && m01 === 0 && m10 === 0 && m11 === 1;

      mechanical =
        parameters.mechanicalResonance === null
          ? null
          : resonantLowPass(parameters.mechanicalResonance, sampleRate);
      electrical =
        parameters.electricalLoad === null
          ? null
          : resonantLowPass(parameters.electricalLoad, sampleRate);

      // 理想なら一切触らない。ビット単位で素通しであることを保証する。
      const self = cartridge as { bypassed: boolean };
      self.bypassed = identity && mechanical === null && electrical === null;
      cartridge.reset();
    },

    processMechanical(left, right) {
      const self = cartridge as { left: number; right: number };
      if (identity && mechanical === null) {
        self.left = left;
        self.right = right;
        return;
      }

      // 幾何: どちらの壁の動きが、どちらのコイルにどれだけ届くか。
      let outLeft = identity ? left : m00 * left + m01 * right;
      let outRight = identity ? right : m10 * left + m11 * right;

      // 機械共振。左右で同じ特性なので行列とは可換（順序を入れ替えても結果は
      // 同じ）。左右で違う特性を入れる日が来たら、この可換性は消える。
      if (mechanical !== null) {
        outLeft = processBiquad(mechanical, mechanicalLeft, outLeft);
        outRight = processBiquad(mechanical, mechanicalRight, outRight);
      }

      self.left = outLeft;
      self.right = outRight;
    },

    processElectrical(left, right) {
      const self = cartridge as { left: number; right: number };
      if (electrical === null) {
        self.left = left;
        self.right = right;
        return;
      }
      self.left = processBiquad(electrical, electricalLeft, left);
      self.right = processBiquad(electrical, electricalRight, right);
    },

    process(left, right) {
      // 2段を続けて呼ぶだけ。**分ける前と1ビットも変わらない**（同じ演算を同じ
      // 順で通る）。誘導ハムを挟まない呼び出し側はこちらを使えばよい。
      cartridge.processMechanical(left, right);
      cartridge.processElectrical(cartridge.left, cartridge.right);
    },

    reset() {
      resetBiquadState(mechanicalLeft);
      resetBiquadState(mechanicalRight);
      resetBiquadState(electricalLeft);
      resetBiquadState(electricalRight);
      const self = cartridge as { left: number; right: number };
      self.left = 0;
      self.right = 0;
    },
  };

  cartridge.configure(initial);
  return cartridge;
}

/** セパレーション（dB）からクロストークの線形比へ。負の値を渡す。 */
export const separationDbToRatio = (db: number) => 10 ** (db / 20);
