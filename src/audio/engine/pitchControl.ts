/**
 * 可変ピッチのプレビュー制御 — **螺旋そのものの形を決める、ロード時の工程。**
 *
 * 実機のカッティングレースには、カッターより**1回転先**を読むプレビューヘッドが
 * ある。これから切る音の大きさが分かるので、送り機構は**大きい音が来る前に**溝の
 * 間隔を広げ、静かなところでは詰める。1枚に入る時間が延び、隣の溝と当たらない。
 *
 * ```
 *   PCM ─▶ 前処理 ─▶ RIAA ─▶ ヘッド ─▶ 溝の制約 ─▶ 積分 ─▶ 変位の包絡（回転ごと）
 *                                        ▲                     │
 *                                        │                     ├─▶ 必要ピッチ
 *                                        │                     │      ↓ 送りの追従限界
 *                                        └───── 半径 ◀──────────┴─▶ pitch map
 * ```
 *
 * **再生音に掛けるものは1つも無い。** ここが決めるのは「盤のどこに溝があるか」
 * だけで、音声カーソルにも回転速度にも触らない（`cutLayout.ts` の
 * `cursorAtRevolution` はピッチを見ない）。**変わるのは半径だけ**である。
 *
 * ## 循環依存 — 半径 → カット結果 → 必要ピッチ → 半径
 *
 * 溝に残るのは**ヘッド共振と溝の制約を通った後**の変位であり、その制約は半径で
 * 変わる（§7.12・線速度 = ω_cut × r）。ところが半径を決めているのはこの pitch
 * map である。**つまり閉ループになっている。**
 *
 * 開くのではなく、**ロード時に決定論的な反復で解く**（`PITCH_SOLVER`）。1周目は
 * 制約を通さない見積り（従来のプレビュー）、2周目からは前の螺旋の半径で実際に
 * 仮カットして測り直す。最後に**確定した半径でもう一度測って**、返す pitch map が
 * その溝を本当に収容していることを確かめる（下回っていれば引き上げる）。
 *
 * **必要ピッチは半径の減少関数である** —— ピッチを広げれば内周が早く来て制約が
 * 強くなり、削られたぶん必要な間隔は減る。つまり写像は単調減少で、素直に
 * 入れ替えると2値を往復しうる。だから残差が縮まなくなった時点で緩和へ切り替える。
 *
 * ## なぜ変位を見るのか
 *
 * 隣の溝と当たるかどうかを決めるのは**変位**であって音量ではない。溝は速度で
 * 刻まれ変位として残るので、同じ音量なら低い音ほど大きく振れる（1/f）。だから
 * 「低域で広げる」は別の係数ではなく、**変位を見れば自動的に出る**。
 *
 * ## 先読みが要る理由
 *
 * 溝と溝の間隔は**その両方**を収めなければならない。回転 k と k+1 の間隔は
 * `max(振れ幅(k), 振れ幅(k+1))` で決まるので、k を切る時点で k+1 を知っている
 * 必要がある。**プレビューヘッドが1回転先にあるのはこのため**で、窓の幅は
 * `previewRevolutions` として持つ。
 *
 * ## 数値について
 *
 * **実在機種の値は書かない。** 既定は `null`（プレビュー制御なし＝一定ピッチ）で、
 * そのとき `CutLayout` は従来と完全に一致する。
 */

import { GROOVE } from "../../physics/groove";
import {
  createCuttingChain,
  isIdealCutting,
  type CuttingParameters,
} from "./cutterHead";
import {
  createBiquadState,
  highPass,
  processBiquad,
  riaaRecording,
  type Biquad,
} from "./riaa";
import { REFERENCE_WALL_VELOCITY } from "./stylus";

/**
 * 送り機構とプレビューの設定。**溝の位置を決めるので、変えたら切り直し。**
 */
