/**
 * 再生履歴による溝の摩耗 — **盤は聴くたびに減る。**
 *
 * ```
 *   final pressed groove（製造で確定した形。**不変**）
 *      ＋ 永久的な盤面（表面粗さ・傷）        ← どちらも盤に固定された形
 *      → [摩耗による永久変形]                ← ここ。**針が通った跡が残る**
 *      ＋ 取り除ける埃                        ← 異物なので摩耗の対象ではない
 *      → 有限な針先による空間サンプリング
 *      → 差分 → 接触モデル → カートリッジ → RIAA
 * ```
 *
 * ## 出力に足すエフェクトではない
 *
 * 摩耗は「古いレコード風のEQ」でも「ノイズの追加」でもない。**針が溝の形を削る**
 * ことそのものである。だから
 *
 * - **1回目と2回目で音が違う。** 同じ盤を鳴らすたびに少しずつ変わっていく
 * - 針を上げれば止まる。盤が止まっても止まる（**進んだ距離で溜まる**）
 * - 減った形は戻らない。埃を払っても、ハムを切っても、**音楽そのものが変わっている**
 * - 元の盤（`manufacturing.ts` の出力）は**そのまま残す**ので、いつでも比較できるし
 *   製造直後へ戻せる
 *
 * ## 何が起きているのか — 丸まる、ということ
 *
 * 削れるのは**接触応力の高いところ**、すなわち曲率のきついところである。針先が
 * 撫でられない鋭い谷ほど強く当たり、そこが優先的に削れて丸くなる。
 *
 * ```
 *   摩耗後 = 形 + s · (平滑化した形 − 形)          s は溜まった摩耗（0〜1）
 *          = 形 + s · Δ²(形) / 4                    ← [1/4, 1/2, 1/4] の平滑そのもの
 * ```
 *
 * **Δ²（空間の2階差分＝曲率）が本質。** 平らなところには何も起きず、鋭いところ
 * だけが削れる。直流も動かない（削って盤が反ることは無い）。**`s = 0` なら補正は
 * 恒等的に 0** で、溝バッファはビット単位でそのまま残る。
 *
 * 読む幅は**距離**（`smoothingRadius`）で決まるので、溝1サンプルが表す距離が短い
 * 内周ほど広い範囲を撫でる ——**同じ摩耗でも内周のほうが高域を失う。**
 * `stylusTip.ts` / `manufacturing.ts` の内周効果と出どころは同じ幾何である。
 *
 * ## 溜まり方 — 時間ではなく距離
 *
 * ```
 *   Δs = rate × (進んだ距離 / その点の受け持ち) × (針圧比)^n
 *        × (1 + 追い切れなさ) × (1 + 鋭さ) × ミストラッキング × 逆走 / 硬さ × (1 − s)
 * ```
 *
 * **括弧の中が「その点を何回通ったか」**である。1回通れば 1、半分だけ擦れば 0.5、
 * 行ったり来たりすれば往復ぶん。時計ではなく距離で数えているので、速く回しても
 * ゆっくり回しても同じだけ減る。
 *
 * - **接触していない／動いていないときは 0。** 距離が 0 なら積も 0 で、分岐は要らない
 * - `(1 − s)` があるので溜まるほど遅くなる。**弾性のある材料は途中で止まる**
 * - **左右の壁は別々**に溜まる。片方の壁だけでミストラッキングすれば、その壁だけが
 *   削れて分離が悪くなる
 * - 逆走とスクラッチが強いのは、針が前向きに作られているからである
 *
 * ## 置き場所とメモリ
 *
 * **溝バッファを複製しない。** 溜まるのは「その場所がどれだけ削れたか」という
 * スカラー1つで、形そのものは削る瞬間に計算する。だから
 * **32サンプルに1セル**（外周で約0.34mm・0.67ms）で足り、
 *
 * ```
 *   3分ステレオ   8.6M frames / 32 × 2壁 × 4B = 2.2MB      （溝本体は 69MB）
 *   20分ステレオ  57.6M frames / 32 × 2壁 × 4B = 14.4MB    （溝本体は 460MB）
 * ```
 *
 * 読み出しはセル間の線形補間なので、境目で段差は出ない。**Float32Array 2本と
 * 数値の概要だけ**なので、そのまま IndexedDB へ入れられる形をしている。
 *
 * ## リアルタイム安全
 *
 * 確保するのは盤の装填時だけ。1サンプルあたりの仕事は積4回と比較1回で、書き込みは
 * **セルを離れるときに1回**（32サンプルに1回）。`process` の中で確保も探索もしない。
 *
 * ## 数値について
 *
 * **実在の盤を測った値ではない。** 既定は `NO_WEAR`（`rate = 0`）で、そのとき
 * この段は完全にバイパスされる。
 */

