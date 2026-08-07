/**
 * 盤そのものの形 — **偏心と反り**。Record領域。
 *
 * 盤は完全な円板ではない。穴が溝の中心からずれていれば（偏心）、スピンドルを軸に
 * 回したとき溝は針の下で前後・左右に揺れる。板が反っていれば、盤面の高さが場所に
 * よって違う。**どちらも盤に固定された形であって、モーターの回り方ではない。**
 *
 * ```
 *   Drive領域   モーターと手 → ω, φ           ← ここは触らない
 *   Record領域  盤の形（偏心・反り）           ← 本モジュール
 *               盤面の欠陥（傷・埃・粗さ）      ← surface.ts
 *   Pickup領域  接触・カートリッジ・RIAA
 * ```
 *
 * **ω を揺らして wow を作ってはならない。** それは Drive領域の話（モーター由来の
 * wow/flutter、`physics/wowFlutter.ts`）であり、偏心とは別物である。偏心の wow は
 * 「盤が一定の速さで回って
 * いても、溝が針の下を通る速さが1回転周期で変わる」ことから出る — 座標変換だけで
 * 出るので、後段は何も知らなくてよい。
 *
 * ## レコード座標
 *
 * **この座標系が、音声・盤面欠陥・将来の盤面描画の共通言語である。** ワールドから
 * 見た針先の位置（スピンドルからの距離と方位角）と盤の回転角から、盤そのものの上で
 * どこにいるかを出す。
 *
 * ```
 *   溝の中心 = スピンドル + e·(cos(φ+ψ), sin(φ+ψ))     ψ は盤に固定（seedで決まる）
 *   針先     = スピンドル + r·(cos a, sin a)
 *
 *   recordRadius = |針先 − 溝の中心|          その盤の「何周目か」を決める半径
 *   recordAngle  = 溝の中心から見た方位 − φ    盤に固定された角度
 *   wobble       = recordAngle − (a − φ)      偏心が角度に与えたずれ（小さい）
 * ```
 *
 * `e = 0` なら `recordRadius = r`、`recordAngle = a − φ`、`wobble = 0` — つまり
 * **完全にバイパスされ、偏心を入れる前と1サンプルも変わらない。**
 *
 * 帰結（どれも別に書かない）:
 *
 * - `wobble` が1回転周期で±(e/r) 揺れる → **カーソルが同じ周期で前後する＝wow**。
 * - `recordRadius` を一定に保つには実際の半径が±e 動く → **アームが左右に揺れる**。
 * - 逆回転すれば `wobble` も `recordAngle` も逆順に辿る → **正逆で同じ形**。
 *
 * ## 反り
 *
 * 高さ場 `h(recordRadius, recordAngle)`。盤の中心はスピンドルとマットで押さえられて
 * いるので、どの成分も外周ほど大きい（r² で効かせる）。成分は2種類あり、
 * **針の下での時間変化がまったく違うので分けてある**:
 *
 * | 成分 | 角度依存 | 針が感じるもの |
 * |---|---|---|
 * | **dish（皿）** | **無し**。半径だけの関数 | 盤に固定された段差。1回転しても高さは変わらず、アームが内周へ寄るあいだにゆっくり傾くだけ |
 * | **warp / tilt（反り・傾き）** | 1回転につき k 回 | k=1 が once-per-revolution の傾き、k=2 が鞍（ポテトチップ）。**実際の反りはほぼこの2つ** |
 *
 * **k=1 は皿ではない。** 皿は角度に依らないので、角度の1次成分に「皿」という名前を
 * 付けると、盤が傾いているだけの状態を皿と呼ぶことになる。両者は針の下でまったく
 * 別のものになる（片方は 0.55Hz の揺れ、もう片方はほぼ直流）。
 *
 * 高さは2つの経路で効く。**どちらも既存の仕組みへ渡すだけで、新しい機構は無い。**
 *
 * 1. **接触**: トーンアーム側の支持面の高さがこの値ぶん動く。アームは上下し、
 *    面が逃げる速さにアームの実効質量が付いていけなければ接触を失う
 *    （`physics/tonearm.ts` の `TonearmVertical`）。
 * 2. **溝**: 垂直方向の変位として溝に足される。ただし**足すのは盤面の高さでは
 *    なく、アームが追従し切れずにカンチレバーへ残ったぶん**である。共振より下
 *    （反りの帯域）ではアームが付いていくので、コイルはほとんど何も拾わない。
 *
 * かつてここにあった「アームの実効質量が無いので超低域の出力を過大に見積もる」と
 * いう限界は、`TonearmVertical` を入れたことで解消済み（audio-engine.md 13）。
 */

