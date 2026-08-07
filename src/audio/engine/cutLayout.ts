/**
 * この盤がどう切られたか — 螺旋溝の割り付け。
 *
 * レコードの溝は1本の螺旋である。したがって**針の半径は「曲の何秒目か」では
 * なく「盤が何回転したか」で決まる**。1回転で内側へ進む量（ピッチ）が半径の
 * 変化そのものであり、正転でも逆転でも停止でも、この関係は変わらない。
 *
 * ## 固定の grooveZone との役割分担
 *
 * `physics/groove.ts` の `GrooveZone` は**盤という物体の形**（どこに溝を切れる
 * か）を表す。こちらは**その盤に実際に何を切ったか**を表す。前者はすべての盤で
 * 同じ、後者は音源ごとに違う。針が演奏領域にいるかどうかの判定はこちら側にある。
 *
 * ## 回転数の原点
 *
 * `revolutions = 0` を**演奏領域の始まり**（リードイン溝の位置）に置く。
 * 負はリードイン、正は演奏領域から内側。カーソルは `revolutions ×
 * samplesPerRevolution` で得られるので、回転数が正本でカーソルは従属変数。
 *
 * Web Audio にも Three.js にも依存しない。
 */

import { GROOVE } from "../../physics/groove";
import { FITS, type CutFit } from "./pitchControl";

export const CUT = {
  /**
   * 演奏領域のピッチの**初期基準**、0.136mm/rev。実機のカッティングと同じく、
   * 収まらない長い音源に対してだけ詰める（`createCutLayout` を参照）。
   */
  programPitch: 0.000136,
  /**
   * リードイン／リードアウトの粗いピッチ、6.4mm/rev。演奏領域の約47倍の速さで
   * 内側へ進むので、無音部分を短い距離で通り抜ける。
   */
  transitPitch: 0.0064,
  /** ロックドグルーブの半径、53.2mm。ここで螺旋は終わり、同じ溝を回り続ける。 */
  lockedRadius: 0.0532,
  /** 既定のカット速度。盤ごとの値は将来 TrackRecord.nominalRpm から来る（rdd.md 25）。 */
  cutRpm: 33.333,
};

export type CutRegion = "lead-in" | "program" | "lead-out" | "locked";

/**
 * **回転ごとの溝の間隔。** 可変ピッチのときだけ持つ（一定なら null）。
 *
 * `radii[k]` は回転 k の**開始半径**で、`radii[k+1] = radii[k] − pitches[k]`。
 * 単調減少なので、半径から回転数への逆写像は二分探索で厳密に引ける。
 *
 * **1回転の中ではピッチは一定**である。送り機構は回転より速くは動けないので、
 * これは近似ではなく実機の刻みそのもの。
 */
export interface GroovePitchMap {
  readonly pitches: Float64Array;
  readonly radii: Float64Array;
}

export interface CutLayout {
  cutRpm: number;
  /** カット時の1回転あたりのサンプル数。カーソルと回転数を結ぶ唯一の係数。 */
  samplesPerRevolution: number;
  /**
   * ピッチ。可変のときは**平均値**で、位置の正本ではない（正本は `pitch`）。
   * 一定ピッチのときだけ、これがそのまま半径の傾きになる。
   */
  programPitch: number;
  /**
   * 可変ピッチの正本。**null は一定ピッチ**で、そのとき半径は従来どおり
   * `leadInRadius − programPitch × 回転数` の直線である（既存の盤と一致する）。
   */
  pitch: GroovePitchMap | null;
  /** 盤に収まったか。一定ピッチの盤はいつも `FITS`。 */
  fit: CutFit;
  /** 演奏領域が占める回転数。 */
  programRevolutions: number;
  /** リードインの回転数（負の側の端）。 */
  leadInRevolutions: number;
  /** ロックドグルーブに入る回転数。ここで螺旋は止まる。 */
  lockedRevolutions: number;
  /** 演奏領域が終わる半径。短い音源ではまだ外側にある。 */
  programEndRadius: number;
}

/**
 * 音源1本ぶんの割り付けを作る。**音源ロード時に一度だけ**。
 *
 * 短い音源を盤面いっぱいへ引き伸ばさない。0.136mm/rev で切れるところまで切り、
 * 余った内周はリードアウトになる — 実際のレコードで短い面がそうなるのと同じ。
 * 長すぎて 57.5mm までに収まらない場合だけ、収まるようピッチを詰める（実機の
 * カッティングでも同じことをする）。
 */