import { CUT, radiusAtRevolution, type CutLayout } from "./cutLayout";
import { GROOVE } from "../../physics/groove";

/* ------------------------------------------------------------------ *
 * パラメータ
 * ------------------------------------------------------------------ */

export interface WearParameters {
  /**
   * **その点を1回通るごと**に溜まる摩耗（基準の針圧・鋭さ 0 の溝で）。
   * **0 で摩耗しない。**
   *
   * 「1回通る」は距離で数える —— 針がその点の受け持ち区間をどれだけ進んだかで、
   * 半分だけ擦れば半分しか溜まらないし、行ったり来たりすれば往復ぶん溜まる。
   * `2e-4` なら 500回でおよそ 10%、鋭い溝ではその数倍の速さで進む。
   */
  rate: number;
  /** 針圧の基準 N。ここでちょうど `rate` になる。 */
  referenceForce: number;
  /** 針圧の指数。接触応力は面圧なので**1より大きい**。 */
  forceExponent: number;
  /** 材料の硬さ（相対）。大きいほど削れにくい。 */
  hardness: number;
  /**
   * 追い切れていない量（`stylusTip` の膨張＝理想の点針との差）が効く度合い。
   * **鈍った針が盤を削るのはここ** —— 谷へ入れない針は肩で当たる。
   */
  tracingSensitivity: number;
  /** 局所の鋭さ（空間曲率）が効く度合い。 */
  curvatureSensitivity: number;
  /** 壁から離れているとき（ミストラッキング）の倍率。**壁ごとに効く。** */
  mistrackingFactor: number;
  /** 逆走の倍率。針は前向きに作られている。 */
  reverseFactor: number;
  /** 摩耗が撫でる空間半径 m。**丸まりの大きさそのもの。** */
  smoothingRadius: number;
}

/** **摩耗しない盤。** この設定では読み出しも蓄積も走らない。 */
export const NO_WEAR: WearParameters = {
  rate: 0,
  referenceForce: 0.0177,
  forceExponent: 1.5,
  hardness: 1,
  tracingSensitivity: 0,
  curvatureSensitivity: 0,
  mistrackingFactor: 1,
  reverseFactor: 1,
  smoothingRadius: 0,
};

/**
 * 選べる摩耗の進み方。**実在の盤を測った値ではない**（`rate` は「何回聴いたら
 * どれだけ減るか」の目盛りである）。
 */
export const WEAR_PRESETS = [
  { name: "none", label: "No wear" },
  { name: "vinyl", label: "Vinyl (slow)" },
  { name: "soft", label: "Soft pressing (fast)" },
] as const;

export type WearPresetName = (typeof WEAR_PRESETS)[number]["name"];

export function wearParametersFor(name: WearPresetName): WearParameters {
  switch (name) {
    case "none":
      return NO_WEAR;

    /**
     * 普通のPVC。**1回の再生で 2e-4** 進むので、可聴になるまでに数百回かかる
     * —— 実機のレコードが「大事に扱えば何百回も聴ける」のと同じ桁である。
     * 大きく振れた高域では鋭さの項が数倍に効くので、そこから先に減っていく。
     */
    case "vinyl":
      return {
        rate: 2e-4,
        /** 1.8gf。`recordCondition.ts` の `GOOD_STYLUS` と同じ基準。 */
        referenceForce: 0.0177,
        forceExponent: 1.5,
        hardness: 1,
        tracingSensitivity: 6,
        curvatureSensitivity: 2,
        mistrackingFactor: 25,
        reverseFactor: 3,
        /** 針先の接触面と同じ桁。**丸まりの大きさそのもの。** */
        smoothingRadius: 6e-6,
      };

    /** 柔らかいプレス。同じ扱いでも10倍速く減る。 */
    case "soft": {
      const base = wearParametersFor("vinyl");
      return { ...base, rate: 2e-3, hardness: 0.5 };
    }
  }
}

/* ------------------------------------------------------------------ *
 * 蓄積の場
 * ------------------------------------------------------------------ */