import { GROOVE } from "../../physics/groove";

const TWO_PI = Math.PI * 2;

export interface DiscShapeParameters {
  /** 盤ごとの seed。**同じ seed なら同じ歪み方**をする。 */
  seed: number;
  eccentricity: {
    /**
     * 溝の中心とスピンドル穴のずれ m。**0 で真円＝完全バイパス。**
     * 実測される盤で 0.05〜0.3mm ほど。
     */
    offset: number;
  };
  warp: {
    /**
     * **皿（dish）**: 角度に依らない半径方向の高さ m。外周での値で、正が
     * 外周の持ち上がり、負が中央の盛り上がり。盤に固定された形なので、
     * 回転しても針の下では変化しない。**0 で無し。**
     */
    dish: number;
    /**
     * **once-per-revolution の反り・傾き（warp / tilt）**: 角度方向の高さ m
     * （外周・片振幅）。**0 で平ら＝完全バイパス。**
     */
    amplitude: number;
    /** 角度方向に使う次数。**1 が once-per-revolution の傾き、2 が鞍。** */
    harmonics: number;
  };
}

/** 歪みの無い盤。**この設定では座標変換も高さ場も素通しになる。** */
export const FLAT_DISC: DiscShapeParameters = {
  seed: 0,
  eccentricity: { offset: 0 },
  warp: { dish: 0, amplitude: 0, harmonics: 0 },
};

/**
 * counter-based hash。**乱数を引かない。**
 *
 * 同じ (seed, counter) からは常に同じ値が出るので、盤の形も欠陥も seed だけで
 * 決まる（audio-engine.md 9.2）。`surface.ts` もこれを使う。
 */