export interface PitchControlParameters {
  /**
   * 何回転先まで読むか。**1 が実機のプレビューヘッド**（次の1回転を知っていれば
   * 隣接の判定はできる）。増やすと早めに開き始める。
   */
  previewRevolutions: number;
  /** これ以上詰められない間隔 m/rev。溝の幅と安全域そのもの。 */
  minPitch: number;
  /** これ以上広げない間隔 m/rev。 */
  maxPitch: number;
  /**
   * 送り機構が**1回転で変えられる**ピッチ m/rev。機械の追従限界で、これが
   * pitch map の傾きの上限になる（急変しないことの根拠）。
   */
  maxChangePerRevolution: number;
  /**
   * 変位1mあたり何m広げるか。**2 が素直な値** —— 隣り合う2本がそれぞれ振れるので、
   * 中心間には両方ぶんの余裕が要る。
   */
  displacementGain: number;
  /** 縦方向の重み。横に対してどれだけ効かせるか。 */
  verticalWeight: number;
  /** 低域を別枠で見る境界 Hz。 */
  lowHz: number;
  /** その重み。変位で既に効いているので、**上積みのぶんだけ**。 */
  lowWeight: number;
}

/** 盤に収まったか。**収まらないとき、黙って潰さずここで返す。** */
export interface CutFit {
  /** 演奏領域が盤に収まったか。 */
  fits: boolean;
  /** 必要だった半径方向の長さ m。 */
  required: number;
  /** 使える半径方向の長さ m（リードイン溝からリードアウト溝まで）。 */
  available: number;
  /**
   * 収めるのに必要なカッティングレベルの低下 dB（0 なら不要）。
   * **この量だけ音を小さく切れば、詰めずに収まる。**
   */
  levelReductionDb: number;
  /**
   * **最小ピッチにしても収まらない。** レベルを下げても解決しないので、
   * 呼び出し側が長さか盤の側を決め直すしかない。
   */
  impossible: boolean;
  /**
   * 半径とカット結果の循環を解くのに回した反復回数（`PITCH_SOLVER`）。
   * **0 は反復していない** —— 一定ピッチの盤と、制約が1つも無い理想のカッティング。
   */
  iterations: number;
  /**
   * 許容値以内で止まったか。**false は最大反復で打ち切ったという告知**である
   * （黙って諦めない）。このときも返す pitch map は最後の測定で収容を確かめて
   * あるので溝は当たらない。詰まり方が最適でないだけである。
   */
  converged: boolean;
  /** 最後の1回で動いたピッチの最大値 m。収束の目安。 */
  residual: number;
}

/** 収まっている、というだけの報告。一定ピッチの盤はいつもこれ。 */
export const FITS: CutFit = {
  fits: true,
  required: 0,
  available: 0,
  levelReductionDb: 0,
  impossible: false,
  iterations: 0,
  converged: true,
  residual: 0,
};

/**
 * 循環を解く反復の設定。**変えると盤の詰まり方が変わる**（音は変わらない）。
 *
 * 収束は「これ以上詰められない」の判定でしかなく、**安全性は最後の収容確認が
 * 持っている**。だから許容値は緩くてよい。
 */
export const PITCH_SOLVER = {
  /** 最大反復回数。ここへ達したら `fit.converged === false` で返す。 */
  maxIterations: 12,
  /**
   * 残差が縮まなくなったときに掛ける緩和係数。**最初は 1（素直に入れ替え）**で
   * 回し、振動を検出したらこちらへ落として二度と戻さない（決定論のため）。
   */
  relaxation: 0.5,
  /**
   * 収束と見なすピッチの最大変化 m。0.1µm（最小ピッチ 80µm の 0.1%）。
   *
   * 実測では1回転ごとの残差が2桁ずつ落ちるので、ここを 1e-6 まで緩めても
   * 1e-11 まで詰めても**ナノメートル単位で同じ map** になる。厳しくしておく側の
   * 代償は1〜2パスで済む。
   */
  pitchTolerance: 1e-7,
  /** 同じく半径 m。1µm（演奏領域 88.5mm に対して 1e-5）。 */
  radiusTolerance: 1e-6,
};

const clamp = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, low), high) : fallback;

/**
 * 1回転ぶんの「振れ幅」。**変位 m** で持つ。
 *
 * 横と縦を分けて持つのは、縦のほうが隣接に効きにくい（溝は上下方向には
 * 隣と重ならない）ため。重みで調整できるようにしてある。
 */
interface Excursion {
  lateral: number;
  vertical: number;
  low: number;
}

/**
 * 仮の螺旋。**`cutLayout.ts` の `variableLayout` と同じ式**で半径を積む
 * （`radii[k+1] = radii[k] − pitches[k]`）。反復のたびに1つ作る。
 */