/**
 * **1セルが受け持つ溝サンプル数。** 32 は外周で約0.34mm・0.67ms にあたる。
 *
 * 丸まりの「形」は読み出しのときに `smoothingRadius`（µmの桁）から作るので、
 * ここが受け持つのは**どれだけ削れたかの分布**だけである。だから音の細かさを
 * 落とさずに 1/32 まで粗くできる。
 */
export const WEAR_CELL_SAMPLES = 32;

/** 保存・比較できる形の摩耗状態。**そのまま IndexedDB へ入れられる。** */
export interface WearField {
  /** 1セルが受け持つ溝サンプル数。 */
  readonly cellSamples: number;
  /** 壁ごとの累積摩耗（0〜1）。 */
  readonly left: Float32Array;
  readonly right: Float32Array;
}

/** Zustand へ出す概要。**数値だけ**で、生の場は runtime 側に置く。 */
export interface WearSummary {
  /** 接触して進んだ距離の累計 m。 */
  distanceMetres: number;
  /** 片面の溝の長さで割ったもの＝**何回ぶん聴いたか**。 */
  plays: number;
  /** いちばん減っているところ（0〜1）。 */
  peak: number;
  /** 盤全体の平均（0〜1）。 */
  mean: number;
}

const clamp = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, low), high) : fallback;

/**
 * 針圧比の上限。理想の針（針圧 ∞）でも値を撒き散らさないための頭打ちで、
 * **物理の主張ではない**。
 */
const MAX_FORCE_RATIO = 8;
/**
 * 丸まりの上限。`severity × 半幅` が 1 を超えるとナイキストで応答が負になる
 * （＝反転する）ので、そこで止める。
 *
 * ponytail: 1段のディフュージョンぶん（内周で 10kHz 約 −4dB）が上限。もっと
 * 減った盤を出すなら、ここを2段にするか半径を広げること。
 */
const MAX_DIFFUSION = 1;

/**
 * 摩耗の runtime。**場を持ち、読み出しと蓄積の両方を受け持つ。**
 *
 * 盤に属するので、デッキ側の seed とも状態とも独立である（盤を替えれば別の場、
 * 同じ盤を載せ直せば同じ場）。
 */
export interface GrooveWear {
  /** `rate = 0` または盤が無い。true なら読み出しも蓄積も走らない。 */
  readonly bypassed: boolean;
  /** **一度でも減ったか。** false なら読み出しは厳密に素通しでよい。 */
  readonly worn: boolean;
  /** 直近の `severityAt` の結果（壁ごと・0〜1）。 */
  readonly left: number;
  readonly right: number;
  /** 摩耗が撫でる半幅 m。呼び出し側が溝サンプルへ直す。 */
  readonly smoothingRadius: number;
  readonly summary: WearSummary;
  /** 保存・比較用。**複製しない**ので、書き換えれば盤が変わる。 */
  readonly field: WearField | null;

  configure(parameters: WearParameters): void;
  /**
   * 盤を載せる。**確保はここだけ**（`process` の中では1バイトも確保しない）。
   * 溝が同じ長さなら場は作り直さず、`reset` を呼ぶまで減ったままである。
   */
  load(frames: number, layout: CutLayout | null): void;
  /** **製造直後の盤へ戻す。** 場も概要も 0 になる。 */
  reset(): void;
  /** その位置の摩耗の強さを `left` / `right` へ。セル間は線形補間。 */
  severityAt(position: number): void;
  /**
   * 1サンプルぶん減らす。**現在のサンプルを読んだ後に呼ぶ。**
   *
   * @param position     溝バッファ上の位置
   * @param distance     このサンプルで進んだ**実距離** m（≥0。0 なら何もしない）
   * @param cellMetres   1セルが受け持つ溝の長さ m。**「1回通った」の分母**で、
   *                     内周ほど短い（＝同じ1回転でも受け持ちが短い）
   * @param force        針圧 N
   * @param reverse      逆走しているか
   * @param sharpLeft    左壁の局所の鋭さ（**無次元** —— `Δ²` をメートルへ直し、
   *                     `smoothingRadius` で割ったもの）
   * @param excessLeft   左壁で針が追い切れていない量（同じ正規化）
   * @param airborneLeft 左壁から離れているか
   */
  accumulate(
    position: number,
    distance: number,
    cellMetres: number,
    force: number,
    reverse: boolean,
    sharpLeft: number,
    sharpRight: number,
    excessLeft: number,
    excessRight: number,
    airborneLeft: boolean,
    airborneRight: boolean,
  ): void;
  /** 溜めかけの分を場へ落とす。針を上げたときと、盤を降ろすとき。 */
  flush(): void;
}