export function createCutLayout(
  durationSeconds: number,
  sampleRate: number,
  cutRpm: number = CUT.cutRpm,
  /**
   * 回転ごとのピッチ m/rev（`pitchControl.ts` が作る）。**省略すれば従来どおりの
   * 一定ピッチ**で、既存の盤と同じ割り付けになる。
   */
  pitches?: Float64Array,
  fit: CutFit = FITS,
): CutLayout {
  const rpm = Number.isFinite(cutRpm) && cutRpm > 0 ? cutRpm : CUT.cutRpm;
  const secondsPerRevolution = 60 / rpm;
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const programRevolutions = duration / secondsPerRevolution;

  // 演奏領域として使える幅。リードイン溝からリードアウト溝まで。
  const available = GROOVE.leadInRadius - GROOVE.leadOutRadius;

  if (pitches !== undefined && pitches.length > 0 && programRevolutions > 0) {
    return variableLayout(
      pitches,
      rpm,
      sampleRate * secondsPerRevolution,
      programRevolutions,
      fit,
    );
  }

  const programPitch =
    programRevolutions > 0
      ? Math.min(CUT.programPitch, available / programRevolutions)
      : CUT.programPitch;

  const programEndRadius = GROOVE.leadInRadius - programPitch * programRevolutions;
  const leadOutRevolutions = Math.max(
    0,
    (programEndRadius - CUT.lockedRadius) / CUT.transitPitch,
  );

  return {
    cutRpm: rpm,
    samplesPerRevolution: sampleRate * secondsPerRevolution,
    programPitch,
    pitch: null,
    fit,
    programRevolutions,
    // リードインは盤の外周から演奏領域まで、粗いピッチで1回転ぶん強。
    leadInRevolutions: -(GROOVE.discRadius - GROOVE.leadInRadius) / CUT.transitPitch,
    lockedRevolutions: programRevolutions + leadOutRevolutions,
    programEndRadius,
  };
}

/**
 * 可変ピッチの割り付け。**半径は回転ごとの累積**になる。
 *
 * 累積を配列で持つのは、逆写像を厳密にするためである。式で持つと半径から回転数を
 * 引くのに数値解が要る —— 針を降ろすたびに反復計算をすることになり、しかも往復で
 * 誤差が残る。
 */
function variableLayout(
  pitches: Float64Array,
  rpm: number,
  samplesPerRevolution: number,
  requestedRevolutions: number,
  fit: CutFit,
): CutLayout {
  let programRevolutions = requestedRevolutions;
  const radii = new Float64Array(pitches.length + 1);
  radii[0] = GROOVE.leadInRadius;
  for (let k = 0; k < pitches.length; k++) {
    radii[k + 1] = radii[k] - pitches[k];
  }

  // **盤からはみ出させない。** 収まらない盤（`fit.impossible`）では、リードアウト溝に
  // 届いたところで演奏領域を打ち切る —— 螺旋がラベルの上まで伸びるくらいなら「そこで
  // 盤が尽きた」ほうが事実に近い。理由は `fit` が持っている。
  let usable = Math.min(programRevolutions, pitches.length);
  if (radii[radii.length - 1] < GROOVE.leadOutRadius) {
    for (let k = 0; k < pitches.length; k++) {
      if (radii[k + 1] <= GROOVE.leadOutRadius) {
        usable = Math.min(
          usable,
          pitches[k] > 0 ? k + (radii[k] - GROOVE.leadOutRadius) / pitches[k] : k,
        );
        break;
      }
    }
  }

  const whole = Math.floor(usable);
  const last = Math.min(pitches.length - 1, whole);
  const programEndRadius =
    whole >= pitches.length
      ? radii[pitches.length]
      : radii[last] - pitches[last] * (usable - whole);
  programRevolutions = usable;

  const leadOutRevolutions = Math.max(
    0,
    (programEndRadius - CUT.lockedRadius) / CUT.transitPitch,
  );
  // 平均ピッチ。**位置には使わない** — 溝に沿った距離のように、1本の代表値で
  // 足りるところだけが読む（`surface.ts`）。
  const mean = (GROOVE.leadInRadius - programEndRadius) / programRevolutions;

  return {
    cutRpm: rpm,
    samplesPerRevolution,
    programPitch: mean,
    pitch: { pitches, radii },
    fit,
    programRevolutions,
    leadInRevolutions: -(GROOVE.discRadius - GROOVE.leadInRadius) / CUT.transitPitch,
    lockedRevolutions: programRevolutions + leadOutRevolutions,
    programEndRadius,
  };
}