interface Spiral {
  pitches: Float64Array;
  radii: Float64Array;
}

function spiralFor(pitches: Float64Array): Spiral {
  const radii = new Float64Array(pitches.length + 1);
  radii[0] = GROOVE.leadInRadius;
  for (let k = 0; k < pitches.length; k++) radii[k + 1] = radii[k] - pitches[k];
  return { pitches, radii };
}

/**
 * **プレビュー解析。** 回転ごとに振れ幅を測る。
 *
 * @param spiral 仮の螺旋。**渡せば実際のカッティング**（ヘッドの機械応答・高域
 *   リミッタ・半径で決まる溝の制約）を通した後の変位を測る —— 溝に残るのはこちら
 *   である。**null なら制約を通さない見積り**で、これが反復の1周目になる（半径が
 *   まだ無いので通しようがない）。
 *
 * 半径の刻み方は `cutting.ts` の `cutConstrained` と同じ（1回転の中は一次式、
 * リードアウト溝で下げ止まり）。**同じ半径で測って同じ半径で切る**のが自己整合の
 * 中身なので、ここが食い違うと反復しても意味が無い。
 *
 * 解析は**配列全体を頭から1回なめるだけ**なので、呼び出し側がどう分割しても
 * 結果は変わらない（分割する口が無い）。
 */
function measureExcursions(
  channels: readonly Float32Array[],
  sampleRate: number,
  cutting: CuttingParameters,
  cutRpm: number,
  samplesPerRevolution: number,
  revolutionCount: number,
  lowHz: number,
  spiral: Spiral | null,
): Excursion[] {
  const left = channels[0];
  const right = channels[1] ?? left;
  const frames = Math.min(left.length, right.length);

  const subsonic = highPass(20, sampleRate);
  const record = riaaRecording(sampleRate);
  const subsonicLeft = createBiquadState();
  const subsonicRight = createBiquadState();
  const recordLeft = createBiquadState();
  const recordRight = createBiquadState();
  // **切るときと同じチェーン。** 前処理の後段（低域モノラル化）は常に、ヘッドと
  // 溝の制約は仮の螺旋があるときだけ通す。盤1枚につき1本という約束どおり、
  // 反復のたびに作り直す（状態が前の周のものだと決定論が壊れる）。
  const chain = createCuttingChain(cutting, sampleRate, cutRpm);

  // 低域だけの変位を別に見るためのローパス（2次バターワース相当）。
  const lowFilter: Biquad | null =
    lowHz > 0 ? lowPassFor(lowHz, sampleRate) : null;
  const lowState = createBiquadState();

  /** 変位1単位が表すメートル（`cutterHead.ts` と同じ較正点）。 */
  const unitsToMetres = REFERENCE_WALL_VELOCITY / sampleRate;

  const excursions: Excursion[] = [];
  for (let k = 0; k < revolutionCount; k++) {
    excursions.push({ lateral: 0, vertical: 0, low: 0 });
  }

  let displacementLeft = 0;
  let displacementRight = 0;
  // 1回転の中はピッチが一定なので、半径はその回転の開始半径からの一次式。
  let revolution = -1;
  let nextRevolutionAt = 0;
  let radiusAtStart = GROOVE.leadInRadius;
  let radiusSlope = 0;
  for (let i = 0; i < frames; i++) {
    const preLeft = Math.fround(
      processBiquad(subsonic, subsonicLeft, left[i]),
    );
    const preRight = Math.fround(
      processBiquad(subsonic, subsonicRight, right[i]),
    );
    chain.preprocess(preLeft, preRight);
    const velocityLeft = Math.fround(
      processBiquad(record, recordLeft, chain.left),
    );
    const velocityRight = Math.fround(
      processBiquad(record, recordRight, chain.right),
    );

    let wallLeft = velocityLeft;
    let wallRight = velocityRight;
    if (spiral !== null) {
      if (samplesPerRevolution > 0 && i >= nextRevolutionAt) {
        revolution += 1;
        nextRevolutionAt = (revolution + 1) * samplesPerRevolution;
        const k = Math.min(spiral.pitches.length - 1, revolution);
        radiusAtStart = spiral.radii[k];
        radiusSlope = spiral.pitches[k] / samplesPerRevolution;
      }
      chain.cut(
        velocityLeft,
        velocityRight,
        Math.max(
          GROOVE.leadOutRadius,
          radiusAtStart - radiusSlope * (i - revolution * samplesPerRevolution),
        ),
      );
      wallLeft = chain.left;
      wallRight = chain.right;
    }
    displacementLeft += wallLeft;
    displacementRight += wallRight;

    // 45/45。**横は隣の溝とぶつかる向き、縦は溝の深さの向き。**
    const lateral = Math.abs(displacementLeft + displacementRight) * Math.SQRT1_2;
    const vertical = Math.abs(displacementLeft - displacementRight) * Math.SQRT1_2;
    const low =
      lowFilter === null
        ? 0
        : Math.abs(
            processBiquad(
              lowFilter,
              lowState,
              (displacementLeft + displacementRight) * Math.SQRT1_2,
            ),
          );

    const index = Math.min(
      revolutionCount - 1,
      Math.floor(i / samplesPerRevolution),
    );
    const slot = excursions[index];
    if (lateral > slot.lateral) slot.lateral = lateral;
    if (vertical > slot.vertical) slot.vertical = vertical;
    if (low > slot.low) slot.low = low;
  }

  for (const slot of excursions) {
    slot.lateral *= unitsToMetres;
    slot.vertical *= unitsToMetres;
    slot.low *= unitsToMetres;
  }
  return excursions;
}