export function createGrooveWear(
  parameters: WearParameters = NO_WEAR,
): GrooveWear {
  let rate = 0;
  let referenceForce = NO_WEAR.referenceForce;
  let forceExponent = 1.5;
  let hardness = 1;
  let tracingSensitivity = 0;
  let curvatureSensitivity = 0;
  let mistrackingFactor = 1;
  let reverseFactor = 1;

  let left: Float32Array | null = null;
  let right: Float32Array | null = null;
  let cells = 0;
  /** 片面の溝の長さ m。`plays` の分母。 */
  let grooveLength = 1;

  /** 溜めかけ。**セルを離れるときにだけ場へ落とす**ので、同じ通過では読まれない。 */
  let pendingCell = -1;
  let pendingLeft = 0;
  let pendingRight = 0;

  const summary: WearSummary = {
    distanceMetres: 0,
    plays: 0,
    peak: 0,
    mean: 0,
  };
  /** 平均を O(1) で出すための累計。場を舐め直さない。 */
  let total = 0;

  const mutable = () =>
    wear as { -readonly [K in keyof GrooveWear]: GrooveWear[K] };

  /** 溜めかけを場へ落とす。**弾性のぶん、減るほど鈍くなる。** */
  function commit(): void {
    if (pendingCell < 0 || left === null || right === null) return;
    if (pendingLeft > 0) {
      const before = left[pendingCell];
      const after = before + pendingLeft * (1 - before);
      left[pendingCell] = after > 1 ? 1 : after;
      total += left[pendingCell] - before;
      if (left[pendingCell] > summary.peak) summary.peak = left[pendingCell];
    }
    if (pendingRight > 0) {
      const before = right[pendingCell];
      const after = before + pendingRight * (1 - before);
      right[pendingCell] = after > 1 ? 1 : after;
      total += right[pendingCell] - before;
      if (right[pendingCell] > summary.peak) summary.peak = right[pendingCell];
    }
    if (total > 0) {
      mutable().worn = true;
      summary.mean = total / (2 * cells);
    }
    pendingLeft = 0;
    pendingRight = 0;
  }

  const wear: GrooveWear = {
    bypassed: true,
    worn: false,
    left: 0,
    right: 0,
    smoothingRadius: 0,
    summary,
    field: null,

    configure(next) {
      rate = Number.isFinite(next.rate) && next.rate > 0 ? next.rate : 0;
      referenceForce = clamp(next.referenceForce, 1e-6, 1, NO_WEAR.referenceForce);
      forceExponent = clamp(next.forceExponent, 0, 6, 1.5);
      hardness = clamp(next.hardness, 1e-3, 1e3, 1);
      tracingSensitivity = clamp(next.tracingSensitivity, 0, 1e4, 0);
      curvatureSensitivity = clamp(next.curvatureSensitivity, 0, 1e4, 0);
      mistrackingFactor = clamp(next.mistrackingFactor, 1, 1e4, 1);
      reverseFactor = clamp(next.reverseFactor, 0, 1e3, 1);
      const self = mutable();
      self.smoothingRadius = clamp(next.smoothingRadius, 0, 1e-3, 0);
      self.bypassed = !(rate > 0 && self.smoothingRadius > 0 && left !== null);
      self.left = 0;
      self.right = 0;
    },

    load(frames, layout) {
      const count = Math.max(
        1,
        Math.ceil(Math.max(0, frames) / WEAR_CELL_SAMPLES) + 1,
      );
      if (left === null || cells !== count) {
        cells = count;
        left = new Float32Array(count);
        right = new Float32Array(count);
        const self = mutable();
        self.field = { cellSamples: WEAR_CELL_SAMPLES, left, right };
        wear.reset();
      }
      grooveLength = programGrooveLength(layout);
      const self = mutable();
      self.bypassed = !(rate > 0 && wear.smoothingRadius > 0);
    },

    reset() {
      left?.fill(0);
      right?.fill(0);
      pendingCell = -1;
      pendingLeft = 0;
      pendingRight = 0;
      total = 0;
      summary.distanceMetres = 0;
      summary.plays = 0;
      summary.peak = 0;
      summary.mean = 0;
      const self = mutable();
      self.worn = false;
      self.left = 0;
      self.right = 0;
    },

    severityAt(position) {
      const self = mutable();
      if (left === null || right === null || !wear.worn) {
        self.left = 0;
        self.right = 0;
        return;
      }
      const at = position / WEAR_CELL_SAMPLES;
      const index = Math.floor(at);
      if (index < 0 || index + 1 >= cells) {
        self.left = 0;
        self.right = 0;
        return;
      }
      // セル間は線形。**境目で段差を出さない。**
      const frac = at - index;
      self.left = left[index] * (1 - frac) + left[index + 1] * frac;
      self.right = right[index] * (1 - frac) + right[index + 1] * frac;
    },

    accumulate(
      position,
      distance,
      cellMetres,
      force,
      reverse,
      sharpLeft,
      sharpRight,
      excessLeft,
      excessRight,
      airborneLeft,
      airborneRight,
    ) {
      if (left === null || rate <= 0) return;
      // **動いていなければ減らない。** 針が止まっていても盤が止まっていても同じ。
      if (!(distance > 0)) return;

      const cell = Math.floor(position / WEAR_CELL_SAMPLES);
      if (cell < 0 || cell >= cells) return;
      if (cell !== pendingCell) {
        commit();
        pendingCell = cell;
      }

      // **針圧比。** 理想の針（針圧 ∞）でも値を撒き散らさないよう頭打ちにする。
      const pressure = Math.pow(
        clamp(force / referenceForce, 0, MAX_FORCE_RATIO, 1),
        forceExponent,
      );
      // **「その点を何回通ったか」で溜める。** 距離をセルの受け持ちで割るので、
      // 1回通れば 1、半分だけ擦れば 0.5、往復すれば 2 になる。溝の長さで割る
      // のではなく**その点の受け持ち**で割るのが要点で、これが無いと短い盤ほど
      // 速く減ることになる。
      const passes = cellMetres > 0 ? distance / cellMetres : 0;
      if (!(passes > 0)) return;
      const base =
        (rate * passes * pressure * (reverse ? reverseFactor : 1)) / hardness;

      pendingLeft +=
        base *
        (1 + curvatureSensitivity * sharpLeft) *
        (1 + tracingSensitivity * Math.abs(excessLeft)) *
        (airborneLeft ? mistrackingFactor : 1);
      pendingRight +=
        base *
        (1 + curvatureSensitivity * sharpRight) *
        (1 + tracingSensitivity * Math.abs(excessRight)) *
        (airborneRight ? mistrackingFactor : 1);

      summary.distanceMetres += distance;
      summary.plays = summary.distanceMetres / grooveLength;
    },

    flush() {
      commit();
      pendingCell = -1;
    },
  };

  wear.configure(parameters);
  return wear;
}

