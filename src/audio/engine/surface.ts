/**
 * 盤面の欠陥 — **Record領域**。表面粗さ・埃・傷。
 *
 * 信号系での位置は溝バッファのすぐ隣、**差分より手前**である。
 *
 * ```
 *   仮想溝(変位) ＋ 盤面欠陥(変位) → 差分 → 接触モデル → カートリッジ → RIAA再生
 *                   ↑ ここ
 * ```
 *
 * ここに置くことが、そのまま次の3つの保証になる（後段は何も知らなくてよい）:
 *
 * - **盤が止まれば無音。** 変位が動かない＝差分が0。ノイズを「止める」処理は要らない。
 * - **逆走すれば同じ欠陥を逆順に通る。** 索引が時刻ではなく盤上の位置だから。
 * - **強い欠陥はミストラッキングを起こす。** 変位が急なら要求加速度が上がり、
 *   接触モデルが勝手に追従限界を超える。傷で針が飛ぶ挙動を別に書く必要がない。
 *
 * ## 索引は「盤上のどこか」だけ
 *
 * 乱数は一切引かない。すべては seed と盤上の座標から決まる counter-based hash で、
 * **同じ場所を何度こすっても同じ音が鳴る**（audio-engine.md 9.2）。
 *
 * 索引には**別々の2系統**を使う。混ぜてはならない。
 *
 * ```
 *   表面粗さ  ← 溝に沿った距離 = ∫2πr d(rev)     溝の壁そのものの荒さ。経路に固定
 *   埃・傷    ← レコード座標 (半径, 角度)         盤面に落ちている／刻まれているもの
 * ```
 *
 * レコード座標は `discShape.ts` が持つ**共通の座標系**で、盤の回転角・針先の方位角・
 * 偏心がすべて畳み込んである。ここでは受け取るだけで、作らない。
 *
 * - **盤の回転角を引く。** 盤が正転すれば、針の下に来る盤面の点は逆向きに巡る。
 *   **`revolutions` から作ってはならない** — 針を上げている間、盤は回り続けるのに
 *   螺旋上の位置は止まるので、上げている間だけ自転が止まった盤になる。
 * - **針先の方位角を足す。** アームは外周から内周まででこの機種は 16.9° 振れる。
 * - **偏心があれば、その座標変換も入る。** 盤がずれて回れば欠陥も一緒にずれる。
 *
 * 針が降りていてアームが止まっている間は、盤面の角度は盤の回転と同じ速さで巡るので、
 * 傷は**1回転ごとに同じ角度で**当たる。
 *
 * ## L/R の壁へどう入るか
 *
 * | 欠陥 | 向き | 壁への入り方 |
 * |---|---|---|
 * | 表面粗さ | 壁ごとに別の面 | 左右**無相関** |
 * | 埃 | 溝の中の粒。針が乗り上げる | **主に垂直**（＋粒の寄りぶんの横方向） |
 * | 傷 | 溝を横切る抉れ | **垂直**＋横切る角度ぶんの横方向 |
 *
 * 垂直・横方向から壁へ戻すのは `cartridge.ts` の 45/45 の関係の逆である。
 *
 * ```
 *   wL = (lateral + vertical)/√2
 *   wR = (lateral − vertical)/√2
 * ```
 *
 * したがって**垂直の欠陥は逆相として出る**。実機で埃や傷がモノラルで消えにくい
 * のと同じ理由で、これは狙った挙動である。
 *
 * ## 数値について
 *
 * 寸法はすべて**メートル**で持ち、溝の単位へは1箇所で換算する（`metresToUnits`）。
 * 換算には接触モデルと同じ `REFERENCE_WALL_VELOCITY` を使う — 較正点を2つ持つと
 * 「同じ深さの傷が針圧の設定で当たったり当たらなかったり」する。
 *
 * **既定は `CLEAN_SURFACE`（何も無い盤）で、このとき完全にバイパスされる。**
 * 実機の盤の値は入れていない。
 */

import { GROOVE } from "../../physics/groove";
import { type CutLayout } from "./cutLayout";
import { discHash as hash, discSigned as signed } from "./discShape";
import { REFERENCE_WALL_VELOCITY } from "./stylus";

const TWO_PI = Math.PI * 2;