/** 2次ローパス（RBJ・Q=1/√2）。低域の変位だけを取り出すのに使う。 */
function lowPassFor(hz: number, sampleRate: number): Biquad {
  const frequency = clamp(hz, 1, sampleRate * 0.45, 100);
  const w = (2 * Math.PI * frequency) / sampleRate;
  const cosw = Math.cos(w);
  const alpha = Math.sin(w) / Math.SQRT2;
  const a0 = 1 + alpha;
  return {
    b0: (1 - cosw) / 2 / a0,
    b1: (1 - cosw) / a0,
    b2: (1 - cosw) / 2 / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * 振れ幅 → ピッチ。**先読みと送りの追従限界を掛けたもの。**
 *
 * @param scale 振れ幅に掛ける倍率。収まらないときに 1 未満へ落として使う。
 */
function pitchesFrom(
  excursions: readonly Excursion[],
  control: PitchControlParameters,
  scale: number,
): Float64Array {
  const count = excursions.length;
  const preview = Math.max(0, Math.round(control.previewRevolutions));
  const pitches = new Float64Array(count);

  for (let k = 0; k < count; k++) {
    // **隣接する溝の両方を収める。** ここが先読みの正体で、k+preview まで見る。
    let need = 0;
    for (let ahead = 0; ahead <= preview; ahead++) {
      const slot = excursions[Math.min(count - 1, k + ahead)];
      const weighted =
        slot.lateral +
        control.verticalWeight * slot.vertical +
        control.lowWeight * slot.low;
      if (weighted > need) need = weighted;
    }
    pitches[k] = clamp(
      control.minPitch + control.displacementGain * scale * need,
      control.minPitch,
      control.maxPitch,
      control.minPitch,
    );
  }

  // **送り機構は急に動けない。** 後ろ向き→前向きの2周で傾きを抑える。どちらも
  // 値を上げる方向にしか触らないので、**必要な間隔を下回ることは無い**。
  //
  // 後ろ向きが先なのが要点で、これが「大きい音が来る前に開いておく」を作る。
  const step = Math.max(1e-9, control.maxChangePerRevolution);
  for (let k = count - 2; k >= 0; k--) {
    const floor = pitches[k + 1] - step;
    if (pitches[k] < floor) pitches[k] = floor;
  }
  for (let k = 1; k < count; k++) {
    const floor = pitches[k - 1] - step;
    if (pitches[k] < floor) pitches[k] = floor;
  }
  return pitches;
}

/** 端数の最終回転を重み付けして、半径方向にどれだけ要るかを出す。 */
function radialLength(pitches: Float64Array, revolutions: number): number {
  let total = 0;
  const full = Math.floor(revolutions);
  for (let k = 0; k < pitches.length; k++) {
    const weight = k < full ? 1 : revolutions - full;
    total += pitches[k] * Math.max(0, weight);
  }
  return total;
}

/** 1組の振れ幅から出した pitch map と、そこへ至るのに使った倍率。 */
interface PitchSolution {
  pitches: Float64Array;
  /** 振れ幅に掛けた倍率。1 なら要求どおり切れている。 */
  scale: number;
  /** **要求どおり（倍率1）に切ったとき**の半径方向の長さ m。詰めた後の長さではない。 */
  required: number;
  levelReductionDb: number;
  impossible: boolean;
}

/**
 * 振れ幅ひと組から pitch map を1つ決める。**盤に収まるところまでがここの仕事。**
 *
 * 収まらないときは**黙って詰めない**。振れ幅を一様に落として収めたうえで、
 * 「音を何dB下げれば詰めずに収まったか」を返す。最小ピッチでも収まらなければ
 * `impossible`（レベルでは解決しない）。
 */
function solvePitches(
  excursions: readonly Excursion[],
  control: PitchControlParameters,
  revolutions: number,
  available: number,
): PitchSolution {
  const full = pitchesFrom(excursions, control, 1);
  const required = radialLength(full, revolutions);
  if (required <= available) {
    return { pitches: full, scale: 1, required, levelReductionDb: 0, impossible: false };
  }

  // 最小ピッチでも入らないなら、レベルの話ではない。
  const floor = pitchesFrom(excursions, control, 0);
  if (radialLength(floor, revolutions) > available) {
    return {
      pitches: floor,
      scale: 0,
      required,
      levelReductionDb: Number.POSITIVE_INFINITY,
      impossible: true,
    };
  }

  // **収まる倍率を挟み撃ちで探す。** 追従限界を掛けた後の長さは倍率の単調増加
  // 関数なので、二分で必ず決まる。40回で倍率の精度は 1e-12。
  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i++) {
    const middle = (low + high) / 2;
    if (radialLength(pitchesFrom(excursions, control, middle), revolutions) <= available) {
      low = middle;
    } else {
      high = middle;
    }
  }
  // 振れ幅を low 倍にすれば収まる ＝ その音量差がそのまま必要な低下量。
  //
  // **0.1dB 上へ丸める。** 二分が返すのはちょうど境界の倍率なので、そのまま
  // 下げても「ぴったり収まる」にしかならず、丸め誤差ひとつで溢れる。返す数字は
  // そのまま実行できるものであるべきなので、刻みぶんの余裕を持たせる。
  const exact = low > 0 ? -20 * Math.log10(low) : Number.POSITIVE_INFINITY;
  return {
    pitches: pitchesFrom(excursions, control, low),
    scale: low,
    required,
    levelReductionDb: Number.isFinite(exact) ? Math.ceil(exact * 10) / 10 : exact,
    impossible: false,
  };
}

export interface GroovePitchPlan {
  /** 回転ごとのピッチ m/rev。長さ = ceil(演奏回転数)。 */
  pitches: Float64Array;
  fit: CutFit;
}

/**
 * **この音源をこの盤へどう送るかを決める。** 半径とカット結果の循環を、ここで
 * 決定論的な反復として解く（モジュール冒頭の「循環依存」）。
 *
 * ```
 *   ① 制約を通さない見積り              ← 半径がまだ無いので通しようがない
 *   ② その螺旋の半径で仮カットして測り直す ← ヘッド共振・高域リミッタ・溝の制約
 *   ③ pitch map を更新（残差が縮まなければ緩和へ）
 *   ④ ②③を許容値以内へ入るまで、最大 PITCH_SOLVER.maxIterations 回
 *   ⑤ 確定した半径でもう一度測り、収容できていなければ引き上げる ← 安全性はここ
 * ```
 *
 * @param revolutions 演奏領域の回転数（端数を含む）。`cutRpm` と長さで決まる。
 *
 * **同じ入力・同じ設定なら反復回数まで含めて同じ結果になる。** 乱数も時計も
 * 入っておらず、打ち切りは回数だけで決まる。
 */
export function planGroovePitch(
  channels: readonly Float32Array[],
  sampleRate: number,
  cutting: CuttingParameters,
  control: PitchControlParameters,
  cutRpm: number,
  samplesPerRevolution: number,
  revolutions: number,
): GroovePitchPlan {
  const count = Math.max(1, Math.ceil(revolutions));
  const available = GROOVE.leadInRadius - GROOVE.leadOutRadius;
  const measure = (spiral: Spiral | null) =>
    measureExcursions(
      channels,
      sampleRate,
      cutting,
      cutRpm,
      samplesPerRevolution,
      count,
      control.lowHz,
      spiral,
    );

  // ① 制約を通さない見積り。**これが従来のプレビューそのもの。**
  let excursions = measure(null);
  let solution = solvePitches(excursions, control, revolutions, available);
  let pitches = solution.pitches;

  // **理想のカッティングでは反復しない。** 制約が1つも無いので仮カットは恒等で、
  // 何周回しても①から動かない —— 従来と同じ pitch map をそのまま返す。
  if (isIdealCutting(cutting)) {
    return {
      pitches,
      fit: fitFor(pitches, solution, revolutions, available, 0, true, 0),
    };
  }

  let iterations = 0;
  let converged = false;
  let residual = Number.POSITIVE_INFINITY;
  let previousResidual = Number.POSITIVE_INFINITY;
  let factor = 1;

  for (let i = 1; i <= PITCH_SOLVER.maxIterations; i++) {
    // ② いまの螺旋の半径で仮カットして測り直す。
    excursions = measure(spiralFor(pitches));
    solution = solvePitches(excursions, control, revolutions, available);

    // ③ 更新。**残差が縮まなくなったら緩和へ落として二度と戻さない** ——
    //    必要ピッチは半径の減少関数なので、素直な入れ替えは2値を往復しうる。
    let worstPitch = 0;
    let worstRadius = 0;
    let drift = 0;
    const next = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      next[k] = pitches[k] + factor * (solution.pitches[k] - pitches[k]);
      const moved = Math.abs(next[k] - pitches[k]);
      if (moved > worstPitch) worstPitch = moved;
      // 半径は動いたピッチの累積。**間隔が僅かでも、内周では効きうる。**
      drift += next[k] - pitches[k];
      if (Math.abs(drift) > worstRadius) worstRadius = Math.abs(drift);
    }
    pitches = next;
    previousResidual = residual;
    residual = worstPitch;
    iterations = i;

    if (worstPitch <= PITCH_SOLVER.pitchTolerance && worstRadius <= PITCH_SOLVER.radiusTolerance) {
      converged = true;
      break;
    }
    if (residual >= previousResidual) factor = PITCH_SOLVER.relaxation;
  }

  // ⑤ **確定した半径でもう一度測る。** 緩和を掛けた値は目標に届いていないことが
  //    あるので、下回っている回転は必要量まで引き上げる。要素ごとの max は
  //    追従限界（傾き）も最小・最大も壊さないので、pitch map の性質は保たれる。
  //
  //    引き上げると内周が早く来て制約が強くなり、**必要量はさらに減る**（減少
  //    関数）。だから1回で足りる —— これが収容の根拠であって、収束ではない。
  if (residual !== 0) excursions = measure(spiralFor(pitches));
  const need = pitchesFrom(excursions, control, solution.scale);
  for (let k = 0; k < count; k++) if (need[k] > pitches[k]) pitches[k] = need[k];

  return {
    pitches,
    fit: fitFor(pitches, solution, revolutions, available, iterations, converged, residual),
  };
}

/**
 * 報告を1つ作る。**`required` は要求どおり切ったときの長さ**（詰めた後ではない）
 * で、`fits` は**返す pitch map が詰めずに盤へ収まったか**である。
 *
 * 倍率を落として詰めたときは `fits === false` のまま `levelReductionDb` が
 * 「何dB下げれば詰めずに済んだか」を持つ。**収まらないことを黙って隠さない。**
 */
function fitFor(
  pitches: Float64Array,
  solution: PitchSolution,
  revolutions: number,
  available: number,
  iterations: number,
  converged: boolean,
  residual: number,
): CutFit {
  return {
    fits: solution.scale === 1 && radialLength(pitches, revolutions) <= available,
    required: solution.required,
    available,
    levelReductionDb: solution.levelReductionDb,
    impossible: solution.impossible,
    iterations,
    converged,
    residual,
  };
}