export function discHash(seed: number, counter: number): number {
  let x = (seed ^ Math.imul(counter | 0, 0x9e3779b1)) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

/** [-1, 1)。 */
export const discSigned = (seed: number, counter: number) =>
  discHash(seed, counter) * 2 - 1;

/** 最短側で測る。±π の継ぎ目で1回転ぶん跳ねない。 */
const wrapToPi = (angle: number) =>
  ((((angle + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;

const finite = (value: number, fallback = 0) =>
  Number.isFinite(value) ? value : fallback;

/** 偏心も反りも皿も無いか。**このとき座標変換は恒等写像である。** */
export function isFlatDisc(shape: DiscShapeParameters): boolean {
  return !(
    finite(shape.eccentricity.offset) > 0 ||
    finite(shape.warp.dish) !== 0 ||
    (finite(shape.warp.amplitude) > 0 && shape.warp.harmonics >= 1)
  );
}

/** 溝の中心が盤上のどちらを向いているか。seed だけで決まり、盤に固定される。 */
const eccentricBearing = (seed: number) => discHash(seed, 0x0ecc) * TWO_PI;

/** 針先が盤のどこにいるか。**音声・欠陥・描画が共有する座標。** */
export interface RecordPoint {
  /** 溝の中心から針先までの距離 m。「何周目か」はこれで決まる。 */
  radius: number;
  /** 盤に固定された角度 rad。**巻き戻さない**ので、そのまま補間できる。 */
  angle: number;
  /** 偏心が角度に与えたずれ rad。カーソルの補正はこれ1つから出る。 */
  wobble: number;
}

/**
 * ワールドから見た針先 → レコード座標。
 *
 * @param labRadius スピンドルから針先までの水平距離 m
 * @param labAzimuth スピンドルから見た針先の方位角 rad（盤の回転と同じ符号）
 * @param platterAngle 盤の回転角 rad（`phiUnwrapped`）
 */
export function recordPointAt(
  shape: DiscShapeParameters,
  labRadius: number,
  labAzimuth: number,
  platterAngle: number,
  into: RecordPoint = { radius: 0, angle: 0, wobble: 0 },
): RecordPoint {
  const ideal = labAzimuth - platterAngle;
  const offset = finite(shape.eccentricity.offset);
  if (!(offset > 0) || !Number.isFinite(labRadius) || labRadius <= 0) {
    into.radius = labRadius;
    into.angle = ideal;
    into.wobble = 0;
    return into;
  }

  // 溝の中心はスピンドルのまわりを1回転周期で回る（盤に固定されているので）。
  const bearing = platterAngle + eccentricBearing(shape.seed);
  const dx = labRadius * Math.cos(labAzimuth) - offset * Math.cos(bearing);
  const dy = labRadius * Math.sin(labAzimuth) - offset * Math.sin(bearing);

  into.radius = Math.hypot(dx, dy);
  // 巻き戻さない角度が要るので、理想（偏心0のとき）からのずれとして持つ。
  into.wobble = wrapToPi(Math.atan2(dy, dx) - labAzimuth);
  into.angle = ideal + into.wobble;
  return into;
}

/**
 * レコード座標の半径 → ワールドの半径（逆変換）。**アームを追従させるのに使う。**
 *
 * 溝を1周ぶん辿る間に、同じ溝に居続けるには実際の半径が±`offset` 動く。これが
 * 偏心した盤でアームが左右に揺れる理由そのものである。
 *
 * ponytail: 1次で展開している（誤差は e²/r ＝ 0.3mm の偏心で 0.5µm）。厳密な逆は
 * 二次方程式になるが、埃1粒が300µmであることを思えば意味の無い精度である。
 */
export function labRadiusFor(
  shape: DiscShapeParameters,
  recordRadius: number,
  labAzimuth: number,
  platterAngle: number,
): number {
  const offset = finite(shape.eccentricity.offset);
  if (!(offset > 0)) return recordRadius;
  const bearing = platterAngle + eccentricBearing(shape.seed);
  return recordRadius + offset * Math.cos(labAzimuth - bearing);
}

/**
 * 盤面の高さ m。レコード座標の関数なので、**盤に固定されている**。
 *
 * 中心は押さえられているので、皿も反りも外周ほど大きい（r²）。角度方向の位相は
 * seed から決まるので、同じ盤なら同じ向きに反る。
 *
 * 皿（角度非依存）と反り（角度依存）は**別々に足す**。針の下での時間変化が
 * 違うので、1つの数字に畳むと片方の性質が消える（冒頭の表）。
 */
export function warpHeightAt(
  shape: DiscShapeParameters,
  radius: number,
  angle: number,
): number {
  if (!Number.isFinite(radius)) return 0;
  const spread = radius / GROOVE.discRadius;

  // 皿: 角度を見ない。1回転しても値は変わらず、半径が変われば変わる。
  const dish = finite(shape.warp.dish) * spread * spread;

  const amplitude = finite(shape.warp.amplitude);
  const orders = Math.min(Math.max(Math.floor(shape.warp.harmonics) || 0, 0), 8);
  if (!(amplitude > 0) || orders < 1) return dish;

  // 1/k で重みを付けるので、1次（1回転に1回の傾き）と2次（鞍）が支配的になる。
  let sum = 0;
  let norm = 0;
  for (let k = 1; k <= orders; k++) {
    sum += Math.sin(k * angle + discHash(shape.seed, 0x3a70 + k) * TWO_PI) / k;
    norm += 1 / k;
  }
  return dish + (amplitude * sum * spread * spread) / norm;
}