/**
 * その回転で隣の溝とどれだけ離れているか m。**pre-echo / post-echo の距離**は
 * ここから出る（隣接する溝の間隔がそのまま転写の強さを決める）。
 *
 * 演奏領域の外はリードイン／リードアウトの粗いピッチ。
 */
export function grooveSpacingAt(layout: CutLayout, revolutions: number): number {
  if (!Number.isFinite(revolutions)) return layout.programPitch;
  if (revolutions < 0 || revolutions > layout.programRevolutions) {
    return CUT.transitPitch;
  }
  if (layout.pitch === null) return layout.programPitch;
  const index = Math.min(
    layout.pitch.pitches.length - 1,
    Math.max(0, Math.floor(revolutions)),
  );
  return layout.pitch.pitches[index];
}

/** 螺旋のどこにいるか。半径ではなく回転数で決まる。 */
export function cutRegionAt(layout: CutLayout, revolutions: number): CutRegion {
  if (revolutions < 0) return "lead-in";
  if (revolutions <= layout.programRevolutions) return "program";
  if (revolutions < layout.lockedRevolutions) return "lead-out";
  return "locked";
}

/**
 * 回転数 → 半径。区分ごとに一次関数で、単調減少。
 *
 * これが「1回転あたりの移動量」の定義そのものなので、正転・逆転・停止・速度
 * 変更のどれでも一貫する。速度は回転数の進み方を変えるだけで、1回転あたりの
 * 移動量は変えない。
 */
export function radiusAtRevolution(layout: CutLayout, revolutions: number): number {
  if (!Number.isFinite(revolutions)) return GROOVE.leadInRadius;
  if (revolutions <= layout.leadInRevolutions) return GROOVE.discRadius;
  if (revolutions < 0) return GROOVE.leadInRadius - CUT.transitPitch * revolutions;
  if (revolutions <= layout.programRevolutions) {
    const map = layout.pitch;
    if (map === null) return GROOVE.leadInRadius - layout.programPitch * revolutions;
    // 1回転の中は一定ピッチなので、区分ごとの一次式。**厳密に可逆。**
    const index = Math.min(map.pitches.length - 1, Math.floor(revolutions));
    return map.radii[index] - map.pitches[index] * (revolutions - index);
  }
  if (revolutions < layout.lockedRevolutions) {
    return (
      layout.programEndRadius -
      CUT.transitPitch * (revolutions - layout.programRevolutions)
    );
  }
  return CUT.lockedRadius;
}

/**
 * 半径 → 回転数。針を降ろした位置から螺旋上の位置を引くための逆写像。
 *
 * `radiusAtRevolution` の厳密な逆で、範囲外は端に丸める（盤の外に螺旋は無い）。
 */
export function revolutionsAtRadius(layout: CutLayout, radius: number): number {
  if (!Number.isFinite(radius)) return 0;
  if (radius >= GROOVE.discRadius) return layout.leadInRevolutions;
  if (radius > GROOVE.leadInRadius) {
    return (GROOVE.leadInRadius - radius) / CUT.transitPitch;
  }
  if (radius >= layout.programEndRadius) {
    const map = layout.pitch;
    if (map === null) {
      // ピッチが0（長さ0の音源）なら演奏領域は点。先頭を返す。
      return layout.programPitch > 0
        ? (GROOVE.leadInRadius - radius) / layout.programPitch
        : 0;
    }
    // radii は単調減少。**radiusAtRevolution の厳密な逆**を二分で引く。
    let low = 0;
    let high = map.pitches.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (map.radii[middle] >= radius) low = middle;
      else high = middle - 1;
    }
    const pitch = map.pitches[low];
    return pitch > 0 ? low + (map.radii[low] - radius) / pitch : low;
  }
  if (radius > CUT.lockedRadius) {
    return (
      layout.programRevolutions +
      (layout.programEndRadius - radius) / CUT.transitPitch
    );
  }
  return layout.lockedRevolutions;
}

/**
 * 回転数 → 溝バッファ上の位置（ソースサンプル）。
 *
 * 演奏領域の外には音が無いので null。リードインもリードアウトもロックドも、
 * 溝はあるが音源は無い（そこに刻まれているのは無音の溝）。
 */
export function cursorAtRevolution(
  layout: CutLayout,
  revolutions: number,
): number | null {
  if (!Number.isFinite(revolutions)) return null;
  if (revolutions < 0 || revolutions > layout.programRevolutions) return null;
  return revolutions * layout.samplesPerRevolution;
}
