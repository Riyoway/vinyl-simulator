/**
 * 仮想カッティング — PCMを溝の形に変える、音源ロード時の一度きりの処理。
 *
 * ```
 *   PCM ──▶ 前処理 ──▶ RIAA録音特性 ──▶ ヘッドの ──▶ 溝の制約 ──▶ 積分 ──▶ 溝壁の変位
 *           超低域除去   （速度として     機械応答    速度・変位・   （変位＝
 *           ＋低域        刻む）          帯域・共振  加速度を        速度の積分）
 *           モノラル化                    クロストーク 壁ごとに
 * ```
 *
 * カッターヘッドは信号に比例した**速度**で振れる。溝に残るのはその積分、
 * すなわち**変位**である。だから溝バッファが持つのは変位であって音声ではない。
 *
 * **なぜオフラインなのか**: IIRフィルタは溝領域で使えない。逆走もジャンプも
 * 停止もある以上「前のサンプル」が定義できないからである。したがってRIAA録音
 * 特性はロード時に一度だけ焼き込む。最適化ではなく、正しさの要求
 * （audio-engine.md 7.2）。
 *
 * **カッティングの非理想も同じ理由でここにある。** ヘッドの機械応答も溝の限界も、
 * 盤に刻まれた事実であって針の性質ではない（`cutterHead.ts`）。ここで変形した
 * 波形はそのまま溝に焼かれ、**綺麗な針で再生しても元には戻らない。**
 *
 * **既定は `IDEAL_CUTTING`** で、そのときは従来どおりの3段だけを通る
 * ——溝バッファは以前とビット単位で一致する。
 *
 * Web Audio に依存しない。
 */

import {
  CUT,
  createCutLayout,
  grooveSpacingAt,
  radiusAtRevolution,
  type CutLayout,
} from "./cutLayout";
import { GROOVE } from "../../physics/groove";
import {
  createCuttingChain,
  IDEAL_CUTTING,
  isIdealCutting,
  type CuttingParameters,
} from "./cutterHead";
import {
  createBiquadState,
  filterInPlace,
  highPass,
  processBiquad,
  riaaRecording,
} from "./riaa";

/**
 * カッティング前段の超低域除去、Hz。
 *
 * 変位は速度の積分なので、超低域が残ると溝の振幅が際限なく大きくなる。実機でも
 * 同じ理由でカッティングチェーンにこれが入っている。
 *
 * 副作用として、この周波数より下は往復で戻らない。可聴帯域の下端をなるべく
 * 削らない位置に置いてある。
 */
export const CUTTING_HIGH_PASS_HZ = 20;

/**
 * この盤をどう切るか。**溝へ焼き込まれる設定**で、あとから外せない。
 *
 * `cutRpm` は限界に効く（線速度 = ω_cut × 半径）ので、**エンジン側の
 * `loadGroove` に渡すものと必ず同じ値にすること** —— 食い違うと、切ったときと
 * 違う半径で鳴っている盤になる。既定はどちらも `CUT.cutRpm`。
 */
export interface CuttingOptions {
  parameters?: CuttingParameters;
  cutRpm?: number;
  /**
   * この盤の螺旋の割り付け。**可変ピッチならこれが位置の正本**で、省略すると
   * 一定ピッチで作り直す（従来どおり）。
   *
   * **エンジンへ渡すものと同じ1つを渡すこと。** 半径で決まる限界（§7.12）が
   * ここで効くので、切ったときと違う割り付けで鳴らすと辻褄が合わなくなる。
   */
  layout?: CutLayout;
}

/**
 * PCMのチャンネル列から、溝壁の変位を作る。
 *
 * 45/45なので壁がそのままLとRである。入力は書き換えず、新しい配列を返す
 * （呼び出し側の `AudioBuffer` はラベル生成などのために残る）。
 *
 * ponytail: 積分の累算だけ倍精度で行い、保存は単精度。変位は速度より低域が
 * 効くぶん値が大きく（20Hzで数十倍）、そこから差分で速度を取り出すので桁落ちが
 * 効く。実測S/Nは検証側で見ている。足りなくなったら、溝を倍精度で持つのではなく
 * 積分の基準点を定期的に引き直すほうが安い。
 */
export function cutToGroove(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: CuttingOptions = {},
): Float32Array[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`cutting: sample rate must be positive, got ${sampleRate}`);
  }

  const parameters = options.parameters ?? IDEAL_CUTTING;
  return isIdealCutting(parameters)
    ? cutIdeal(channels, sampleRate)
    : cutConstrained(
        channels,
        sampleRate,
        parameters,
        options.cutRpm ?? CUT.cutRpm,
        options.layout,
      );
}

/**
 * 理想のカッティング。**チャンネルごとに独立**で、前処理 → RIAA → 積分の3段だけ。
 *
 * **この関数は変えないこと。** 非理想の側がどれだけ育っても、`IDEAL_CUTTING` の
 * 出力がここを通る限り、溝バッファは以前とビット単位で一致し続ける。
 */