/**
 * 盤面を角度で区切る数。針が1つの区画にいる間はそこの欠陥だけ見ればよいので、
 * 埃を何百個置いても1サンプルあたりの仕事は増えない。
 */
const ANGULAR_BINS = 512;

export interface SurfaceParameters {
  /**
   * この盤の seed。**同じ seed なら同じ盤**で、傷も埃も同じ場所にある。
   * 将来は音源のハッシュから決める（rdd.md 7.4 / audio-engine.md 9.2）。
   */
  seed: number;
  /**
   * 表面粗さ。溝の壁そのものの荒さで、**連続した溝の経路に固定**されている。
   * 毎サンプルの乱数ではないので、こすれば同じ音が返り、遅く通せば低く鳴る。
   */
  roughness: {
    /** 片壁の変位の実効値 m。0 で無し。 */
    rms: number;
    /** 溝に沿った相関長 m。短いほど高い音になる。 */
    correlationLength: number;
  };
  /** 溝に落ちた埃。有限の大きさを持つ盤面上の点。 */
  dust: {
    /** 盤全体に置く粒の数。0 で無し。 */
    count: number;
    /** 粒の半径 m。 */
    minRadius: number;
    maxRadius: number;
    /** 一番大きい粒が針を持ち上げる高さ m。 */
    height: number;
  };
  /** 溝を横切る傷。**1本が何回転ぶんもの溝を横切る。** */
  scratches: {
    /** 本数。0 で無し。 */
    count: number;
    /** 溝を横切る向きの幅 m。狭いほど鋭いクリックになる。 */
    width: number;
    /** 抉れの深さ m。 */
    depth: number;
    /** 弧の曲がり具合 rad/m。0 なら半径方向の直線＝完全に垂直な擾乱。 */
    curvature: number;
    /** 1本が覆う半径方向の長さ m。 */
    length: number;
  };
}

/** 傷も埃も粗さも無い盤。**この設定では完全にバイパスされる。** */
export const CLEAN_SURFACE: SurfaceParameters = {
  seed: 0,
  roughness: { rms: 0, correlationLength: 0 },
  dust: { count: 0, minRadius: 0, maxRadius: 0, height: 0 },
  scratches: { count: 0, width: 0, depth: 0, curvature: 0, length: 0 },
};

interface DustSpeck {
  /** スピンドルからの距離 m。 */
  radius: number;
  /** 盤上の角度 rad。 */
  angle: number;
  /** 粒の半径 m。 */
  size: number;
  /** 針を持ち上げる高さ（溝の単位）。 */
  height: number;
  /** 溝のどちら寄りに乗っているか。−1〜1。 */
  lean: number;
}

interface Scratch {
  /** 内周端での角度 rad。 */
  angle: number;
  /** 半径が増えるほど角度がずれる量 rad/m。0 なら直線。 */
  curvature: number;
  innerRadius: number;
  outerRadius: number;
  /** 溝を横切る向きの半幅 m。 */
  halfWidth: number;
  /** 抉れの深さ（溝の単位）。 */
  depth: number;
  /** 溝を斜めに横切るぶん、横方向へ効く割合。直線の傷なら0。 */
  obliquity: number;
}