/**
 * 摩耗の丸まりを1サンプルぶん出す。**呼び出し側が読んだ3点から作る。**
 *
 * ```
 *   補正 = s · (前 + 後 − 2×中心) / 4
 * ```
 *
 * `s = 0` で厳密に 0。**半幅は距離で決まる**ので、内周ほど同じ摩耗で高域を失う。
 * ナイキストで応答が負にならないよう `s × 半幅` は 1 で頭打ちにする。
 *
 * @param severity その場所の摩耗（0〜1）
 * @param halfSamples 半幅（溝サンプル）。1未満でよい —— 線形補間で読んでいれば
 *   効きはそのぶん弱くなるだけで、段差にはならない
 */
export function wearRounding(
  severity: number,
  halfSamples: number,
  behind: number,
  centre: number,
  ahead: number,
): number {
  const strength = severity * halfSamples;
  if (!(strength > 0)) return 0;
  const bounded = strength > MAX_DIFFUSION ? MAX_DIFFUSION : strength;
  return (bounded * (behind + ahead - 2 * centre)) / 4;
}

/**
 * 演奏領域の溝の長さ m。`plays` の分母で、**盤ごとに違う**（短い盤は1回が短い）。
 *
 * 半径は回転数に対して一次なので、平均半径 × 2π × 回転数でちょうど出る。
 */
function programGrooveLength(layout: CutLayout | null): number {
  if (layout === null || !(layout.programRevolutions > 0)) {
    return 2 * Math.PI * GROOVE.leadInRadius;
  }
  const outer = radiusAtRevolution(layout, 0);
  const inner = radiusAtRevolution(layout, layout.programRevolutions);
  const mean = (outer + inner) / 2;
  return Math.max(
    CUT.programPitch,
    2 * Math.PI * mean * layout.programRevolutions,
  );
}