function cutIdeal(
  channels: readonly Float32Array[],
  sampleRate: number,
): Float32Array[] {
  const subsonic = highPass(CUTTING_HIGH_PASS_HZ, sampleRate);
  const record = riaaRecording(sampleRate);

  return channels.map((channel) => {
    const wall = new Float32Array(channel.length);
    wall.set(channel);

    // 1. 超低域を落とす。これをしないと次の積分が発散する。
    filterInPlace(subsonic, wall);
    // 2. RIAA録音特性。ここまでが「カッターヘッドの速度」。
    filterInPlace(record, wall);

    // 3. 積分して変位にする。1サンプルあたりの素朴な累算で、再生側の差分が
    //    厳密な逆演算になるようにしてある（係数を挟むと逆にならない）。
    let displacement = 0;
    for (let i = 0; i < wall.length; i++) {
      displacement += wall[i];
      wall[i] = displacement;
    }
    return wall;
  });
}

/**
 * 非理想のカッティング。**左右を同時に**、1サンプルずつ通す。
 *
 * 縦横の分解（低域モノラル化）とクロストークとリンクしたリミッタがあるので、
 * チャンネルごとに独立に流すことはできない。**モノラル音源も2本の壁に展開する**
 * ——同じ配列を2回指したままでは、片方だけ書き換えることになる。
 *
 * 半径は螺旋の割り付けから出す。`revolutions = i / samplesPerRevolution` で、
 * 演奏領域は `radiusAtRevolution` の一次式そのもの（検証で突き合わせている）。
 */
function cutConstrained(
  channels: readonly Float32Array[],
  sampleRate: number,
  parameters: CuttingParameters,
  cutRpm: number,
  given?: CutLayout,
): Float32Array[] {
  const source = channels[0];
  const sourceRight = channels[1] ?? source;
  const frames = Math.min(source.length, sourceRight.length);

  const layout = given ?? createCutLayout(frames / sampleRate, sampleRate, cutRpm);
  const perRevolution = layout.samplesPerRevolution;

  const subsonic = highPass(CUTTING_HIGH_PASS_HZ, sampleRate);
  const record = riaaRecording(sampleRate);
  const subsonicLeft = createBiquadState();
  const subsonicRight = createBiquadState();
  const recordLeft = createBiquadState();
  const recordRight = createBiquadState();
  const chain = createCuttingChain(parameters, sampleRate, cutRpm);

  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let displacementLeft = 0;
  let displacementRight = 0;
  // 1回転の中はピッチが一定なので、半径はその回転の開始半径からの一次式。
  let revolution = -1;
  let nextRevolutionAt = 0;
  let radiusAtStart = GROOVE.leadInRadius;
  let radiusSlope = 0;

  for (let i = 0; i < frames; i++) {
    // 1. 前処理。超低域除去は壁ごと、低域モノラル化は縦横で。
    //
    // **段ごとに単精度へ丸める。** 理想の側は `Float32Array` をその場で通すので
    // 段の境目で丸めが乗る（`filterInPlace`）。ここで丸めないと、限界に1度も
    // 触れていないのに溝のビットが違う盤になり、「制限以下は変わらない」が
    // 成り立たなくなる。**精度を落としているのではなく、揃えている。**
    const preLeft = Math.fround(processBiquad(subsonic, subsonicLeft, source[i]));
    const preRight = Math.fround(
      processBiquad(subsonic, subsonicRight, sourceRight[i]),
    );
    chain.preprocess(preLeft, preRight);

    // 2. RIAA録音特性。ここまでが「カッターヘッドの速度」。
    const velocityLeft = Math.fround(
      processBiquad(record, recordLeft, chain.left),
    );
    const velocityRight = Math.fround(
      processBiquad(record, recordRight, chain.right),
    );

    // 3. ヘッドの機械応答と、4. 溝の限界。**半径がここで効く。**
    //
    // 半径は割り付けから引く。カーソルは単調に進むので回転数も単調で、
    // **1サンプルごとに探索し直す必要は無い**（可変ピッチでも O(1)）。
    if (perRevolution > 0 && i >= nextRevolutionAt) {
      revolution += 1;
      nextRevolutionAt = (revolution + 1) * perRevolution;
      radiusAtStart = radiusAtRevolution(layout, revolution);
      radiusSlope = grooveSpacingAt(layout, revolution) / perRevolution;
    }
    const radius = Math.max(
      GROOVE.leadOutRadius,
      radiusAtStart - radiusSlope * (i - revolution * perRevolution),
    );
    chain.cut(velocityLeft, velocityRight, radius);

    // 5. 積分して変位にする。理想の側と同じ素朴な累算。
    displacementLeft += chain.left;
    displacementRight += chain.right;
    left[i] = displacementLeft;
    right[i] = displacementRight;
  }

  return [left, right];
}