/** 最短側で測る。±π の継ぎ目で1回転ぶん跳ねない。 */
function wrapToPi(angle: number): number {
  return ((((angle + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

/** 0〜2π へ畳む。負の角度でも正しく回る。 */
function wrapToTwoPi(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

/**
 * 溝の経路に固定された連続なノイズ。節の値は hash、間は Catmull-Rom。
 *
 * **節を通り、傾きも連続。** 直線補間だと速度（＝差分）が階段になり、粗さではなく
 * 砂利の音になる。
 */
function pathNoise(seed: number, x: number): number {
  const node = Math.floor(x);
  const t = x - node;
  const a = signed(seed, node - 1);
  const b = signed(seed, node);
  const c = signed(seed, node + 1);
  const d = signed(seed, node + 2);
  return (
    0.5 *
    (2 * b +
      (c - a) * t +
      (2 * a - 5 * b + 4 * c - d) * t * t +
      (3 * b - 3 * c + d - a) * t * t * t)
  );
}

/** 端で値も傾きも 0 になる山。入口と出口で段差が出ない。 */
const bump = (squared: number) => (1 - squared) * (1 - squared);

export interface Surface {
  /** 何も無い盤なら true。このとき `sample` は 0 しか返さない。 */
  readonly bypassed: boolean;
  /** 直近の `sample` の結果（永久 ＋ 埃）。割り当てを避けるため、ここに書く。 */
  readonly left: number;
  readonly right: number;
  /**
   * そのうち**盤に永久に残る形**（表面粗さ＋傷）。
   *
   * **摩耗（`wear.ts`）が削れるのはこちらだけ**である。埃は取り除ける異物なので、
   * 針が通っても盤の形にはならない —— 払えば消えるものを溝へ焼き込まない。
   */
  readonly permanentLeft: number;
  readonly permanentRight: number;
  /** そのうち**取り除ける埃**のぶん。 */
  readonly dustLeft: number;
  readonly dustRight: number;
  /** 埃が1粒も無いか。true なら永久側だけを読めばよい。 */
  readonly dustless: boolean;
  /**
   * 盤を1枚作る。**盤の装填時とパラメータ変更時にだけ**呼ぶ。
   *
   * `layout` は螺旋の形（半径と回転数の対応）を知るために要る。`grooveSampleRate`
   * はメートルを溝の単位へ直すために要る。
   */
  configure(
    parameters: SurfaceParameters,
    layout: CutLayout | null,
    grooveSampleRate: number,
  ): void;
  /**
   * その場所の盤面欠陥の変位を `left` / `right` へ書く。
   *
   * @param revolutions 螺旋上の位置。**溝に沿った距離（表面粗さ）だけ**を決める。
   * @param recordRadius レコード座標の半径 m（溝の中心から。`discShape.ts`）。
   * @param recordAngle レコード座標の角度 rad。巻き戻していなくてよい。
   */
  sample(revolutions: number, recordRadius: number, recordAngle: number): void;
}

export function createSurface(
  parameters: SurfaceParameters = CLEAN_SURFACE,
  layout: CutLayout | null = null,
  grooveSampleRate = 48000,
): Surface {
  let dustBins: DustSpeck[][] = [];
  let scratchBins: Scratch[][] = [];
  let hasFeatures = false;

  let roughAmplitude = 0;
  let nodesPerMetre = 0;
  let seedLeft = 0;
  let seedRight = 0;

  let spiral: CutLayout | null = null;
  /** 溝に沿った距離を出すための係数。`arcLength` を参照。 */
  let pitch = 0;

  /**
   * 螺旋の始まりから `rev` までの、**溝に沿った距離** m。
   *
   * 半径が `r = R0 − pitch·rev` と決まっているので、`∫2πr d(rev)` はそのまま解ける。
   * 表面粗さの索引がこれである以上、内周ほど1回転が短くなり、同じ粗さが低い音に
   * なる — 実機の内周と同じ理屈で、別に書く必要はない。
   */
  const arcLength = (rev: number) =>
    TWO_PI * (GROOVE.leadInRadius * rev - (pitch * rev * rev) / 2);

  /** 角度の範囲に触れる区画すべてへ入れる。1サンプルの検索を短く保つための索引。 */
  function addToBins<T>(bins: T[][], item: T, from: number, to: number): void {
    if (to - from >= TWO_PI) {
      for (const bin of bins) bin.push(item);
      return;
    }
    const first = Math.floor((from / TWO_PI) * ANGULAR_BINS);
    const last = Math.floor((to / TWO_PI) * ANGULAR_BINS);
    for (let i = first; i <= last; i++) {
      const index = ((i % ANGULAR_BINS) + ANGULAR_BINS) % ANGULAR_BINS;
      bins[index].push(item);
    }
  }

  const surface: Surface = {
    bypassed: true,
    left: 0,
    right: 0,
    permanentLeft: 0,
    permanentRight: 0,
    dustLeft: 0,
    dustRight: 0,
    dustless: true,

    configure(next, cut, sampleRate) {
      spiral = cut;
      pitch = cut === null ? 0 : cut.programPitch;

      dustBins = Array.from({ length: ANGULAR_BINS }, (): DustSpeck[] => []);
      scratchBins = Array.from({ length: ANGULAR_BINS }, (): Scratch[] => []);
      roughAmplitude = 0;
      nodesPerMetre = 0;
      hasFeatures = false;

      const self = surface as {
        bypassed: boolean;
        dustless: boolean;
        left: number;
        right: number;
        permanentLeft: number;
        permanentRight: number;
        dustLeft: number;
        dustRight: number;
      };
      self.left = 0;
      self.right = 0;
      self.permanentLeft = 0;
      self.permanentRight = 0;
      self.dustLeft = 0;
      self.dustRight = 0;
      self.bypassed = true;
      self.dustless = true;
      if (cut === null || !Number.isFinite(sampleRate) || sampleRate <= 0) return;

      // 寸法は m で持ち、ここ1箇所で溝の単位へ直す。溝の変位は速度の素朴な累算
      // なので、1単位 = referenceVelocity / grooveSampleRate メートルにあたる。
      const metresToUnits = sampleRate / REFERENCE_WALL_VELOCITY;
      const seed = Number.isFinite(next.seed) ? next.seed | 0 : 0;
      seedLeft = seed ^ 0x5ea1;
      seedRight = seed ^ 0x3b17;

      // --- 表面粗さ: 溝の経路に沿った1次元のノイズ ---
      const correlation = next.roughness.correlationLength;
      if (next.roughness.rms > 0 && correlation > 0) {
        // 節の値は [-1,1) の一様分布（実効値 1/√3）なので √3 を掛けて戻す。
        // 補間が均すぶん、出てくる実効値は指定より少しだけ小さい。
        roughAmplitude = next.roughness.rms * metresToUnits * Math.sqrt(3);
        nodesPerMetre = 1 / correlation;
      }

      // --- 埃: 盤面へ面積一様にばらまく ---
      const dust = next.dust;
      const count = Math.max(0, Math.min(Math.floor(dust.count) || 0, 4096));
      const maxSize = Math.max(dust.minRadius, dust.maxRadius);
      if (count > 0 && maxSize > 0 && dust.height > 0) {
        const inner = GROOVE.leadOutRadius;
        const outer = GROOVE.discRadius;
        for (let i = 0; i < count; i++) {
          const at = i * 5;
          // 面積一様: 半径を二乗で引く。外周ばかりに寄らない。
          const radius = Math.sqrt(
            inner * inner + hash(seed, at) * (outer * outer - inner * inner),
          );
          const size = Math.max(
            1e-6,
            dust.minRadius + hash(seed, at + 2) * (maxSize - dust.minRadius),
          );
          const speck: DustSpeck = {
            radius,
            angle: hash(seed, at + 1) * TWO_PI,
            size,
            // 大きい粒ほど高く持ち上げる。別の乱数を引かない。
            height: dust.height * (size / maxSize) * metresToUnits,
            lean: signed(seed, at + 3),
          };
          const spread = speck.size / speck.radius;
          addToBins(dustBins, speck, speck.angle - spread, speck.angle + spread);
        }
        hasFeatures = true;
        self.dustless = false;
      }

      // --- 傷: 溝を何本も横切る線または弧 ---
      const scratches = next.scratches;
      const lines = Math.max(0, Math.min(Math.floor(scratches.count) || 0, 256));
      if (lines > 0 && scratches.depth > 0 && scratches.width > 0) {
        for (let i = 0; i < lines; i++) {
          const at = 0x10000 + i * 5;
          const span = Math.max(
            scratches.width,
            scratches.length * (0.4 + 0.6 * hash(seed, at + 2)),
          );
          const inner = Math.max(
            GROOVE.leadOutRadius,
            GROOVE.leadOutRadius +
              hash(seed, at) * (GROOVE.discRadius - GROOVE.leadOutRadius - span),
          );
          const outer = Math.min(GROOVE.discRadius, inner + span);
          const curvature = scratches.curvature * signed(seed, at + 3);
          const middle = (inner + outer) / 2;
          // 溝を斜めに横切るほど、抉れは横方向へも効く。**傷の形から出る値**で、
          // 別に持つパラメータではない。直線（curvature = 0）なら厳密に0。
          const slope = middle * curvature;
          const scratch: Scratch = {
            angle: hash(seed, at + 1) * TWO_PI,
            curvature,
            innerRadius: inner,
            outerRadius: outer,
            halfWidth: (scratches.width * (0.5 + hash(seed, at + 4))) / 2,
            depth: scratches.depth * metresToUnits,
            obliquity: slope / Math.hypot(1, slope),
          };
          const drift = curvature * (outer - inner);
          const spread = scratch.halfWidth / inner;
          addToBins(
            scratchBins,
            scratch,
            Math.min(scratch.angle, scratch.angle + drift) - spread,
            Math.max(scratch.angle, scratch.angle + drift) + spread,
          );
        }
        hasFeatures = true;
      }

      self.bypassed = !(roughAmplitude > 0 || hasFeatures);
    },

    sample(revolutions, recordRadius, recordAngle) {
      const self = surface as {
        left: number;
        right: number;
        permanentLeft: number;
        permanentRight: number;
        dustLeft: number;
        dustRight: number;
      };
      if (surface.bypassed || spiral === null) {
        self.left = 0;
        self.right = 0;
        self.permanentLeft = 0;
        self.permanentRight = 0;
        self.dustLeft = 0;
        self.dustRight = 0;
        return;
      }

      // 壁ごとに別の面。左右は無相関で、横方向にも垂直方向にも同じだけ乗る。
      let left = 0;
      let right = 0;
      // **埃だけを別に持つ。** 摩耗が削れるのは残りのほう（`wear.ts`）。
      let dustLeft = 0;
      let dustRight = 0;
      if (roughAmplitude > 0) {
        const along = arcLength(revolutions) * nodesPerMetre;
        left = pathNoise(seedLeft, along) * roughAmplitude;
        right = pathNoise(seedRight, along) * roughAmplitude;
      }

      if (hasFeatures && Number.isFinite(recordRadius)) {
        // **いま針の真下にある盤面の点。** 呼び出し側が `discShape.ts` の座標変換で
        // 出したもので、盤の回転・アームの振れ・偏心がすべて畳まれている。
        const radius = recordRadius;
        const angle = wrapToTwoPi(recordAngle);
        const bin =
          (Math.floor((angle / TWO_PI) * ANGULAR_BINS) % ANGULAR_BINS +
            ANGULAR_BINS) %
          ANGULAR_BINS;

        let vertical = 0;
        let lateral = 0;

        // **埃は盤の形ではない。** 別に積んで、摩耗の対象から外す。
        let dustVertical = 0;
        let dustLateral = 0;
        const specks = dustBins[bin];
        for (let i = 0; i < specks.length; i++) {
          const speck = specks[i];
          const across = radius - speck.radius;
          if (across > speck.size || across < -speck.size) continue;
          const along = radius * wrapToPi(angle - speck.angle);
          const distance = (along * along + across * across) / (speck.size * speck.size);
          if (distance >= 1) continue;
          // 針は粒に乗り上げる。持ち上げなので垂直が主で、粒の寄りぶんが横に出る。
          const lift = speck.height * bump(distance);
          dustVertical += lift;
          dustLateral += lift * speck.lean;
        }
        if (dustVertical !== 0 || dustLateral !== 0) {
          dustLeft = (dustLateral + dustVertical) * Math.SQRT1_2;
          dustRight = (dustLateral - dustVertical) * Math.SQRT1_2;
        }

        const cuts = scratchBins[bin];
        for (let i = 0; i < cuts.length; i++) {
          const scratch = cuts[i];
          if (radius < scratch.innerRadius || radius > scratch.outerRadius) continue;
          const line =
            scratch.angle + scratch.curvature * (radius - scratch.innerRadius);
          const along = (radius * wrapToPi(angle - line)) / scratch.halfWidth;
          if (along >= 1 || along <= -1) continue;
          // 抉れなので針は落ちる。斜めに横切るぶんだけ横方向へも振られる。
          const drop = scratch.depth * bump(along * along);
          vertical -= drop;
          lateral -= drop * scratch.obliquity;
        }

        // 45/45 の関係の逆。**垂直の擾乱は逆相として出る。**
        left += (lateral + vertical) * Math.SQRT1_2;
        right += (lateral - vertical) * Math.SQRT1_2;
      }

      self.permanentLeft = left;
      self.permanentRight = right;
      self.dustLeft = dustLeft;
      self.dustRight = dustRight;
      self.left = left + dustLeft;
      self.right = right + dustRight;
    },
  };

  surface.configure(parameters, layout, grooveSampleRate);
  return surface;
}
