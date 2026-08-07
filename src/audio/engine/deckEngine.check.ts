/**
 * DSPコアの決定論チェック。platterMotor.check.ts と同じ方式で、テスト基盤は
 * 使わない。コンパイルして直接走らせる:
 *
 *   npm run check:dsp
 *
 * その中身:
 *
 *   npx tsc --ignoreConfig src/physics/platterMotor.ts src/physics/pitch.ts \
 *     src/physics/groove.ts src/physics/tonearm.ts src/physics/wowFlutter.ts \
 *     src/audio/engine/grooveBuffer.ts src/audio/engine/resampler.ts \
 *     src/audio/engine/riaa.ts src/audio/engine/cartridge.ts \
 *     src/audio/engine/stylus.ts src/audio/engine/discShape.ts \
 *     src/audio/engine/surface.ts src/audio/engine/rumble.ts \
 *     src/audio/engine/hum.ts src/audio/engine/stylusTip.ts \
 *     src/audio/engine/recordCondition.ts src/audio/engine/cutting.ts \
 *     src/audio/engine/cutLayout.ts src/audio/engine/deckEngine.ts \
 *     src/audio/engine/deckEngine.check.ts \
 *     --outDir <tmp> --module commonjs --target es2022
 *   node <tmp>/audio/engine/deckEngine.check.js
 *
 * ここで確かめるのは audio-engine.md 9.4 の不変条件のうち、いま実装されている
 * 範囲（#1 ブロック長非依存 / #2 カーソル可逆性 / #4 ω=0で厳密無音 /
 * #5 正逆対称 / #6 ピッチ整合 / #7 RIAA往復 / #8 折り返し / #9 サンプルレート
 * 非依存 / #10 NaN不出現 / #11 カーソルとφの整合 / #12 シーク以外でカーソルが
 * 跳ばない）に、カートリッジと接触モデルを足したもの。**#3 ノイズ可逆性は
 * 盤面ノイズの段が入ってから足す。**
 */
import { GROOVE } from "../../physics/groove";
import {
  IDEAL_TONEARM,
  liftAngleForSurface,
  TONEARM_GEOMETRY,
  yawForRadius,
  type TonearmVerticalParameters,
} from "../../physics/tonearm";
import {
  IDEAL_WOW_FLUTTER,
  type WowFlutterParameters,
} from "../../physics/wowFlutter";
import { createRumble, IDEAL_RUMBLE, type RumbleParameters } from "./rumble";
import { IDEAL_HUM, type HumParameters } from "./hum";
import {
  createStylusTip,
  IDEAL_STYLUS_TIP,
  sampleGrooveWall,
  type StylusTip,
  type StylusTipParameters,
} from "./stylusTip";
import {
  CUT,
  createCutLayout,
  cutRegionAt,
  grooveSpacingAt,
  radiusAtRevolution,
  revolutionsAtRadius,
} from "./cutLayout";
import {
  radPerSecToRpm,
  rpmToRadPerSec,
  stepPlatterMotor,
  type MotorRuntime,
} from "../../physics/platterMotor";
import { createGrooveBuffer } from "./grooveBuffer";
import {
  cursorAdvanceForPhi,
  createDeckEngine,
  PHYSICS_CHUNK_FRAMES,
  type DeckEngineInput,
} from "./deckEngine";
import { createResampler, RESAMPLER_SHAPE } from "./resampler";
import { CUTTING_HIGH_PASS_HZ, cutToGroove } from "./cutting";
import {
  cuttingParametersFor,
  IDEAL_CUTTING,
  type CuttingParameters,
} from "./cutterHead";
import {
  PITCH_SOLVER,
  planGroovePitch,
  type PitchControlParameters,
} from "./pitchControl";
import {
  IDEAL_MANUFACTURING,
  isIdealManufacturing,
  manufactureGroove,
  manufacturingParametersFor,
  manufacturingSeedFrom,
  type ManufacturingParameters,
} from "./manufacturing";
import {
  DIGITAL_CALIBRATION_DB,
  REFERENCE_LEVELS,
  createOutputChain,
  levelParametersFor,
  phonoGainForReference,
  voltsPerGrooveUnit,
  type LevelParameters,
} from "./levels";
import {
  NO_WEAR,
  WEAR_CELL_SAMPLES,
  wearParametersFor,
  type WearParameters,
} from "./wear";
import {
  createCartridge,
  IDEAL_CARTRIDGE,
  separationDbToRatio,
  type CartridgeParameters,
} from "./cartridge";
import {
  biquadResponseDb,
  createBiquadState,
  processBiquad,
  RIAA_TIME_CONSTANTS,
  riaaPlayback,
  riaaRecording,
} from "./riaa";
import {
  createStylus,
  IDEAL_STYLUS,
  REFERENCE_WALL_VELOCITY,
  type StylusParameters,
} from "./stylus";
import {
  CLEAN_SURFACE,
  createSurface,
  type SurfaceParameters,
} from "./surface";
import {
  FLAT_DISC,
  isFlatDisc,
  recordPointAt,
  warpHeightAt,
  type DiscShapeParameters,
} from "./discShape";
import {
  discSeedFromBytes,
  RECORD_CONDITIONS,
  recordConditionFor,
  type RecordCondition,
} from "./recordCondition";

const SAMPLE_RATE = 48000;
const NOMINAL_RPM = 33.333;
let failures = 0;

function check(label: string, condition: boolean, detail: unknown = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label} ${JSON.stringify(detail)}`);
  }
}

/** 位置がそのまま値になる溝。補間とカーソルの位置ずれが値の差として出る。 */
function rampGroove(frames: number) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = i / frames;
    right[i] = -i / frames;
  }
  return createGrooveBuffer([left, right], SAMPLE_RATE);
}

/** どこを読んでも 1 の変位＝振れていない溝。**無音になるのが正しい。** */
function flatGroove(frames: number) {
  const flat = new Float32Array(frames).fill(1);
  return createGrooveBuffer([flat], SAMPLE_RATE);
}

/**
 * 実際に音の出る溝。カッティング（RIAA録音特性＋積分）を通してあるので、
 * 中身は音声ではなく**変位**である。
 */
function cutTone(seconds: number, hz = 440, amplitude = 0.5) {
  const frames = Math.round(SAMPLE_RATE * seconds);
  const source = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    source[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  }
  return createGrooveBuffer(cutToGroove([source], SAMPLE_RATE), SAMPLE_RATE);
}

/** 出力のゼロ交差から基本周波数を測る。速度のずれに強い。 */
function dominantHz(values: Float32Array, from = 0) {
  let crossings = 0;
  for (let i = from + 1; i < values.length; i++) {
    if ((values[i - 1] < 0 && values[i] >= 0) || (values[i - 1] >= 0 && values[i] < 0)) {
      crossings++;
    }
  }
  return (crossings / 2) * (SAMPLE_RATE / (values.length - from));
}

const REST_RADIUS = 0.1969; // アームレスト上

/**
 * その盤の演奏領域の 25% あたりの半径。
 *
 * **固定の半径は使えない。** 短い音源は盤面いっぱいへ引き伸ばされないので、
 * 4秒の音源なら演奏領域は外周の 0.3mm しかない。120mm へ針を落とせば、それは
 * リードアウトであって無音である — 実際のレコードと同じ。
 */
const dropRadius = (durationSeconds: number, fraction = 0.25) => {
  const layout = createCutLayout(durationSeconds, SAMPLE_RATE);
  return radiusAtRevolution(layout, layout.programRevolutions * fraction);
};

const PROGRAM_RADIUS = dropRadius(1); // flatGroove(48000) 用

const baseInput = (over: Partial<DeckEngineInput> = {}): DeckEngineInput => ({
  frames: 128,
  motorRequested: true,
  targetRpm: NOMINAL_RPM,
  handAngularVelocity: null,
  stylusContact: true,
  stylusRadius: PROGRAM_RADIUS,
  armIntent: "follow",
  landingSpeed: 0,
  stylusAzimuth: 0,
  ...over,
});

/**
 * **ライン出力のまま測る設定。** 物理（感度・フォノ段・RIAA）はそのままで、
 * 「ライン基準を dBFS のどこへ置くか」という取り決めだけを外す。
 *
 * この設定は**従来の互換設定そのもの**でもある（`digitalCalibrationDb: 0`）。
 */
const LINE_LEVELS: LevelParameters = {
  ...REFERENCE_LEVELS,
  digitalCalibrationDb: 0,
};

/** frames サンプルを blockSize ずつ処理して、書けた全サンプルを返す。 */
function run(
  engine: ReturnType<typeof createDeckEngine>,
  input: DeckEngineInput,
  totalFrames: number,
  blockSize: number,
) {
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);
  const blockL = new Float32Array(blockSize);
  const blockR = new Float32Array(blockSize);
  for (let at = 0; at < totalFrames; at += blockSize) {
    const frames = Math.min(blockSize, totalFrames - at);
    engine.process({ ...input, frames }, blockL, blockR);
    left.set(blockL.subarray(0, frames), at);
    right.set(blockR.subarray(0, frames), at);
  }
  return { left, right };
}

console.log("groove buffer");

{
  const stereo = rampGroove(1000);
  check("keeps both walls", stereo.walls[0] !== stereo.walls[1]);
  check("duration follows the frame count", stereo.durationSeconds === 1000 / SAMPLE_RATE);

  const mono = flatGroove(500);
  check(
    "mono shares one array between the walls, no copy",
    mono.walls[0] === mono.walls[1],
  );

  let threw = false;
  try {
    createGrooveBuffer([new Float32Array(0)], SAMPLE_RATE);
  } catch {
    threw = true;
  }
  check("an empty channel is refused, not carried", threw);

  threw = false;
  try {
    createGrooveBuffer([new Float32Array(10)], 0);
  } catch {
    threw = true;
  }
  check("a nonsense sample rate is refused", threw);
}

console.log("\nresampler");

/** 位置 p を rate で読む（1本の壁）。 */
const readAt = (wall: Float32Array, p: number, rate = 1) => {
  const r = createResampler();
  r.prepare(p, Math.abs(rate));
  return r.sample(wall);
};

/** freq（サンプルレートに対する比）の正弦波。 */
function toneGroove(frames: number, freq: number) {
  const wall = new Float32Array(frames);
  for (let i = 0; i < frames; i++) wall[i] = Math.sin(2 * Math.PI * freq * i);
  return wall;
}

const rms = (values: ArrayLike<number>, from = 0, to = values.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += values[i] * values[i];
  return Math.sqrt(sum / (to - from));
};

const dB = (ratio: number) => 20 * Math.log10(Math.max(ratio, 1e-30));

{
  const wall = rampGroove(4096).walls[0];
  check(
    "integer positions still return the sample",
    Math.abs(readAt(wall, 1000) - wall[1000]) < 1e-6,
    readAt(wall, 1000) - wall[1000],
  );
  const half = readAt(wall, 1000.5);
  check(
    "a half position lands between its neighbours",
    half > wall[1000] && half < wall[1001],
    half,
  );
  check(
    "reading past either end is finite, never NaN",
    Number.isFinite(readAt(wall, -50)) && Number.isFinite(readAt(wall, 1e6)),
  );

  // 直流利得はどの位相でも、どの引き伸ばし量でもちょうど1。
  const flat = new Float32Array(4096).fill(0.75);
  let worstDc = 0;
  for (const rate of [0.001, 0.5, 1, 1.7, 4, 8, 20]) {
    for (const frac of [0, 0.1, 0.25, 0.5, 0.75, 0.9]) {
      worstDc = Math.max(worstDc, Math.abs(readAt(flat, 2000 + frac, rate) - 0.75));
    }
  }
  check("dc gain is exactly 1 at every phase and speed", worstDc < 1e-6, worstDc);

  // 係数は有界。実時間で回るためにここが効く。
  const r = createResampler();
  r.prepare(2000.5, 1);
  const atUnity = r.taps;
  r.prepare(2000.5, 100);
  check(
    "the tap count is bounded even at absurd speeds",
    r.taps <= RESAMPLER_SHAPE.maxTaps && atUnity <= 2 * RESAMPLER_SHAPE.halfTaps + 2,
    { atUnity, atSpeed: r.taps, cap: RESAMPLER_SHAPE.maxTaps },
  );
}

// 正逆対称: 同じ位置を同じ速さで、向きだけ変えて読めば同じ値。
{
  const wall = toneGroove(8192, 0.077);
  let worst = 0;
  for (const rate of [0.25, 1, 2.5, 6]) {
    for (const p of [1000, 1000.5, 2048.25, 4096.75]) {
      worst = Math.max(worst, Math.abs(readAt(wall, p, rate) - readAt(wall, p, -rate)));
    }
  }
  check("the kernel is symmetric in the direction of travel", worst === 0, worst);

  // 走らせて確かめる: 前進した列と、同じ道を後退した列は反転一致する。
  const forward: number[] = [];
  const backward: number[] = [];
  const step = 0.37;
  for (let i = 0; i < 256; i++) forward.push(readAt(wall, 3000 + step * i, step));
  for (let i = 0; i < 256; i++) backward.push(readAt(wall, 3000 + step * (255 - i), step));
  let mirrored = true;
  for (let i = 0; i < 256; i++) {
    if (forward[i] !== backward[255 - i]) mirrored = false;
  }
  check("a forward pass and a backward pass over the same groove mirror exactly", mirrored);
}

// ナイキスト超えの抑圧: 速く走るほどカットオフが下がる。
{
  const OUT = 4096;
  const START = 8192;
  // 溝は「読み切る長さ + 窓の張り出し」を必ず持たせる。足りないと端の減衰が
  // 測定値を支配して、フィルタの実力ではなく境界を測ってしまう（実際に踏んだ）。
  const grooveFor = (rate: number, freq: number) =>
    toneGroove(START + Math.ceil(rate * OUT) + RESAMPLER_SHAPE.maxTaps, freq);

  const render = (wall: Float32Array, rate: number) => {
    const out = new Float32Array(OUT);
    const r = createResampler();
    for (let i = 0; i < OUT; i++) {
      const p = START + rate * i;
      r.prepare(p, Math.abs(rate));
      out[i] = r.sample(wall);
    }
    return out;
  };

  // 4倍で読むと 0.3 は 1.2（＝ナイキスト超え）へ写る。落とせていなければ
  // 折り返して出てくる。
  const alias4 = rms(render(grooveFor(4, 0.3), 4));
  const kept4 = rms(render(grooveFor(4, 0.02), 4));
  const unity = rms(render(grooveFor(1, 0.3), 1));

  check(
    "at 1x the tone passes",
    dB(unity / Math.SQRT1_2) > -1,
    dB(unity / Math.SQRT1_2).toFixed(2),
  );
  check(
    "at 4x the over-Nyquist tone is suppressed by more than 60 dB",
    dB(alias4 / Math.SQRT1_2) < -60,
    `${dB(alias4 / Math.SQRT1_2).toFixed(1)} dB`,
  );
  check(
    "while passband content at 4x survives",
    dB(kept4 / Math.SQRT1_2) > -1,
    `${dB(kept4 / Math.SQRT1_2).toFixed(2)} dB`,
  );

  const alias8 = rms(render(grooveFor(8, 0.2), 8));
  check(
    "and 8x suppresses its own over-Nyquist content too",
    dB(alias8 / Math.SQRT1_2) < -60,
    `${dB(alias8 / Math.SQRT1_2).toFixed(1)} dB`,
  );

  // 引き伸ばしの上限を超えたところは折り返しが戻る。上限そのものを検証して
  // おき、上げ下げしたときに気づけるようにする。
  const beyondCap = rms(render(grooveFor(16, 0.2), 16));
  check(
    "past the stretch cap the suppression is finite and known, not silent failure",
    dB(beyondCap / Math.SQRT1_2) < -20,
    `${dB(beyondCap / Math.SQRT1_2).toFixed(1)} dB at ${RESAMPLER_SHAPE.maxStretch}x cap`,
  );
}

// ほぼ停止と完全停止。
{
  const wall = toneGroove(4096, 0.05);
  const crawl = readAt(wall, 2000.3, 1e-9);
  check("a crawling stylus reads a finite value", Number.isFinite(crawl), crawl);
  check(
    "and reads essentially the same value as a still one",
    Math.abs(crawl - readAt(wall, 2000.3, 0)) < 1e-9,
  );
  check(
    "a zero rate does not divide by anything",
    Number.isFinite(readAt(wall, 2000.3, 0)),
  );
}

// 速度スイープでクリックも位相跳びも起きないこと。
//
// 純音を読むなら理想の出力は解析的に分かる（sin(2π f p)）。出力と解析値の差を
// 見れば、クリックも位相の跳びも「差の突出」として直接出る。2階差分の外れ値
// を見る方法は使わない — 掃引では信号自身の2階差分が速度の2乗で増えるため、
// 何も壊れていなくても外れ値が出る。
{
  const FREQ = 0.01;
  const OUT = 8192;
  const START = 20000;
  const wall = toneGroove(START + 3 * OUT + RESAMPLER_SHAPE.maxTaps, FREQ);
  const out = new Float32Array(OUT);
  const ideal = new Float32Array(OUT);
  const r = createResampler();
  let position = START;

  for (let i = 0; i < OUT; i++) {
    // 0.25 → 3.0 を滑らかに掃引（1.0 をまたぐ = カットオフが動き出す点）。
    const rate = 0.25 + (2.75 * i) / OUT;
    r.prepare(position, rate);
    out[i] = r.sample(wall);
    ideal[i] = Math.sin(2 * Math.PI * FREQ * position);
    position += rate;
  }

  let worstError = 0;
  for (let i = 0; i < OUT; i++) {
    worstError = Math.max(worstError, Math.abs(out[i] - ideal[i]));
  }
  check(
    "a speed sweep tracks the ideal waveform with no click or phase jump",
    worstError < 1e-3,
    worstError.toExponential(2),
  );
  check("and the sweep stays bounded", out.every((v) => Math.abs(v) <= 1.001));

  // 1.0 をまたぐ瞬間（カットオフが動き出す点）を拡大して見る。
  const crossing = Math.round(((1 - 0.25) / 2.75) * OUT);
  let localWorst = 0;
  for (let i = crossing - 64; i < crossing + 64; i++) {
    localWorst = Math.max(localWorst, Math.abs(out[i] - ideal[i]));
  }
  check(
    "including the moment the cutoff starts moving at 1x",
    localWorst < 1e-4,
    localWorst.toExponential(2),
  );
}

// L/R は独立、ただしカーソルと位相は共有。
{
  const groove = rampGroove(4096);
  const r = createResampler();
  r.prepare(2000.37, 1);
  const left = r.sample(groove.walls[0]);
  const right = r.sample(groove.walls[1]);
  check(
    "both walls are read at the same position from one set of coefficients",
    Math.abs(left + right) < 1e-9,
    { left, right },
  );
}

console.log("\ncursor advance");

{
  const perRevolution = cursorAdvanceForPhi(Math.PI * 2, NOMINAL_RPM, SAMPLE_RATE);
  const expected = (SAMPLE_RATE * 60) / NOMINAL_RPM;
  check(
    "one revolution advances exactly one revolution of samples",
    Math.abs(perRevolution - expected) < 1e-9,
    perRevolution,
  );
  check(
    "45 advances proportionally less per revolution",
    Math.abs(cursorAdvanceForPhi(Math.PI * 2, 45, SAMPLE_RATE) - (SAMPLE_RATE * 60) / 45) < 1e-9,
  );
  // #2 可逆性: 行って戻れば厳密に元へ。
  check(
    "advancing backwards is the exact negation",
    cursorAdvanceForPhi(-1.234, NOMINAL_RPM, SAMPLE_RATE) ===
      -cursorAdvanceForPhi(1.234, NOMINAL_RPM, SAMPLE_RATE),
  );
  check("no rotation is no advance", cursorAdvanceForPhi(0, NOMINAL_RPM, SAMPLE_RATE) === 0);
  check(
    "a NaN angle cannot move the cursor",
    cursorAdvanceForPhi(Number.NaN, NOMINAL_RPM, SAMPLE_RATE) === 0,
  );
  // #9 出力レートは式に出てこない。溝のレートだけが効く。
  check(
    "the advance depends on the groove's rate, not the output rate",
    cursorAdvanceForPhi(1, NOMINAL_RPM, 44100) !==
      cursorAdvanceForPhi(1, NOMINAL_RPM, 48000),
  );
}

console.log("\nsilence");

// #4 **相対運動も構造励振も無ければ厳密な無音。** 止まった盤に載った針は何も
// 出さない — ただしそれは「ω = 0 だから」ではなく、盤の位置で索引されるものが
// 一つも動かないからである（構造が揺れていれば ω = 0 でも音は出る。後述）。
{
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(cutTone(1));
  const idle = baseInput({ motorRequested: false });
  run(engine, idle, 48000, 128); // 完全に停止させる
  check("the platter really stopped", engine.state.motor.angularVelocity === 0);

  const { left, right } = run(engine, idle, 4096, 128);
  check(
    "a stopped platter with nothing shaking is exactly silent",
    left.every((v) => v === 0) && right.every((v) => v === 0),
  );
  check("and the cursor did not move", engine.state.omega === 0);
}

// 針が上がっていれば、盤が回っていても無音。
{
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  // 1秒の音源では0.56回転で刻み終わってしまうので、演奏領域が続く長さを使う。
  engine.loadGroove(cutTone(60));
  run(engine, baseInput(), 48000, 128); // 回して針も落とす
  const playing = run(engine, baseInput(), 512, 128);
  check("a dropped stylus on a spinning record makes sound", playing.left.some((v) => v !== 0));

  const cursorBefore = engine.state.programCursor;
  const lifted = run(engine, baseInput({ stylusContact: false }), 4096, 128);
  check(
    "lifting the stylus is exactly silent",
    lifted.left.every((v) => v === 0) && lifted.right.every((v) => v === 0),
  );
  check(
    "and freezes the cursor where it was",
    engine.state.programCursor === cursorBefore,
    engine.state.programCursor,
  );
}

// 溝の無いところ（アームレスト上）で降ろしても鳴らない。
{
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(cutTone(1));
  const { left } = run(engine, baseInput({ stylusRadius: REST_RADIUS }), 4096, 128);
  check("a stylus off the disc is silent", left.every((v) => v === 0));
  check(
    "and its cursor is nowhere, not zero",
    Number.isNaN(engine.state.programCursor),
    engine.state.programCursor,
  );
}

// 短い音源は盤面いっぱいへ引き伸ばされない。内周へ落とせばリードアウト。
{
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(cutTone(1)); // 1秒 = 0.56回転ぶんしか刻まれていない
  const { left } = run(engine, baseInput({ stylusRadius: 0.12 }), 4096, 128);
  check(
    "dropping a 1-second record at 120mm lands in the run-out, not the music",
    left.every((v) => v === 0) && engine.state.cutRegion === "lead-out",
    engine.state.cutRegion,
  );
}

// 音源が無ければ何をしても無音。
{
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  const { left, right } = run(engine, baseInput(), 4096, 128);
  check(
    "an empty deck is silent",
    left.every((v) => v === 0) && right.every((v) => v === 0),
  );
}

console.log("\nseek");

// 針を降ろした瞬間だけシークする。
{
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  const groove = rampGroove(SAMPLE_RATE * 600); // 10分。演奏領域が実用的な幅になる
  engine.loadGroove(groove);
  const layout = createCutLayout(groove.durationSeconds, groove.sampleRate);
  run(engine, baseInput({ stylusContact: false }), 256, 128);

  const radius = radiusAtRevolution(layout, layout.programRevolutions * 0.5);
  run(engine, baseInput({ stylusContact: true, stylusRadius: radius }), 128, 128);
  const landed = revolutionsAtRadius(layout, radius) * layout.samplesPerRevolution;
  check(
    "dropping the stylus seeks to where that radius sits on the spiral",
    Math.abs(engine.state.programCursor - landed) < 2000,
    { cursor: engine.state.programCursor, landed },
  );

  // #12 降りている間の半径変化はカーソルへ届かない（帰還の遮断）。
  const before = engine.state.programCursor;
  const inner = radiusAtRevolution(layout, layout.programRevolutions * 0.9);
  run(engine, baseInput({ stylusContact: true, stylusRadius: inner }), 128, 128);
  const moved = engine.state.programCursor - before;
  const advance = cursorAdvanceForPhi(
    engine.state.omega * (128 / SAMPLE_RATE),
    layout.cutRpm,
    SAMPLE_RATE,
  );
  check(
    "moving the arm while following does not seek",
    Math.abs(moved - advance) < 1,
    { moved, advance },
  );
  check(
    "the far smaller radius would have seeked much further",
    Math.abs(revolutionsAtRadius(layout, inner) * layout.samplesPerRevolution - before) > 1e6,
  );

  // 上げて降ろし直せば、そのときの半径へ跳ぶ。
  run(engine, baseInput({ stylusContact: false }), 128, 128);
  run(engine, baseInput({ stylusContact: true, stylusRadius: inner }), 128, 128);
  const relanded = revolutionsAtRadius(layout, inner) * layout.samplesPerRevolution;
  check(
    "dropping it again seeks to the new radius",
    Math.abs(engine.state.programCursor - relanded) < 2000,
    engine.state.programCursor,
  );

  // 掴んでいる間、半径は**どの周か**を選ぶ。周の中のどこかは盤の回転が決める。
  const held = radiusAtRevolution(layout, layout.programRevolutions * 0.2);
  run(engine, baseInput({ stylusContact: true, stylusRadius: held, armIntent: "user" }), 128, 128);
  const wanted = revolutionsAtRadius(layout, held) * layout.samplesPerRevolution;
  check(
    "while the arm is held, the radius picks the turn the cursor is on",
    Math.abs(engine.state.programCursor - wanted) < layout.samplesPerRevolution * 0.5,
    { cursor: engine.state.programCursor, radius: wanted },
  );
}

console.log("\ndragging the arm by hand");

// 腕を掴んで押さえているだけなら、聞こえるのは**普通の再生**である。
//
// ここが半径だけからカーソルを引き直していたとき、ブロックごとに同じ断片へ戻って
// ブロック長の周期（48kHzで375Hz）のブザーが鳴っていた。以下はその再発防止。
{
  const groove = cutTone(12, 1000, 0.4);
  const layout = createCutLayout(groove.durationSeconds, groove.sampleRate);
  const radius = radiusAtRevolution(layout, layout.programRevolutions * 0.25);

  const play = (armIntent: DeckEngineInput["armIntent"]) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove);
    run(engine, baseInput({ stylusContact: false, stylusRadius: radius }), SAMPLE_RATE * 3, 128);
    run(engine, baseInput({ stylusRadius: radius }), 4096, 128); // 降ろして落ち着かせる
    const input = baseInput({ stylusRadius: radius, armIntent });
    run(engine, input, 4096, 128);
    const from = engine.state.programCursor;
    const played = run(engine, input, 16384, 128);
    return { played, advanced: engine.state.programCursor - from, engine };
  };

  const following = play("follow");
  const holding = play("user");

  check(
    "a held arm does not stall the cursor",
    Math.abs(holding.advanced / following.advanced - 1) < 0.01,
    { held: holding.advanced, following: following.advanced },
  );
  check(
    "and a 1kHz tone still comes out as 1kHz, not as a block-rate buzz",
    Math.abs(dominantHz(holding.played.left, 2048) - 1000) < 30,
    dominantHz(holding.played.left, 2048),
  );
  check(
    "at the same level as when the arm is free",
    Math.abs(rms(holding.played.left, 2048) / rms(following.played.left, 2048) - 1) < 0.05,
    {
      held: rms(holding.played.left, 2048),
      following: rms(following.played.left, 2048),
    },
  );

  // ブザーの正体はブロック長での繰り返しだったので、そこを直接見る。
  const repeats = (values: Float32Array) => {
    let same = 0;
    let total = 0;
    for (let i = 4096; i + 128 < values.length; i++) {
      same += Math.abs(values[i] - values[i + 128]);
      total += Math.abs(values[i]);
    }
    return same / total;
  };
  check(
    "the output does not repeat itself every 128 frames",
    repeats(holding.played.left) > 0.1,
    repeats(holding.played.left),
  );

  // 腕を動かせば溝を横切る。**そのときだけ**位置が周ごと跳ぶ。
  //
  // 12秒の盤は演奏領域が外周0.9mmしかないので、引きずるとすぐリードアウト
  // （6.4mm/rev）へ出てしまう。溝の間隔を見るには一面ぶんの割り付けが要る。
  const side = createGrooveBuffer([new Float32Array(4000 * 1200)], 4000);
  const sideLayout = createCutLayout(side.durationSeconds, side.sampleRate);
  const from = radiusAtRevolution(sideLayout, sideLayout.programRevolutions * 0.3);
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(side);
  run(engine, baseInput({ stylusContact: false, stylusRadius: from }), SAMPLE_RATE * 3, 128);
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  let crossings = 0;
  let previous = Number.NaN;
  const blocks = 400;
  for (let block = 0; block < blocks; block++) {
    // 1秒あたり 5mm ほどの速さで内周へ引きずる。
    const dragged = from - (block * 128 * 0.005) / SAMPLE_RATE;
    engine.process(
      baseInput({ stylusRadius: dragged, armIntent: "user" }),
      outL,
      outR,
    );
    // 溝を跨ぐと、位置が1周ぶん跳ぶ。跨がなければ連続に進むだけ。
    const now = engine.state.revolutions;
    if (Number.isFinite(previous) && Math.abs(now - previous) > 0.5) crossings++;
    previous = now;
  }
  // 5mm/s ÷ 0.136mm/rev ≒ 37本/秒。400ブロックは約1.07秒。
  const expected = ((blocks * 128) / SAMPLE_RATE) * 0.005 / CUT.programPitch;
  check(
    "dragging the arm inward crosses one groove per 0.136mm of travel",
    Math.abs(crossings - expected) < 3,
    { crossings, expected },
  );
}

console.log("\nblock size independence");

// #1 4096を1回で渡しても128×32回で渡してもビット単位で同じ。
{
  const identical = (blockSize: number) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(rampGroove(SAMPLE_RATE * 2));
    run(engine, baseInput(), 8192, blockSize); // 助走
    return run(engine, baseInput(), 4096, blockSize);
  };
  const small = identical(128);
  const large = identical(4096);
  let sameSamples = true;
  for (let i = 0; i < small.left.length; i++) {
    if (small.left[i] !== large.left[i] || small.right[i] !== large.right[i]) {
      sameSamples = false;
      break;
    }
  }
  check("128 and 4096 frame blocks produce identical samples", sameSamples);

  const odd = identical(512);
  let sameAsOdd = true;
  for (let i = 0; i < small.left.length; i++) {
    if (small.left[i] !== odd.left[i]) {
      sameAsOdd = false;
      break;
    }
  }
  check("and so does 512", sameAsOdd);
}

console.log("\ncursor and phi stay together");

// #11 長く回してもカーソルと角度の積分が離れない。
{
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  const groove = rampGroove(SAMPLE_RATE * 120);
  engine.loadGroove(groove);
  run(engine, baseInput({ stylusContact: false }), SAMPLE_RATE, 128); // 助走
  run(engine, baseInput(), 128, 128); // 針を降ろす
  const startCursor = engine.state.programCursor;
  const startPhi = engine.state.phiUnwrapped;

  run(engine, baseInput(), SAMPLE_RATE * 30, 128);

  const expected = cursorAdvanceForPhi(
    engine.state.phiUnwrapped - startPhi,
    NOMINAL_RPM,
    groove.sampleRate,
  );
  const actual = engine.state.programCursor - startCursor;
  check(
    "after 30 seconds the cursor matches the angle integral exactly",
    Math.abs(actual - expected) < 1e-6,
    { actual, expected },
  );
  check(
    "phiWrapped is phiUnwrapped folded, not a separate accumulation",
    Math.abs(
      engine.state.phiWrapped -
        ((engine.state.phiUnwrapped % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2),
    ) < 1e-9,
  );
  check(
    "phiUnwrapped kept counting past one turn",
    engine.state.phiUnwrapped > Math.PI * 2 * 10,
    engine.state.phiUnwrapped,
  );
}

console.log("\nplayback ratio");

// #6 ピッチは ω 側にだけ効く。カーソルの基準（cutRpm）は動かない。
//
// 溝は変位を持つので、「速く回すと出力が比例して大きくなる」という素朴な
// 測り方はもうできない。速く回れば**音程が上がり**、そのぶん RIAA 再生特性の
// 効き方も変わる。測るべきは音程であり、音量は曲線から予測した値と比べる。
{
  const played = (targetRpm: number) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(cutTone(10, 1000));
    const input = baseInput({ targetRpm });
    run(engine, input, SAMPLE_RATE * 3, 128);
    const { left } = run(engine, input, 16384, 128);
    return { hz: dominantHz(left, 2048), level: rms(left, 2048) };
  };
  const curve = riaaPlayback(SAMPLE_RATE);
  /** 速度比 r で 1000Hz の音を鳴らしたときの、公称速度に対する予測音量比。 */
  const expectedLevel = (r: number) =>
    r *
    10 **
      ((biquadResponseDb(curve, 1000 * r, SAMPLE_RATE) -
        biquadResponseDb(curve, 1000, SAMPLE_RATE)) /
        20);

  const nominal = played(NOMINAL_RPM);
  check(
    "at nominal speed the groove passes at 1:1",
    Math.abs(nominal.hz / 1000 - 1) < 0.01,
    nominal.hz,
  );

  for (const [label, rpm, ratio] of [
    ["+8% pitch reads 8% faster", NOMINAL_RPM * 1.08, 1.08],
    ["-8% pitch reads 8% slower", NOMINAL_RPM * 0.92, 0.92],
    // 盤は 33⅓ で切られている（CutLayout の既定）。セレクターを 45 にすれば速い。
    ["playing a 33 record at 45 runs at 1.35x", 45, 45 / NOMINAL_RPM],
  ] as Array<[string, number, number]>) {
    const out = played(rpm);
    check(label, Math.abs(out.hz / (1000 * ratio) - 1) < 0.01, out.hz);
    check(
      `  and its level follows the fixed RIAA curve (${ratio.toFixed(2)}x)`,
      Math.abs(out.level / nominal.level / expectedLevel(ratio) - 1) < 0.05,
      { measured: out.level / nominal.level, expected: expectedLevel(ratio) },
    );
  }
}

console.log("\nreverse and scratch");

// 手で逆回転させれば、カーソルは戻り、出力は符号を反転する。
{
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(cutTone(10, 1000));
  run(engine, baseInput(), SAMPLE_RATE * 3, 128);
  const forwardCursor = engine.state.programCursor;
  const forward = run(engine, baseInput(), 16384, 128);

  const reverse = baseInput({
    motorRequested: false,
    handAngularVelocity: -rpmToRadPerSec(NOMINAL_RPM),
  });
  run(engine, reverse, SAMPLE_RATE, 128);
  const back = run(engine, reverse, 16384, 128);

  check("a hand can drive the platter backwards", engine.state.omega < 0, engine.state.omega);
  check("the cursor runs back up the groove", engine.state.programCursor < forwardCursor);
  check(
    "at the same speed backwards the level matches",
    Math.abs(rms(back.left, 2048) / rms(forward.left, 2048) - 1) < 0.05,
    { forward: rms(forward.left, 2048), reverse: rms(back.left, 2048) },
  );
  check(
    "and the pitch is unchanged — only the direction is",
    Math.abs(dominantHz(back.left, 2048) / dominantHz(forward.left, 2048) - 1) < 0.02,
    dominantHz(back.left, 2048),
  );

  // 手を離せば、再生成なしにそのまま正転へ戻っていく。
  run(engine, baseInput(), SAMPLE_RATE * 3, 128);
  check("letting go returns it to forward play", engine.state.omega > 0);
  const recovered = run(engine, baseInput(), 16384, 128);
  check(
    "and it plays again at the forward level",
    Math.abs(rms(recovered.left, 2048) / rms(forward.left, 2048) - 1) < 0.05,
    rms(recovered.left, 2048),
  );
}

// 掴んで止めれば無音、押し戻せばまた鳴る。すべて同じ経路。
{
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(cutTone(10, 1000));
  run(engine, baseInput(), SAMPLE_RATE * 3, 128);
  const playing = rms(run(engine, baseInput(), 8192, 128).left, 2048);
  const held = baseInput({ handAngularVelocity: 0 });
  run(engine, held, SAMPLE_RATE, 128);
  const { left } = run(engine, held, 8192, 128);
  // 完全な無音にはならない。モーターと手が綱引きして約 ⅓RPM のクリープが残る
  // ので（スリップマット相当・§7）、溝は 1% ほどの速さで流れ続ける。その音は
  // 1% の速度＝1% の振幅だが、10Hz まで落ちた成分を RIAA が持ち上げるので、
  // 素朴に −40dB にはならない。**押さえたときの低い唸りは実機でも聞こえる。**
  check(
    "a hand holding the record all but silences it, leaving the creep",
    rms(left, 2048) < playing * 0.15,
    { playing, held: rms(left, 2048), ratio: rms(left, 2048) / playing },
  );
}

console.log("\nrobustness");

// #10 何を投げ込んでも非有限値を出さない。
{
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(rampGroove(SAMPLE_RATE));
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  let sane = true;

  for (let i = 0; i < 600; i++) {
    engine.process(
      {
        frames: 128,
        motorRequested: i % 3 === 0,
        targetRpm: i % 5 === 0 ? 45 : NOMINAL_RPM,
        handAngularVelocity: i % 2 === 0 ? ((i % 13) - 6) * 3 : null,
        stylusContact: i % 7 !== 0,
        stylusRadius: GROOVE.labelRadius + ((i * 7) % 100) / 1000,
        armIntent: i % 11 === 0 ? "user" : "follow",
        landingSpeed: (i % 17) / 100,
        stylusAzimuth: ((i % 23) - 11) * 0.1,
      },
      outL,
      outR,
    );
    if (
      outL.some((v) => !Number.isFinite(v)) ||
      outR.some((v) => !Number.isFinite(v)) ||
      !Number.isFinite(engine.state.phiUnwrapped) ||
      !Number.isFinite(engine.state.omega)
    ) {
      sane = false;
      break;
    }
  }
  check("hammering every input never produces a non-finite sample", sane);
  check(
    "phiWrapped stayed inside one turn",
    engine.state.phiWrapped >= 0 && engine.state.phiWrapped < Math.PI * 2,
    engine.state.phiWrapped,
  );

  // 出力配列より大きな frames を渡しても書き出しははみ出さない。
  const small = new Float32Array(32);
  engine.process({ ...baseInput(), frames: 4096 }, small, small);
  check("an oversized frame count is clamped to the output", small.length === 32);

  // 音源の載せ替えでカーソルは無効化される。
  engine.loadGroove(rampGroove(1000));
  check("loading a new groove invalidates the cursor", Number.isNaN(engine.state.programCursor));
  const after = run(engine, baseInput({ stylusContact: false }), 256, 128);
  check("and the deck is silent until the stylus lands again", after.left.every((v) => v === 0));
}

console.log("\ncut layout");

// 割り付けそのもの。半径は「曲の何秒目か」ではなく回転数で決まる。
{
  const mm = (metres: number) => metres * 1000;
  const threeMinutes = createCutLayout(180, SAMPLE_RATE);

  check(
    "the program starts at the lead-in groove",
    radiusAtRevolution(threeMinutes, 0) === GROOVE.leadInRadius,
  );
  check(
    "one revolution moves the stylus in by the program pitch",
    Math.abs(
      mm(radiusAtRevolution(threeMinutes, 0) - radiusAtRevolution(threeMinutes, 1)) - 0.136,
    ) < 1e-9,
  );
  check(
    "a 3-minute side uses the reference pitch",
    threeMinutes.programPitch === CUT.programPitch,
  );
  check(
    "and occupies only the outer 13.6mm — it is not stretched to fill the disc",
    Math.abs(mm(GROOVE.leadInRadius - threeMinutes.programEndRadius) - 13.6) < 0.1,
    mm(GROOVE.leadInRadius - threeMinutes.programEndRadius),
  );

  // 長すぎる面はピッチを詰めて収める（実機のカッティングと同じ）。
  const marathon = createCutLayout(60 * 40, SAMPLE_RATE);
  check(
    "a side too long for the reference pitch is cut tighter to fit",
    marathon.programPitch < CUT.programPitch,
    mm(marathon.programPitch),
  );
  check(
    "and lands exactly on the lead-out groove radius",
    Math.abs(marathon.programEndRadius - GROOVE.leadOutRadius) < 1e-9,
    mm(marathon.programEndRadius),
  );

  // リードアウトは 6.4mm/rev で 53.2mm まで。
  const afterProgram = radiusAtRevolution(
    threeMinutes,
    threeMinutes.programRevolutions + 1,
  );
  check(
    "the lead-out runs at 6.4mm per revolution",
    Math.abs(mm(threeMinutes.programEndRadius - afterProgram) - 6.4) < 1e-9,
    mm(threeMinutes.programEndRadius - afterProgram),
  );
  check(
    "and stops at the locked groove at 53.2mm",
    Math.abs(mm(radiusAtRevolution(threeMinutes, threeMinutes.lockedRevolutions)) - 53.2) < 1e-9,
  );
  check(
    "past which the spiral goes no further",
    radiusAtRevolution(threeMinutes, threeMinutes.lockedRevolutions + 1000) === CUT.lockedRadius,
  );
  check(
    "the locked groove is inside the disc's own run-out band",
    CUT.lockedRadius > GROOVE.labelRadius && CUT.lockedRadius < GROOVE.leadOutRadius,
  );

  // 区分の判定は CutLayout 側にある（盤の形の grooveZone とは別物）。
  check(
    "regions come from the cut, not the disc",
    cutRegionAt(threeMinutes, -0.5) === "lead-in" &&
      cutRegionAt(threeMinutes, 0) === "program" &&
      cutRegionAt(threeMinutes, threeMinutes.programRevolutions) === "program" &&
      cutRegionAt(threeMinutes, threeMinutes.programRevolutions + 0.5) === "lead-out" &&
      cutRegionAt(threeMinutes, threeMinutes.lockedRevolutions) === "locked",
  );

  // 半径 ↔ 回転数は厳密な逆写像。
  let worstRoundTrip = 0;
  for (let rev = threeMinutes.leadInRevolutions; rev < threeMinutes.lockedRevolutions; rev += 3.7) {
    const back = revolutionsAtRadius(threeMinutes, radiusAtRevolution(threeMinutes, rev));
    worstRoundTrip = Math.max(worstRoundTrip, Math.abs(back - rev));
  }
  check("radius and revolutions are exact inverses", worstRoundTrip < 1e-9, worstRoundTrip);
}

console.log("\narm follows the groove");

// 1回転あたりの移動量は、速度にも向きにも依らない。
{
  const groove = rampGroove(SAMPLE_RATE * 600);
  const layout = createCutLayout(groove.durationSeconds, groove.sampleRate);

  const travelPerRevolution = (targetRpm: number, hand: number | null) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove);
    const input = baseInput({
      targetRpm,
      handAngularVelocity: hand,
      motorRequested: hand === null,
      stylusRadius: radiusAtRevolution(layout, layout.programRevolutions * 0.3),
    });
    run(engine, input, SAMPLE_RATE * 3, 128); // 助走して安定させる
    const startRadius = engine.state.stylusRadius;
    const startPhi = engine.state.phiUnwrapped;
    run(engine, input, SAMPLE_RATE * 2, 128);
    const revolutions = (engine.state.phiUnwrapped - startPhi) / (Math.PI * 2);
    return (startRadius - engine.state.stylusRadius) / revolutions;
  };

  const atNominal = travelPerRevolution(NOMINAL_RPM, null);
  const at45 = travelPerRevolution(45, null);
  const pitched = travelPerRevolution(NOMINAL_RPM * 1.08, null);
  const byHand = travelPerRevolution(NOMINAL_RPM, 8);

  check(
    "at nominal speed the arm moves one program pitch per revolution",
    Math.abs(atNominal * 1000 - 0.136) < 1e-6,
    atNominal * 1000,
  );
  check(
    "at 45 the arm still moves the same distance per revolution",
    Math.abs(at45 - atNominal) < 1e-9,
    { atNominal, at45 },
  );
  check(
    "and with the pitch fader up too",
    Math.abs(pitched - atNominal) < 1e-9,
  );
  check(
    "and when a hand is driving the platter",
    Math.abs(byHand - atNominal) < 1e-9,
  );

  // 逆転すればアームは外へ戻る。同じ 1回転あたりの量で。
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(groove);
  const forward = baseInput({
    stylusRadius: radiusAtRevolution(layout, layout.programRevolutions * 0.3),
  });
  run(engine, forward, SAMPLE_RATE * 3, 128);
  const beforeReverse = engine.state.stylusRadius;
  const phiBefore = engine.state.phiUnwrapped;
  const back = baseInput({
    motorRequested: false,
    handAngularVelocity: -rpmToRadPerSec(NOMINAL_RPM),
    stylusRadius: 0,
  });
  run(engine, back, SAMPLE_RATE * 2, 128);
  const backRevolutions = (engine.state.phiUnwrapped - phiBefore) / (Math.PI * 2);
  const backTravel = (beforeReverse - engine.state.stylusRadius) / backRevolutions;
  check(
    "running backwards walks the arm back out at the same rate per revolution",
    engine.state.stylusRadius > beforeReverse &&
      Math.abs(backTravel * 1000 - 0.136) < 1e-6,
    { backTravel: backTravel * 1000, moved: engine.state.stylusRadius > beforeReverse },
  );

  // 止まっている間はアームも動かない。手を離しておく — 押さえたままだと ω は
  // 厳密な0へ落ちない（`stepPlatterMotor` の停止スナップは非接触が条件）。
  const stopped = baseInput({ motorRequested: false, handAngularVelocity: null, stylusRadius: 0 });
  run(engine, stopped, SAMPLE_RATE * 2, 128);
  const held = engine.state.stylusRadius;
  run(engine, stopped, SAMPLE_RATE, 128);
  check("a stopped platter leaves the arm exactly where it is", engine.state.stylusRadius === held);
}

// 音源が終われば、リードアウトを通ってロックドグルーブへ入る。
{
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  const groove = cutTone(4);
  engine.loadGroove(groove);
  const layout = createCutLayout(groove.durationSeconds, groove.sampleRate);

  // 先に助走しておく（針は上げたまま）。降ろしてから加速すると、演奏領域の
  // 終わり際は加速中に通り過ぎてしまう。
  run(engine, baseInput({ stylusContact: false }), SAMPLE_RATE, 128);

  // 演奏領域の終わり際へ降ろす。
  const nearEnd = radiusAtRevolution(layout, layout.programRevolutions * 0.9);
  const input = baseInput({ stylusRadius: nearEnd });
  const playing = run(engine, input, 2048, 128);
  check(
    "the last of the programme still plays",
    engine.state.cutRegion === "program" && playing.left.some((v) => v !== 0),
    engine.state.cutRegion,
  );

  run(engine, input, SAMPLE_RATE, 128);
  check("past the end it is in the run-out", engine.state.cutRegion === "lead-out");
  const leadOut = run(engine, input, 512, 128);
  check("which is silent", leadOut.left.every((v) => v === 0));

  // リードアウトは粗いので、あっという間にロックドへ着く。
  run(engine, input, SAMPLE_RATE * 40, 128);
  check(
    "and then the stylus is locked at 53.2mm",
    engine.state.cutRegion === "locked" &&
      Math.abs(engine.state.stylusRadius * 1000 - 53.2) < 1e-9,
    engine.state.stylusRadius * 1000,
  );
  const lockedRadius = engine.state.stylusRadius;
  run(engine, baseInput({ stylusRadius: nearEnd }), SAMPLE_RATE * 10, 128);
  check(
    "a locked groove goes nowhere no matter how long it spins",
    engine.state.stylusRadius === lockedRadius,
  );
}

// アームのジオメトリ: 半径 → yaw が rdd.md 10.2 の表を再現する。
{
  const deg = (rad: number) => (rad * 180) / Math.PI;
  const rows: Array<[number, number]> = [
    [0.1969, 0],
    [0.1524, -13.6],
    [0.146, -15.5],
    [0.0575, -41.0],
  ];
  let worst = 0;
  for (const [radius, expected] of rows) {
    const yaw = yawForRadius(radius);
    worst = Math.max(worst, Math.abs(deg(yaw ?? 0) - expected));
  }
  check(
    "yawForRadius reproduces the documented yaw/radius table",
    worst < 0.06,
    `${worst.toFixed(3)}°`,
  );
  check(
    "the arm rest is exactly yaw zero",
    yawForRadius(0.1969) === 0,
  );
  check(
    "a radius the arm cannot reach reports nothing",
    yawForRadius(1) === null,
  );
}

console.log("\nRIAA");

// 係数は時定数から生成されている。規格の曲線を再現できているかを直接測る。
{
  const playback = riaaPlayback(SAMPLE_RATE);
  // 規格値（1kHz基準、dB）。時定数から解析的に出る値そのもの。
  const standard: Array<[number, number]> = [
    [20, 19.27],
    [50, 16.95],
    [100, 13.09],
    [500, 2.65],
    [1000, 0],
    [2122, -2.87],
    [5000, -8.21],
  ];
  let worst = 0;
  let worstAt = 0;
  for (const [hz, expected] of standard) {
    const error = Math.abs(biquadResponseDb(playback, hz, SAMPLE_RATE) - expected);
    if (error > worst) {
      worst = error;
      worstAt = hz;
    }
  }
  check(
    "the playback curve matches the published RIAA table up to 5kHz",
    worst < 0.3,
    `worst ${worst.toFixed(3)}dB at ${worstAt}Hz`,
  );

  // 最上オクターブは双一次変換の構造的な限界で落ちる。**隠さずに測っておき、
  // 悪化したら気づけるようにする。** 6dB/octで下がり続ける特性を2次の
  // デジタルフィルタで作る以上、ナイキストに零点が乗るのは避けられない
  // （プリワープしても 0.05dB しか変わらないことを実測で確認済み）。
  const deviation = (hz: number) =>
    biquadResponseDb(playback, hz, SAMPLE_RATE) -
    (hz === 10000 ? -13.73 : -17.16);
  check(
    "the known top-octave deviation has not grown",
    deviation(10000) > -1.6 && deviation(15000) > -4.2,
    `10k ${deviation(10000).toFixed(2)}dB / 15k ${deviation(15000).toFixed(2)}dB`,
  );
  check(
    "and it is exactly 0dB at the 1kHz reference",
    Math.abs(biquadResponseDb(playback, 1000, SAMPLE_RATE)) < 1e-9,
  );

  // 時定数からの生成であることの確認: レートを変えれば係数は変わるが曲線は同じ。
  for (const rate of [44100, 48000, 96000]) {
    const curve = riaaPlayback(rate);
    const at100 = biquadResponseDb(curve, 100, rate);
    check(
      `the curve holds at ${rate}Hz sampling`,
      Math.abs(at100 - 13.09) < 0.15,
      `${at100.toFixed(3)}dB at 100Hz`,
    );
  }

  // 録音特性は再生特性を打ち消す（Neumann極のぶんだけ高域に残差が出る）。
  {
    const record = riaaRecording(SAMPLE_RATE);
    const playbackCurve = riaaPlayback(SAMPLE_RATE);
    const roundTrip = (hz: number) =>
      biquadResponseDb(record, hz, SAMPLE_RATE) +
      biquadResponseDb(playbackCurve, hz, SAMPLE_RATE);

    let worstBand = 0;
    for (let hz = 40; hz <= 10000; hz *= 1.2) {
      worstBand = Math.max(worstBand, Math.abs(roundTrip(hz)));
    }
    check(
      "record then playback is flat to 10kHz",
      worstBand < 0.3,
      `${worstBand.toFixed(3)}dB`,
    );
    check(
      "and still within a dB at 15kHz",
      Math.abs(roundTrip(15000)) < 1.1,
      `${roundTrip(15000).toFixed(3)}dB`,
    );
    // 往復の残差は Neumann極（カッティング側の50kHz極）そのもの。再生側は
    // それを補正しないので、実機のレコードにも同じ形で残っている。
    check(
      "the top octave loses the Neumann pole, as a real record does",
      roundTrip(20000) < -1 && roundTrip(20000) > -6,
      `${roundTrip(20000).toFixed(2)}dB at 20kHz`,
    );
  }

  // 録音特性は安定でなければならない（Neumann極が無いと単位円上に極が乗る）。
  {
    const record = riaaRecording(SAMPLE_RATE);
    const state = createBiquadState();
    let peak = 0;
    for (let i = 0; i < 20000; i++) {
      const out = processBiquad(record, state, i === 0 ? 1 : 0);
      peak = Math.max(peak, Math.abs(out));
      if (i > 2000 && Math.abs(out) > 1e-6) peak = Number.POSITIVE_INFINITY;
    }
    check("the recording filter's impulse response decays", Number.isFinite(peak));
  }

  check(
    "the time constants are the standard ones",
    RIAA_TIME_CONSTANTS.t1 === 3180e-6 &&
      RIAA_TIME_CONSTANTS.t2 === 318e-6 &&
      RIAA_TIME_CONSTANTS.t3 === 75e-6,
  );
}

console.log("\ncutting and the cartridge");

/** 溝の変位バッファから、公称速度で再生した出力を取り出す。 */
function playBack(source: Float32Array[], seconds: number) {
  const walls = cutToGroove(source, SAMPLE_RATE);
  const groove = createGrooveBuffer(walls, SAMPLE_RATE);
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  // **測るのはライン出力**（＝物理）であって、録音レベルの取り決めではない。
  // 「往復で元へ戻る」はカッティングと再生の主張で、dBFS のどこへ置くかは別
  // （`levels.ts` の3つの基準）。
  engine.setLevels(LINE_LEVELS);
  engine.loadGroove(groove);
  const layout = createCutLayout(groove.durationSeconds, groove.sampleRate);

  // 助走してから針を落とす（加速中の可変速部分を測らない）。
  const lifted = baseInput({ stylusContact: false });
  run(engine, lifted, SAMPLE_RATE * 3, 128);
  const input = baseInput({
    stylusRadius: radiusAtRevolution(layout, layout.programRevolutions * 0.25),
  });
  run(engine, input, 4096, 128); // 針を降ろして落ち着かせる
  const startCursor = Math.round(engine.state.programCursor);
  const played = run(engine, input, Math.round(SAMPLE_RATE * seconds), 128);
  return { played, startCursor, engine, groove };
}

/**
 * 公称速度での往復利得（dB）。
 *
 * **標本ごとの比較はできない。** モーターは公称速度を ±0.15RPM の許容で保つので、
 * 1秒で最大200サンプルほど位相がずれる。ずれは音として正しく（実機のワウと同じ）、
 * 波形の一致で測る対象ではない。したがって振幅で測る。
 */
function roundTripGainDb(hz: number, amplitude = 0.4) {
  const frames = SAMPLE_RATE * 6;
  const source = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    source[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  }
  const { played } = playBack([source], 0.4);
  const from = Math.round(SAMPLE_RATE * 0.15); // フィルタの立ち上がりを避ける
  return {
    db: 20 * Math.log10(rms(played.left, from) / (amplitude / Math.SQRT2)),
    // 純音なら rms = peak/√2。崩れていれば歪みか途切れ。
    sineFit: (() => {
      let peak = 0;
      for (let i = from; i < played.left.length; i++) {
        peak = Math.max(peak, Math.abs(played.left[i]));
      }
      return rms(played.left, from) / (peak / Math.SQRT2);
    })(),
    played,
  };
}

// 公称速度で元の音源へ戻ること。これがカッティングと再生チェーンの一番の主張。
{
  let worst = 0;
  let worstAt = 0;
  let worstFit = 1;
  for (const hz of [50, 100, 220, 440, 1000, 3000, 7000]) {
    const { db, sineFit } = roundTripGainDb(hz);
    if (Math.abs(db) > Math.abs(worst)) {
      worst = db;
      worstAt = hz;
    }
    worstFit = Math.min(worstFit, sineFit);
  }
  check(
    "at nominal speed the deck gives back the source, flat across the band",
    Math.abs(worst) < 0.6,
    `worst ${worst.toFixed(3)}dB at ${worstAt}Hz`,
  );
  check(
    "and the waveform stays a clean sine — no gross distortion",
    worstFit > 0.98 && worstFit < 1.02,
    worstFit.toFixed(4),
  );

  // カッティングの超低域除去より下は戻らない。仕様であって不具合ではない。
  const belowCut = roundTripGainDb(8).db;
  check(
    "below the cutting high-pass the groove holds nothing",
    belowCut < -10,
    `${belowCut.toFixed(1)}dB at 8Hz`,
  );

  const mono = roundTripGainDb(1000).played;
  check("both walls carry the mono source identically", (() => {
    for (let i = 0; i < mono.left.length; i++) {
      if (mono.left[i] !== mono.right[i]) return false;
    }
    return true;
  })());
}

// 左右は独立に刻まれ、独立に取り出される。
{
  const frames = SAMPLE_RATE * 6;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    left[i] = 0.4 * Math.sin(2 * Math.PI * 400 * t);
    right[i] = 0.4 * Math.sin(2 * Math.PI * 1500 * t);
  }
  const { played } = playBack([left, right], 0.5);
  const from = Math.round(SAMPLE_RATE * 0.2);
  // まだクロストークは入れていないので、両チャンネルは混ざらない。
  const leftHasRight = (() => {
    let dot = 0;
    for (let i = from; i < played.left.length; i++) dot += played.left[i] * played.right[i];
    return Math.abs(dot) / (played.left.length - from);
  })();
  check(
    "the two walls stay separate — no crosstalk has been added yet",
    leftHasRight < 1e-3,
    leftHasRight.toExponential(2),
  );
  check(
    "and each wall carries its own tone",
    rms(played.left, from) > 0.1 && rms(played.right, from) > 0.1,
  );
}

// 停止と非接触は、チェーンを通しても厳密な無音のまま。
{
  const frames = SAMPLE_RATE * 8;
  const source = new Float32Array(frames);
  for (let i = 0; i < frames; i++) source[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
  const walls = cutToGroove([source], SAMPLE_RATE);
  const groove = createGrooveBuffer(walls, SAMPLE_RATE);
  const layout = createCutLayout(groove.durationSeconds, groove.sampleRate);
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(groove);

  const radius = radiusAtRevolution(layout, layout.programRevolutions * 0.25);
  run(engine, baseInput({ stylusContact: false }), SAMPLE_RATE * 2, 128);
  const playing = run(engine, baseInput({ stylusRadius: radius }), 8192, 128);
  check("the record plays through the full chain", playing.left.some((v) => v !== 0));

  // モーターを止めて完全停止まで待つ。
  const idle = baseInput({ motorRequested: false, stylusRadius: radius });
  run(engine, idle, SAMPLE_RATE * 3, 128);
  check("the platter reached a true standstill", engine.state.motor.angularVelocity === 0);
  const stopped = run(engine, idle, 4096, 128);
  check(
    "a stopped platter is still exactly silent — the equaliser leaves no tail",
    stopped.left.every((v) => v === 0) && stopped.right.every((v) => v === 0),
  );

  // 針を上げても同じ。
  const spinning = baseInput({ stylusRadius: radius });
  run(engine, spinning, SAMPLE_RATE * 2, 128);
  const lifted = run(engine, baseInput({ stylusContact: false }), 4096, 128);
  check(
    "and so is a lifted stylus",
    lifted.left.every((v) => v === 0) && lifted.right.every((v) => v === 0),
  );
}

// 逆転・可変速も同じ経路。分岐は無い。
{
  const frames = SAMPLE_RATE * 8;
  const source = new Float32Array(frames);
  for (let i = 0; i < frames; i++) source[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
  const walls = cutToGroove([source], SAMPLE_RATE);
  const groove = createGrooveBuffer(walls, SAMPLE_RATE);
  const layout = createCutLayout(groove.durationSeconds, groove.sampleRate);
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(groove);
  const radius = radiusAtRevolution(layout, layout.programRevolutions * 0.5);

  run(engine, baseInput({ stylusContact: false }), SAMPLE_RATE * 2, 128);
  const forward = run(engine, baseInput({ stylusRadius: radius }), 16384, 128);
  const forwardLevel = rms(forward.left, 4096);

  const reverse = baseInput({
    motorRequested: false,
    handAngularVelocity: -rpmToRadPerSec(NOMINAL_RPM),
    stylusRadius: radius,
  });
  run(engine, reverse, SAMPLE_RATE, 128);
  const back = run(engine, reverse, 16384, 128);
  check(
    "reverse plays through the same chain at the same level",
    Math.abs(rms(back.left, 4096) / forwardLevel - 1) < 0.1,
    { forward: forwardLevel, reverse: rms(back.left, 4096) },
  );
  check("and the cursor really ran backwards", engine.state.omega < 0);

  // 半速なら1オクターブ下がって、振幅もそのぶん小さくなる（速度変換器）。
  const half = baseInput({
    motorRequested: false,
    handAngularVelocity: rpmToRadPerSec(NOMINAL_RPM) / 2,
    stylusRadius: radius,
  });
  run(engine, half, SAMPLE_RATE, 128);
  const slow = run(engine, half, 16384, 128);
  const zeroCrossings = (values: Float32Array, from: number) => {
    let count = 0;
    for (let i = from + 1; i < values.length; i++) {
      if ((values[i - 1] < 0 && values[i] >= 0) || (values[i - 1] >= 0 && values[i] < 0)) count++;
    }
    return (count / 2) * (SAMPLE_RATE / (values.length - from));
  };
  check(
    "half speed drops the pitch by an octave",
    Math.abs(zeroCrossings(slow.left, 4096) / zeroCrossings(forward.left, 4096) - 0.5) < 0.05,
    {
      nominal: Math.round(zeroCrossings(forward.left, 4096)),
      half: Math.round(zeroCrossings(slow.left, 4096)),
    },
  );
  // 半速の音量は「速度が半分」と「RIAAが固定時間である」ことの積で決まる。
  // 440Hz が 220Hz へ落ちると、再生特性はそのぶん低域を持ち上げるので、
  // ちょうど半分にはならない。**この値が合うことが、時定数を速度で
  // 動かしていないことの証明になる。**
  {
    const curve = riaaPlayback(SAMPLE_RATE);
    const boostDb =
      biquadResponseDb(curve, 220, SAMPLE_RATE) -
      biquadResponseDb(curve, 440, SAMPLE_RATE);
    const expected = 0.5 * 10 ** (boostDb / 20);
    const measured = rms(slow.left, 4096) / forwardLevel;
    check(
      "half speed lands where a fixed-time RIAA curve says it should",
      Math.abs(measured / expected - 1) < 0.05,
      { measured, expected, boostDb: boostDb.toFixed(2) },
    );
    check("which is quieter than nominal", measured < 1);
  }
}

// カッティングの超低域除去。積分が発散しないための条件。
{
  const frames = SAMPLE_RATE * 4;
  const dc = new Float32Array(frames).fill(0.5);
  const [wall] = cutToGroove([dc], SAMPLE_RATE);
  let worst = 0;
  for (let i = SAMPLE_RATE; i < frames; i++) worst = Math.max(worst, Math.abs(wall[i]));
  check(
    "a DC input does not make the groove wander off",
    worst < 1,
    worst,
  );
  check(
    "the cutting high-pass sits below the audio band",
    CUTTING_HIGH_PASS_HZ <= 20,
    CUTTING_HIGH_PASS_HZ,
  );
}

console.log("\ncartridge and 45/45");

const cartridgeWith = (over: Partial<CartridgeParameters>): CartridgeParameters => ({
  ...IDEAL_CARTRIDGE,
  ...over,
  sensitivity: { ...IDEAL_CARTRIDGE.sensitivity, ...over.sensitivity },
  crosstalk: { ...IDEAL_CARTRIDGE.crosstalk, ...over.crosstalk },
});

// 理想設定は**ビット単位で**素通しでなければならない。
{
  const cartridge = createCartridge(SAMPLE_RATE);
  check("an ideal cartridge reports itself bypassed", cartridge.bypassed);

  let exact = true;
  for (const [l, r] of [
    [0, 0],
    [1, -1],
    [0.3, 0.7],
    [-1e-30, 1e30],
    [Math.PI, -Math.E],
  ]) {
    cartridge.process(l, r);
    if (cartridge.left !== l || cartridge.right !== r) exact = false;
  }
  check("and passes both walls through untouched", exact);

  // 理想の値を明示的に渡しても同じ。
  cartridge.configure(IDEAL_CARTRIDGE);
  cartridge.process(0.25, -0.5);
  check(
    "configuring the ideal values explicitly keeps the bypass",
    cartridge.bypassed && cartridge.left === 0.25 && cartridge.right === -0.5,
  );
}

// アジマスずれは横／垂直平面の回転。セパレーションはちょうど tan(ψ)。
{
  const cartridge = createCartridge(SAMPLE_RATE);
  let worst = 0;
  for (const degrees of [0.5, 1, 2, 5, 15]) {
    const azimuth = (degrees * Math.PI) / 180;
    cartridge.configure(cartridgeWith({ azimuth }));
    // 左だけに信号を入れ、右へ漏れる量を見る。
    cartridge.process(1, 0);
    const separation = Math.abs(cartridge.right / cartridge.left);
    worst = Math.max(worst, Math.abs(separation - Math.tan(azimuth)));
  }
  check(
    "azimuth error leaks exactly tan(psi) into the other channel",
    worst < 1e-12,
    worst,
  );

  cartridge.configure(cartridgeWith({ azimuth: (1 * Math.PI) / 180 }));
  cartridge.process(1, 0);
  const db = 20 * Math.log10(Math.abs(cartridge.right / cartridge.left));
  check(
    "so one degree of azimuth costs about 35dB of separation",
    db < -34 && db > -36,
    `${db.toFixed(1)}dB`,
  );

  // モノラル（横方向だけ）の盤にアジマスずれがあると、左右が不均衡になる。
  // 傾いたコイルから見ると水平な動きの射影が左右で違うためで、**実機でも
  // アジマスずれの症状として現れる**。ここも比はちょうど tan(ψ)。
  cartridge.process(1, 1);
  const imbalance =
    (cartridge.left - cartridge.right) / (cartridge.left + cartridge.right);
  check(
    "a mono cut comes out imbalanced by exactly tan(psi)",
    Math.abs(imbalance - Math.tan((1 * Math.PI) / 180)) < 1e-12,
    imbalance,
  );
}

// 感度差とクロストークは指定どおりの定数。
{
  const cartridge = createCartridge(SAMPLE_RATE);
  cartridge.configure(cartridgeWith({ sensitivity: { left: 0.5, right: 2 } }));
  cartridge.process(1, 1);
  check(
    "sensitivity scales each coil exactly",
    cartridge.left === 0.5 && cartridge.right === 2,
    { left: cartridge.left, right: cartridge.right },
  );

  const leak = separationDbToRatio(-30);
  cartridge.configure(cartridgeWith({ crosstalk: { leftFromRight: leak, rightFromLeft: leak } }));
  cartridge.process(0, 1);
  check(
    "crosstalk leaks exactly the requested ratio",
    Math.abs(cartridge.left - leak) < 1e-12,
    cartridge.left,
  );
  check(
    "-30dB of separation is about 3% of the other channel",
    Math.abs(leak - 0.0316) < 0.001,
    leak,
  );
}

// 共振は直流で利得1、指定周波数に山、そして必ず減衰する。
{
  const cartridge = createCartridge(SAMPLE_RATE);
  const magnitudeAt = (hz: number) => {
    cartridge.reset();
    let peak = 0;
    const total = Math.round(SAMPLE_RATE * 0.2);
    for (let i = 0; i < total; i++) {
      cartridge.process(Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE), 0);
      if (i > total / 2) peak = Math.max(peak, Math.abs(cartridge.left));
    }
    return peak;
  };

  cartridge.configure(cartridgeWith({ mechanicalResonance: { hz: 12000, q: 4 } }));
  // 共振よりずっと下で測る。1Hz では窓の中に1周期も入らず、振幅を測れない。
  const atLow = magnitudeAt(100);
  const atPeak = magnitudeAt(12000);
  const above = magnitudeAt(20000);
  check("a resonance leaves the band below it alone", Math.abs(atLow - 1) < 0.01, atLow);
  check(
    "peaks near its frequency by about Q",
    atPeak > 3 && atPeak < 5,
    atPeak,
  );
  check("and rolls off above it", above < atPeak * 0.5, above);

  // 電気負荷も同じ形。2つ重ねても素直に積になる。
  cartridge.configure(
    cartridgeWith({
      mechanicalResonance: { hz: 12000, q: 2 },
      electricalLoad: { hz: 12000, q: 2 },
    }),
  );
  const both = magnitudeAt(12000);
  cartridge.configure(cartridgeWith({ mechanicalResonance: { hz: 12000, q: 2 } }));
  const one = magnitudeAt(12000);
  check(
    "two sections multiply, they do not fight",
    Math.abs(both - one * one) / both < 0.05,
    { one, both },
  );
}

// 極端な設定でも発振しない。
{
  const cartridge = createCartridge(SAMPLE_RATE);
  const absurd: Array<Partial<CartridgeParameters>> = [
    { azimuth: 100 },
    { azimuth: Number.NaN },
    { sensitivity: { left: 1e9, right: -1e9 } },
    { crosstalk: { leftFromRight: 50, rightFromLeft: -50 } },
    { mechanicalResonance: { hz: SAMPLE_RATE * 10, q: 1e6 } },
    { mechanicalResonance: { hz: -5, q: -3 } },
    { mechanicalResonance: { hz: Number.NaN, q: Number.NaN } },
    { electricalLoad: { hz: 0, q: 1e-9 } },
    {
      mechanicalResonance: { hz: SAMPLE_RATE * 0.499, q: 40 },
      electricalLoad: { hz: SAMPLE_RATE * 0.499, q: 40 },
    },
  ];

  let sane = true;
  let growing = false;
  for (const settings of absurd) {
    cartridge.configure(cartridgeWith(settings));
    // インパルスを1発入れて、その尾が育たないことを見る。**減衰しきることは
    // 求めない** — 1Hz・低Qのような設定は正しく安定でも数秒かかる。発振して
    // いるかどうかは「後の窓が前の窓より大きくならない」で決まる。
    cartridge.process(1, 1);
    let early = 0;
    let late = 0;
    for (let i = 0; i < 40000; i++) {
      cartridge.process(0, 0);
      if (!Number.isFinite(cartridge.left) || !Number.isFinite(cartridge.right)) {
        sane = false;
        break;
      }
      if (i >= 10000 && i < 20000) early = Math.max(early, Math.abs(cartridge.left));
      if (i >= 30000) late = Math.max(late, Math.abs(cartridge.left));
    }
    if (late > early + 1e-12) growing = true;
  }
  check("no setting, however absurd, produces a non-finite sample", sane);
  check("and no impulse response ever grows", !growing);

  // まともな設定なら、ちゃんと消える。
  cartridge.configure(cartridgeWith({ mechanicalResonance: { hz: 12000, q: 5 } }));
  cartridge.process(1, 1);
  let tail = 0;
  for (let i = 0; i < 4000; i++) {
    cartridge.process(0, 0);
    if (i > 2000) tail = Math.max(tail, Math.abs(cartridge.left));
  }
  check("a sensible resonance rings out quickly", tail < 1e-9, tail);
}

// エンジンに載せたとき: 理想なら出力が変わらず、無音も無音のまま。
{
  const groove = cutTone(10, 1000);
  const render = (parameters: CartridgeParameters | null, blockSize = 128) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove);
    if (parameters !== null) engine.setCartridge(parameters);
    run(engine, baseInput({ stylusContact: false }), SAMPLE_RATE * 3, blockSize);
    return run(engine, baseInput(), 16384, blockSize);
  };

  const withoutCartridge = render(null);
  const withIdeal = render(IDEAL_CARTRIDGE);
  let identical = true;
  for (let i = 0; i < withoutCartridge.left.length; i++) {
    if (
      withoutCartridge.left[i] !== withIdeal.left[i] ||
      withoutCartridge.right[i] !== withIdeal.right[i]
    ) {
      identical = false;
      break;
    }
  }
  check("an ideal cartridge changes the deck's output not at all", identical);

  // ブロック長非依存は共振の状態を持ち越しても保たれること。
  const tilted = cartridgeWith({
    azimuth: (3 * Math.PI) / 180,
    sensitivity: { left: 0.9, right: 1.1 },
    crosstalk: { leftFromRight: 0.02, rightFromLeft: 0.03 },
    mechanicalResonance: { hz: 14000, q: 3 },
    electricalLoad: { hz: 9000, q: 1.2 },
  });
  const small = render(tilted, 128);
  const large = render(tilted, 4096);
  let sameAcrossBlocks = true;
  for (let i = 0; i < small.left.length; i++) {
    if (small.left[i] !== large.left[i] || small.right[i] !== large.right[i]) {
      sameAcrossBlocks = false;
      break;
    }
  }
  check("a non-ideal cartridge is still block-size independent", sameAcrossBlocks);
  check("and it does change the sound", (() => {
    for (let i = 0; i < small.left.length; i++) {
      if (small.left[i] !== withIdeal.left[i]) return true;
    }
    return false;
  })());

  // 停止と非接触は、カートリッジを噛ませても厳密な無音。
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(groove);
  engine.setCartridge(tilted);
  run(engine, baseInput(), SAMPLE_RATE * 3, 128);
  const idle = baseInput({ motorRequested: false });
  run(engine, idle, SAMPLE_RATE * 3, 128);
  const stopped = run(engine, idle, 4096, 128);
  check(
    "a stopped platter is exactly silent through the cartridge too",
    stopped.left.every((v) => v === 0) && stopped.right.every((v) => v === 0),
  );
  run(engine, baseInput(), SAMPLE_RATE * 2, 128);
  const lifted = run(engine, baseInput({ stylusContact: false }), 4096, 128);
  check(
    "and so is a lifted stylus",
    lifted.left.every((v) => v === 0) && lifted.right.every((v) => v === 0),
  );

  // 正転と逆転で同じ扱いを受けること。
  //
  // 両方向とも**手で**同じ大きさの角速度を与える。モーターで正転させて手で逆転
  // させると、整定する速度が数%違ってしまい、その差（速度そのものとRIAAの効き方）を
  // 対称性の破れと取り違える。
  // 演奏領域のまん中あたりへ落とす。頭の近くで逆走させると溝の始まりを追い越して
  // リードインへ出てしまい、「無音になった」のを対称性の破れと読み違える。
  const layout = createCutLayout(groove.durationSeconds, groove.sampleRate);
  const midRadius = radiusAtRevolution(layout, layout.programRevolutions * 0.6);
  const byHand = (omega: number) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove);
    engine.setCartridge(tilted);
    const input = baseInput({
      motorRequested: false,
      handAngularVelocity: omega,
      stylusRadius: midRadius,
    });
    run(engine, baseInput({ stylusContact: false, motorRequested: false }), SAMPLE_RATE, 128);
    run(engine, input, SAMPLE_RATE * 2, 128);
    return { level: rms(run(engine, input, 16384, 128).left, 2048), omega: engine.state.omega };
  };
  const nominalOmega = rpmToRadPerSec(NOMINAL_RPM);
  const ahead = byHand(nominalOmega);
  const behind = byHand(-nominalOmega);
  check(
    "the hand reaches the same speed in both directions",
    Math.abs(Math.abs(behind.omega) / ahead.omega - 1) < 0.01,
    { forward: ahead.omega, reverse: behind.omega },
  );
  check(
    "the cartridge treats forward and reverse alike",
    Math.abs(behind.level / ahead.level - 1) < 0.02,
    { forward: ahead.level, reverse: behind.level },
  );
}

// 理想のカートリッジは、刻んだ L/R をそのまま返す。
{
  const frames = SAMPLE_RATE * 6;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    left[i] = 0.4 * Math.sin(2 * Math.PI * 400 * t);
    right[i] = 0.4 * Math.sin(2 * Math.PI * 1500 * t);
  }
  const { played } = playBack([left, right], 0.5);
  const from = Math.round(SAMPLE_RATE * 0.2);
  check(
    "an ideal cartridge keeps the two channels apart",
    Math.abs(dominantHz(played.left, from) - 400) < 20 &&
      Math.abs(dominantHz(played.right, from) - 1500) < 30,
    { left: dominantHz(played.left, from), right: dominantHz(played.right, from) },
  );
}

console.log("\nstylus contact, tracking and needle drop");

/**
 * 試験用の針。**実在カートリッジの値ではない** — 理想を崩したときの挙動を見る
 * ためだけの組で、既定（`IDEAL_STYLUS`）へ持ち込まないこと。
 *
 * 桁だけは実機の姿に合わせてある: 針圧 0.015N（≒1.5gf）、針先 0.3mg、
 * カンチレバー 15cu（=1.5e-2 m/N）、ζ=0.7。
 */
const stylusWith = (over: Partial<StylusParameters> = {}): StylusParameters => ({
  trackingForce: 0.015,
  stylusMass: 3e-7,
  compliance: 1.5e-2,
  damping: 0.7,
  referenceVelocity: REFERENCE_WALL_VELOCITY,
  ...over,
});

const peakOf = (values: ArrayLike<number>, from = 0) => {
  let peak = 0;
  for (let i = from; i < values.length; i++) peak = Math.max(peak, Math.abs(values[i]));
  return peak;
};

/**
 * 溝の要求が厳しい盤。5kHz・ほぼフルスケール。
 *
 * 加速度は 2πf×振幅なので、**周波数が高いほど同じ振幅でも要求が大きい**。
 * この盤で 0.015N の針は追い切り、0.001N では追えなくなる。
 *
 * 長さは、手で逆へ回しても演奏領域から出ないだけ取ってある（短い盤で逆走
 * させるとリードインへ出て無音になり、それを対称性の破れと読み違える）。
 */
const DEMANDING = cutTone(12, 5000, 0.9);

/** 助走してから演奏領域の途中へ針を降ろし、落ち着いてから測る。 */
/**
 * **出力段を外して、モデルそのものを測る。**
 *
 * `levels.ts` の飽和とセーフティは**信号を非線形にする**ので、2回の再生の差で
 * 量を測る検査（着地の過渡・反り・ランブル）はそれを外してから比べる。ここで
 * 見たいのは針とアームであって、フォノ段の余裕ではない。
 *
 * **基準設定そのものが働くかどうかは別に検査してある**（レベル校正の節）。
 */
const MEASURE_ONLY: LevelParameters = {
  ...REFERENCE_LEVELS,
  inputOverloadMv: Number.POSITIVE_INFINITY,
  outputHeadroomDb: Number.POSITIVE_INFINITY,
  // **校正も外す。** モデルそのものを測るので、録音レベルの取り決めは要らない。
  digitalCalibrationDb: 0,
  safetyCeilingDbfs: 24,
};

const dropStylus = (
  parameters: StylusParameters | null,
  options: {
    groove?: ReturnType<typeof cutTone>;
    blockSize?: number;
    landingSpeed?: number;
    frames?: number;
  } = {},
) => {
  const groove = options.groove ?? DEMANDING;
  const blockSize = options.blockSize ?? 128;
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.setLevels(MEASURE_ONLY);
  engine.loadGroove(groove);
  if (parameters !== null) engine.setStylus(parameters);

  const layout = createCutLayout(groove.durationSeconds, groove.sampleRate);
  const radius = radiusAtRevolution(layout, layout.programRevolutions * 0.25);
  run(
    engine,
    baseInput({ stylusContact: false, stylusRadius: radius }),
    SAMPLE_RATE * 3,
    blockSize,
  );
  const input = baseInput({
    stylusRadius: radius,
    landingSpeed: options.landingSpeed ?? 0,
  });
  const landing = run(engine, input, 4096, blockSize);
  // 針を降ろす瞬間そのものは別に数える。溝へ入る段差は接触の失敗ではないので、
  // 「この盤を追えているか」はそれが済んだ後で見る。
  const afterLanding = engine.state.contactLossSamples;
  const played = run(engine, input, options.frames ?? 16384, blockSize);
  return {
    landing,
    played,
    engine,
    settledLosses: engine.state.contactLossSamples - afterLanding,
  };
};

// 理想の針は、いまの音を1サンプルも変えない。
{
  const withoutStylus = dropStylus(null);
  const withIdeal = dropStylus(IDEAL_STYLUS);
  let identical = true;
  for (let i = 0; i < withoutStylus.played.left.length; i++) {
    if (
      withoutStylus.played.left[i] !== withIdeal.played.left[i] ||
      withoutStylus.played.right[i] !== withIdeal.played.right[i]
    ) {
      identical = false;
      break;
    }
  }
  check("an ideal stylus changes the deck's output not at all", identical);
  check(
    "and never reports losing the groove",
    withIdeal.engine.state.contactLossSamples === 0 &&
      !withIdeal.engine.state.mistracking,
  );

  // 追い切れる針も同じ。**追える溝では接触モデルは素通しでなければならない。**
  const capable = dropStylus(stylusWith());
  let unchanged = true;
  for (let i = 0; i < capable.played.left.length; i++) {
    if (
      capable.played.left[i] !== withIdeal.played.left[i] ||
      capable.played.right[i] !== withIdeal.played.right[i]
    ) {
      unchanged = false;
      break;
    }
  }
  check(
    "a stylus that can follow the groove is silent about it, to the bit",
    unchanged && capable.engine.state.contactLossSamples === 0,
    capable.engine.state.contactLossSamples,
  );
}

// 要求が能力を超えたときだけ、超えたぶんだけ壊れる。
{
  const ideal = dropStylus(IDEAL_STYLUS);
  const reference = peakOf(ideal.played.left);

  const departure = (trackingForce: number) => {
    const { played, settledLosses } = dropStylus(stylusWith({ trackingForce }));
    let worst = 0;
    for (let i = 0; i < played.left.length; i++) {
      worst = Math.max(worst, Math.abs(played.left[i] - ideal.played.left[i]));
    }
    return { worst: worst / reference, losses: settledLosses };
  };

  // 針圧を下げていくと、どこかで追えなくなる。その最初の一歩が跳ねないこと。
  // この盤の要求は 7.3e4（単位/s²）で、1.09mN でちょうど拮抗する。
  const ladder = [0.015, 0.003, 0.002, 0.0012, 0.00108, 0.00106, 0.001, 0.0006, 0.0002];
  const measured = ladder.map(departure);
  const onset = measured.findIndex((m) => m.losses > 0);

  check(
    "lightening the tracking force eventually costs contact",
    onset > 0,
    ladder.map((force, i) => `${force}N:${measured[i].losses}`).join(" "),
  );
  check(
    "everything above that force still tracks perfectly",
    measured.slice(0, onset).every((m) => m.losses === 0 && m.worst === 0),
  );
  check(
    "the first loss is a small one, not a cliff",
    measured[onset].worst < 0.05,
    measured[onset],
  );
  check(
    "and it grows smoothly from there rather than in one step",
    measured
      .slice(onset, -1)
      .every((m, i) => measured[onset + i + 1].worst >= m.worst),
    measured.slice(onset).map((m) => m.worst.toFixed(4)).join(" "),
  );
  check(
    "and it keeps growing as the force keeps dropping",
    measured[onset].worst < measured[measured.length - 1].worst &&
      measured[measured.length - 1].worst > 0.2,
    { onset: measured[onset].worst, lightest: measured[measured.length - 1].worst },
  );
  check(
    "a mistracking stylus still produces finite samples only",
    (() => {
      const { played } = dropStylus(stylusWith({ trackingForce: 0.0002 }));
      return (
        played.left.every((v) => Number.isFinite(v)) &&
        played.right.every((v) => Number.isFinite(v))
      );
    })(),
  );
}

// ブロック長非依存。接触の状態はサンプルを跨いで持ち越されるので、ここが本番。
{
  const light = stylusWith({ trackingForce: 0.0006 });
  const small = dropStylus(light, { blockSize: 128 });
  const large = dropStylus(light, { blockSize: 4096 });
  let same = true;
  for (let i = 0; i < small.played.left.length; i++) {
    if (
      small.played.left[i] !== large.played.left[i] ||
      small.played.right[i] !== large.played.right[i]
    ) {
      same = false;
      break;
    }
  }
  check("mistracking is bit-identical at 128 and 4096 frames a block", same);
  check(
    "and so is the count of lost samples",
    small.settledLosses === large.settledLosses,
    { small: small.settledLosses, large: large.settledLosses },
  );
  check("which is not zero, or this proves nothing", small.settledLosses > 0);
}

// 正転と逆転で対称であること。**モジュール単体なら、これは厳密に言える。**
{
  const stylus = createStylus(SAMPLE_RATE, stylusWith({ trackingForce: 0.0006 }));
  const frames = 4096;
  const wall = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    // 溝の速度そのものを与える。振幅は 0.015N の限界を軽く超える大きさ。
    wall[i] = 3 * Math.sin((2 * Math.PI * 5000 * i) / SAMPLE_RATE);
  }

  const sweep = (sign: number) => {
    stylus.reset();
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      stylus.process(sign * wall[i], sign * wall[i]);
      left[i] = stylus.left;
      right[i] = stylus.right;
    }
    return { left, right };
  };

  const forward = sweep(1);
  const reverse = sweep(-1);
  // 横方向の盤では、左右の壁が互いに逆の半周期を受け持つ。向きを反転すると
  // 役割がそのまま入れ替わるので、**符号を反転した相手側と一致する**。
  let mirrored = true;
  for (let i = 0; i < frames; i++) {
    if (
      reverse.left[i] !== -forward.right[i] ||
      reverse.right[i] !== -forward.left[i]
    ) {
      mirrored = false;
      break;
    }
  }
  check("forward and reverse are exact mirrors of each other", mirrored);
}

// エンジンごと逆へ回しても、追えなくなる量は変わらない。
{
  const byHand = (omega: number) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(DEMANDING);
    engine.setStylus(stylusWith({ trackingForce: 0.0006 }));
    const layout = createCutLayout(DEMANDING.durationSeconds, DEMANDING.sampleRate);
    const radius = radiusAtRevolution(layout, layout.programRevolutions * 0.5);
    run(
      engine,
      baseInput({ stylusContact: false, motorRequested: false, stylusRadius: radius }),
      SAMPLE_RATE,
      128,
    );
    const input = baseInput({
      motorRequested: false,
      handAngularVelocity: omega,
      stylusRadius: radius,
    });
    run(engine, input, SAMPLE_RATE * 2, 128);
    const before = engine.state.contactLossSamples;
    const played = run(engine, input, 16384, 128);
    return {
      losses: engine.state.contactLossSamples - before,
      level: rms(played.left, 2048),
    };
  };

  const nominalOmega = rpmToRadPerSec(NOMINAL_RPM);
  const ahead = byHand(nominalOmega);
  const behind = byHand(-nominalOmega);
  check(
    "the stylus loses the groove as often backwards as forwards",
    ahead.losses > 0 && Math.abs(behind.losses / ahead.losses - 1) < 0.05,
    { forward: ahead.losses, reverse: behind.losses },
  );
  check(
    "and it sounds the same going either way",
    Math.abs(behind.level / ahead.level - 1) < 0.05,
    { forward: ahead.level, reverse: behind.level },
  );
}

// 針を上げれば、どんなに酷く暴れていても厳密な無音。
{
  const light = stylusWith({ trackingForce: 0.0002 });
  const { engine } = dropStylus(light);
  check("a badly mistracking stylus is still reported as such", engine.state.mistracking);

  const lifted = run(engine, baseInput({ stylusContact: false }), 8192, 128);
  check(
    "lifting it is exactly silent, mistracking or not",
    lifted.left.every((v) => v === 0) && lifted.right.every((v) => v === 0),
  );
  check(
    "and a lifted stylus is not 'mistracking' — it is not tracking anything",
    !engine.state.mistracking,
  );
  const idle = engine.state.contactLossSamples;
  run(engine, baseInput({ stylusContact: false }), 8192, 128);
  check("nor does it keep counting losses while up", engine.state.contactLossSamples === idle);

  // 止まった盤も同じ。ω=0 なら要求加速度も0なので、そもそも離れようがない。
  const stopped = createDeckEngine({ sampleRate: SAMPLE_RATE });
  stopped.loadGroove(DEMANDING);
  stopped.setStylus(light);
  const still = run(stopped, baseInput({ motorRequested: false }), SAMPLE_RATE * 3, 128);
  check(
    "a stopped platter is exactly silent through the contact model too",
    still.left.every((v) => v === 0) && still.right.every((v) => v === 0),
  );
}

// 針落下: 過渡は**実際の着地速度**から出る。
{
  const capable = stylusWith();
  // 溝の音ではなく**過渡だけ**を測る。同じ盤を同じ場所で鳴らして差を取る。
  const quiet = dropStylus(capable, { landingSpeed: 0 });
  const transientOf = (landingSpeed: number) => {
    const { landing } = dropStylus(capable, { landingSpeed });
    let worst = 0;
    for (let i = 0; i < landing.left.length; i++) {
      worst = Math.max(worst, Math.abs(landing.left[i] - quiet.landing.left[i]));
    }
    return worst;
  };

  const placed = transientOf(0);
  const gentle = transientOf(0.05);
  const dropped = transientOf(0.12);
  check(
    "placing the stylus without any descent makes no transient at all",
    placed === 0,
    placed,
  );
  check(
    "a faster landing makes a bigger one",
    gentle > 0 && dropped > gentle,
    { gentle, dropped },
  );
  check(
    "and its size is the landing speed itself",
    Math.abs(dropped / gentle - 0.12 / 0.05) < 0.01,
    { gentle, dropped, ratio: dropped / gentle },
  );

  // 理想の針は着地しても鳴らない。運動量が無いのだから何も起きない。
  const idealPlaced = dropStylus(IDEAL_STYLUS, { landingSpeed: 0 });
  const idealDropped = dropStylus(IDEAL_STYLUS, { landingSpeed: 0.5 });
  check(
    "an ideal stylus lands in silence, however hard it is dropped",
    (() => {
      for (let i = 0; i < idealPlaced.landing.left.length; i++) {
        if (idealPlaced.landing.left[i] !== idealDropped.landing.left[i]) return false;
      }
      return true;
    })(),
  );

  // そして過渡は**消える**。鳴り続けたら共振が発散している。
  const settled = dropStylus(capable, { landingSpeed: 0.12 });
  let tail = 0;
  for (let i = 0; i < settled.played.left.length; i++) {
    tail = Math.max(tail, Math.abs(settled.played.left[i] - quiet.played.left[i]));
  }
  check(
    "the drop rings out rather than staying",
    tail < 1e-4,
    { tail, transient: dropped },
  );
}

// レートが変わっても、追える／追えないの境目は動かない。
{
  const trackedFraction = (rate: number) => {
    const frames = Math.round(rate * 4);
    const source = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      source[i] = 0.9 * Math.sin((2 * Math.PI * 5000 * i) / rate);
    }
    const groove = createGrooveBuffer(cutToGroove([source], rate), rate);
    const engine = createDeckEngine({ sampleRate: rate });
    engine.loadGroove(groove);
    engine.setStylus(stylusWith({ trackingForce: 0.0006 }));
    const layout = createCutLayout(groove.durationSeconds, groove.sampleRate);
    const radius = radiusAtRevolution(layout, layout.programRevolutions * 0.25);
    run(engine, baseInput({ stylusContact: false, stylusRadius: radius }), rate * 3, 128);
    const input = baseInput({ stylusRadius: radius });
    run(engine, input, 4096, 128);
    const before = engine.state.contactLossSamples;
    const frames2 = Math.round(rate * 0.25);
    run(engine, input, frames2, 128);
    return (engine.state.contactLossSamples - before) / frames2;
  };

  const at48 = trackedFraction(48000);
  const at44 = trackedFraction(44100);
  check(
    "the same groove costs the same share of contact at 44.1k and 48k",
    at48 > 0 && Math.abs(at44 / at48 - 1) < 0.1,
    { "44100": at44, "48000": at48 },
  );
}

// どんな設定を渡されても、値を撒き散らさない・鳴り続けない。
{
  const absurd: Array<Partial<StylusParameters>> = [
    { trackingForce: 0 },
    { trackingForce: -1 },
    { trackingForce: Number.NaN },
    { trackingForce: 1e9 },
    { stylusMass: -1 },
    { stylusMass: Number.NaN },
    { stylusMass: 1e12 },
    { stylusMass: 1e-30 },
    { compliance: 0 },
    { compliance: -1 },
    { compliance: Number.NaN },
    { compliance: 1e12 },
    { damping: 0 },
    { damping: -5 },
    { damping: Number.NaN },
    { damping: 1e9 },
    { referenceVelocity: 0 },
    { referenceVelocity: Number.NaN },
    { referenceVelocity: -1 },
  ];

  let sane = true;
  let growing = false;
  let worst: unknown = null;
  for (const over of absurd) {
    const stylus = createStylus(SAMPLE_RATE, stylusWith(over));
    let early = 0;
    let late = 0;
    for (let i = 0; i < 24000; i++) {
      // 追従能力を確実に超える大きさで叩き続ける。
      const drive = 20 * Math.sin((2 * Math.PI * 6000 * i) / SAMPLE_RATE);
      stylus.process(drive, -drive);
      if (!Number.isFinite(stylus.left) || !Number.isFinite(stylus.right)) {
        sane = false;
        worst = over;
        break;
      }
      if (i >= 4000 && i < 8000) early = Math.max(early, Math.abs(stylus.left));
      if (i >= 20000) late = Math.max(late, Math.abs(stylus.left));
    }
    // 入力は定常なので、応答も定常に収まっていなければならない。
    if (late > early * 1.5 + 1e-9) {
      growing = true;
      worst = over;
    }
  }
  check("no setting, however absurd, produces a non-finite sample", sane, worst);
  check("and none of them lets the contact model run away", !growing, worst);

  // 着地の跳ね返りも同じ。極端な速度を投げ込んでも収まる。
  const stylus = createStylus(SAMPLE_RATE, stylusWith());
  stylus.land(1e6);
  let landed = 0;
  let ringing = 0;
  for (let i = 0; i < 48000; i++) {
    stylus.process(0, 0);
    if (!Number.isFinite(stylus.left)) landed = Number.NaN;
    if (i > 24000) ringing = Math.max(ringing, Math.abs(stylus.left));
  }
  check(
    "an absurd landing speed still settles",
    !Number.isNaN(landed) && ringing === 0,
    ringing,
  );
}

// 追従限界は針圧と針先質量から出る — 数値ではなく式が正本。
{
  const stylus = createStylus(SAMPLE_RATE, stylusWith());
  const expected =
    (0.015 * Math.SQRT1_2) / (3e-7 * REFERENCE_WALL_VELOCITY);
  check(
    "the tracking limit is tracking force over tip mass, through the 45° walls",
    Math.abs(stylus.trackingLimit / expected - 1) < 1e-12,
    { limit: stylus.trackingLimit, expected },
  );
  check(
    "doubling the tracking force doubles what it can follow",
    (() => {
      stylus.configure(stylusWith({ trackingForce: 0.03 }));
      return Math.abs(stylus.trackingLimit / (2 * expected) - 1) < 1e-12;
    })(),
  );
  check(
    "and halving the tip mass does the same",
    (() => {
      stylus.configure(stylusWith({ stylusMass: 1.5e-7 }));
      return Math.abs(stylus.trackingLimit / (2 * expected) - 1) < 1e-12;
    })(),
  );
  check(
    "a massless stylus follows anything at all",
    (() => {
      stylus.configure(IDEAL_STYLUS);
      return stylus.bypassed && stylus.trackingLimit === Number.POSITIVE_INFINITY;
    })(),
  );
  check(
    "but no tracking force at all is not the same as a perfect one",
    (() => {
      stylus.configure(stylusWith({ trackingForce: 0 }));
      return !stylus.bypassed && stylus.trackingLimit === 0;
    })(),
  );
}

console.log("\nsurface defects");

/**
 * 試験用の盤面。**実機の盤を測った値ではない** — 桁だけ現実に合わせてある。
 *
 * 粗さ 2nm / 相関長 25µm、埃は 60〜300µm の粒を120個、傷は幅120µm・深さ4µm を4本。
 */
const surfaceWith = (over: Partial<SurfaceParameters> = {}): SurfaceParameters => ({
  seed: 20260727,
  roughness: { rms: 2e-9, correlationLength: 25e-6 },
  dust: { count: 120, minRadius: 60e-6, maxRadius: 300e-6, height: 3e-6 },
  scratches: { count: 4, width: 120e-6, depth: 4e-6, curvature: 3, length: 0.03 },
  ...over,
});

/**
 * 針が降りている間の盤の角度。螺旋上の位置と同じ速さで進む（どちらも Δφ から
 * 出る）ので、走査もそれに倣う。**上げている間だけ両者はずれる** — その挙動は
 * エンジン越しに別途確かめる。
 */
const playingPhi = (revolutions: number) => revolutions * 2 * Math.PI;

/** クリックの立ち上がりだけを拾う。RIAA の余韻で再点火しない程度の間隔を置く。 */
const CLICK_LEVEL = 1e-3;
const CLICK_GUARD = 500;

/**
 * 再生しながらクリックを拾い、**そのとき盤が何度回っていたか**を添えて返す。
 *
 * 盤の角度はブロックの前後の `phiUnwrapped` から線形に割る。欠陥が盤面に固定されて
 * いるかどうかは、この角度でしか確かめようがない。
 */
const collectClicks = (
  engine: ReturnType<typeof createDeckEngine>,
  input: DeckEngineInput,
  blocks: number,
) => {
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  const clicks: Array<{ phi: number; sample: number }> = [];
  let quietFor = CLICK_GUARD;
  for (let block = 0; block < blocks; block++) {
    const before = engine.state.phiUnwrapped;
    engine.process(input, outL, outR);
    const after = engine.state.phiUnwrapped;
    for (let i = 0; i < 128; i++) {
      if (Math.abs(outL[i]) < CLICK_LEVEL) {
        quietFor++;
        continue;
      }
      if (quietFor >= CLICK_GUARD) {
        clicks.push({
          phi: before + (i / 128) * (after - before),
          sample: block * 128 + i,
        });
      }
      quietFor = 0;
    }
  }
  return clicks;
};

/**
 * 針が降りていて、アームが止まっている状態での盤面の読み取り。
 *
 * 方位角は 0 に固定してある — アームを振ったときの挙動はエンジン越しに別途
 * 確かめる。半径は螺旋が運んだ先（follow 中の正本）。
 */
const scanSurface = (
  surface: ReturnType<typeof createSurface>,
  layout: ReturnType<typeof createCutLayout>,
  revolutions: number,
) =>
  // レコード座標の角度は「方位角 − 回転角」。方位角を固定した走査なので、
  // 盤の回転角の符号を反転しただけになる。
  surface.sample(
    revolutions,
    radiusAtRevolution(layout, revolutions),
    -playingPhi(revolutions),
  );

const QUIET = cutTone(12, 1000, 0.2);
const QUIET_LAYOUT = createCutLayout(QUIET.durationSeconds, QUIET.sampleRate);

/**
 * 片面20分ぶんの割り付け。**欠陥の配置を見るときはこちらを使う。**
 *
 * 12秒の盤は外周 0.9mm しか使わないので、盤面にばらまいた埃や傷にほとんど
 * 出会わない（実際のレコードでもそう）。幾何を確かめるには一面ぶんが要る。
 */
const LP_LAYOUT = createCutLayout(1200, SAMPLE_RATE);
/** 一面の真ん中あたりの回転数。 */
const LP_MIDDLE = Math.floor(LP_LAYOUT.programRevolutions * 0.5);

/** 盤面だけを見る。針もカートリッジも理想のまま。 */
const playSurface = (
  parameters: SurfaceParameters | null,
  options: { blockSize?: number; frames?: number; stylus?: StylusParameters } = {},
) => {
  const blockSize = options.blockSize ?? 128;
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(QUIET);
  if (parameters !== null) engine.setSurface(parameters);
  if (options.stylus) engine.setStylus(options.stylus);
  const radius = radiusAtRevolution(
    QUIET_LAYOUT,
    QUIET_LAYOUT.programRevolutions * 0.25,
  );
  run(
    engine,
    baseInput({ stylusContact: false, stylusRadius: radius }),
    SAMPLE_RATE * 3,
    blockSize,
  );
  const input = baseInput({ stylusRadius: radius });
  run(engine, input, 4096, blockSize);
  const settledFrom = engine.state.contactLossSamples;
  const played = run(engine, input, options.frames ?? 32768, blockSize);
  return { played, engine, losses: engine.state.contactLossSamples - settledFrom };
};

// きれいな盤は、いまの音を1サンプルも変えない。
{
  const bare = playSurface(null);
  const clean = playSurface(CLEAN_SURFACE);
  let identical = true;
  for (let i = 0; i < bare.played.left.length; i++) {
    if (
      bare.played.left[i] !== clean.played.left[i] ||
      bare.played.right[i] !== clean.played.right[i]
    ) {
      identical = false;
      break;
    }
  }
  check("a clean disc changes the deck's output not at all", identical);

  const dirty = playSurface(surfaceWith());
  check(
    "and a dirty one does change it",
    (() => {
      for (let i = 0; i < dirty.played.left.length; i++) {
        if (dirty.played.left[i] !== clean.played.left[i]) return true;
      }
      return false;
    })(),
  );
}

// 同じ seed なら同じ盤。読み直しても、別のエンジンでも、同じ波形。
{
  const first = playSurface(surfaceWith());
  const second = playSurface(surfaceWith());
  let same = true;
  for (let i = 0; i < first.played.left.length; i++) {
    if (
      first.played.left[i] !== second.played.left[i] ||
      first.played.right[i] !== second.played.right[i]
    ) {
      same = false;
      break;
    }
  }
  check("the same seed gives the same disc, bit for bit", same);

  const other = playSurface(surfaceWith({ seed: 20260728 }));
  check(
    "and a different seed gives a different one",
    (() => {
      for (let i = 0; i < first.played.left.length; i++) {
        if (first.played.left[i] !== other.played.left[i]) return true;
      }
      return false;
    })(),
  );

  // ブロック長非依存。欠陥は状態を持たないので、ここは構造的に通るはず。
  const large = playSurface(surfaceWith(), { blockSize: 4096 });
  let acrossBlocks = true;
  for (let i = 0; i < first.played.left.length; i++) {
    if (
      first.played.left[i] !== large.played.left[i] ||
      first.played.right[i] !== large.played.right[i]
    ) {
      acrossBlocks = false;
      break;
    }
  }
  check("defects are bit-identical at 128 and 4096 frames a block", acrossBlocks);
}

// 止まった盤・上げた針からは、新しいノイズが出ない。
{
  const filthy = surfaceWith({
    roughness: { rms: 2e-8, correlationLength: 25e-6 },
    dust: { count: 600, minRadius: 60e-6, maxRadius: 400e-6, height: 6e-6 },
  });
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(QUIET);
  engine.setSurface(filthy);
  const radius = radiusAtRevolution(QUIET_LAYOUT, QUIET_LAYOUT.programRevolutions * 0.25);
  run(engine, baseInput({ stylusContact: false, stylusRadius: radius }), SAMPLE_RATE * 3, 128);
  run(engine, baseInput({ stylusRadius: radius }), SAMPLE_RATE, 128);

  const lifted = run(engine, baseInput({ stylusContact: false }), 8192, 128);
  check(
    "a lifted stylus hears no surface at all",
    lifted.left.every((v) => v === 0) && lifted.right.every((v) => v === 0),
  );

  const stopping = baseInput({ motorRequested: false });
  run(engine, stopping, SAMPLE_RATE * 3, 128);
  const stopped = run(engine, stopping, 8192, 128);
  check(
    "and a stopped platter generates no new noise",
    stopped.left.every((v) => v === 0) && stopped.right.every((v) => v === 0),
  );

  // 押さえて止めている場合も同じ。溝の上にはいるが、動いていない。
  const held = run(
    engine,
    baseInput({ motorRequested: false, handAngularVelocity: 0 }),
    8192,
    128,
  );
  check(
    "nor does a hand holding the record still",
    held.left.every((v) => v === 0) && held.right.every((v) => v === 0),
  );
}

// 盤面は位置の関数でしかない。ここから逆走の対称性と決定論が出る。
{
  const surface = createSurface(surfaceWith(), QUIET_LAYOUT, SAMPLE_RATE);
  const from = QUIET_LAYOUT.programRevolutions * 0.2;
  const stepRev = 1e-5;
  const count = 20000;

  const forward: number[] = [];
  for (let i = 0; i < count; i++) {
    scanSurface(surface, QUIET_LAYOUT, from + i * stepRev);
    forward.push(surface.left);
  }
  let reversible = true;
  for (let i = count - 1; i >= 0; i--) {
    scanSurface(surface, QUIET_LAYOUT, from + i * stepRev);
    if (surface.left !== forward[i]) {
      reversible = false;
      break;
    }
  }
  check("running the disc backwards passes the same defects in reverse", reversible);

  // 刻み幅を変えても同じ位置なら同じ値。ブロック長にも速度にも依らない。
  let stepIndependent = true;
  for (let i = 0; i < count; i += 7) {
    scanSurface(surface, QUIET_LAYOUT, from + i * stepRev);
    if (surface.left !== forward[i]) {
      stepIndependent = false;
      break;
    }
  }
  check("and the same place always sounds the same, however it was reached", stepIndependent);

  // 表面粗さは**経路に固定された連続な場**。毎サンプルのホワイトノイズではない。
  const rough = createSurface(
    surfaceWith({
      dust: { count: 0, minRadius: 0, maxRadius: 0, height: 0 },
      scratches: { count: 0, width: 0, depth: 0, curvature: 0, length: 0 },
      // 相関長を溝の1サンプルぶんより十分長く取る。連続なら隣は近いはず。
      roughness: { rms: 2e-9, correlationLength: 1e-3 },
    }),
    QUIET_LAYOUT,
    SAMPLE_RATE,
  );
  // 公称速度で1出力サンプルぶん進む量。
  const perSample = 1 / QUIET_LAYOUT.samplesPerRevolution;
  let field = 0;
  let deltas = 0;
  let previous = 0;
  for (let i = 0; i < 20000; i++) {
    scanSurface(rough, QUIET_LAYOUT, from + i * perSample);
    field += rough.left * rough.left;
    if (i > 0) deltas += (rough.left - previous) ** 2;
    previous = rough.left;
  }
  const continuity = Math.sqrt(deltas / field);
  check(
    "surface roughness is a continuous field, not per-sample noise",
    continuity < 0.2,
    { rmsOfDifference: continuity },
  );
  check("but it is not silent either", field > 0);
}

// 埃は有限の大きさを持つ局所的な欠陥で、盤面の (半径, 角度) に固定されている。
{
  const dustOnly = surfaceWith({
    roughness: { rms: 0, correlationLength: 0 },
    scratches: { count: 0, width: 0, depth: 0, curvature: 0, length: 0 },
    dust: { count: 2000, minRadius: 200e-6, maxRadius: 300e-6, height: 4e-6 },
  });
  const surface = createSurface(dustOnly, LP_LAYOUT, SAMPLE_RATE);

  // 1回転ぶんを細かく走査して、当たった区間を数える。
  const scan = (fromRev: number, revs: number, steps: number) => {
    const hits: Array<{ at: number; width: number }> = [];
    let inside = false;
    let start = 0;
    for (let i = 0; i <= steps; i++) {
      const rev = fromRev + (i / steps) * revs;
      scanSurface(surface, LP_LAYOUT, rev);
      const on = surface.left !== 0 || surface.right !== 0;
      if (on && !inside) {
        inside = true;
        start = rev;
      } else if (!on && inside) {
        inside = false;
        hits.push({ at: (start + rev) / 2, width: rev - start });
      }
    }
    return hits;
  };

  const base = LP_MIDDLE;
  const hits = scan(base, 1, 200000);
  check(
    "dust is local: a whole turn meets a few specks, not a carpet",
    hits.length > 0 && hits.reduce((sum, h) => sum + h.width, 0) < 0.2,
    { specks: hits.length, covered: hits.reduce((sum, h) => sum + h.width, 0) },
  );
  check(
    "and every speck is finite and small",
    hits.every((h) => h.width > 0 && h.width < 0.02),
    hits.map((h) => h.width.toFixed(5)).join(" "),
  );

  // 粒の直径は溝のピッチ（0.136mm/rev）より大きいので、**続く回転でも当たる**。
  const next = scan(base + 1, 1, 200000);
  const repeated = hits.some((h) =>
    next.some((n) => Math.abs((n.at - 1) - h.at) < 0.01),
  );
  check("a speck wider than the groove pitch is met again next time round", repeated);

  // 埃は針を持ち上げる＝垂直。左右の壁には逆相で入る。
  let opposite = true;
  for (const hit of hits) {
    scanSurface(surface, LP_LAYOUT, hit.at);
    if (surface.left * surface.right > 0) {
      opposite = false;
      break;
    }
  }
  check("dust lifts the stylus, so it lands out of phase on the two walls", opposite);
}

// 傷は溝を横切る線・弧として盤面に固定され、同じ角度で何回転ぶんも鳴る。
{
  const scratchesOnly = (over: Partial<SurfaceParameters["scratches"]> = {}) =>
    surfaceWith({
      roughness: { rms: 0, correlationLength: 0 },
      dust: { count: 0, minRadius: 0, maxRadius: 0, height: 0 },
      scratches: {
        count: 30,
        width: 150e-6,
        depth: 4e-6,
        curvature: 0,
        length: 0.03,
        ...over,
      },
    });
  const surface = createSurface(scratchesOnly(), LP_LAYOUT, SAMPLE_RATE);

  /** 1回転ぶん走査して、当たった角度（回転数の小数部）をすべて返す。 */
  const hitAngles = (fromRev: number) => {
    const found: number[] = [];
    let inside = false;
    for (let i = 0; i <= 200000; i++) {
      const rev = fromRev + i / 200000;
      scanSurface(surface, LP_LAYOUT, rev);
      const on = surface.left !== 0 || surface.right !== 0;
      if (on && !inside) found.push(rev - Math.floor(rev));
      inside = on;
    }
    return found;
  };

  const first = hitAngles(LP_MIDDLE);
  check("a scratch crosses the groove and is met while playing", first.length > 0, first.length);

  // 傷は盤に固定されているので、**次の回転でも同じ角度で**当たる。1本の傷が
  // 30mmぶんの半径を横切る＝0.133mm/rev で 220回転ぶん鳴り続ける。
  const laterTurns = [1, 2, 3, 4].map((n) => hitAngles(LP_MIDDLE + n));
  const persists = first.some((angle) =>
    laterTurns.every((turn) => turn.some((a) => Math.abs(a - angle) < 0.002)),
  );
  check("and it is met again at that same angle on the turns that follow", persists);

  // まっすぐな傷は溝と直角に交わる＝擾乱は純粋に垂直＝左右は厳密に逆相。
  let vertical = true;
  let sampled = 0;
  for (const angle of first) {
    for (let i = -50; i <= 50; i++) {
      scanSurface(surface, LP_LAYOUT, LP_MIDDLE + angle + i * 1e-7);
      if (surface.left === 0 && surface.right === 0) continue;
      sampled++;
      if (surface.left !== -surface.right) {
        vertical = false;
        break;
      }
    }
  }
  check(
    "a radial scratch throws the stylus straight up: wL is exactly −wR",
    vertical && sampled > 0,
    sampled,
  );

  // 弧を描く傷は溝を斜めに横切るので、横方向にも効く。**形から出る値**であって、
  // 別に持っているパラメータではない。
  const curved = createSurface(scratchesOnly({ curvature: 40 }), LP_LAYOUT, SAMPLE_RATE);
  let lateralSeen = false;
  for (let i = 0; i <= 400000 && !lateralSeen; i++) {
    scanSurface(curved, LP_LAYOUT, LP_MIDDLE + i / 400000);
    if (curved.left !== 0 && curved.left !== -curved.right) lateralSeen = true;
  }
  check("a curved one crosses the groove at an angle and leans to one side", lateralSeen);
}

// 接触モデルより手前にあるので、強い欠陥は勝手にミストラッキングを起こす。
{
  const gentle = playSurface(surfaceWith(), { stylus: stylusWith() });
  check("an ordinary surface does not throw a well-loaded stylus", gentle.losses === 0, gentle.losses);

  // 溝を抉るほどの傷。要求加速度は 4×深さ/(半幅/線速度)² なので、深く鋭いほど
  // 飛びやすい。25µm はレコードの溝の深さと同じ桁＝盤を捨てる類の傷である。
  const savage = surfaceWith({
    roughness: { rms: 0, correlationLength: 0 },
    dust: { count: 0, minRadius: 0, maxRadius: 0, height: 0 },
    scratches: { count: 120, width: 50e-6, depth: 25e-6, curvature: 0, length: 0.06 },
  });
  const thrown = playSurface(savage, { stylus: stylusWith(), frames: 65536 });
  check("but a sharp deep scratch does", thrown.losses > 0, thrown.losses);
  check(
    "and the ideal stylus rides straight over it",
    playSurface(savage).losses === 0,
  );
  check(
    "while the sound stays finite either way",
    thrown.played.left.every((v) => Number.isFinite(v)) &&
      thrown.played.right.every((v) => Number.isFinite(v)),
  );
}

// **針を上げている間も盤は回る。** 欠陥は盤面に固定されているので、降ろし直せば
// 位相はその回転ぶん動く。接触は出力のゲートであって、盤の自転を止めるものではない。
{
  const silent = createGrooveBuffer(
    cutToGroove([new Float32Array(SAMPLE_RATE * 20)], SAMPLE_RATE),
    SAMPLE_RATE,
  );
  const layout = createCutLayout(silent.durationSeconds, silent.sampleRate);
  const radius = radiusAtRevolution(layout, layout.programRevolutions * 0.25);
  const scratched = surfaceWith({
    roughness: { rms: 0, correlationLength: 0 },
    dust: { count: 0, minRadius: 0, maxRadius: 0, height: 0 },
    scratches: { count: 60, width: 200e-6, depth: 4e-6, curvature: 0, length: 0.06 },
  });

  const TWO_PI = Math.PI * 2;

  /**
   * 針を上げたまま `extraBlocks` ぶん余計に回してから降ろし、1回転ぶん再生する。
   * クリックごとに「そのとき盤が何度回っていたか」を返す。
   */
  const dropAfterWaiting = (extraBlocks: number) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(silent);
    engine.setSurface(scratched);
    const lifted = baseInput({ stylusContact: false, stylusRadius: radius });
    const outL = new Float32Array(128);
    const outR = new Float32Array(128);

    // 助走。ここまではどの回も同じ。
    for (let i = 0; i < 1200; i++) engine.process(lifted, outL, outR);
    // 針を上げたまま待つ。**盤はこの間も回っている。**
    const phiBeforeWait = engine.state.phiUnwrapped;
    const revolutionsBeforeWait = engine.state.revolutions;
    for (let i = 0; i < extraBlocks; i++) engine.process(lifted, outL, outR);
    const waited = engine.state.phiUnwrapped - phiBeforeWait;
    const drifted = engine.state.revolutions - revolutionsBeforeWait;

    // 降ろして1回転ぶん。クリックの角度と時刻を拾う。
    const down = baseInput({ stylusRadius: radius });
    const phiAtDrop = engine.state.phiUnwrapped;
    const clicks = collectClicks(
      engine,
      down,
      Math.ceil((SAMPLE_RATE * 1.8) / 128),
    ).map((hit) => ({
      angle: ((hit.phi % TWO_PI) + TWO_PI) % TWO_PI,
      sample: hit.sample,
    }));
    return { clicks, waited, drifted, phiAtDrop, omega: engine.state.omega };
  };

  const early = dropAfterWaiting(0);
  const late = dropAfterWaiting(400); // 約0.55回転ぶん余計に回してから降ろす

  check(
    "the platter keeps turning while the stylus is up",
    late.waited > 3 && Math.abs(late.drifted) < 1e-12,
    { turnedRadians: late.waited, grooveMoved: late.drifted },
  );
  check("and a scratched disc clicks once it is back down", early.clicks.length > 2, {
    early: early.clicks.length,
    late: late.clicks.length,
  });
  check(
    "the same scratches are met either way round the wait",
    early.clicks.length === late.clicks.length,
    { early: early.clicks.length, late: late.clicks.length },
  );

  // **本題**: 欠陥は盤面に固定されている。いつ降ろしても、鳴る「盤の角度」は同じ。
  const sortedAngles = (hits: Array<{ angle: number }>) =>
    hits.map((h) => h.angle).sort((a, b) => a - b);
  const earlyAngles = sortedAngles(early.clicks);
  const lateAngles = sortedAngles(late.clicks);
  let worstAngle = 0;
  for (let i = 0; i < Math.min(earlyAngles.length, lateAngles.length); i++) {
    worstAngle = Math.max(worstAngle, Math.abs(earlyAngles[i] - lateAngles[i]));
  }
  check(
    "every scratch is met at the same disc angle, whenever the needle went down",
    worstAngle < 0.01,
    { worstRadians: worstAngle },
  );

  // そして**同じ傷が鳴る時刻は、待った回転ぶんずれる**。ずれなければ位相が凍結して
  // いる。比べるのは「同じ傷」どうし — どれが最初に来るかは降ろした位相で変わる。
  const period = TWO_PI / early.omega;
  const first = early.clicks[0];
  const same = late.clicks.reduce((best, hit) =>
    Math.abs(hit.angle - first.angle) < Math.abs(best.angle - first.angle) ? hit : best,
  );
  const circular = (seconds: number) => ((seconds % period) + period) % period;
  // 盤の角度が固定なら、待った角度ぶんだけ早く（遅く）その傷へ着く。
  const expected = circular((early.phiAtDrop - late.phiAtDrop) / early.omega);
  const measured = circular((same.sample - first.sample) / SAMPLE_RATE);
  const error = Math.abs(measured - expected);
  check(
    "and the same scratch comes round later or earlier by exactly the rotation waited out",
    Math.min(error, period - error) < 0.01,
    { expectedSeconds: expected, measuredSeconds: measured, period },
  );
  check(
    "which is not zero — the phase really moved",
    Math.abs(same.sample - first.sample) > SAMPLE_RATE * 0.05,
    { early: first.sample, late: same.sample },
  );
}

// **アームもスピンドルのまわりを動く。** 外周と内周では針の方位角が14°ほど違うので、
// 同じ盤面固定の傷に当たる盤の位相もそのぶんずれる。
{
  // 一面ぶんの盤。**溝の中身は要らない**（傷だけを聞く）ので、溝バッファは低い
  // レートで持つ — 20分を48kHzで持つと230MBになる。割り付けは長さと回転数だけで
  // 決まるので、レートを落としても螺旋の形は変わらない。
  const GROOVE_RATE = 4000;
  const side = createGrooveBuffer(
    [new Float32Array(GROOVE_RATE * 1200)],
    GROOVE_RATE,
  );
  const scratched = surfaceWith({
    roughness: { rms: 0, correlationLength: 0 },
    dust: { count: 0, minRadius: 0, maxRadius: 0, height: 0 },
    // length を盤面の幅（94.9mm）より長く取ると、どの傷も**内周から外周まで**
    // 溝を横切る＝外周で当たる傷は内周でも当たる。同じ傷を比べるための条件。
    scratches: { count: 8, width: 300e-6, depth: 4e-6, curvature: 0, length: 1 },
  });

  /**
   * スピンドルから見た針先の方位角。アームの三角形（ピボット・スピンドル・針先）を
   * 余弦定理で解いただけで、**目測でも定数でもない**。
   */
  const azimuthAt = (radius: number) => {
    const { effectiveLength: L, pivotToSpindle: D } = TONEARM_GEOMETRY;
    return Math.acos((D * D + radius * radius - L * L) / (2 * D * radius));
  };

  const playAt = (radius: number) => {
    const azimuth = azimuthAt(radius);
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(side);
    engine.setSurface(scratched);
    const outL = new Float32Array(128);
    const outR = new Float32Array(128);
    const lifted = baseInput({
      stylusContact: false,
      stylusRadius: radius,
      stylusAzimuth: azimuth,
    });
    for (let i = 0; i < 1200; i++) engine.process(lifted, outL, outR);
    const down = baseInput({ stylusRadius: radius, stylusAzimuth: azimuth });
    const clicks = collectClicks(
      engine,
      down,
      Math.ceil((SAMPLE_RATE * 1.8) / 128),
    );
    return { radius, azimuth, clicks, engine };
  };

  const outer = playAt(0.145);
  const inner = playAt(0.062);
  const swing = inner.azimuth - outer.azimuth;

  check(
    "the arm really does swing across the side",
    Math.abs(swing) > 0.2 && Math.abs(swing) < 0.5,
    { outer: outer.azimuth, inner: inner.azimuth, swingDegrees: (swing * 180) / Math.PI },
  );
  check(
    "and the groove carries the stylus to where it was put down",
    Math.abs(outer.engine.state.stylusRadius - 0.145) < 1e-3 &&
      Math.abs(inner.engine.state.stylusRadius - 0.062) < 1e-3,
    { outer: outer.engine.state.stylusRadius, inner: inner.engine.state.stylusRadius },
  );
  check(
    "both ends of the side meet scratches",
    outer.clicks.length > 4 && inner.clicks.length > 4,
    { outer: outer.clicks.length, inner: inner.clicks.length },
  );

  const turn = Math.PI * 2;
  const wrap = (angle: number) => ((angle % turn) + turn) % turn;
  /** そのクリックはどの盤面の角度だったのか。索引を逆に解いただけ。 */
  const discAngles = (run: typeof outer, withAzimuth: boolean) =>
    run.clicks.map((hit) => wrap((withAzimuth ? run.azimuth : 0) - hit.phi));
  /** 集合として一致するか。近い相手までの距離の最大を返す。 */
  const worstGap = (a: number[], b: number[]) => {
    let worst = 0;
    for (const angle of a) {
      let best = Infinity;
      for (const other of b) {
        const gap = Math.abs(angle - other);
        best = Math.min(best, Math.min(gap, turn - gap));
      }
      worst = Math.max(worst, best);
    }
    return worst;
  };

  // **本題**: 方位角を入れて解けば、外周でも内周でも同じ傷が同じ盤面角度に出る。
  const withArm = worstGap(discAngles(outer, true), discAngles(inner, true));
  check(
    "the same scratches sit at the same place on the record from either end of the arm's travel",
    withArm < 0.01,
    { worstRadians: withArm },
  );

  // 盤の位相そのものは、方位角の変化ぶんちょうどずれている。
  const rawGap = worstGap(discAngles(outer, false), discAngles(inner, false));
  check(
    "so the platter phase they are met at moved by exactly the arm's bearing change",
    Math.abs(rawGap - Math.abs(swing)) < 0.01,
    { movedRadians: rawGap, swingRadians: Math.abs(swing) },
  );
  check(
    "which is the whole point: ignoring the arm would put them 16° out",
    rawGap > 0.2,
    rawGap,
  );
}

// でたらめな設定でも壊れない。
{
  const absurd: Array<Partial<SurfaceParameters>> = [
    { seed: Number.NaN },
    { roughness: { rms: Number.NaN, correlationLength: 25e-6 } },
    { roughness: { rms: 1, correlationLength: 0 } },
    { roughness: { rms: -1, correlationLength: -1 } },
    { roughness: { rms: 1e3, correlationLength: 1e-12 } },
    { dust: { count: -5, minRadius: 1, maxRadius: -1, height: Number.NaN } },
    { dust: { count: 1e9, minRadius: 0, maxRadius: 0, height: 1 } },
    { scratches: { count: 1e9, width: 0, depth: Number.NaN, curvature: 1e9, length: -1 } },
    { scratches: { count: 3, width: 1e-12, depth: 1e3, curvature: 1e6, length: 1e3 } },
  ];

  let sane = true;
  let worst: unknown = null;
  for (const over of absurd) {
    const surface = createSurface(surfaceWith(over), QUIET_LAYOUT, SAMPLE_RATE);
    for (let i = 0; i < 4000; i++) {
      scanSurface(surface, QUIET_LAYOUT, QUIET_LAYOUT.programRevolutions * (i / 4000));
      if (!Number.isFinite(surface.left) || !Number.isFinite(surface.right)) {
        sane = false;
        worst = over;
        break;
      }
    }
    if (!sane) break;
  }
  check("no surface setting, however absurd, produces a non-finite sample", sane, worst);

  // 盤が入っていなければ、何を設定しても素通し。
  const orphan = createSurface(surfaceWith(), null, SAMPLE_RATE);
  orphan.sample(1, 0.1, 0);
  check(
    "with no disc loaded there is no surface to read",
    orphan.bypassed && orphan.left === 0 && orphan.right === 0,
  );
}

console.log("\neccentricity and warp");

/**
 * 試験用の歪んだ盤。**実機を測った値ではない** — 桁だけ現実に合わせてある。
 * 偏心 0.2mm（実測される盤で 0.05〜0.3mm）、反りは外周 0.5mm の傾き＋鞍。
 * 皿（角度非依存）は既定では入れない。
 */
const discWith = (over: Partial<DiscShapeParameters> = {}): DiscShapeParameters => ({
  seed: 20260728,
  eccentricity: { offset: 2e-4 },
  warp: { dish: 0, amplitude: 5e-4, harmonics: 2 },
  ...over,
});

const ECCENTRIC_ONLY = discWith({ warp: { dish: 0, amplitude: 0, harmonics: 0 } });
const WARP_ONLY = discWith({ eccentricity: { offset: 0 } });

// 歪みの無い盤では、座標変換も高さ場も完全に素通しになる。
{
  const groove = cutTone(12, 1000, 0.4);
  const layout = createCutLayout(groove.durationSeconds, groove.sampleRate);
  const radius = radiusAtRevolution(layout, layout.programRevolutions * 0.25);
  const render = (shape: DiscShapeParameters | null) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove);
    if (shape !== null) engine.setDiscShape(shape);
    run(engine, baseInput({ stylusContact: false, stylusRadius: radius }), SAMPLE_RATE * 3, 128);
    const input = baseInput({ stylusRadius: radius });
    run(engine, input, 4096, 128);
    return { played: run(engine, input, 32768, 128), engine };
  };

  const bare = render(null);
  const flat = render(FLAT_DISC);
  let identical = true;
  for (let i = 0; i < bare.played.left.length; i++) {
    if (
      bare.played.left[i] !== flat.played.left[i] ||
      bare.played.right[i] !== flat.played.right[i]
    ) {
      identical = false;
      break;
    }
  }
  check("a true, flat disc changes the deck's output not at all", identical);
  check(
    "and the record coordinates fall back to the plain ones",
    // 1チャンクぶん螺旋が進むので、その 0.2µm だけは離れる。
    Math.abs(flat.engine.state.recordRadius - flat.engine.state.stylusRadius) < 1e-6 &&
      flat.engine.state.surfaceHeight === 0,
    {
      record: flat.engine.state.recordRadius,
      lab: flat.engine.state.stylusRadius,
    },
  );

  const eccentric = render(ECCENTRIC_ONLY);
  const warped = render(WARP_ONLY);
  const differs = (a: Float32Array, b: Float32Array) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
    return false;
  };
  check(
    "eccentricity alone changes the sound",
    differs(eccentric.played.left, flat.played.left),
  );
  check("and so does warp alone", differs(warped.played.left, flat.played.left));

  // 同じ seed なら同じ盤。
  const again = render(discWith());
  const once = render(discWith());
  check(
    "the same seed warps the disc the same way, bit for bit",
    !differs(again.played.left, once.played.left),
  );
  check(
    "and a different seed does not",
    differs(render(discWith({ seed: 7 })).played.left, once.played.left),
  );
  check(
    "block size still does not matter",
    (() => {
      const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
      engine.loadGroove(groove);
      engine.setDiscShape(discWith());
      run(engine, baseInput({ stylusContact: false, stylusRadius: radius }), SAMPLE_RATE * 3, 4096);
      const input = baseInput({ stylusRadius: radius });
      run(engine, input, 4096, 4096);
      const large = run(engine, input, 32768, 4096);
      return !differs(large.left, once.played.left);
    })(),
  );
}

// 偏心は Record 領域の座標変換。**ω には指一本触れない。**
{
  const shape = ECCENTRIC_ONLY;
  const offset = shape.eccentricity.offset;
  const groove = cutTone(30, 1000, 0.4);
  const layout = createCutLayout(groove.durationSeconds, groove.sampleRate);
  const radius = radiusAtRevolution(layout, layout.programRevolutions * 0.25);

  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(groove);
  engine.setDiscShape(shape);
  const lifted = baseInput({ stylusContact: false, stylusRadius: radius });
  run(engine, lifted, SAMPLE_RATE * 3, 128);
  const input = baseInput({ stylusRadius: radius });
  run(engine, input, 4096, 128);

  // 2回転ぶん、1ブロックずつ見る。
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  let omegaMin = Infinity;
  let omegaMax = -Infinity;
  let armMin = Infinity;
  let armMax = -Infinity;
  let cursorLead = -Infinity;
  let cursorLag = Infinity;
  const blocks = Math.ceil((SAMPLE_RATE * 3.6) / 128);
  for (let i = 0; i < blocks; i++) {
    engine.process(input, outL, outR);
    omegaMin = Math.min(omegaMin, engine.state.omega);
    omegaMax = Math.max(omegaMax, engine.state.omega);
    // **螺旋が運んだぶんを引く。** 残りが偏心そのもので、内周へ進む動きと混ざらない。
    const spiralRadius = radiusAtRevolution(layout, engine.state.revolutions);
    armMin = Math.min(armMin, engine.state.stylusRadius - spiralRadius);
    armMax = Math.max(armMax, engine.state.stylusRadius - spiralRadius);
    const spiralCursor = engine.state.revolutions * layout.samplesPerRevolution;
    cursorLead = Math.max(cursorLead, engine.state.programCursor - spiralCursor);
    cursorLag = Math.min(cursorLag, engine.state.programCursor - spiralCursor);
  }

  check(
    "the platter's own speed is untouched by eccentricity",
    (omegaMax - omegaMin) / omegaMax < 0.005,
    { omegaMin, omegaMax },
  );
  check(
    "but the arm swings by the offset, once a turn",
    Math.abs((armMax - armMin) / (2 * offset) - 1) < 0.05,
    { swingMm: (armMax - armMin) * 1000, expectedMm: 2 * offset * 1000 },
  );
  // 針の下を溝が通る速さが1回転周期で変わる＝wow。ずれの大きさは e/r ラジアン。
  const expected = (offset / radius) * (layout.samplesPerRevolution / (2 * Math.PI));
  check(
    "and the reading position leads and lags by e/r of a turn — that is the wow",
    Math.abs(cursorLead / expected - 1) < 0.15 &&
      Math.abs(cursorLag / -expected - 1) < 0.15,
    { lead: cursorLead, lag: cursorLag, expected },
  );
}

// レコード座標そのもの: 逆回転で同じ形を逆順に通り、盤に固定されている。
{
  const shape = discWith();
  const radius = 0.12;
  const azimuth = 1.2;
  const at = (phi: number) => recordPointAt(shape, radius, azimuth, phi);

  // 1回転すれば同じ点へ戻る。
  const start = at(0);
  const round = at(Math.PI * 2);
  check(
    "a full turn brings the same bit of record back under the stylus",
    Math.abs(round.radius - start.radius) < 1e-12 &&
      Math.abs(((round.angle - start.angle) % (Math.PI * 2))) < 1e-12,
  );

  // 偏心は半径を±offset、角度を±e/r 揺らす。
  let radiusMin = Infinity;
  let radiusMax = -Infinity;
  let wobble = 0;
  for (let i = 0; i < 2000; i++) {
    const point = at((i / 2000) * Math.PI * 2);
    radiusMin = Math.min(radiusMin, point.radius);
    radiusMax = Math.max(radiusMax, point.radius);
    wobble = Math.max(wobble, Math.abs(point.wobble));
  }
  check(
    "the record's own radius swings by twice the offset over a turn",
    Math.abs((radiusMax - radiusMin) / (2 * shape.eccentricity.offset) - 1) < 0.01,
    { swing: radiusMax - radiusMin },
  );
  check(
    "and its angle wobbles by e/r",
    Math.abs(wobble / (shape.eccentricity.offset / radius) - 1) < 0.02,
    { wobble, expected: shape.eccentricity.offset / radius },
  );

  // 逆回転は同じ場を逆順に辿るだけ。
  let reversible = true;
  for (let i = 0; i <= 500; i++) {
    const phi = (i / 500) * Math.PI * 2;
    const forward = at(phi);
    const back = at(phi);
    if (forward.radius !== back.radius || forward.angle !== back.angle) {
      reversible = false;
      break;
    }
  }
  check("running it backwards passes the same coordinates in reverse", reversible);

  // 反りは高さ場。同じ点なら同じ高さで、外周ほど大きい。
  const rim = warpHeightAt(shape, GROOVE.discRadius, 0.7);
  const middle = warpHeightAt(shape, GROOVE.discRadius / 2, 0.7);
  check(
    "warp is a height field fixed to the record, biggest at the rim",
    warpHeightAt(shape, 0.1, 0.5) === warpHeightAt(shape, 0.1, 0.5) &&
      Math.abs(middle / rim - 0.25) < 1e-9,
    { rim, middle },
  );
  check(
    "and it stays inside the amplitude asked for",
    (() => {
      let peak = 0;
      for (let i = 0; i < 4000; i++) {
        peak = Math.max(
          peak,
          Math.abs(warpHeightAt(shape, GROOVE.discRadius, (i / 4000) * Math.PI * 2)),
        );
      }
      return peak <= shape.warp.amplitude * 1.001 && peak > shape.warp.amplitude * 0.5;
    })(),
  );
  check(
    "a flat disc has no height at all",
    warpHeightAt(FLAT_DISC, 0.12, 1) === 0 && isFlatDisc(FLAT_DISC),
  );
}

// 反りは溝と同じ「変位」として、**垂直方向**に入る。
//
// 垂直は左右の壁へ逆相で入るので、L−R には出るが L+R には出ない。埃や傷と
// まったく同じ経路で、専用の機構は無い。
{
  const groove = cutTone(12, 1000, 0.4);
  const layout = createCutLayout(groove.durationSeconds, groove.sampleRate);
  const radius = radiusAtRevolution(layout, layout.programRevolutions * 0.25);
  const play = (shape: DiscShapeParameters) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove);
    engine.setDiscShape(shape);
    engine.setStylus(stylusWith());
    run(engine, baseInput({ stylusContact: false, stylusRadius: radius }), SAMPLE_RATE * 3, 128);
    const input = baseInput({ stylusRadius: radius });
    run(engine, input, 8192, 128);
    const before = engine.state.contactLossSamples;
    const played = run(engine, input, SAMPLE_RATE, 128);
    return { losses: engine.state.contactLossSamples - before, played, engine };
  };

  const flat = play(FLAT_DISC);
  const warped = play(WARP_ONLY);
  const spread = (played: { left: Float32Array; right: Float32Array }, sign: number) => {
    let low = Infinity;
    let high = -Infinity;
    for (let i = 2048; i < played.left.length; i++) {
      const value = played.left[i] + sign * played.right[i];
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    return high - low;
  };

  check(
    "a warp shows up out of phase — in L−R, which is the vertical direction",
    spread(warped.played, -1) > spread(flat.played, -1) * 3,
    { warped: spread(warped.played, -1), flat: spread(flat.played, -1) },
  );
  check(
    "and hardly at all in L+R, where the music is",
    Math.abs(spread(warped.played, 1) / spread(flat.played, 1) - 1) < 0.2,
    { warped: spread(warped.played, 1), flat: spread(flat.played, 1) },
  );
  check(
    "the sound stays finite through it",
    warped.played.left.every((v) => Number.isFinite(v)),
  );
  check(
    "the warp under the stylus is reported for the scene to draw",
    Math.abs(warped.engine.state.surfaceHeight) > 0 &&
      Math.abs(warped.engine.state.surfaceHeight) <= WARP_ONLY.warp.amplitude,
    warped.engine.state.surfaceHeight,
  );
  // **滑らかな反りは針先の追従限界を食わない。** 4Hzの揺れが要求する加速度は
  // 5kHzの信号の10万分の1で、0.3mgの針先には何でもない。反った盤で針が飛ぶのは
  // アームの実効質量が付いていけないからで、それはここではなく接触判定の側
  // （支持面の高さ）から来る。過大に主張しないためにここで押さえておく。
  check(
    "but a smooth warp does not trouble the tip itself — that is the arm's problem",
    warped.losses === 0 && flat.losses === 0,
    { warped: warped.losses, flat: flat.losses },
  );
}

// 接触判定の支持面が動く。**アームが反りに乗って上下する。**
{
  // アームの実測ジオメトリ（§7）。針先はリフトピボットから約0.19m先、1.5mm上。
  const alongArm = 0.19;
  const aboveTip = 0.0015;
  const flatOffset = -0.0015;
  const shape = WARP_ONLY;

  const floorAt = (angle: number) =>
    liftAngleForSurface(
      alongArm,
      aboveTip,
      flatOffset + warpHeightAt(shape, 0.12, angle),
    ) ?? 0;

  let lowest = Infinity;
  let highest = -Infinity;
  for (let i = 0; i < 2000; i++) {
    const angle = (i / 2000) * Math.PI * 2;
    lowest = Math.min(lowest, floorAt(angle));
    highest = Math.max(highest, floorAt(angle));
  }
  const flatFloor = liftAngleForSurface(alongArm, aboveTip, flatOffset) ?? 0;
  check(
    "a warped record raises and lowers the surface the stylus rides on",
    highest > flatFloor && lowest < flatFloor,
    { lowest, flat: flatFloor, highest },
  );
  // 角度の振れ幅は、高さの振れ幅を針先の腕の長さで割っただけ。
  let heightLow = Infinity;
  let heightHigh = -Infinity;
  for (let i = 0; i < 2000; i++) {
    const height = warpHeightAt(shape, 0.12, (i / 2000) * Math.PI * 2);
    heightLow = Math.min(heightLow, height);
    heightHigh = Math.max(heightHigh, height);
  }
  check(
    "by the height of the warp, turned into an angle by the arm's own length",
    Math.abs((highest - lowest) / ((heightHigh - heightLow) / alongArm) - 1) < 0.02,
    {
      angleSpread: highest - lowest,
      heightSpreadMm: (heightHigh - heightLow) * 1000,
    },
  );
  check(
    "a flat record leaves the old fixed contact angle exactly where it was",
    (liftAngleForSurface(alongArm, aboveTip, flatOffset + warpHeightAt(FLAT_DISC, 0.12, 1)) ??
      0) === flatFloor,
  );
}

// でたらめな盤でも壊れない。
{
  const absurd: Array<Partial<DiscShapeParameters>> = [
    { seed: Number.NaN },
    { eccentricity: { offset: Number.NaN } },
    { eccentricity: { offset: -1 } },
    { eccentricity: { offset: 10 } },
    { warp: { dish: 0, amplitude: Number.NaN, harmonics: 2 } },
    { warp: { dish: Number.NaN, amplitude: -1, harmonics: -3 } },
    { warp: { dish: 1e3, amplitude: 1e3, harmonics: 1e6 } },
  ];
  let sane = true;
  let worst: unknown = null;
  for (const over of absurd) {
    const shape = discWith(over);
    for (let i = 0; i < 500; i++) {
      const point = recordPointAt(shape, 0.1, 1, (i / 500) * 20);
      const height = warpHeightAt(shape, point.radius, point.angle);
      if (!Number.isFinite(point.radius) || !Number.isFinite(point.angle) || !Number.isFinite(height)) {
        sane = false;
        worst = over;
        break;
      }
    }
    if (!sane) break;
  }
  check("no disc shape, however absurd, produces a non-finite coordinate", sane, worst);
}

console.log("\ndish and once-per-revolution warp");

// **k=1 は皿ではない。** 皿は角度に依らず、k=1 は半周で符号が反転する。
// 見分けはこの1点だけで付き、混ぜて持つとどちらの性質も検査できなくなる。
{
  const DISH_ONLY = discWith({
    eccentricity: { offset: 0 },
    warp: { dish: 4e-4, amplitude: 0, harmonics: 0 },
  });
  const TILT_ONLY = discWith({
    eccentricity: { offset: 0 },
    warp: { dish: 0, amplitude: 5e-4, harmonics: 1 },
  });

  const radius = 0.12;
  let dishFlat = true;
  let tiltAntisymmetric = true;
  let addsUp = true;
  const both = discWith({
    eccentricity: { offset: 0 },
    warp: { dish: 4e-4, amplitude: 5e-4, harmonics: 1 },
  });
  const first = warpHeightAt(DISH_ONLY, radius, 0);
  for (let i = 0; i < 720; i++) {
    const angle = (i / 720) * Math.PI * 2;
    const dish = warpHeightAt(DISH_ONLY, radius, angle);
    const tilt = warpHeightAt(TILT_ONLY, radius, angle);
    const opposite = warpHeightAt(TILT_ONLY, radius, angle + Math.PI);
    if (dish !== first) dishFlat = false;
    // sin(θ+π) = −sin θ。1次だけならこれが厳密に成り立つ。
    if (Math.abs(tilt + opposite) > 1e-18) tiltAntisymmetric = false;
    if (Math.abs(warpHeightAt(both, radius, angle) - (dish + tilt)) > 1e-18) {
      addsUp = false;
    }
  }

  check("a dish is the same height all the way round", dishFlat && first !== 0, first);
  check(
    "a once-per-revolution warp is the opposite height half a turn later",
    tiltAntisymmetric,
  );
  check("and the two are simply added, never folded together", addsUp);
  check(
    "the dish grows with the square of the radius, like the rest",
    Math.abs(
      warpHeightAt(DISH_ONLY, 2 * radius, 1) / warpHeightAt(DISH_ONLY, radius, 1) - 4,
    ) < 1e-12,
  );
  check(
    "a disc that is only dished is not a flat disc",
    !isFlatDisc(DISH_ONLY) && isFlatDisc(FLAT_DISC),
  );
  check(
    "and a dish alone leaves the record coordinates untouched",
    (() => {
      const point = recordPointAt(DISH_ONLY, 0.1, 1, 3);
      return point.radius === 0.1 && point.wobble === 0;
    })(),
  );
}

console.log("\ntonearm effective mass");

/**
 * **実機を測った値ではない。** 実効質量 10g と `stylusWith` の 15cu で
 * 縦共振は 13Hz。針そのものは質量ゼロ＝バイパスにして、**アームの効果だけ**を
 * 見えるようにしてある。
 */
const TEST_ARM: TonearmVerticalParameters = {
  effectiveMass: 0.01,
  pivotInertia: 0,
  damping: 0.1,
};
/** 針は理想（質量ゼロ）。ばね（compliance）だけがアームへ渡る。 */
const ARM_TEST_STYLUS = stylusWith({ stylusMass: 0 });

{
  const groove = cutTone(12, 1000, 0.4);
  const radius = dropRadius(12, 0.25);
  const WARM = 128 * 375; // 1秒
  const SETTLE = 128 * 563; // 1.5秒。アームの自由振動は ζω₀ = 8/s で消える
  const MEASURE = 128 * 375;

  const render = (arm: TonearmVerticalParameters | null, blockSize = 128) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove);
    engine.setDiscShape(WARP_ONLY);
    engine.setStylus(ARM_TEST_STYLUS);
    if (arm !== null) engine.setTonearm(arm);
    // 針を降ろす前に盤を回し切ってから、降ろして過渡が消えるまで捨てる。
    const off = baseInput({ stylusContact: false, stylusRadius: radius });
    run(engine, off, WARM, blockSize);
    const input = baseInput({ stylusRadius: radius });
    run(engine, input, SETTLE, blockSize);
    return run(engine, input, MEASURE, blockSize);
  };

  /** 反りは逆相に出るので、L−R がそのまま「反りが届いた量」になる。 */
  const antiphaseRms = (played: { left: Float32Array; right: Float32Array }) => {
    let sum = 0;
    for (let i = 0; i < played.left.length; i++) {
      const d = played.left[i] - played.right[i];
      sum += d * d;
    }
    return Math.sqrt(sum / played.left.length);
  };

  const bare = render(null);
  const ideal = render(IDEAL_TONEARM);
  const heavy = render(TEST_ARM);

  const same = (a: typeof bare, b: typeof bare) => {
    for (let i = 0; i < a.left.length; i++) {
      if (a.left[i] !== b.left[i] || a.right[i] !== b.right[i]) return false;
    }
    return true;
  };

  check(
    "the ideal arm changes the deck's output not one bit",
    same(bare, ideal),
  );
  check(
    "an arm with mass does change it, or the rest of this proves nothing",
    !same(bare, heavy),
  );

  const loose = antiphaseRms(bare);
  const held = antiphaseRms(heavy);
  check(
    "and the warp reaching the coils drops by more than an order of magnitude",
    loose > 0 && held < loose / 20,
    { idealArm: loose, withMass: held, ratio: loose / held },
  );
  check("with nothing non-finite on the way", heavy.left.every((v) => Number.isFinite(v)));

  // ブロック長非依存。アームの状態はサンプルを跨いで持ち越されるので、ここが本番。
  const small = render(TEST_ARM, 128);
  const large = render(TEST_ARM, 4096);
  const odd = render(TEST_ARM, 512);
  check(
    "the arm is bit-identical at 128, 512 and 4096 frames a block",
    same(small, large) && same(small, odd),
  );
}

console.log("\ndrive wow / flutter");

/**
 * 試験用のモーター。**実機を測った値ではない** — 経路が生きていることを見える
 * ようにするためだけの大きさで、実機よりかなり大きい。
 */
const TEST_MOTOR: WowFlutterParameters = {
  seed: 20260803,
  wow: { torque: 0.5, hz: 3, components: 3 },
  flutter: { torque: 0.25, hz: 25, components: 3 },
  commutationRipple: { torque: 0.2, cyclesPerRevolution: 24 },
};

{
  const groove = cutTone(12, 1000, 0.4);
  const radius = dropRadius(12, 0.25);
  const SETTLE = 128 * 375; // 1秒
  const MEASURE = 128 * 375;

  const render = (
    motor: WowFlutterParameters | null,
    blockSize = 128,
    frames = MEASURE,
  ) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove);
    if (motor !== null) engine.setWowFlutter(motor);
    const input = baseInput({ stylusRadius: radius });
    run(engine, input, SETTLE, blockSize);
    return { engine, played: run(engine, input, frames, blockSize) };
  };

  const same = (
    a: { left: Float32Array; right: Float32Array },
    b: { left: Float32Array; right: Float32Array },
  ) => {
    for (let i = 0; i < a.left.length; i++) {
      if (a.left[i] !== b.left[i] || a.right[i] !== b.right[i]) return false;
    }
    return true;
  };

  const bare = render(null);
  const ideal = render(IDEAL_WOW_FLUTTER);
  const wobbling = render(TEST_MOTOR);

  check(
    "an ideal motor changes the deck's output not one bit",
    same(bare.played, ideal.played) &&
      bare.engine.state.phiUnwrapped === ideal.engine.state.phiUnwrapped,
  );
  check(
    "and reports no disturbance at all",
    ideal.engine.state.driveWowTorque === 0 &&
      ideal.engine.state.driveFlutterTorque === 0 &&
      ideal.engine.state.driveCommutationRippleTorque === 0 &&
      ideal.engine.state.driveSpeedRatio === 0,
  );
  check(
    "a wobbling motor does change it, or the rest of this proves nothing",
    !same(bare.played, wobbling.played),
  );
  check(
    "and the change arrives as rotation, not as a playback rate bolted on",
    bare.engine.state.phiUnwrapped !== wobbling.engine.state.phiUnwrapped &&
      wobbling.played.left.every((v) => Number.isFinite(v)),
  );

  // ブロック長非依存。外乱は (時刻, 角度) の純関数なので構造的に通るはずだが、
  // 時計をチャンクごとに進めている以上、ここが本番。
  const small = render(TEST_MOTOR, 128);
  const large = render(TEST_MOTOR, 4096);
  const odd = render(TEST_MOTOR, 512);
  check(
    "the disturbance is bit-identical at 128, 512 and 4096 frames a block",
    same(small.played, large.played) && same(small.played, odd.played),
  );
  check(
    "and so is the rotation it produced",
    small.engine.state.phiUnwrapped === large.engine.state.phiUnwrapped &&
      small.engine.state.phiUnwrapped === odd.engine.state.phiUnwrapped,
  );

  // 同じ seed なら同じ盤の回り方。違う seed なら違うモーター。
  const twin = render(TEST_MOTOR);
  const other = render({ ...TEST_MOTOR, seed: TEST_MOTOR.seed + 1 });
  check(
    "the same seed gives the same motor",
    same(wobbling.played, twin.played),
  );
  check(
    "and a different seed gives a different one",
    !same(wobbling.played, other.played),
  );

  // テレメトリ。**成分は分かれたまま出る。**
  const telemetry = wobbling.engine.state;
  check(
    "the three components are reported separately, and all are live",
    telemetry.driveWowTorque !== 0 &&
      telemetry.driveFlutterTorque !== 0 &&
      telemetry.driveCommutationRippleTorque !== 0 &&
      Number.isFinite(telemetry.driveWowTorque),
  );
  check(
    "and the speed deviation they actually caused is reported too",
    telemetry.driveSpeedRatio > 0 && telemetry.driveSpeedRatio < 0.1,
    telemetry.driveSpeedRatio,
  );
}

// 平均RPMと長期の位相をドリフトさせないこと。**20秒回して直接見る。**
{
  const groove = cutTone(12, 1000, 0.4);
  const radius = dropRadius(12, 0.25);
  const input = baseInput({ stylusRadius: radius });

  const spin = (motor: WowFlutterParameters | null) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove);
    if (motor !== null) engine.setWowFlutter(motor);
    run(engine, input, SAMPLE_RATE * 5, 4096); // 起動の過渡を捨てる
    const marks: number[] = [];
    for (let i = 0; i < 3; i++) {
      run(engine, input, SAMPLE_RATE * 5, 4096);
      marks.push(engine.state.phiUnwrapped);
    }
    return { engine, marks };
  };

  const quiet = spin(null);
  const wobbling = spin(TEST_MOTOR);

  // 5秒ごとに回った角度。揺れていても、1周期を跨げば同じだけ回る。
  const turnsPerWindow = (marks: number[]) => [
    marks[1] - marks[0],
    marks[2] - marks[1],
  ];
  const quietTurns = turnsPerWindow(quiet.marks);
  const wobbleTurns = turnsPerWindow(wobbling.marks);
  const expected = rpmToRadPerSec(NOMINAL_RPM) * 5;

  check(
    "a wobbling deck turns through the same angle per window as a quiet one",
    Math.abs(wobbleTurns[0] - expected) / expected < 1e-4 &&
      Math.abs(wobbleTurns[1] - expected) / expected < 1e-4,
    { quiet: quietTurns, wobbling: wobbleTurns },
  );
  check(
    "so the phase error against an ideal motor stays put instead of growing",
    Math.abs(wobbleTurns[1] - wobbleTurns[0]) < 5e-3,
    wobbleTurns[1] - wobbleTurns[0],
  );

  // その一方で、瞬間の速度は本当に動いている。
  check(
    "while the deck really is wobbling, or this measured nothing",
    Math.abs(wobbling.engine.state.driveSpeedRatio) > 1e-4,
    wobbling.engine.state.driveSpeedRatio,
  );
}

// STOP・逆転・手回しが同じ経路を通ること。
{
  const groove = cutTone(12, 1000, 0.4);
  const radius = dropRadius(12, 0.25);
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(groove);
  engine.setWowFlutter(TEST_MOTOR);
  run(engine, baseInput({ stylusRadius: radius }), SAMPLE_RATE * 3, 4096);

  // 手で逆へ回す。外乱はモーターのトルクに足されるだけなので、逆転は普通に出る。
  const reversed = run(
    engine,
    baseInput({ stylusRadius: radius, handAngularVelocity: -4 }),
    SAMPLE_RATE,
    128,
  );
  check(
    "a hand can still turn a wobbling deck backwards",
    engine.state.omega < 0 && reversed.left.some((v) => v !== 0),
    engine.state.omega,
  );

  // STOP。**止まりきったら厳密に0で、厳密な無音。**
  const stopped = run(
    engine,
    baseInput({ stylusRadius: radius, motorRequested: false }),
    SAMPLE_RATE * 4,
    128,
  );
  check(
    "and a stopped one still reaches an exact standstill",
    engine.state.motor.angularVelocity === 0 && engine.state.omega === 0,
    engine.state.motor.angularVelocity,
  );
  check(
    "with exact silence at the end of it",
    stopped.left[stopped.left.length - 1] === 0 &&
      stopped.right[stopped.right.length - 1] === 0,
  );
}

// 盤を載せ替えてもモーターは止まらない。**別のレコードを載せても同じ個体である。**
{
  const first = cutTone(8, 1000, 0.4);
  const second = cutTone(8, 700, 0.4);
  const radius = dropRadius(8, 0.25);
  const input = baseInput({ stylusRadius: radius });

  const straight = createDeckEngine({ sampleRate: SAMPLE_RATE });
  straight.loadGroove(first);
  straight.setWowFlutter(TEST_MOTOR);
  run(straight, input, SAMPLE_RATE * 2, 4096);

  const swapped = createDeckEngine({ sampleRate: SAMPLE_RATE });
  swapped.loadGroove(first);
  swapped.setWowFlutter(TEST_MOTOR);
  run(swapped, input, SAMPLE_RATE, 4096);
  swapped.loadGroove(second);
  run(swapped, input, SAMPLE_RATE, 4096);

  check(
    "swapping the record does not rewind the motor's own clock",
    straight.state.driveWowTorque === swapped.state.driveWowTorque &&
      straight.state.driveFlutterTorque === swapped.state.driveFlutterTorque,
    {
      straight: straight.state.driveWowTorque,
      swapped: swapped.state.driveWowTorque,
    },
  );
}

console.log("\nrumble and structure-borne vibration");

/**
 * 試験用のデッキ。**実機を測った値ではない** — 経路が生きていることを見える
 * ようにするためだけの大きさで、実機よりかなり大きい。
 */
const TEST_RUMBLE: RumbleParameters = {
  seed: 20260803,
  bearing: { amplitude: 4e-7, harmonics: 12 },
  motor: { amplitude: 2e-7, hz: 30, components: 3 },
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

// モデル単体。**相対変位であることと、剛体なら厳密に打ち消えること。**
{
  const rumble = createRumble(SAMPLE_RATE, IDEAL_RUMBLE);
  check("an ideal deck is bypassed", rumble.bypassed);
  let silent = true;
  for (let i = 0; i < 2000; i++) {
    rumble.sample(i / SAMPLE_RATE, i * 0.01, 3.49, true);
    if (rumble.lateral !== 0 || rumble.vertical !== 0) silent = false;
  }
  check("and never moves the stylus at all", silent);

  // **同じ経路を両側に入れれば、相対変位は厳密に 0。** デッキ全体が剛体として
  // 揺れても針は何も読まない — これが「出力へノイズを足す」構造との違いである。
  const rigid = createRumble(SAMPLE_RATE, {
    ...TEST_RUMBLE,
    tonearmPath: { ...TEST_RUMBLE.platterPath },
  });
  let cancelled = true;
  let moved = false;
  for (let i = 0; i < 20000; i++) {
    rigid.sample(i / SAMPLE_RATE, i * 0.0021, 3.49, true);
    if (rigid.lateral !== 0 || rigid.vertical !== 0) cancelled = false;
    if (rigid.platterLateral !== 0) moved = true;
  }
  check(
    "a deck that shakes as one rigid body produces exactly nothing",
    cancelled,
  );
  check(
    "even though both paths really were moving",
    moved,
  );

  // 経路が違えば残る。
  const real = createRumble(SAMPLE_RATE, TEST_RUMBLE);
  let heard = false;
  for (let i = 0; i < 20000; i++) {
    real.sample(i / SAMPLE_RATE, i * 0.0021, 3.49, true);
    if (real.lateral !== 0 || real.vertical !== 0) heard = true;
  }
  check("two different paths do leave a relative displacement", heard);
}

// 2つの源が別々に効くこと。
{
  const spin = 3.49;
  const bearingOnly = createRumble(SAMPLE_RATE, {
    ...TEST_RUMBLE,
    motor: { ...TEST_RUMBLE.motor, amplitude: 0 },
  });
  const motorOnly = createRumble(SAMPLE_RATE, {
    ...TEST_RUMBLE,
    bearing: { ...TEST_RUMBLE.bearing, amplitude: 0 },
  });

  // **軸受けは手回しでも出る。** 駆動しているかどうかを見ていない。
  let byHand = 0;
  for (let i = 0; i < 20000; i++) {
    bearingOnly.sample(i / SAMPLE_RATE, i * 0.0021, spin, false);
    byHand = Math.max(byHand, Math.abs(bearingOnly.lateral));
  }
  check("bearing rumble is there while a hand turns a stopped deck", byHand > 0);

  // **止まれば厳密に 0。** 止まった軸受けは鳴らない。
  bearingOnly.reset();
  let stopped = true;
  for (let i = 0; i < 20000; i++) {
    bearingOnly.sample(i / SAMPLE_RATE, 1.2345, 0, false);
    if (bearingOnly.lateral !== 0 || bearingOnly.vertical !== 0) stopped = false;
  }
  check("and exactly zero once the platter stops", stopped);

  // **振幅は速さに比例する。** 同じ角度の並びを違う ω で通して、源の項だけを見る
  // （経路は線形なので、励振がちょうど半分なら出力もちょうど半分になる）。
  //
  // 実際に盤を速く回すとこの比では増えない。速く回せば同じ次数がより高い周波数に
  // なり、防振材に削られるためで、**それも正しい**（実機のランブルが速度で単純に
  // 比例しないのと同じ理由）。ここで測っているのは源の項だけである。
  const traceAt = (omega: number) => {
    bearingOnly.reset();
    const out: number[] = [];
    for (let i = 0; i < 20000; i++) {
      bearingOnly.sample(i / SAMPLE_RATE, i * 7e-4, omega, false);
      out.push(bearingOnly.lateral);
    }
    return out;
  };
  const full = traceAt(3.49);
  const half = traceAt(3.49 / 2);
  let scales = true;
  let biggest = 0;
  for (let i = 0; i < full.length; i++) {
    biggest = Math.max(biggest, Math.abs(full[i]));
    if (Math.abs(full[i] - 2 * half[i]) > 1e-18) scales = false;
  }
  check(
    "and its amplitude is proportional to how fast the platter turns",
    scales && biggest > 0,
    { peak: biggest },
  );

  // **モーター振動は駆動中だけ。** 転流リプルとは別のパラメータである。
  let driven = 0;
  let idle = true;
  for (let i = 0; i < 20000; i++) {
    motorOnly.sample(i / SAMPLE_RATE, i * 0.0021, spin, true);
    driven = Math.max(driven, Math.abs(motorOnly.lateral));
  }
  motorOnly.reset();
  for (let i = 0; i < 20000; i++) {
    motorOnly.sample(i / SAMPLE_RATE, i * 0.0021, spin, false);
    if (motorOnly.lateral !== 0 || motorOnly.vertical !== 0) idle = false;
  }
  check("motor vibration is there while the motor drives", driven > 0);
  check("and exactly zero when it does not, however fast the platter turns", idle);
}

// 停止したら厳密な無音へ落ちること。**構造の残響も切る。**
{
  const rumble = createRumble(SAMPLE_RATE, TEST_RUMBLE);
  for (let i = 0; i < 20000; i++) {
    rumble.sample(i / SAMPLE_RATE, i * 0.0021, 3.49, true);
  }
  // 盤も止め、モーターも切る。励振はここで 0 になる。
  let settledAt = -1;
  for (let i = 0; i < SAMPLE_RATE; i++) {
    rumble.sample((20000 + i) / SAMPLE_RATE, 1.2345, 0, false);
    if (rumble.lateral === 0 && rumble.vertical === 0) {
      settledAt = i;
      break;
    }
  }
  check(
    "the structure rings down to an exact zero rather than a small number",
    settledAt >= 0 && settledAt < SAMPLE_RATE,
    { samples: settledAt },
  );
  let stays = true;
  for (let i = 0; i < 20000; i++) {
    rumble.sample(i / SAMPLE_RATE, 1.2345, 0, false);
    if (rumble.lateral !== 0 || rumble.vertical !== 0) stays = false;
  }
  check("and stays there", stays);
}

// 決定論と、正逆対称。
{
  const a = createRumble(SAMPLE_RATE, TEST_RUMBLE);
  const b = createRumble(SAMPLE_RATE, TEST_RUMBLE);
  const other = createRumble(SAMPLE_RATE, {
    ...TEST_RUMBLE,
    seed: TEST_RUMBLE.seed + 1,
  });
  let same = true;
  let differs = false;
  for (let i = 0; i < 20000; i++) {
    a.sample(i / SAMPLE_RATE, i * 0.0021, 3.49, true);
    b.sample(i / SAMPLE_RATE, i * 0.0021, 3.49, true);
    other.sample(i / SAMPLE_RATE, i * 0.0021, 3.49, true);
    if (a.lateral !== b.lateral || a.vertical !== b.vertical) same = false;
    if (a.lateral !== other.lateral) differs = true;
  }
  check("the same seed gives the same deck, every time", same);
  check("and a different seed gives a different one", differs);

  // **軸受けは回転角に固定されている。** 逆に回せば同じ励振を逆順に辿る。
  const forward = createRumble(SAMPLE_RATE, {
    ...TEST_RUMBLE,
    motor: { ...TEST_RUMBLE.motor, amplitude: 0 },
  });
  const backward = createRumble(SAMPLE_RATE, {
    ...TEST_RUMBLE,
    motor: { ...TEST_RUMBLE.motor, amplitude: 0 },
  });
  let mirrored = true;
  for (let i = 0; i < 5000; i++) {
    forward.sample(i / SAMPLE_RATE, i * 0.0021, 3.49, false);
    // 同じ角度を負の ω で通る。振幅は速さだけで決まるので、大きさは変わらない。
    backward.sample(i / SAMPLE_RATE, i * 0.0021, -3.49, false);
    if (forward.lateral !== backward.lateral) mirrored = false;
  }
  check(
    "and turning backwards at the same speed reads the same bearing",
    mirrored,
  );
}

// エンジンに載せる。理想はビット単位で素通し、実設定は音になり、ブロック長に依らない。
{
  const groove = cutTone(12, 1000, 0.4);
  const radius = dropRadius(12, 0.25);
  const SETTLE = 128 * 375;
  const MEASURE = 128 * 375;

  const render = (parameters: RumbleParameters | null, blockSize = 128) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove);
    if (parameters !== null) engine.setRumble(parameters);
    const input = baseInput({ stylusRadius: radius });
    run(engine, input, SETTLE, blockSize);
    return { engine, played: run(engine, input, MEASURE, blockSize) };
  };

  const same = (
    a: { left: Float32Array; right: Float32Array },
    b: { left: Float32Array; right: Float32Array },
  ) => {
    for (let i = 0; i < a.left.length; i++) {
      if (a.left[i] !== b.left[i] || a.right[i] !== b.right[i]) return false;
    }
    return true;
  };

  const bare = render(null);
  const ideal = render(IDEAL_RUMBLE);
  const shaking = render(TEST_RUMBLE);

  check(
    "an ideal deck changes the output not one bit",
    same(bare.played, ideal.played),
  );
  check(
    "a shaking one does change it, or the rest of this proves nothing",
    !same(bare.played, shaking.played) &&
      shaking.played.left.every((v) => Number.isFinite(v)),
  );

  // **横方向と垂直方向が分かれて壁へ入っていること。** 垂直は逆相に出るので、
  // L−R に現れる。剛体のデッキならどちらも厳密に 0 のまま。
  const antiphase = (played: { left: Float32Array; right: Float32Array }) => {
    let sum = 0;
    for (let i = 0; i < played.left.length; i++) {
      const d = played.left[i] - played.right[i];
      sum += d * d;
    }
    return Math.sqrt(sum / played.left.length);
  };
  const rigid = render({
    ...TEST_RUMBLE,
    tonearmPath: { ...TEST_RUMBLE.platterPath },
  });
  check(
    "the vertical component reaches the walls out of phase",
    antiphase(shaking.played) > antiphase(bare.played),
    { shaking: antiphase(shaking.played), quiet: antiphase(bare.played) },
  );
  check(
    "and a rigid deck is bit-identical to no rumble at all",
    same(bare.played, rigid.played),
  );

  // ブロック長非依存。構造は状態を持つので、ここが本番。
  const small = render(TEST_RUMBLE, 128);
  const large = render(TEST_RUMBLE, 4096);
  const odd = render(TEST_RUMBLE, 512);
  check(
    "rumble is bit-identical at 128, 512 and 4096 frames a block",
    same(small.played, large.played) && same(small.played, odd.played),
  );
}

// START/STOP・逆転・手回しが同じ経路を通ること。
{
  const groove = cutTone(12, 1000, 0.4);
  const radius = dropRadius(12, 0.25);
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(groove);
  engine.setRumble(TEST_RUMBLE);
  run(engine, baseInput({ stylusRadius: radius }), SAMPLE_RATE * 2, 4096);

  const reversed = run(
    engine,
    baseInput({ stylusRadius: radius, handAngularVelocity: -4 }),
    SAMPLE_RATE,
    128,
  );
  check(
    "a shaking deck still plays backwards under the hand",
    engine.state.omega < 0 && reversed.left.some((v) => v !== 0),
    engine.state.omega,
  );

  const stopped = run(
    engine,
    baseInput({ stylusRadius: radius, motorRequested: false }),
    SAMPLE_RATE * 4,
    128,
  );
  check(
    "and a stopped one is exactly silent, rumble and all",
    engine.state.motor.angularVelocity === 0 &&
      stopped.left[stopped.left.length - 1] === 0 &&
      stopped.right[stopped.right.length - 1] === 0,
  );
}

// でたらめな設定でも壊れない。
{
  const absurd: RumbleParameters[] = [
    {
      seed: Number.NaN,
      bearing: { amplitude: Number.NaN, harmonics: Number.NaN },
      motor: { amplitude: -1, hz: -5, components: 0 },
      platterPath: { gain: Number.NaN, resonanceHz: Number.NaN, resonanceQ: 0, isolationHz: -1, isolationQ: -3 },
      tonearmPath: { gain: 1e9, resonanceHz: 1e9, resonanceQ: 1e9, isolationHz: 1e9, isolationQ: 1e9 },
    },
    {
      seed: 7,
      bearing: { amplitude: 1e9, harmonics: 1e9 },
      motor: { amplitude: 1e9, hz: 1e9, components: 1e9 },
      platterPath: { gain: 1e6, resonanceHz: 0, resonanceQ: 1e-9, isolationHz: 0, isolationQ: 0 },
      tonearmPath: { gain: -1e6, resonanceHz: 0, resonanceQ: 1e-9, isolationHz: 0, isolationQ: 0 },
    },
  ];
  let sane = true;
  let worst: unknown = null;
  for (const parameters of absurd) {
    const rumble = createRumble(SAMPLE_RATE, parameters);
    for (let i = 0; i < 40000; i++) {
      rumble.sample(i / SAMPLE_RATE, i * 0.0021, 3.49, true);
      if (!Number.isFinite(rumble.lateral) || !Number.isFinite(rumble.vertical)) {
        sane = false;
        worst = parameters;
        break;
      }
    }
    if (!sane) break;
  }
  check("no deck setting, however absurd, produces a non-finite value", sane, worst);
}

console.log("\nsilence is stillness, not omega");

/**
 * 無音の条件が「ω = 0」から「相対運動も構造励振も無い」へ変わったこと。
 *
 * **盤が止まっていることと、何も動いていないことは別である。** START のまま盤を
 * 手で押さえれば、盤は止まっていても筐体は揺れ続け、針はそれを読む。
 */
{
  const groove = cutTone(12, 1000, 0.4);
  const radius = dropRadius(12, 0.25);
  /** 軸受けを切り、モーター振動だけ残したデッキ。ω に依らない源だけになる。 */
  const MOTOR_ONLY: RumbleParameters = {
    ...TEST_RUMBLE,
    bearing: { ...TEST_RUMBLE.bearing, amplitude: 0 },
  };
  /** 逆に、回転に紐づく源だけ。 */
  const BEARING_ONLY: RumbleParameters = {
    ...TEST_RUMBLE,
    motor: { ...TEST_RUMBLE.motor, amplitude: 0 },
  };

  // まずモデルの契約。**ここが「ω では決められない」の核心。**
  {
    const motor = createRumble(SAMPLE_RATE, MOTOR_ONLY);
    check(
      "a motor that is driving excites the structure even at a standstill",
      motor.active(0, true),
    );
    check(
      "and stops exciting it the moment the motor is switched off",
      !motor.active(0, false),
    );

    const bearing = createRumble(SAMPLE_RATE, BEARING_ONLY);
    check(
      "a bearing excites nothing at a standstill, driving or not",
      !bearing.active(0, true) && !bearing.active(0, false),
    );
    check(
      "but does as soon as the platter turns, by hand or by motor",
      bearing.active(3.49, false) && bearing.active(-3.49, false),
    );
    check(
      "and a deck that does not shake never claims to",
      !createRumble(SAMPLE_RATE, IDEAL_RUMBLE).active(3.49, true),
    );
  }

  /**
   * **START のまま盤を手で押さえる。**
   *
   * ここで ω はきっかり 0 にはならない — 手とモーターが綱引きして約 ⅓ RPM の
   * クリープが残るのが、このデッキの決めた挙動である（スリップマット相当）。
   * 「ω = 0 ちょうど」で構造だけが鳴っている状態は、STOP 後の残響で作る（下）。
   */
  const held = (parameters: RumbleParameters | null) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove);
    if (parameters !== null) engine.setRumble(parameters);
    run(engine, baseInput({ stylusRadius: radius }), SAMPLE_RATE * 2, 4096);
    const played = run(
      engine,
      baseInput({
        stylusRadius: radius,
        handAngularVelocity: 0,
      }),
      SAMPLE_RATE,
      128,
    );
    return { engine, played };
  };

  const shaking = held(MOTOR_ONLY);
  check(
    "a hand on a started deck leaves only the slipmat creep",
    Math.abs(radPerSecToRpm(shaking.engine.state.omega)) < 0.5,
    radPerSecToRpm(shaking.engine.state.omega),
  );
  check(
    "and motor vibration reaches the stylus through the structure",
    shaking.played.left.some((v) => v !== 0),
  );

  /**
   * **ω がきっかり 0 で、それでも構造が鳴っている状態。**
   *
   * STOP して盤が止まりきった直後がそれである。軸受けはもう励振しないが、筐体には
   * まだエネルギーが残っている。旧来の「ω = 0 なら全出力 0」ではここが切られていた。
   */
  const ringing = createDeckEngine({ sampleRate: SAMPLE_RATE });
  ringing.loadGroove(groove);
  ringing.setRumble(TEST_RUMBLE);
  run(ringing, baseInput({ stylusRadius: radius }), SAMPLE_RATE * 2, 4096);
  const braking = baseInput({ stylusRadius: radius, motorRequested: false });
  // 止まりきるまで 128 フレームずつ進める。止まった**次の**チャンクで Δφ も 0 に
  // なるので、そこまで進めてから測る。
  for (let i = 0; i < 1000; i++) {
    run(ringing, braking, 128, 128);
    if (ringing.state.motor.angularVelocity === 0 && ringing.state.omega === 0) {
      break;
    }
  }
  check(
    "the platter reaches an exact standstill after STOP",
    ringing.state.motor.angularVelocity === 0 && ringing.state.omega === 0,
    ringing.state.motor.angularVelocity,
  );
  const cursorBefore = ringing.state.programCursor;
  const decaying = run(ringing, braking, 1024, 128);
  check(
    "the structure is still ringing, so the output is not gated to zero",
    decaying.left.some((v) => v !== 0),
  );
  check(
    "while the groove cursor stays frozen where it was",
    ringing.state.programCursor === cursorBefore,
    { before: cursorBefore, after: ringing.state.programCursor },
  );

  // 源が回転に紐づいていれば、止まった時点で自然に消える。**軸受けだけのデッキは
  // モーターが回っていても ω = 0 で何も出さない** — ゲートではなく源が 0 になる。
  const bearing = held(BEARING_ONLY);
  const stopping2 = baseInput({ stylusRadius: radius, motorRequested: false });
  run(bearing.engine, stopping2, SAMPLE_RATE * 4, 4096); // 止まりきるまで待つ
  const bearingStopped = run(bearing.engine, stopping2, SAMPLE_RATE, 128);
  check(
    "bearing rumble goes quiet on its own once the platter stops",
    bearing.engine.state.omega === 0 &&
      bearingStopped.left.every((v) => v === 0) &&
      bearingStopped.right.every((v) => v === 0),
  );

  // **針を上げれば、何が揺れていようと厳密な無音。** ここは変えていない。
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  engine.loadGroove(groove);
  engine.setRumble(TEST_RUMBLE);
  run(engine, baseInput({ stylusRadius: radius }), SAMPLE_RATE, 4096);
  const lifted = run(
    engine,
    baseInput({ stylusRadius: radius, stylusContact: false }),
    SAMPLE_RATE,
    128,
  );
  check(
    "lifting the stylus is exactly silent, whatever the deck is doing",
    lifted.left.every((v) => v === 0) && lifted.right.every((v) => v === 0),
  );

  // **STOP後は新しい励振が無く、構造の残響が収まれば厳密な0へ落ちる。**
  const stopping = createDeckEngine({ sampleRate: SAMPLE_RATE });
  stopping.loadGroove(groove);
  stopping.setRumble(TEST_RUMBLE);
  run(stopping, baseInput({ stylusRadius: radius }), SAMPLE_RATE * 2, 4096);
  const settling = baseInput({ stylusRadius: radius, motorRequested: false });
  run(stopping, settling, SAMPLE_RATE * 6, 128);
  check(
    "after STOP the platter reaches a true standstill",
    stopping.state.motor.angularVelocity === 0,
  );
  const afterStop = run(stopping, settling, SAMPLE_RATE, 128);
  check(
    "and once the structure has rung down the output is exactly zero",
    afterStop.left.every((v) => v === 0) &&
      afterStop.right.every((v) => v === 0),
  );
  const stillLater = run(stopping, settling, SAMPLE_RATE, 4096);
  check(
    "and stays exactly zero",
    stillLater.left.every((v) => v === 0) &&
      stillLater.right.every((v) => v === 0),
  );
}

console.log("\nthe silent fast-path waits for everything to settle");

/**
 * 「新しい励振が無い」だけで切ると、まだ動いているものが途中で消える。
 * ここで確かめるのは、**止まった後も尾が最後まで鳴り、そのうえで厳密な 0 へ
 * 収束する**こと。
 */
{
  const groove = cutTone(12, 1000, 0.4);
  const radius = dropRadius(12, 0.25);
  const braking = baseInput({ stylusRadius: radius, motorRequested: false });

  /** 再生してから制動し、**ω が厳密に 0 になった後**の出力だけを返す。 */
  const tailAfterStandstill = (
    setup: (engine: ReturnType<typeof createDeckEngine>) => void,
    chunks = 4000,
  ) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove);
    setup(engine);
    run(engine, baseInput({ stylusRadius: radius }), SAMPLE_RATE * 2, 4096);

    // 止まりきるまで 128 フレームずつ。Δφ も 0 になったところで止める。
    let stoppedAfter = -1;
    for (let i = 0; i < 2000; i++) {
      run(engine, braking, 128, 128);
      if (engine.state.motor.angularVelocity === 0 && engine.state.omega === 0) {
        stoppedAfter = i;
        break;
      }
    }

    // ここから先は盤が動いていない。出るものはすべて「残っていたもの」。
    const tail: number[] = [];
    let lastSounding = -1;
    for (let i = 0; i < chunks; i++) {
      const block = run(engine, braking, 128, 128);
      for (let k = 0; k < block.left.length; k++) {
        tail.push(block.left[k]);
        if (block.left[k] !== 0 || block.right[k] !== 0) {
          lastSounding = i * 128 + k;
        }
      }
    }
    return { engine, stoppedAfter, tail, lastSounding };
  };

  // **フィルタの尾。** 理想のデッキでも RIAA には状態が残っている。
  const plain = tailAfterStandstill(() => {});
  check(
    "the platter really did reach an exact standstill first",
    plain.stoppedAfter >= 0,
    plain.stoppedAfter,
  );
  check(
    "the equaliser's tail survives the platter stopping",
    plain.lastSounding > 0,
    { lastSoundingSample: plain.lastSounding },
  );
  check(
    "and it decays to a bit-exact zero rather than a small number",
    plain.lastSounding < plain.tail.length - 128,
    {
      lastSoundingSample: plain.lastSounding,
      of: plain.tail.length,
      seconds: plain.lastSounding / SAMPLE_RATE,
    },
  );
  check(
    "which then stays exactly zero",
    plain.tail.slice(plain.lastSounding + 1).every((v) => v === 0),
  );

  // **反りを追っているアームは、盤が止まっても整定しきるまで動き続ける。**
  // ここを「Δφ = 0 だから」で切ると、13Hz の整定が途中で消える。
  const warped = tailAfterStandstill((engine) => {
    engine.setDiscShape(WARP_ONLY);
    engine.setStylus(ARM_TEST_STYLUS);
    engine.setTonearm(TEST_ARM);
  });
  check(
    "an arm still settling on a warped record keeps sounding at a standstill",
    warped.lastSounding > plain.lastSounding,
    {
      withArm: warped.lastSounding,
      idealArm: plain.lastSounding,
      seconds: warped.lastSounding / SAMPLE_RATE,
    },
  );
  check(
    "and it too converges to a bit-exact zero",
    warped.lastSounding < warped.tail.length - 128 &&
      warped.tail.slice(warped.lastSounding + 1).every((v) => v === 0),
  );

  // **構造の共振も同じ。** 励振が止まっても筐体は鳴り続ける。
  const shaken = tailAfterStandstill((engine) => {
    engine.setRumble(TEST_RUMBLE);
  });
  check(
    "structural resonance is not cut off when the excitation stops",
    shaken.lastSounding > plain.lastSounding,
    { withRumble: shaken.lastSounding, quiet: plain.lastSounding },
  );
  check(
    "and it converges to a bit-exact zero as well",
    shaken.lastSounding < shaken.tail.length - 128 &&
      shaken.tail.slice(shaken.lastSounding + 1).every((v) => v === 0),
  );

  // **ブロック長非依存。** fast-path の入口はチャンク単位で決まるので、呼び出し側の
  // ブロック長が変わっても同じところで同じ判断をしなければならない。
  const decay = (blockSize: number) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove);
    engine.setDiscShape(WARP_ONLY);
    engine.setStylus(ARM_TEST_STYLUS);
    engine.setTonearm(TEST_ARM);
    engine.setRumble(TEST_RUMBLE);
    run(engine, baseInput({ stylusRadius: radius }), 128 * 750, blockSize);
    return run(engine, braking, 128 * 2500, blockSize);
  };
  const at128 = decay(128);
  const at512 = decay(512);
  const at4096 = decay(4096);
  const identical = (
    a: { left: Float32Array; right: Float32Array },
    b: { left: Float32Array; right: Float32Array },
  ) => {
    for (let i = 0; i < a.left.length; i++) {
      if (a.left[i] !== b.left[i] || a.right[i] !== b.right[i]) return false;
    }
    return true;
  };
  check(
    "the whole stop-and-decay is bit-identical at 128, 512 and 4096",
    identical(at128, at512) && identical(at128, at4096),
  );
  check(
    "and it really did fall silent inside that window, or this proves nothing",
    at128.left[at128.left.length - 1] === 0 &&
      at128.left.some((v) => v !== 0),
  );
}

console.log("\nmains hum and induced noise");

/**
 * 試験用の混入。**実機を測った値ではない** — 経路が生きていることを見えるように
 * するためだけの大きさで、実機よりかなり大きい。
 */
const humWith = (over: Partial<HumParameters> = {}): HumParameters => ({
  ...IDEAL_HUM,
  seed: 20260803,
  mainsHz: 50,
  ...over,
});
const CARTRIDGE_HUM = humWith({
  cartridgeInduction: {
    ...IDEAL_HUM.cartridgeInduction,
    fundamental: 2e-3,
    positionSensitivity: 0.5,
    platterSensitivity: 0.5,
    coilAngleRadians: Math.PI / 4,
  },
});
const ELECTRONICS_HUM = humWith({
  electronics: { fundamental: 2e-3, rectifier: 0, harmonics: 0, harmonicCount: 3 },
});

{
  const groove = cutTone(12, 1000, 0.4);
  const radius = dropRadius(12, 0.25);
  const SETTLE = 128 * 375;
  const MEASURE = 128 * 375;

  const render = (
    parameters: HumParameters | null,
    over: Partial<DeckEngineInput> = {},
    blockSize = 128,
  ) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    // ハムの注入量もライン基準の話。**録音レベルの取り決めは外して測る。**
    engine.setLevels(LINE_LEVELS);
    engine.loadGroove(groove);
    if (parameters !== null) engine.setHum(parameters);
    const input = baseInput({ stylusRadius: radius, ...over });
    run(engine, input, SETTLE, blockSize);
    return { engine, played: run(engine, input, MEASURE, blockSize) };
  };

  const same = (
    a: { left: Float32Array; right: Float32Array },
    b: { left: Float32Array; right: Float32Array },
  ) => {
    for (let i = 0; i < a.left.length; i++) {
      if (a.left[i] !== b.left[i] || a.right[i] !== b.right[i]) return false;
    }
    return true;
  };

  const bare = render(null);
  const ideal = render(IDEAL_HUM);
  check(
    "a deck with no hum changes the output not one bit",
    same(bare.played, ideal.played),
  );

  // **注入点が違うので、同じ振幅でも大きさが違う。** RIAA が低域を持ち上げるため。
  const quiet = baseInput({ stylusRadius: radius, stylusContact: false });
  const coilOnly = render(CARTRIDGE_HUM, { stylusContact: false });
  const stageOnly = render(ELECTRONICS_HUM, { stylusContact: false });
  const coilLevel = rms(coilOnly.played.left);
  const stageLevel = rms(stageOnly.played.left);
  check(
    "cartridge hum goes through the RIAA curve, so it comes out far louder",
    coilLevel > stageLevel * 4,
    { cartridge: coilLevel, electronics: stageLevel, ratio: coilLevel / stageLevel },
  );
  check(
    "and the electronics side comes out at the level it was given",
    Math.abs(stageLevel / (2e-3 / Math.SQRT2) - 1) < 0.05,
    stageLevel,
  );

  // **針を上げても電気ハムは残る。** ここが機械振動との決定的な違い。
  check(
    "hum is still there with the stylus off the record",
    coilOnly.played.left.some((v) => v !== 0) &&
      stageOnly.played.left.some((v) => v !== 0),
    { quiet: quiet.stylusContact },
  );
  check(
    "while a deck with no hum is exactly silent in the same state",
    render(null, { stylusContact: false }).played.left.every((v) => v === 0),
  );

  // 電源周波数は設定項目。**既定を焼き込んでいない。**
  const at = (mainsHz: 50 | 60) =>
    dominantHz(
      render(humWith({ mainsHz, electronics: ELECTRONICS_HUM.electronics }), {
        stylusContact: false,
      }).played.left,
    );
  check(
    "the mains frequency is what comes out, 50 or 60 as chosen",
    Math.abs(at(50) - 50) < 1 && Math.abs(at(60) - 60) < 1,
    { fifty: at(50), sixty: at(60) },
  );

  // 整流成分は基音とは別のパラメータ。**基音を切っても残る。**
  const rectifierOnly = render(
    humWith({
      electronics: { fundamental: 0, rectifier: 2e-3, harmonics: 0, harmonicCount: 0 },
    }),
    { stylusContact: false },
  );
  check(
    "the rectifier component is separate, and lands on twice the mains",
    Math.abs(dominantHz(rectifierOnly.played.left) - 100) < 1,
    dominantHz(rectifierOnly.played.left),
  );
  const harmonicsOnly = render(
    humWith({
      electronics: { fundamental: 0, rectifier: 0, harmonics: 2e-3, harmonicCount: 3 },
    }),
    { stylusContact: false },
  );
  check(
    "and the harmonics are separate again, starting above the rectifier",
    rms(harmonicsOnly.played.left) > 0 &&
      dominantHz(harmonicsOnly.played.left) > 120,
    dominantHz(harmonicsOnly.played.left),
  );

  // **カートリッジ側はアーム位置と盤角度で変わる。**
  const outer = render(CARTRIDGE_HUM, {
    stylusContact: false,
    stylusRadius: GROOVE.discRadius,
    armIntent: "user",
  });
  const inner = render(CARTRIDGE_HUM, {
    stylusContact: false,
    stylusRadius: GROOVE.leadOutRadius,
    armIntent: "user",
  });
  check(
    "induced hum grows as the arm moves in towards the spindle",
    rms(inner.played.left) > rms(outer.played.left) * 1.05,
    { outer: rms(outer.played.left), inner: rms(inner.played.left) },
  );
  const spinning = render(CARTRIDGE_HUM, { stylusContact: false });
  const stopped = render(CARTRIDGE_HUM, {
    stylusContact: false,
    motorRequested: false,
  });
  check(
    "and the platter's own angle modulates it, so a spinning deck differs",
    !same(spinning.played, stopped.played),
  );

  // **左右コイルの向き。** 45° で左右が等しく、そこから外れると偏る。
  const balanced = render(CARTRIDGE_HUM, { stylusContact: false });
  let symmetric = true;
  for (let i = 0; i < balanced.played.left.length; i++) {
    if (balanced.played.left[i] !== balanced.played.right[i]) symmetric = false;
  }
  check("coils at 45 degrees pick up the same hum in both channels", symmetric);

  const leaning = render(
    humWith({
      cartridgeInduction: {
        ...CARTRIDGE_HUM.cartridgeInduction,
        coilAngleRadians: 0.2,
      },
    }),
    { stylusContact: false },
  );
  check(
    "and turning them away makes one channel louder than the other",
    rms(leaning.played.left) > rms(leaning.played.right) * 1.5,
    { left: rms(leaning.played.left), right: rms(leaning.played.right) },
  );

  // **グラウンドループは左右に共通成分を持てる。**
  const loop = (commonMode: number) =>
    render(
      humWith({
        groundLoop: {
          fundamental: 2e-3,
          rectifier: 0,
          harmonics: 0,
          harmonicCount: 0,
          commonMode,
        },
      }),
      { stylusContact: false },
    ).played;
  const difference = (played: { left: Float32Array; right: Float32Array }) => {
    let sum = 0;
    for (let i = 0; i < played.left.length; i++) {
      const d = played.left[i] - played.right[i];
      sum += d * d;
    }
    return Math.sqrt(sum / played.left.length);
  };
  check(
    "a fully common-mode ground loop cancels in the difference",
    difference(loop(1)) === 0 && rms(loop(1).left) > 0,
  );
  check(
    "and an uncorrelated one does not",
    difference(loop(0)) > 0,
    difference(loop(0)),
  );

  // 決定論とブロック長非依存。
  const twin = render(CARTRIDGE_HUM, { stylusContact: false });
  const other = render(
    humWith({
      seed: 99,
      cartridgeInduction: CARTRIDGE_HUM.cartridgeInduction,
    }),
    { stylusContact: false },
  );
  check("the same seed gives the same hum", same(coilOnly.played, twin.played));
  check("and a different seed gives a different phase", !same(coilOnly.played, other.played));

  const small = render(CARTRIDGE_HUM, {}, 128);
  const large = render(CARTRIDGE_HUM, {}, 4096);
  const odd = render(CARTRIDGE_HUM, {}, 512);
  check(
    "hum is bit-identical at 128, 512 and 4096 frames a block",
    same(small.played, large.played) && same(small.played, odd.played),
  );

  // **溝にも接触モデルにも混ざっていないこと。** 電気ノイズが針を飛ばしてはならない。
  // 追えない溝（大振幅の5kHz）を使って、実際にミストラッキングさせた上で比べる。
  const hard = cutTone(12, 5000, 0.9);
  const tracked = (parameters: HumParameters | null) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(hard);
    engine.setStylus(stylusWith({ trackingForce: 0.0006 }));
    if (parameters !== null) engine.setHum(parameters);
    run(engine, baseInput({ stylusRadius: radius }), SETTLE, 128);
    run(engine, baseInput({ stylusRadius: radius }), MEASURE, 128);
    return engine.state.contactLossSamples;
  };
  check(
    "hum never reaches the contact model — it is a voltage, not a force",
    tracked(null) === tracked(CARTRIDGE_HUM) &&
      tracked(null) === tracked(ELECTRONICS_HUM) &&
      tracked(null) > 0,
    tracked(null),
  );

  // でたらめな設定でも壊れない。
  const absurd: HumParameters[] = [
    humWith({
      seed: Number.NaN,
      mainsHz: 50,
      cartridgeInduction: {
        fundamental: Number.NaN,
        rectifier: -1,
        harmonics: 1e9,
        harmonicCount: 1e9,
        positionSensitivity: Number.NaN,
        platterSensitivity: 1e9,
        coilAngleRadians: Number.NaN,
      },
    }),
    humWith({
      electronics: { fundamental: 1e9, rectifier: 1e9, harmonics: 1e9, harmonicCount: -5 },
      groundLoop: { fundamental: 1e9, rectifier: 0, harmonics: 0, harmonicCount: 0, commonMode: Number.NaN },
    }),
  ];
  let sane = true;
  for (const parameters of absurd) {
    const played = render(parameters, { stylusContact: false }).played;
    if (!played.left.every((v) => Number.isFinite(v))) sane = false;
  }
  check("no hum setting, however absurd, produces a non-finite sample", sane);
}

console.log("\nhum injection points");

/**
 * 3つの注入点が**別の段の後ろ**にあること。どこに入るかで受けるものが違う:
 *
 * | | 電気負荷 | RIAA |
 * |---|---|---|
 * | `cartridgeInduction` | **かかる** | **かかる** |
 * | `cableHum` / `groundLoop` | かからない | **かかる** |
 * | `electronics` | かからない | かからない |
 */
{
  // カートリッジの分割そのもの。**分ける前と1ビットも変わらないこと。**
  const parameters: CartridgeParameters = {
    azimuth: 0.02,
    sensitivity: { left: 0.9, right: 1.1 },
    crosstalk: { leftFromRight: 0.03, rightFromLeft: 0.02 },
    mechanicalResonance: { hz: 18000, q: 1.5 },
    electricalLoad: { hz: 12000, q: 0.9 },
  };
  const whole = createCartridge(SAMPLE_RATE, parameters);
  const split = createCartridge(SAMPLE_RATE, parameters);
  let identical = true;
  for (let i = 0; i < 4096; i++) {
    const l = Math.sin(i / 7) * 0.4;
    const r = Math.cos(i / 11) * 0.3;
    whole.process(l, r);
    split.processMechanical(l, r);
    split.processElectrical(split.left, split.right);
    if (whole.left !== split.left || whole.right !== split.right) {
      identical = false;
      break;
    }
  }
  check(
    "splitting the cartridge into two stages changes nothing, to the bit",
    identical,
  );

  const groove = cutTone(12, 1000, 0.4);
  const radius = dropRadius(12, 0.25);
  const LEVEL = 2e-3;
  const tone = { fundamental: LEVEL, rectifier: 0, harmonics: 0, harmonicCount: 0 };
  /** 50Hz を大きく削る電気負荷。**誘導だけがこれを受ける。** */
  const LOADED: CartridgeParameters = {
    ...IDEAL_CARTRIDGE,
    electricalLoad: { hz: 20, q: 0.7 },
  };

  const heard = (
    over: Partial<HumParameters>,
    cartridge: CartridgeParameters = IDEAL_CARTRIDGE,
  ) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove);
    engine.setCartridge(cartridge);
    engine.setHum(humWith(over));
    // 針は上げたまま。**電気だけを見る。**
    const input = baseInput({ stylusRadius: radius, stylusContact: false });
    run(engine, input, 128 * 375, 128);
    return run(engine, input, 128 * 375, 128);
  };

  const induction = { ...IDEAL_HUM.cartridgeInduction, ...tone };
  const bare = {
    induction: rms(heard({ cartridgeInduction: induction }).left),
    cable: rms(heard({ cableHum: tone }).left),
    electronics: rms(heard({ electronics: tone }).left),
  };

  // 電気負荷が無ければ、誘導も配線も同じ道（RIAA だけ）を通る。**ただし誘導は
  // 1つの磁界を2つのコイルへ射影したもの**なので、45° のぶんだけ小さく出る。
  // 配線から入るものにはコイルが無いので、その射影を受けない。
  check(
    "with no electrical load, induction and cable differ only by the coil projection",
    Math.abs(bare.induction / (bare.cable * Math.cos(Math.PI / 4)) - 1) < 1e-6,
    { ...bare, ratio: bare.induction / bare.cable },
  );
  check(
    "and both are lifted by RIAA well above the post-RIAA stage",
    bare.cable > bare.electronics * 4,
    { cable: bare.cable, electronics: bare.electronics },
  );

  // 電気負荷を入れると、**誘導だけが削られる**。
  const loaded = {
    induction: rms(heard({ cartridgeInduction: induction }, LOADED).left),
    cable: rms(heard({ cableHum: tone }, LOADED).left),
    electronics: rms(heard({ electronics: tone }, LOADED).left),
  };
  check(
    "the coil's own load attenuates induced hum, because it enters before it",
    loaded.induction < bare.induction * 0.5,
    { free: bare.induction, loaded: loaded.induction },
  );
  check(
    "while cable hum enters after the coil and is untouched by that load",
    loaded.cable === bare.cable,
    { free: bare.cable, loaded: loaded.cable },
  );
  check(
    "and so is the stage after RIAA",
    loaded.electronics === bare.electronics,
  );

  // グラウンドループも配線側へ移った。**RIAA は受けるが電気負荷は受けない。**
  const ground = {
    ...IDEAL_HUM.groundLoop,
    ...tone,
    commonMode: 1,
  };
  const loop = heard({ groundLoop: ground });
  check(
    "the ground loop now sits with the cable, so RIAA lifts it too",
    Math.abs(rms(loop.left) / bare.cable - 1) < 1e-6,
    { groundLoop: rms(loop.left), cable: bare.cable },
  );
  check(
    "and the coil's load leaves it alone as well",
    rms(heard({ groundLoop: ground }, LOADED).left) === rms(loop.left),
  );
  check(
    "while still cancelling in the difference when fully common-mode",
    (() => {
      for (let i = 0; i < loop.left.length; i++) {
        if (loop.left[i] !== loop.right[i]) return false;
      }
      return rms(loop.left) > 0;
    })(),
  );
}

console.log("\ntracing distortion from a finite stylus tip");

/**
 * 試験用の針先。**実在針の寸法ではない** — 経路が生きていることを見えるように
 * するためだけの大きさで、実機の丸針よりかなり大きい。
 */
const BLUNT_TIP: StylusTipParameters = {
  scanningRadius: 40e-6,
  transverseRadius: 0,
};
/** 楕円針の形（溝方向だけ小さい）を模したもの。同じく実測値ではない。 */
const SHARP_TIP: StylusTipParameters = {
  scanningRadius: 10e-6,
  transverseRadius: 0,
};
const PINCH_TIP: StylusTipParameters = {
  scanningRadius: 0,
  transverseRadius: 40e-6,
};

/** 変位1単位が表すメートル。エンジンが使うのと同じ換算。 */
const TIP_UNITS_TO_METRES = REFERENCE_WALL_VELOCITY / SAMPLE_RATE;
/** その半径での溝1サンプルぶんの距離 m。**内周ほど小さい。** */
const metresPerGrooveSample = (radius: number) =>
  (rpmToRadPerSec(CUT.cutRpm) * radius) / SAMPLE_RATE;
const AT_LEAD_IN = metresPerGrooveSample(GROOVE.leadInRadius);
const AT_LEAD_OUT = metresPerGrooveSample(GROOVE.leadOutRadius);

/**
 * 針先が触れる**局所盤面形状**。ここでは溝だけを返す — 反り・偏心・ランブル・ハムは
 * 針先を通さないので、この試験にも入らない（`stylusTip.ts` の `LocalGrooveProfile`）。
 */
const tipProfile = {
  left: 0,
  right: 0,
  walls: [new Float32Array(0), new Float32Array(0)] as Float32Array[],
  position: 0,
  readAt(offset: number) {
    tipProfile.left = sampleGrooveWall(tipProfile.walls[0], tipProfile.position + offset);
    tipProfile.right = sampleGrooveWall(tipProfile.walls[1], tipProfile.position + offset);
  },
};

/** その位置に針先を置いて読む。溝だけを与えるので、相対変位は入らない。 */
const traceAt = (
  model: StylusTip,
  left: Float32Array,
  right: Float32Array,
  position: number,
  metresPerSample: number,
) => {
  tipProfile.walls[0] = left;
  tipProfile.walls[1] = right;
  tipProfile.position = position;
  model.read(tipProfile, metresPerSample, TIP_UNITS_TO_METRES);
};

// モデル単体。**理想は厳密に 0、そして山は残り谷だけが埋まる。**
{
  const ideal = createStylusTip(IDEAL_STYLUS_TIP);
  check("a point stylus is bypassed", ideal.bypassed);

  /**
   * 40µm の針が**追えない**溝。歪むかどうかは振幅ではなく曲率で決まるので、
   * そこを跨ぐように選んである: 波長 8サンプル（32µm）・振幅 2単位（1.5µm）で
   * 谷の曲率半径は約 18µm、針の 40µm より小さい。
   */
  const wall = new Float32Array(512);
  const WALL_PERIOD = 8;
  for (let i = 0; i < wall.length; i++) {
    wall[i] = 2 * Math.sin((2 * Math.PI * i) / WALL_PERIOD);
  }
  let silent = true;
  for (let i = 8; i < 500; i += 0.37) {
    traceAt(ideal, wall, wall, i, AT_LEAD_OUT);
    if (ideal.left !== 0 || ideal.right !== 0 || ideal.vertical !== 0) {
      silent = false;
    }
  }
  check("and reads the groove without changing a single value", silent);

  // **山は残り、谷だけが持ち上がる。** ローパスなら山も同じだけ鈍る。
  const tip = createStylusTip(BLUNT_TIP);
  let atPeaks = 0;
  let atTroughs = 0;
  let everNegative = false;
  for (let i = 16; i < 480; i += 0.25) {
    traceAt(tip, wall, wall, i, AT_LEAD_OUT);
    if (tip.left < -1e-12) everNegative = true;
    const phase = Math.sin((2 * Math.PI * i) / WALL_PERIOD);
    if (phase > 0.99) atPeaks = Math.max(atPeaks, tip.left);
    if (phase < -0.99) atTroughs = Math.max(atTroughs, tip.left);
  }
  check(
    "a finite tip only ever adds — it cannot reach deeper than the groove",
    !everNegative,
  );
  check(
    "it fills in the troughs while leaving the peaks alone",
    atTroughs > atPeaks * 4 && atTroughs > 0,
    { peaks: atPeaks, troughs: atTroughs },
  );

  // **追える溝では厳密に 0。** 曲率が針より緩ければ何も起きない。
  const gentle = new Float32Array(512);
  for (let i = 0; i < gentle.length; i++) gentle[i] = 0.02 * Math.sin(i / 90);
  let untouched = true;
  for (let i = 16; i < 480; i += 0.31) {
    traceAt(tip, gentle, gentle, i, AT_LEAD_OUT);
    if (tip.left !== 0 || tip.right !== 0) untouched = false;
  }
  check(
    "a groove the tip can follow comes back exactly unchanged",
    untouched,
  );

  // **溝方向の半径だけが効く。** 楕円針が高域に強い理由そのもの。
  const blunt = createStylusTip(BLUNT_TIP);
  const sharp = createStylusTip(SHARP_TIP);
  let bluntPeak = 0;
  let sharpPeak = 0;
  for (let i = 16; i < 480; i += 0.25) {
    traceAt(blunt, wall, wall, i, AT_LEAD_OUT);
    traceAt(sharp, wall, wall, i, AT_LEAD_OUT);
    bluntPeak = Math.max(bluntPeak, blunt.left);
    sharpPeak = Math.max(sharpPeak, sharp.left);
  }
  check(
    "a smaller scanning radius traces the same groove more closely",
    sharpPeak < bluntPeak * 0.5 && bluntPeak > 0,
    { blunt: bluntPeak, sharp: sharpPeak },
  );

  // **左右の壁は別々に評価される。** 片方だけ荒れていれば片方だけ歪む。
  const flat = new Float32Array(512);
  let oneSided = 0;
  let otherSideMoved = false;
  for (let i = 16; i < 480; i += 0.25) {
    traceAt(blunt, wall, flat, i, AT_LEAD_OUT);
    oneSided = Math.max(oneSided, blunt.left);
    if (blunt.right !== 0) otherSideMoved = true;
  }
  check(
    "the two walls are read separately, as the separate surfaces they are",
    oneSided > 0 && !otherSideMoved,
    { modulated: oneSided },
  );

  // **正逆対称。** 位置の純関数なので、同じ位置からは同じ値が返る。
  const forward: number[] = [];
  for (let i = 0; i <= 200; i++) {
    traceAt(blunt, wall, wall, 100 + i * 0.5, AT_LEAD_OUT);
    forward.push(blunt.left);
  }
  let mirrored = true;
  for (let i = 200; i >= 0; i--) {
    traceAt(blunt, wall, wall, 100 + i * 0.5, AT_LEAD_OUT);
    if (blunt.left !== forward[i]) mirrored = false;
  }
  check("and reading it backwards returns exactly the same values", mirrored);

  /**
   * **内周ほど歪む。** 同じ溝・同じ針で、変えるのは1サンプルが表す距離だけ。
   *
   * 窓の幅はメートルで決まっているのに、線速度が落ちれば同じ距離により多くの
   * サンプルが入る ——**同じ音声周波数でも空間波長が短くなる**。内周歪みは別に
   * 実装するものではなく、この1つの数字から出る。
   */
  const worstAt = (metresPerSample: number) => {
    let peak = 0;
    for (let i = 16; i < 480; i += 0.25) {
      traceAt(blunt, wall, wall, i, metresPerSample);
      peak = Math.max(peak, blunt.left);
    }
    return peak;
  };
  const outer = worstAt(AT_LEAD_IN);
  const inner = worstAt(AT_LEAD_OUT);
  check(
    "the same groove is traced worse where the linear speed is lower",
    inner > 0 && outer < inner * 0.2,
    { atLeadIn: outer, atLeadOut: inner },
  );
  check(
    "and the inner groove really does pack more of it into the tip's window",
    AT_LEAD_OUT < AT_LEAD_IN,
    { leadIn: AT_LEAD_IN, leadOut: AT_LEAD_OUT },
  );

  // pinch は**傾きの偶関数**なので、変調の2倍の周期で出る。
  const pinch = createStylusTip(PINCH_TIP);
  const smooth = new Float32Array(1024);
  const period = 64;
  for (let i = 0; i < smooth.length; i++) {
    smooth[i] = 0.5 * Math.sin((2 * Math.PI * i) / period);
  }
  const rises: number[] = [];
  for (let i = 0; i < period; i++) {
    traceAt(pinch, smooth, smooth, 512 + i, AT_LEAD_OUT);
    rises.push(pinch.vertical);
  }
  check("pinch only ever lifts the tip, never drops it", rises.every((v) => v >= 0));
  check(
    "and it repeats twice per cycle of the modulation",
    (() => {
      let worst = 0;
      for (let i = 0; i < period / 2; i++) {
        worst = Math.max(worst, Math.abs(rises[i] - rises[i + period / 2]));
      }
      return worst < 1e-12 && Math.max(...rises) > 0;
    })(),
    { peak: Math.max(...rises) },
  );
  check(
    "a tip with no transverse radius produces no pinch at all",
    (() => {
      const none = createStylusTip(BLUNT_TIP);
      traceAt(none, smooth, smooth, 520.3, AT_LEAD_OUT);
      return none.vertical === 0;
    })(),
  );

  // でたらめな寸法でも壊れない。
  const absurd: StylusTipParameters[] = [
    { scanningRadius: Number.NaN, transverseRadius: Number.NaN },
    { scanningRadius: -1, transverseRadius: -1 },
    { scanningRadius: 1e9, transverseRadius: 1e9 },
  ];
  let sane = true;
  for (const parameters of absurd) {
    const model = createStylusTip(parameters);
    for (let i = 0; i < 400; i++) {
      traceAt(model, wall, wall, i * 1.13, AT_LEAD_OUT);
      if (
        !Number.isFinite(model.left) ||
        !Number.isFinite(model.right) ||
        !Number.isFinite(model.vertical)
      ) {
        sane = false;
      }
    }
    // 0 や負の縮尺を渡されても黙って 0 を返すこと。
    traceAt(model, wall, wall, 100, 0);
    if (model.left !== 0) sane = false;
  }
  check("no tip setting, however absurd, produces a non-finite value", sane);
}

/**
 * エンジンに載せる。**トレーシング歪みは高域の現象**なので 10kHz を深く切った溝で
 * 測る（この振幅なら谷の曲率半径が 27µm ほどで、40µm の針は入れない）。
 *
 * 半径の効きはここでは測れない。12秒の音源は演奏領域を 0.9mm しか使わないので、
 * 内周も外周も同じ場所である（`dropRadius` の注記）。半径の効きは上のモデル単体で
 * リードイン／リードアウトの実速度を入れて確かめてある。
 */
{
  const groove = cutTone(12, 10000, 0.9);
  const SETTLE = 128 * 375;
  const MEASURE = 128 * 375;

  const render = (
    parameters: StylusTipParameters | null,
    radius: number,
    blockSize = 128,
  ) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove);
    if (parameters !== null) engine.setStylusTip(parameters);
    const input = baseInput({ stylusRadius: radius });
    run(engine, input, SETTLE, blockSize);
    return { engine, played: run(engine, input, MEASURE, blockSize) };
  };

  const same = (
    a: { left: Float32Array; right: Float32Array },
    b: { left: Float32Array; right: Float32Array },
  ) => {
    for (let i = 0; i < a.left.length; i++) {
      if (a.left[i] !== b.left[i] || a.right[i] !== b.right[i]) return false;
    }
    return true;
  };

  const radius = dropRadius(12, 0.25);
  const damage = (
    traced: { left: Float32Array; right: Float32Array },
    clean: { left: Float32Array; right: Float32Array },
  ) => {
    let sum = 0;
    for (let i = 0; i < traced.left.length; i++) {
      const d = traced.left[i] - clean.left[i];
      sum += d * d;
    }
    return Math.sqrt(sum / traced.left.length);
  };

  const bare = render(null, radius);
  const ideal = render(IDEAL_STYLUS_TIP, radius);
  check(
    "a point stylus changes the deck's output not one bit",
    same(bare.played, ideal.played),
  );

  const traced = render(BLUNT_TIP, radius);
  const sharper = render(SHARP_TIP, radius);
  check(
    "a blunt tip does damage the signal, or the rest of this proves nothing",
    damage(traced.played, bare.played) > 0 &&
      traced.played.left.every((v) => Number.isFinite(v)),
    damage(traced.played, bare.played),
  );
  check(
    "and a smaller scanning radius leaves the same groove closer to intact",
    damage(sharper.played, bare.played) <
      damage(traced.played, bare.played) * 0.5,
    {
      blunt: damage(traced.played, bare.played),
      sharp: damage(sharper.played, bare.played),
    },
  );

  // ブロック長非依存。位置の純関数なので構造的に通るはずだが、半径が
  // チャンク内で補間されている以上ここが本番。
  const small = render(BLUNT_TIP, radius, 128);
  const large = render(BLUNT_TIP, radius, 4096);
  const odd = render(BLUNT_TIP, radius, 512);
  check(
    "tracing is bit-identical at 128, 512 and 4096 frames a block",
    same(small.played, large.played) && same(small.played, odd.played),
  );

  // **速度を変えても歪みの量は変わらない。** 窓は距離で決まっていて、盤に刻まれた
  // 形は回し方に依らない ——速く回せば同じ歪みが速く通り過ぎるだけである。
  const relativeDamageAt = (targetRpm: number) => {
    const withTip = createDeckEngine({ sampleRate: SAMPLE_RATE });
    withTip.loadGroove(groove);
    withTip.setStylusTip(BLUNT_TIP);
    const clean = createDeckEngine({ sampleRate: SAMPLE_RATE });
    clean.loadGroove(groove);
    const input = baseInput({ stylusRadius: radius, targetRpm });
    run(withTip, input, SETTLE, 4096);
    run(clean, input, SETTLE, 4096);
    const a = run(withTip, input, MEASURE, 4096);
    const b = run(clean, input, MEASURE, 4096);
    return damage(a, b) / rms(b.left);
  };
  const nominal = relativeDamageAt(33.333);
  const fast = relativeDamageAt(45);
  /**
   * **針が溝をどう読むかは速度に依らない**（窓は距離で決まり、`metresPerSample` は
   * `cutRpm` から来る。モデルには速度という引数がそもそも無い）。
   *
   * ただし**出力で測った比は一致しない**。RIAA は出力の時間軸で回る固定フィルタ
   * なので、速く回せば歪みの高調波がより高いところへ移り、そこでより多く削られる。
   * 変わっているのは RIAA の効き方であって、溝の読まれ方ではない — 一致を要求すると
   * 正しい実装のほうが落ちる。
   */
  check(
    "playing faster leaves the tracing itself alone; only RIAA sees it differently",
    nominal > 0 && fast > nominal * 0.5 && fast < nominal * 1.5,
    { at33: nominal, at45: fast },
  );

  // pinch はエンジンでも逆相へ入る。
  const pinched = render(PINCH_TIP, radius);
  const antiphase = (played: { left: Float32Array; right: Float32Array }) => {
    let sum = 0;
    for (let i = 0; i < played.left.length; i++) {
      const d = played.left[i] - played.right[i];
      sum += d * d;
    }
    return Math.sqrt(sum / played.left.length);
  };
  check(
    "pinch reaches the walls out of phase, as a vertical component must",
    antiphase(pinched.played) > antiphase(bare.played),
    { pinched: antiphase(pinched.played), clean: antiphase(bare.played) },
  );
}

console.log("\nwhat the tip is allowed to touch");

/**
 * **針先が空間的に読むのは、盤に固定された局所形状だけ**である。
 *
 * | 入る | 入らない |
 * |---|---|
 * | 切られた溝・表面粗さ・埃・傷 | 反り／皿・偏心・ランブル・ハム |
 *
 * 右の列は「盤の上の形」ではない。針先で丸めてしまうと、盤が上下しただけで高域が
 * 失われるという実機に無い挙動になる。
 */
{
  const groove = cutTone(12, 10000, 0.9);
  const radius = dropRadius(12, 0.25);
  const SETTLE = 128 * 375;
  const MEASURE = 128 * 375;

  const render = (
    setup: (engine: ReturnType<typeof createDeckEngine>) => void,
    blockSize = 128,
  ) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    // 針先と反りの量を差で測るので、**出力段の非線形は外しておく**（MEASURE_ONLY）。
    engine.setLevels(MEASURE_ONLY);
    engine.loadGroove(groove);
    setup(engine);
    const input = baseInput({ stylusRadius: radius });
    run(engine, input, SETTLE, blockSize);
    return { engine, played: run(engine, input, MEASURE, blockSize) };
  };

  const same = (
    a: { left: Float32Array; right: Float32Array },
    b: { left: Float32Array; right: Float32Array },
  ) => {
    for (let i = 0; i < a.left.length; i++) {
      if (a.left[i] !== b.left[i] || a.right[i] !== b.right[i]) return false;
    }
    return true;
  };

  const GRITTY = surfaceWith({
    roughness: { rms: 4e-8, correlationLength: 25e-6 },
    dust: { count: 600, minRadius: 60e-6, maxRadius: 300e-6, height: 3e-6 },
  });

  // **理想の針と綺麗な盤では、いまと1ビットも変わらない。**
  const bare = render(() => {});
  const idealBoth = render((engine) => {
    engine.setStylusTip(IDEAL_STYLUS_TIP);
    engine.setSurface(CLEAN_SURFACE);
  });
  check(
    "an ideal tip on a clean record changes the output not one bit",
    same(bare.played, idealBoth.played),
  );

  // **埃と傷も針先で丸められる。** 針先を通す前と後で、盤面欠陥の出方が変わる。
  const grittyPoint = render((engine) => engine.setSurface(GRITTY));
  const grittyTraced = render((engine) => {
    engine.setSurface(GRITTY);
    engine.setStylusTip(BLUNT_TIP);
  });
  const groovePoint = render(() => {});
  const grooveTraced = render((engine) => engine.setStylusTip(BLUNT_TIP));

  const differenceRms = (
    a: { left: Float32Array; right: Float32Array },
    b: { left: Float32Array; right: Float32Array },
  ) => {
    let sum = 0;
    for (let i = 0; i < a.left.length; i++) {
      const d = a.left[i] - b.left[i];
      sum += d * d;
    }
    return Math.sqrt(sum / a.left.length);
  };

  check(
    "the surface really is on the record, or the rest of this proves nothing",
    differenceRms(grittyPoint.played, groovePoint.played) > 0,
  );
  // 針先が撫でる相手に盤面欠陥が入っていなければ、欠陥のぶんの差は針先の有無で
  // 変わらないはずである。変わるということは、**埃と傷も窓を通っている**。
  const defectPoint = differenceRms(grittyPoint.played, groovePoint.played);
  const defectTraced = differenceRms(grittyTraced.played, grooveTraced.played);
  check(
    "dust and scratches are rounded off by the tip as well as the groove is",
    Math.abs(defectTraced - defectPoint) > defectPoint * 0.01,
    { pointStylus: defectPoint, finiteTip: defectTraced },
  );

  // **丸められても、強い欠陥は接触を失わせられる。**
  const HARSH = surfaceWith({
    scratches: { count: 60, width: 120e-6, depth: 3e-5, curvature: 3, length: 0.06 },
  });
  const harsh = render((engine) => {
    engine.setSurface(HARSH);
    engine.setStylusTip(BLUNT_TIP);
    engine.setStylus(stylusWith({ trackingForce: 0.0006 }));
  });
  check(
    "a deep scratch still throws the stylus after the tip has rounded it",
    harsh.engine.state.contactLossSamples > 0,
    harsh.engine.state.contactLossSamples,
  );

  // **反りは針先を通らない。** 盤全体の巨視的な形であってアームの支持面である。
  const warpPoint = render((engine) => engine.setDiscShape(WARP_ONLY));
  const warpTraced = render((engine) => {
    engine.setDiscShape(WARP_ONLY);
    engine.setStylusTip(BLUNT_TIP);
  });
  const warpDeltaPoint = differenceRms(warpPoint.played, groovePoint.played);
  const warpDeltaTraced = differenceRms(warpTraced.played, grooveTraced.played);
  check(
    "warp is added after the tip, so a blunt tip does not blunt it",
    Math.abs(warpDeltaTraced - warpDeltaPoint) < warpDeltaPoint * 1e-6,
    { pointStylus: warpDeltaPoint, finiteTip: warpDeltaTraced },
  );

  // **ランブルも同じ。** プラッターとアームの相対振動で、盤に刻まれていない。
  const rumblePoint = render((engine) => engine.setRumble(TEST_RUMBLE));
  const rumbleTraced = render((engine) => {
    engine.setRumble(TEST_RUMBLE);
    engine.setStylusTip(BLUNT_TIP);
  });
  const rumbleDeltaPoint = differenceRms(rumblePoint.played, groovePoint.played);
  const rumbleDeltaTraced = differenceRms(
    rumbleTraced.played,
    grooveTraced.played,
  );
  check(
    "and so is structural rumble — the tip never sees it",
    Math.abs(rumbleDeltaTraced - rumbleDeltaPoint) < rumbleDeltaPoint * 1e-6,
    { pointStylus: rumbleDeltaPoint, finiteTip: rumbleDeltaTraced },
  );

  // **ハムも同じ。** そもそも形ではない。
  const humPoint = render((engine) => engine.setHum(CARTRIDGE_HUM));
  const humTraced = render((engine) => {
    engine.setHum(CARTRIDGE_HUM);
    engine.setStylusTip(BLUNT_TIP);
  });
  const humDeltaPoint = differenceRms(humPoint.played, groovePoint.played);
  const humDeltaTraced = differenceRms(humTraced.played, grooveTraced.played);
  check(
    "and mains hum, which is not a shape at all",
    Math.abs(humDeltaTraced - humDeltaPoint) < humDeltaPoint * 1e-6,
    { pointStylus: humDeltaPoint, finiteTip: humDeltaTraced },
  );

  // 盤面欠陥を窓の中で拾っても、決定論とブロック長非依存は保たれる。
  const small = render((engine) => {
    engine.setSurface(GRITTY);
    engine.setStylusTip(BLUNT_TIP);
  }, 128);
  const large = render((engine) => {
    engine.setSurface(GRITTY);
    engine.setStylusTip(BLUNT_TIP);
  }, 4096);
  const odd = render((engine) => {
    engine.setSurface(GRITTY);
    engine.setStylusTip(BLUNT_TIP);
  }, 512);
  check(
    "tracing a defective record stays bit-identical at 128, 512 and 4096",
    same(small.played, large.played) && same(small.played, odd.played),
  );
  check(
    "and the same seed still gives the same record",
    same(
      small.played,
      render((engine) => {
        engine.setSurface(GRITTY);
        engine.setStylusTip(BLUNT_TIP);
      }).played,
    ),
  );
}

console.log("\nvariable groove pitch (preview control)");

/**
 * プレビュー制御による可変ピッチ（`pitchControl.ts` / `cutLayout.ts`）。
 *
 * **決めるのは溝の位置だけ**で、音声カーソルにも回転にも触らない。だから見るのは
 * 「螺旋の形」と「その形の上で半径と回転数が一致するか」である。
 *
 * 1. **静かなところは詰まり、大きい／低いところは開く。**
 * 2. **pitch map に段差が無い。** 送り機構は1回転でこれ以上動けない。
 * 3. **半径 ↔ 回転数が厳密に往復する。** 針を降ろす位置がずれない。
 * 4. **アームと音声カーソルが同じ割り付けを見ている。**
 * 5. **短い音源を盤いっぱいに引き伸ばさない。**
 * 6. **収まらないときは黙って潰さず、必要な低下量を返す。**
 * 7. **一定ピッチ設定では従来の割り付けと一致する。**
 */
{
  const RPM = CUT.cutRpm;
  const perRevolution = (SAMPLE_RATE * 60) / RPM;

  /** 試験用の送り機構。**実機の値ではない**（境界を短い音源で踏むための値）。 */
  const control: PitchControlParameters = {
    previewRevolutions: 1,
    minPitch: 80e-6,
    maxPitch: 300e-6,
    maxChangePerRevolution: 80e-6,
    displacementGain: 2,
    verticalWeight: 0.5,
    lowHz: 150,
    lowWeight: 0.5,
  };

  /** 前半は静か、後半は低域で大きい音源。**回転の境目に合わせて切り替える。** */
  const quietThenLoud = (revolutions: number) => {
    const frames = Math.round(revolutions * perRevolution);
    const half = Math.round((revolutions / 2) * perRevolution);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const t = i / SAMPLE_RATE;
      if (i < half) {
        // 静か: 1kHz を −40dB。変位はごく小さい。
        left[i] = 0.01 * Math.sin(2 * Math.PI * 1000 * t);
        right[i] = 0.01 * Math.sin(2 * Math.PI * 1000 * t + 0.3);
      } else {
        // 大きい低域: 50Hz をフルスケール近くで。**変位が桁違いに大きい。**
        left[i] = 0.9 * Math.sin(2 * Math.PI * 50 * t);
        right[i] = 0.9 * Math.sin(2 * Math.PI * 50 * t + 0.3);
      }
    }
    return { channels: [left, right], frames, revolutions };
  };

  const plan = (
    source: { channels: Float32Array[]; revolutions: number },
    over: Partial<PitchControlParameters> = {},
    cutting = IDEAL_CUTTING,
  ) =>
    planGroovePitch(
      source.channels,
      SAMPLE_RATE,
      cutting,
      { ...control, ...over },
      RPM,
      perRevolution,
      source.revolutions,
    );

  // ── 1. 静かなところは詰まり、大きいところは開く ────────────────────
  {
    const source = quietThenLoud(12);
    const { pitches, fit } = plan(source);
    const quiet = pitches[1];
    const loud = pitches[pitches.length - 2];
    check(
      "a quiet passage is cut with a tighter pitch than a loud bass one",
      loud > quiet * 1.5,
      { quiet, loud },
    );
    // 静かな側もゼロではない（1kHz −40dB でも変位はある）ので、最小のすぐ上。
    check(
      "the quiet passage sits just above the minimum pitch",
      quiet <= control.minPitch * 1.01,
      quiet,
    );
    check("and the loud one does not exceed the maximum", loud <= control.maxPitch + 1e-12, loud);
    check("a 12-revolution source fits easily", fit.fits && fit.levelReductionDb === 0);

    // **同じ音を静かにすれば、必要な間隔も減る。** 変位を見ている証拠。
    const softer = {
      ...source,
      channels: source.channels.map((c) => c.map((v) => v * 0.25)),
    };
    check(
      "cutting the same music quieter needs less room",
      plan(softer).pitches[pitches.length - 2] < loud,
    );

    // 低域だけを高い音へ置き換えると、同じ音量でも必要な間隔は減る（変位は 1/f）。
    const treble = {
      ...source,
      channels: source.channels.map((channel, index) => {
        const out = new Float32Array(channel.length);
        const half = Math.round((source.revolutions / 2) * perRevolution);
        for (let i = 0; i < channel.length; i++) {
          const t = i / SAMPLE_RATE;
          out[i] = i < half ? channel[i] : 0.9 * Math.sin(2 * Math.PI * 4000 * t + index * 0.3);
        }
        return out;
      }),
    };
    // **同じ音量でも、低いほど場所を食う。** 溝に残るのは変位なので 1/f で効く。
    // 比べるのは最小ピッチからの上積み（下駄を履いた値どうしでは分からない）。
    const trebleRoom = plan(treble).pitches[pitches.length - 2] - control.minPitch;
    const bassRoom = loud - control.minPitch;
    check(
      "the same level at 4 kHz needs far less room than at 50 Hz",
      trebleRoom < bassRoom * 0.5,
      { trebleRoom, bassRoom },
    );
  }

  // ── 2. pitch map に段差が無い ──────────────────────────────────────
  {
    const source = quietThenLoud(16);
    const { pitches } = plan(source);
    let biggest = 0;
    for (let k = 1; k < pitches.length; k++) {
      biggest = Math.max(biggest, Math.abs(pitches[k] - pitches[k - 1]));
    }
    check(
      "the pitch map never moves faster than the feed can",
      biggest <= control.maxChangePerRevolution + 1e-12,
      biggest,
    );
    // **開くのは音が来る前。** 静かな側の最後の回転は、既に最小より広い。
    const middle = Math.floor(pitches.length / 2);
    check(
      "and it opens up before the loud passage arrives, not after",
      pitches[middle - 1] > control.minPitch,
      { before: pitches[middle - 1], at: pitches[middle] },
    );

    // 送りを遅くすれば、開き始めるのはもっと前になる。
    const slow = plan(source, { maxChangePerRevolution: 20e-6 });
    let slowest = 0;
    for (let k = 1; k < slow.pitches.length; k++) {
      slowest = Math.max(slowest, Math.abs(slow.pitches[k] - slow.pitches[k - 1]));
    }
    check("a slower feed gives a smoother map", slowest <= 20e-6 + 1e-12, slowest);
  }

  // ── 3・4. 半径と回転数、アームとカーソル ───────────────────────────
  {
    const source = quietThenLoud(20);
    const { pitches } = plan(source);
    const layout = createCutLayout(
      source.frames / SAMPLE_RATE,
      SAMPLE_RATE,
      RPM,
      pitches,
    );

    let worstRadius = 0;
    let worstRevolution = 0;
    for (let step = 0; step <= 400; step++) {
      const revolutions = (step / 400) * layout.programRevolutions;
      const radius = radiusAtRevolution(layout, revolutions);
      const back = revolutionsAtRadius(layout, radius);
      worstRevolution = Math.max(worstRevolution, Math.abs(back - revolutions));
      worstRadius = Math.max(
        worstRadius,
        Math.abs(radiusAtRevolution(layout, back) - radius),
      );
    }
    check(
      "radius and revolutions round-trip on the variable map",
      worstRevolution < 1e-9 && worstRadius < 1e-12,
      { worstRevolution, worstRadius },
    );
    check(
      "the map is monotone — the spiral only ever goes inward",
      (() => {
        let previous = GROOVE.leadInRadius + 1;
        for (let step = 0; step <= 400; step++) {
          const radius = radiusAtRevolution(
            layout,
            (step / 400) * layout.programRevolutions,
          );
          if (radius > previous) return false;
          previous = radius;
        }
        return true;
      })(),
    );
    check(
      "adjacent-groove spacing is readable per revolution",
      grooveSpacingAt(layout, 0) === pitches[0] &&
        grooveSpacingAt(layout, layout.programRevolutions - 0.5) ===
          pitches[Math.floor(layout.programRevolutions - 0.5)],
    );

    // **アームとカーソルが同じ割り付けを見ている。** 溝を鳴らし、針の半径から
    // 引いた回転数がカーソルと一致することを見る。
    const groove = createGrooveBuffer(
      cutToGroove(source.channels, SAMPLE_RATE),
      SAMPLE_RATE,
    );
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(groove, layout);
    const drop = radiusAtRevolution(layout, layout.programRevolutions * 0.25);
    const blockL = new Float32Array(PHYSICS_CHUNK_FRAMES);
    const blockR = new Float32Array(PHYSICS_CHUNK_FRAMES);
    const input = baseInput({ stylusRadius: drop });
    for (let at = 0; at < SAMPLE_RATE * 2; at += PHYSICS_CHUNK_FRAMES) {
      engine.process(input, blockL, blockR);
    }
    const state = engine.state;
    check(
      "the arm sits where the map says the groove has carried it",
      Math.abs(state.stylusRadius - radiusAtRevolution(layout, state.revolutions)) <
        1e-12,
      { radius: state.stylusRadius, revolutions: state.revolutions },
    );
    check(
      "and the audio cursor still comes from revolutions alone",
      Math.abs(
        state.programCursor - state.revolutions * layout.samplesPerRevolution,
      ) < 1e-6,
      { cursor: state.programCursor, revolutions: state.revolutions },
    );
    check(
      "dropping the stylus lands on the revolution that radius belongs to",
      Math.abs(revolutionsAtRadius(layout, drop) - layout.programRevolutions * 0.25) <
        1e-9,
    );
  }

  // ── 5. 短い音源を引き伸ばさない ────────────────────────────────────
  {
    const source = quietThenLoud(8);
    const { pitches } = plan(source);
    const layout = createCutLayout(
      source.frames / SAMPLE_RATE,
      SAMPLE_RATE,
      RPM,
      pitches,
    );
    check(
      "a short source stays near the outer edge",
      layout.programEndRadius > GROOVE.leadInRadius - 0.003,
      layout.programEndRadius,
    );
    check(
      "and its lead-out still reaches the locked groove",
      layout.lockedRevolutions > layout.programRevolutions,
    );
  }

  // ── 6. 収まる／収まらない境界 ──────────────────────────────────────
  {
    const available = GROOVE.leadInRadius - GROOVE.leadOutRadius;
    // 送りを粗くして、短い音源で境界を踏む。
    const coarse = { minPitch: 5e-3, maxPitch: 8e-3, maxChangePerRevolution: 8e-3 };
    const revolutionsThatFit = Math.floor(available / coarse.minPitch);

    const small = quietThenLoud(revolutionsThatFit - 2);
    check(
      "a source that fits reports so",
      plan(small, coarse).fit.fits,
    );

    const big = quietThenLoud(revolutionsThatFit + 4);
    const impossible = plan(big, coarse).fit;
    check(
      "one that cannot fit even at the minimum pitch says so",
      impossible.impossible && !impossible.fits,
      impossible,
    );
    check(
      "and does not pretend a level reduction would help",
      impossible.levelReductionDb === Number.POSITIVE_INFINITY,
    );
    // **それでも螺旋は盤の中に収める。** ラベルの上まで伸びるくらいなら、
    // 「そこで盤が尽きた」ほうが事実に近い（理由は fit が持っている）。
    {
      const overflow = plan(big, coarse);
      const layout = createCutLayout(
        big.frames / SAMPLE_RATE,
        SAMPLE_RATE,
        RPM,
        overflow.pitches,
        overflow.fit,
      );
      check(
        "a source that cannot fit still leaves the spiral inside the disc",
        layout.programEndRadius >= GROOVE.leadOutRadius - 1e-9 &&
          layout.programRevolutions < big.revolutions,
        {
          endRadius: layout.programEndRadius,
          cut: layout.programRevolutions,
          asked: big.revolutions,
        },
      );
    }

    // ちょうど間: 最小ピッチなら入るが、要求どおりだと入らない。**音の寄与が
    // 効く範囲**でこれを踏むために、送りの利得を大きく取った試験用の設定を使う
    // （実機の値ではない。境界の扱いだけを見ている）。
    const tight = {
      minPitch: 80e-6,
      maxPitch: 6e-3,
      maxChangePerRevolution: 6e-3,
      displacementGain: 400,
    };
    const edge = quietThenLoud(40);
    const report = plan(edge, tight).fit;
    check(
      "between the two, it asks for a level reduction instead of silently squashing",
      !report.fits &&
        !report.impossible &&
        report.levelReductionDb > 0 &&
        Number.isFinite(report.levelReductionDb),
      report,
    );
    check("and reports what it needed against what it had", report.required > report.available);

    // **返ってきた低下量が本当に効くか。** その量だけ下げて切り直せば収まること。
    const scale = 10 ** (-report.levelReductionDb / 20);
    const quieter = {
      ...edge,
      channels: edge.channels.map((c) => c.map((v) => v * scale)),
    };
    check(
      "cutting that much quieter really does fit",
      plan(quieter, tight).fit.fits,
      plan(quieter, tight).fit,
    );
  }

  // ── 7. 一定ピッチは従来どおり ──────────────────────────────────────
  {
    const seconds = 30;
    const layout = createCutLayout(seconds, SAMPLE_RATE, RPM);
    check(
      "a layout without a pitch map is still the constant-pitch one",
      layout.pitch === null &&
        layout.programPitch === CUT.programPitch &&
        layout.fit.fits,
    );
    let worst = 0;
    for (let step = 0; step <= 200; step++) {
      const revolutions = (step / 200) * layout.programRevolutions;
      worst = Math.max(
        worst,
        Math.abs(
          radiusAtRevolution(layout, revolutions) -
            (GROOVE.leadInRadius - CUT.programPitch * revolutions),
        ),
      );
    }
    check("and its radius is exactly the old straight line", worst === 0, worst);
    check(
      "IDEAL_CUTTING asks for no pitch control at all",
      IDEAL_CUTTING.pitch === null,
    );
  }

  // ── 決定論 ─────────────────────────────────────────────────────────
  {
    const source = quietThenLoud(10);
    const once = plan(source).pitches;
    const twice = plan(source).pitches;
    let identical = once.length === twice.length;
    for (let k = 0; k < once.length && identical; k++) {
      if (once[k] !== twice[k]) identical = false;
    }
    check("the same source and settings plan the same spiral every time", identical);

    // **解析の入口が配列の作り方に依らない。** 同じ中身を別の配列で渡しても同じ。
    const copied = {
      ...source,
      channels: source.channels.map((channel) => {
        const half = channel.length >> 1;
        const out = new Float32Array(channel.length);
        out.set(channel.subarray(0, half), 0);
        out.set(channel.subarray(half), half);
        return out;
      }),
    };
    const rebuilt = plan(copied).pitches;
    let same = true;
    for (let k = 0; k < once.length && same; k++) {
      if (once[k] !== rebuilt[k]) same = false;
    }
    check("and does not depend on how the samples were assembled", same);
    check(
      "an ideal cutting needs no iteration at all",
      plan(source).fit.iterations === 0 && plan(source).fit.converged,
    );
  }
}

console.log("\npitch map ↔ cut groove self-consistency");

/**
 * **半径 → カット結果 → 必要ピッチ → 半径 の循環**（`pitchControl.ts`）。
 *
 * プレビューが測るのはヘッド応答と溝の制約を通した**後**の変位で、その制約は
 * 半径で変わり、半径はこの pitch map が決めている。ロード時の反復でそれを解く。
 *
 * 見るのは6つ:
 *
 * 1. **ヘッド共振で変位が増える素材**では、反復後の溝は preview より広くなる。
 * 2. **制約で変位が減る素材**では、反復後の溝は preview より詰まる。
 * 3. **外周と内周で違う。** 同じ音でも内周ほど制約が強いので、内周ほど詰まる。
 * 4. **返した pitch map が実際に切った溝を収容する。** プランナーの内部ではなく
 *    `cutToGroove` が出した溝そのものを測る。
 * 5. **打ち切っても溝は当たらない。** 収束は詰まり方の話で、安全性は別に立つ。
 * 6. **反復回数まで決定論的。**
 */
{
  const RPM = CUT.cutRpm;
  const perRevolution = (SAMPLE_RATE * 60) / RPM;

  /**
   * 試験用の送り機構。**実機の値ではない** —— 短い音源で盤の外周から内周まで
   * 走らせるため、1回転あたりを実機の30倍ほど粗くしてある（そうしないと半径が
   * 変わるところまで行くのに20分の素材が要る）。
   */
  const control: PitchControlParameters = {
    previewRevolutions: 1,
    minPitch: 1e-3,
    maxPitch: 9e-3,
    maxChangePerRevolution: 9e-3,
    displacementGain: 110,
    verticalWeight: 0.5,
    // 低域の別枠は使わない。**収容の判定を lateral と vertical だけで書ける。**
    lowHz: 0,
    lowWeight: 0,
  };

  /** 全編おなじ音。**変わるのは半径だけ**という状況を作る。 */
  const uniform = (
    revolutions: number,
    hz: number,
    amplitude: number,
    hf = 0,
    hfHz = 5000,
  ) => {
    const frames = Math.round(revolutions * perRevolution);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const t = i / SAMPLE_RATE;
      const tone =
        amplitude * Math.sin(2 * Math.PI * hz * t) +
        hf * Math.sin(2 * Math.PI * hfHz * t);
      left[i] = tone;
      right[i] = tone * 0.9;
    }
    return { channels: [left, right], frames, revolutions };
  };

  const plan = (
    source: { channels: Float32Array[]; revolutions: number },
    cutting: CuttingParameters,
    over: Partial<PitchControlParameters> = {},
  ) =>
    planGroovePitch(
      source.channels,
      SAMPLE_RATE,
      cutting,
      { ...control, ...over },
      RPM,
      perRevolution,
      source.revolutions,
    );

  /** 60Hz を持ち上げるヘッド。**共振は変位を増やす向きに効く。** */
  const RESONANT: CuttingParameters = {
    ...IDEAL_CUTTING,
    head: { lowHz: 0, resonanceHz: 60, resonanceQ: 4, crosstalk: 0 },
  };
  /** 溝の限界だけ。**半径で変わる唯一の段**で、削るので変位は減る。 */
  const LIMITS: CuttingParameters = {
    ...IDEAL_CUTTING,
    limits: cuttingParametersFor("lathe").limits,
  };
  /** 高域リミッタだけ。半径には依らない。 */
  const DEESSER: CuttingParameters = {
    ...IDEAL_CUTTING,
    highFrequency: cuttingParametersFor("hot").highFrequency,
  };

  /**
   * **収容判定の許容値 1nm。** プランナーは変位を倍精度で積むが、切った溝は
   * `Float32Array` に入る（溝の1単位は 0.737µm なので、その丸めが 0.1nm 前後の
   * 差になる）。**溝の単位の1/700 であって、詰め方の話ではない。**
   */
  const TOUCH = 1e-9;

  /**
   * **実際に切った溝**を回転ごとに測って、必要な間隔を出す。プランナーの内部では
   * なく `cutToGroove` の出力を見るので、ここが通れば pitch map は本物の溝を
   * 収容している。
   */
  const shortfall = (
    source: { channels: Float32Array[]; frames: number; revolutions: number },
    cutting: CuttingParameters,
    pitches: Float64Array,
    over: Partial<PitchControlParameters> = {},
  ) => {
    const settings = { ...control, ...over };
    const layout = createCutLayout(
      source.frames / SAMPLE_RATE,
      SAMPLE_RATE,
      RPM,
      pitches,
    );
    const walls = cutToGroove(source.channels, SAMPLE_RATE, {
      parameters: cutting,
      layout,
    });
    const left = walls[0];
    const right = walls[1] ?? walls[0];
    const unitsToMetres = REFERENCE_WALL_VELOCITY / SAMPLE_RATE;
    const count = pitches.length;
    const room = new Float64Array(count);
    for (let i = 0; i < left.length; i++) {
      const k = Math.min(count - 1, Math.floor(i / perRevolution));
      const wanted =
        (Math.abs(left[i] + right[i]) +
          settings.verticalWeight * Math.abs(left[i] - right[i])) *
        Math.SQRT1_2 *
        unitsToMetres;
      if (wanted > room[k]) room[k] = wanted;
    }
    // 先読みぶん（隣り合う2本の**両方**を収める）まで含めた必要量と比べる。
    let worst = 0;
    for (let k = 0; k < count; k++) {
      const need =
        settings.minPitch +
        settings.displacementGain *
          Math.max(room[k], room[Math.min(count - 1, k + 1)]);
      worst = Math.max(worst, need - pitches[k]);
    }
    return worst;
  };

  // ── 1. ヘッド共振で変位が増える素材 ────────────────────────────────
  {
    const source = uniform(10, 60, 0.5);
    const preview = plan(source, IDEAL_CUTTING).pitches;
    const solved = plan(source, RESONANT);
    check(
      "a head resonance that lifts the bass forces the spiral open",
      solved.pitches[1] > preview[1] * 1.5,
      { preview: preview[1], solved: solved.pitches[1] },
    );
    check(
      "and it settles — the loop is not left hanging",
      solved.fit.converged && solved.fit.iterations >= 1,
      solved.fit,
    );
    check(
      "the settled map holds the groove that was actually cut",
      shortfall(source, RESONANT, solved.pitches) <= TOUCH,
      shortfall(source, RESONANT, solved.pitches),
    );
    // **preview のままではもう収まらない。** それが自己整合が要る理由そのもの。
    check(
      "while the pre-cutter preview would have let the grooves touch",
      shortfall(source, RESONANT, preview) > TOUCH,
      shortfall(source, RESONANT, preview),
    );
  }

  // ── 2. 高域リミッタで変位が減る素材 ────────────────────────────────
  //
  // 高域は変位をあまり持たないので（変位は 1/f）、**ディエッサーが pitch map を
  // 動かすのは素材が高域そのもののとき**である。8kHz を刻んだ盤で見る。
  {
    const source = uniform(8, 8000, 0.9);
    const over = { displacementGain: 1500 };
    const preview = plan(source, IDEAL_CUTTING, over).pitches;
    const solved = plan(source, DEESSER, over);
    check(
      "a groove the de-esser carves down asks for less room than the preview did",
      solved.pitches[4] < preview[4] * 0.95,
      { preview: preview[4], solved: solved.pitches[4] },
    );
    check(
      "and that tighter map still holds the groove that was actually cut",
      shortfall(source, DEESSER, solved.pitches, over) <= TOUCH,
      shortfall(source, DEESSER, solved.pitches, over),
    );
    check(
      "it settles too",
      solved.fit.converged && solved.fit.iterations >= 1,
      solved.fit,
    );
  }

  // ── 3. 外周と内周 ──────────────────────────────────────────────────
  //
  // **同じ音でも、内周ほど線速度が低い＝制約が強い**（§7.12）。削られたぶん溝は
  // 浅くなるので、必要な間隔も内周ほど小さい。理想のカッティングでは同じ音は
  // 同じ間隔になる（半径を見る段が1つも無い）。
  //
  // 最初の1回転だけはどちらでも広い。フィルタと積分器が静止から立ち上がる過渡が
  // そこに入るためで、半径の話ではない（だから比べるのは回転1から）。
  {
    const source = uniform(22, 60, 0.9, 0.7);
    const flat = plan(source, IDEAL_CUTTING).pitches;
    const solved = plan(source, LIMITS);
    const outer = solved.pitches[1];
    const inner = solved.pitches[solved.pitches.length - 1];
    check(
      "the same music needs a wider groove at the outer edge than near the label",
      inner < outer * 0.95,
      { outer, inner },
    );
    check(
      "at the outer edge the limiter takes nothing, so the preview was already right",
      Math.abs(outer - flat[1]) < flat[1] * 1e-3,
      { preview: flat[1], solved: outer },
    );
    // 1回転は 86400.86 サンプルで整数ではないので、回転の切れ目は波形に対して
    // 少しずつずれる。**それが 1e-4 の差**であって、半径の効果ではない。
    check(
      "while an ideal cutting gives the same music the same pitch everywhere",
      Math.abs(flat[flat.length - 1] - flat[1]) < flat[1] * 1e-4,
      { outer: flat[1], inner: flat[flat.length - 1] },
    );
    check(
      "and the map that came out holds the groove that was actually cut",
      shortfall(source, LIMITS, solved.pitches) <= TOUCH,
      shortfall(source, LIMITS, solved.pitches),
    );
    const layout = createCutLayout(
      source.frames / SAMPLE_RATE,
      SAMPLE_RATE,
      RPM,
      solved.pitches,
      solved.fit,
    );
    check(
      "and the spiral really did reach the inner radii",
      layout.programEndRadius < GROOVE.leadInRadius - 0.05,
      layout.programEndRadius,
    );
    // **逆写像も隣接距離も、反復した map の上でそのまま成り立つ。**
    let worstRevolution = 0;
    for (let step = 0; step <= 200; step++) {
      const revolutions = (step / 200) * layout.programRevolutions;
      worstRevolution = Math.max(
        worstRevolution,
        Math.abs(revolutionsAtRadius(layout, radiusAtRevolution(layout, revolutions)) - revolutions),
      );
    }
    check(
      "radius and revolutions still round-trip on the iterated map",
      worstRevolution < 1e-9,
      worstRevolution,
    );
    check(
      "and adjacent-groove spacing still reads per revolution",
      grooveSpacingAt(layout, 3.5) === solved.pitches[3],
    );
  }

  // ── 4・5. 打ち切りと安全性 ─────────────────────────────────────────
  //
  // **収束は詰まり方の話で、収容は別に立っている。** 最大反復で打ち切っても
  // 最後に実際の半径で測り直して引き上げるので、溝は当たらない。
  {
    const source = uniform(10, 60, 0.5);
    const full = plan(source, RESONANT);
    const ceiling = PITCH_SOLVER.maxIterations;
    PITCH_SOLVER.maxIterations = 1;
    const cut = plan(source, RESONANT);
    PITCH_SOLVER.maxIterations = ceiling;
    check(
      "stopping at the iteration ceiling is reported, not hidden",
      !cut.fit.converged && cut.fit.iterations === 1 && cut.fit.residual > 0,
      cut.fit,
    );
    check(
      "and the truncated map still holds the groove that was actually cut",
      shortfall(source, RESONANT, cut.pitches) <= TOUCH,
      shortfall(source, RESONANT, cut.pitches),
    );
    check(
      "letting it run to convergence never packs the side looser",
      full.pitches[1] <= cut.pitches[1] + 1e-12,
      { converged: full.pitches[1], truncated: cut.pitches[1] },
    );
  }

  // ── 6. 決定論 ──────────────────────────────────────────────────────
  {
    const source = uniform(22, 60, 0.9, 0.7);
    const once = plan(source, LIMITS);
    const twice = plan(source, LIMITS);
    let identical = once.fit.iterations === twice.fit.iterations;
    for (let k = 0; k < once.pitches.length && identical; k++) {
      if (once.pitches[k] !== twice.pitches[k]) identical = false;
    }
    check(
      "the same source and settings take the same number of iterations to the same spiral",
      identical,
      { iterations: once.fit.iterations },
    );
  }
}

console.log("\ncutter head and cutting constraints");

/**
 * 非理想なカッティング（`cutterHead.ts` / `cutting.ts`）。
 *
 * **測るのは溝そのもの**である。再生を通さずに溝バッファを直接見るので、ここで
 * 落ちたら原因はカッティング側にしかない。
 *
 * 見るのは7つ:
 *
 * 1. **理想ならビット一致。** 既定の `IDEAL_CUTTING` では従来の3段だけを通る。
 * 2. **限界以下は1ビットも変わらない。** 触れていない信号に痕跡を残さない。
 * 3. **超えたぶんだけ連続に歪む。** しきい値をまたいだところで段差が出ない。
 * 4. **外周と内周で余裕が違う。** 同じ高域信号が内周でだけ制限される。
 * 5. **低域モノラル化は縦だけを削る。** 横（L+R）は素通し。
 * 6. **ブロックの切り方に依らない。** 切った盤の再生が 128 でも 4096 でも同じ。
 * 7. **同じ音源・設定なら同じ盤。** 乱数も時計も入っていない。
 */
{
  const CUT_SECONDS = 2;
  const cutFrames = SAMPLE_RATE * CUT_SECONDS;

  /** 片チャンネルの正弦。振幅はフルスケールに対する比。 */
  const tone = (hz: number, amplitude: number, phase = 0) => {
    const samples = new Float32Array(cutFrames);
    for (let i = 0; i < cutFrames; i++) {
      samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE + phase);
    }
    return samples;
  };

  /** 溝の変位から速度（＝壁の差分）へ戻す。制限が効いたかはこちらに出る。 */
  const wallVelocity = (wall: Float32Array) => {
    const velocity = new Float64Array(wall.length);
    for (let i = 1; i < wall.length; i++) velocity[i] = wall[i] - wall[i - 1];
    return velocity;
  };
  const peakOf = (values: Float64Array, from: number) => {
    let top = 0;
    for (let i = from; i < values.length; i++) top = Math.max(top, Math.abs(values[i]));
    return top;
  };
  const identicalWalls = (a: Float32Array, b: Float32Array) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  const LATHE = cuttingParametersFor("lathe");

  // ── 1. 理想はビット一致 ─────────────────────────────────────────────
  {
    const stereo = [tone(1000, 0.8), tone(1000, 0.8, 0.7)];
    const before = cutToGroove(stereo, SAMPLE_RATE);
    const after = cutToGroove(stereo, SAMPLE_RATE, { parameters: IDEAL_CUTTING });
    check(
      "ideal cutting is bit-identical to the plain chain",
      before.length === after.length &&
        before.every((wall, index) => identicalWalls(wall, after[index])),
    );
    check(
      "and the default argument is the ideal one",
      identicalWalls(cutToGroove(stereo, SAMPLE_RATE)[0], before[0]),
    );
    check(
      "a mono source still comes back as one wall when ideal",
      cutToGroove([tone(1000, 0.5)], SAMPLE_RATE).length === 1,
    );
  }

  // ── 2. 限界以下は変わらない ─────────────────────────────────────────
  //
  // ヘッドも低域モノラル化も外し、**限界だけ**を入れる。触れない信号は
  // 1ビットも変わってはならない。
  {
    const onlyLimits = {
      ...IDEAL_CUTTING,
      limits: LATHE.limits,
    };
    // 1kHz・−12dBFS。RIAA でも持ち上がらない帯域で、限界にはまるで届かない。
    const quiet = [tone(1000, 0.25), tone(1000, 0.25, 1.1)];
    const plain = cutToGroove(quiet, SAMPLE_RATE);
    const limited = cutToGroove(quiet, SAMPLE_RATE, { parameters: onlyLimits });
    check(
      "a signal under every limit is cut bit-identically",
      identicalWalls(plain[0], limited[0]) && identicalWalls(plain[1], limited[1]),
    );

    // 同じ設定で、限界を超える信号は変わる。
    const loud = [tone(10000, 0.95), tone(10000, 0.95, 1.1)];
    const loudPlain = cutToGroove(loud, SAMPLE_RATE);
    const loudLimited = cutToGroove(loud, SAMPLE_RATE, { parameters: onlyLimits });
    check(
      "and one that exceeds them is not",
      !identicalWalls(loudPlain[0], loudLimited[0]),
    );
    check(
      "the limited groove is quieter than the unlimited one",
      peakOf(wallVelocity(loudLimited[0]), SAMPLE_RATE / 2) <
        peakOf(wallVelocity(loudPlain[0]), SAMPLE_RATE / 2),
    );
  }

  // ── 3. 超えたぶんだけ連続に ────────────────────────────────────────
  //
  // 入力レベルを上げていったとき、**削られる量が飛ばずに増える**こと。
  // ハードクリップならしきい値で折れ、ここが不連続になる。
  {
    const onlyLimits = { ...IDEAL_CUTTING, limits: LATHE.limits };
    const reduction = (amplitude: number) => {
      const source = [tone(8000, amplitude), tone(8000, amplitude, 0.4)];
      const plain = wallVelocity(cutToGroove(source, SAMPLE_RATE)[0]);
      const cut = wallVelocity(
        cutToGroove(source, SAMPLE_RATE, { parameters: onlyLimits })[0],
      );
      const from = Math.floor(SAMPLE_RATE / 2);
      return peakOf(cut, from) / peakOf(plain, from);
    };

    const levels = [0.2, 0.35, 0.5, 0.65, 0.8, 0.95];
    const curve = levels.map(reduction);
    check(
      "gentle levels come through untouched",
      curve[0] === 1 && curve[1] === 1,
      curve,
    );
    let monotone = true;
    let biggestStep = 0;
    for (let i = 1; i < curve.length; i++) {
      if (curve[i] > curve[i - 1] + 1e-6) monotone = false;
      biggestStep = Math.max(biggestStep, curve[i - 1] - curve[i]);
    }
    check("the reduction only ever grows with level", monotone, curve);
    check(
      "and grows continuously — no cliff at the threshold",
      biggestStep < 0.2,
      { biggestStep, curve },
    );
    check(
      "the loudest level is genuinely held back",
      curve[curve.length - 1] < 0.85,
      curve[curve.length - 1],
    );
  }

  // ── 4. 外周と内周で余裕が違う ──────────────────────────────────────
  //
  // **同じ音源・同じ設定**で、盤の長さだけを変える。長い盤は同じ信号を内周で
  // 切ることになるので、線速度が落ちたぶん先に限界へ当たる。
  {
    const onlyLimits = { ...IDEAL_CUTTING, limits: LATHE.limits };
    const hot = [tone(9000, 0.9), tone(9000, 0.9, 0.5)];

    /** 音源の後ろ半分がどの半径で切られるかは、その前に何回転あったかで決まる。 */
    const cutAtRadius = (leadSeconds: number) => {
      const leadFrames = SAMPLE_RATE * leadSeconds;
      const padded = hot.map((channel) => {
        const source = new Float32Array(leadFrames + channel.length);
        source.set(channel, leadFrames);
        return source;
      });
      const walls = cutToGroove(padded, SAMPLE_RATE, { parameters: onlyLimits });
      const plain = cutToGroove(padded, SAMPLE_RATE);
      const from = leadFrames + SAMPLE_RATE / 2;
      return (
        peakOf(wallVelocity(walls[0]), from) / peakOf(wallVelocity(plain[0]), from)
      );
    };

    // 外周（頭から）と、20分ぶん内側へ入ったところ。
    const outer = cutAtRadius(0);
    const inner = cutAtRadius(19 * 60);
    check(
      "the same tone is cut back harder at the inner groove",
      inner < outer - 0.05,
      { outer, inner },
    );
  }

  // ── 5. 低域モノラル化は縦だけ ──────────────────────────────────────
  {
    const onlyMono = { ...IDEAL_CUTTING, lowFrequency: LATHE.lowFrequency };
    // 60Hz の**純粋な縦成分**（L = −R）と、その上に乗る 60Hz の横成分。
    const vertical = tone(60, 0.6);
    const lateral = tone(60, 0.6, Math.PI / 2);
    const left = new Float32Array(cutFrames);
    const right = new Float32Array(cutFrames);
    for (let i = 0; i < cutFrames; i++) {
      left[i] = lateral[i] + vertical[i];
      right[i] = lateral[i] - vertical[i];
    }
    const plain = cutToGroove([left, right], SAMPLE_RATE);
    const monoed = cutToGroove([left, right], SAMPLE_RATE, { parameters: onlyMono });

    const component = (walls: Float32Array[], sign: number) => {
      const velocity = new Float64Array(cutFrames);
      const l = wallVelocity(walls[0]);
      const r = wallVelocity(walls[1]);
      for (let i = 0; i < cutFrames; i++) velocity[i] = (l[i] + sign * r[i]) * Math.SQRT1_2;
      return peakOf(velocity, SAMPLE_RATE / 2);
    };

    const lateralBefore = component(plain, 1);
    const lateralAfter = component(monoed, 1);
    const verticalBefore = component(plain, -1);
    const verticalAfter = component(monoed, -1);
    check(
      "low-frequency mono removes the vertical component",
      verticalAfter < verticalBefore * 0.1,
      { verticalBefore, verticalAfter },
    );
    // 横は数式の上では素通しだが、溝は単精度で持つ。変位は速度より2桁大きいので、
    // そこから差分で速度を取り出すと単精度の刻みが 1e-5 程度の相対誤差に見える。
    check(
      "and leaves the lateral one alone",
      Math.abs(lateralAfter / lateralBefore - 1) < 1e-4,
      { lateralBefore, lateralAfter },
    );

    // 高いほうは触らない。1kHz の縦成分はそのまま残る。
    const highVertical = tone(1000, 0.6);
    const highLeft = new Float32Array(cutFrames);
    const highRight = new Float32Array(cutFrames);
    for (let i = 0; i < cutFrames; i++) {
      highLeft[i] = highVertical[i];
      highRight[i] = -highVertical[i];
    }
    const highPlain = cutToGroove([highLeft, highRight], SAMPLE_RATE);
    const highMonoed = cutToGroove([highLeft, highRight], SAMPLE_RATE, {
      parameters: onlyMono,
    });
    check(
      "a vertical component above the crossover survives",
      component(highMonoed, -1) > component(highPlain, -1) * 0.9,
    );
  }

  // ── 6・7. 決定論とブロック非依存 ───────────────────────────────────
  {
    const source = [tone(6000, 0.9), tone(6000, 0.9, 0.3)];
    const once = cutToGroove(source, SAMPLE_RATE, { parameters: LATHE });
    const twice = cutToGroove(source, SAMPLE_RATE, { parameters: LATHE });
    check(
      "the same source and settings cut the same groove every time",
      identicalWalls(once[0], twice[0]) && identicalWalls(once[1], twice[1]),
    );
    check(
      "a different cutting preset cuts a different groove",
      !identicalWalls(
        once[0],
        cutToGroove(source, SAMPLE_RATE, {
          parameters: cuttingParametersFor("hot"),
        })[0],
      ),
    );

    // 切られた盤を鳴らす。**ブロックの切り方で1ビットも変わらない。**
    const groove = createGrooveBuffer(once, SAMPLE_RATE);
    const engine = (blockSize: number) => {
      const deck = createDeckEngine({ sampleRate: SAMPLE_RATE });
      deck.loadGroove(groove);
      return run(
        deck,
        baseInput({ stylusRadius: dropRadius(CUT_SECONDS, 0.25) }),
        SAMPLE_RATE,
        blockSize,
      );
    };
    const small = engine(PHYSICS_CHUNK_FRAMES);
    const large = engine(4096);
    check(
      "and playing it is block-size independent",
      identicalWalls(small.left, large.left) &&
        identicalWalls(small.right, large.right),
    );
  }

  // ── 制約は溝に残る ────────────────────────────────────────────────
  //
  // **これが目的そのもの。** 完全に理想の針（＝再生側は全段バイパス）で鳴らして
  // なお、制限を受けた盤と受けていない盤の音は違う。
  {
    const source = [tone(9000, 0.95), tone(9000, 0.95, 0.2)];
    const play = (walls: Float32Array[]) => {
      const deck = createDeckEngine({ sampleRate: SAMPLE_RATE });
      deck.loadGroove(createGrooveBuffer(walls, SAMPLE_RATE));
      return run(
        deck,
        baseInput({ stylusRadius: dropRadius(CUT_SECONDS, 0.25) }),
        SAMPLE_RATE,
        PHYSICS_CHUNK_FRAMES,
      ).left;
    };
    const ideal = play(cutToGroove(source, SAMPLE_RATE));
    const constrained = play(
      cutToGroove(source, SAMPLE_RATE, { parameters: LATHE }),
    );
    let worst = 0;
    for (let i = SAMPLE_RATE / 2; i < ideal.length; i++) {
      worst = Math.max(worst, Math.abs(ideal[i] - constrained[i]));
    }
    check(
      "a clean stylus still hears the cut it was given",
      worst > 1e-3,
      worst,
    );
  }
}

console.log("\nmanufacturing, transfer and adjacent-groove echo");

/**
 * 製造・転写工程と隣接溝の pre/post-echo（`manufacturing.ts`）。
 *
 * **測るのは溝そのもの**である。カットした溝と、製造を通した溝を直接比べるので、
 * ここで落ちたら原因は製造側にしかない。
 *
 * 見るのは8つ:
 *
 * 1. **理想ならビット一致。** 配列がそのまま返る（コピーすら作らない）。
 * 2. **転写を重ねるほど空間高域が落ちる。** 金属パーツの枚数で単調に増える。
 * 3. **内周ほど落ちる。** 分解能は距離で決まるので、同じ音でも内周では相対的に粗い。
 * 4. **強い溝でだけ局所変形が増える。** 降伏傾きに届かない溝は設定を変えても動かない。
 * 5. **狭い隣接溝ほどエコーが強い。** 距離の正本は `grooveSpacingAt`。
 * 6. **可変ピッチでは回転ごとにエコー量が変わる。**
 * 7. **45で回せばエコーの実時間間隔も縮む。** 焼き込まれた距離だから。
 * 8. **製造後も隣の溝と衝突していない。** 転写でもエコーでも溝は重ならない。
 *
 * 決定論とブロック非依存も併せて見る。
 */
{
  const RPM = CUT.cutRpm;
  const perRevolution = (SAMPLE_RATE * 60) / RPM;
  const SEED = manufacturingSeedFrom(0x51de);
  const PRESSED = manufacturingParametersFor("pressed");
  /** エコーだけを外した製造。転写と材料の話と、隣の溝の話を混ぜないため。 */
  const withoutEcho = (p: ManufacturingParameters): ManufacturingParameters => ({
    ...p,
    echo: { ...p.echo, preGain: 0, postGain: 0 },
  });

  const sine = (frames: number, hz: number, amplitude: number, phase = 0) => {
    const samples = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE + phase);
    }
    return samples;
  };
  const wallVelocity = (wall: Float32Array) => {
    const velocity = new Float64Array(wall.length);
    for (let i = 1; i < wall.length; i++) velocity[i] = wall[i] - wall[i - 1];
    return velocity;
  };
  const rmsOf = (values: Float64Array, from: number, to: number) => {
    let sum = 0;
    let count = 0;
    for (let i = from; i < Math.min(to, values.length); i++) {
      sum += values[i] * values[i];
      count += 1;
    }
    return Math.sqrt(sum / Math.max(1, count));
  };
  const peakBetween = (values: Float64Array, from: number, to: number) => {
    let top = 0;
    for (let i = Math.max(0, from); i < Math.min(to, values.length); i++) {
      top = Math.max(top, Math.abs(values[i]));
    }
    return top;
  };
  const dbOf = (a: number, b: number) => 20 * Math.log10(a / b);
  const identical = (a: Float32Array, b: Float32Array) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  /** 製造は入力を書き換えない約束なので、比較用に毎回同じ盤を作り直す。 */
  const press = (
    walls: Float32Array[],
    layout: ReturnType<typeof createCutLayout>,
    parameters: ManufacturingParameters,
    seed = SEED,
  ) =>
    manufactureGroove(
      walls.map((wall) => wall.slice()),
      SAMPLE_RATE,
      layout,
      parameters,
      seed,
    );

  // ── 1. 理想はビット一致 ─────────────────────────────────────────────
  {
    const frames = SAMPLE_RATE * 2;
    const walls = cutToGroove([sine(frames, 1000, 0.8)], SAMPLE_RATE);
    const layout = createCutLayout(2, SAMPLE_RATE);
    const made = manufactureGroove(
      walls,
      SAMPLE_RATE,
      layout,
      IDEAL_MANUFACTURING,
      SEED,
    );
    check(
      "ideal manufacturing hands back the very same groove",
      made === walls && made[0] === walls[0],
    );
    check(
      "and a mono lacquer stays a single wall",
      made.length === 1 && identical(made[0], walls[0]),
    );
    check(
      "the ideal preset really is ideal",
      isIdealManufacturing(manufacturingParametersFor("ideal")),
    );
    check(
      "while a pressed one is not",
      !isIdealManufacturing(PRESSED) && !isIdealManufacturing(
        manufacturingParametersFor("late-pressing"),
      ),
    );
  }

  // ── 2. 転写の回数と空間高域損失 ─────────────────────────────────────
  //
  // 金属パーツは**必ず奇数枚**（偶数だとプレス盤がネガになる）。枚数を増やすと
  // 同じ音が単調に鈍る —— 転写のたびに同じ分解能の壁を通るからである。
  {
    const seconds = 2;
    const frames = SAMPLE_RATE * seconds;
    const source = [sine(frames, 10000, 0.5), sine(frames, 10000, 0.5, 0.3)];
    const walls = cutToGroove(source, SAMPLE_RATE);
    const layout = createCutLayout(seconds, SAMPLE_RATE);
    const reference = rmsOf(wallVelocity(walls[0]), SAMPLE_RATE / 2, frames);
    const lossFor = (generations: number) =>
      dbOf(
        rmsOf(
          wallVelocity(
            press(walls, layout, { ...withoutEcho(PRESSED), generations })[0],
          ),
          SAMPLE_RATE / 2,
          frames,
        ),
        reference,
      );
    const one = lossFor(1);
    const three = lossFor(3);
    const five = lossFor(5);
    check(
      "every extra metal part costs more high-frequency detail",
      one < 0 && three < one && five < three,
      { one, three, five },
    );
    check(
      "an even part count is rounded up — a negative pressing cannot be played",
      identical(
        press(walls, layout, { ...withoutEcho(PRESSED), generations: 2 })[0],
        press(walls, layout, { ...withoutEcho(PRESSED), generations: 3 })[0],
      ),
    );
    // **時間軸のローパスではない**ことの裏取り: 同じ製造でも、低い音は落ちない。
    //
    // 寸法誤差は外しておく。**あれは高域損失ではなく倍率**なので（0.3%＝0.026dB）、
    // 混ぜると「低い音も動いた」ことになって主張がぼける。
    const exact: ManufacturingParameters = {
      ...withoutEcho(PRESSED),
      transfer: { ...PRESSED.transfer, tolerance: 0 },
    };
    const lowSource = [sine(frames, 500, 0.5), sine(frames, 500, 0.5, 0.3)];
    const lowWalls = cutToGroove(lowSource, SAMPLE_RATE);
    const lossThrough = (wall: Float32Array[], source: Float32Array[]) =>
      dbOf(
        rmsOf(wallVelocity(wall[0]), SAMPLE_RATE / 2, frames),
        rmsOf(wallVelocity(source[0]), SAMPLE_RATE / 2, frames),
      );
    const lowLoss = lossThrough(press(lowWalls, layout, exact), lowWalls);
    const highLoss = lossThrough(press(walls, layout, exact), walls);
    check(
      "and the loss is a spatial one — 500 Hz barely notices what 10 kHz cannot survive",
      Math.abs(lowLoss) < 0.01 && highLoss < -0.5,
      { lowLoss, highLoss },
    );
    check(
      "the dimensional tolerance is a scale, not a loss — it lifts 500 Hz as easily",
      Math.abs(
        dbOf(
          rmsOf(
            wallVelocity(press(lowWalls, layout, withoutEcho(PRESSED))[0]),
            SAMPLE_RATE / 2,
            frames,
          ),
          rmsOf(wallVelocity(lowWalls[0]), SAMPLE_RATE / 2, frames),
        ),
      ) > Math.abs(lowLoss),
    );
  }

  // ── 3. 外周と内周 ──────────────────────────────────────────────────
  //
  // 分解能は**距離**で決まる。溝1サンプルが表す距離は内周ほど小さいので、同じ
  // 音声周波数の空間波長が相対的に短くなり、**同じ工程でより多く失われる。**
  {
    const seconds = 60 * 16;
    const frames = SAMPLE_RATE * seconds;
    const source = [sine(frames, 10000, 0.5), sine(frames, 10000, 0.5, 0.3)];
    const walls = cutToGroove(source, SAMPLE_RATE);
    const layout = createCutLayout(seconds, SAMPLE_RATE);
    const made = press(walls, layout, withoutEcho(PRESSED));
    const window = SAMPLE_RATE * 20;
    const outer = dbOf(
      rmsOf(wallVelocity(made[0]), SAMPLE_RATE, window),
      rmsOf(wallVelocity(walls[0]), SAMPLE_RATE, window),
    );
    const inner = dbOf(
      rmsOf(wallVelocity(made[0]), frames - window, frames - SAMPLE_RATE),
      rmsOf(wallVelocity(walls[0]), frames - window, frames - SAMPLE_RATE),
    );
    check(
      "the same transfer costs far more near the label than at the outer edge",
      inner < outer - 2,
      { outer, inner },
    );
  }

  // ── 4. 強い溝でだけ増える局所変形 ───────────────────────────────────
  //
  // PVC は急な形ほど押し戻す。**降伏傾きに届かない溝では、降伏の設定を変えても
  // 1ビットも動かない** —— レベルに掛かるコンプレッサーではないことの証拠。
  {
    const seconds = 2;
    const frames = SAMPLE_RATE * seconds;
    const layout = createCutLayout(seconds, SAMPLE_RATE);
    const onlyVinyl: ManufacturingParameters = {
      ...withoutEcho(PRESSED),
      generations: 1,
      transfer: { resolution: 0, fillRadius: 0, tolerance: 0 },
      vinyl: { ...PRESSED.vinyl, fillRadius: 0 },
    };
    const stiff: ManufacturingParameters = {
      ...onlyVinyl,
      vinyl: { ...onlyVinyl.vinyl, relaxation: 0 },
    };
    const lossAt = (amplitude: number, parameters: ManufacturingParameters) => {
      const walls = cutToGroove(
        [sine(frames, 6000, amplitude), sine(frames, 6000, amplitude, 0.3)],
        SAMPLE_RATE,
      );
      return dbOf(
        rmsOf(
          wallVelocity(press(walls, layout, parameters)[0]),
          SAMPLE_RATE / 2,
          frames,
        ),
        rmsOf(wallVelocity(walls[0]), SAMPLE_RATE / 2, frames),
      );
    };
    const quiet = lossAt(0.2, onlyVinyl);
    const loud = lossAt(0.95, onlyVinyl);
    check(
      "a groove cut hard loses more than the same groove cut quietly",
      loud < quiet - 0.2,
      { quiet, loud },
    );
    check(
      "and a groove below the yield does not care about the yield settings at all",
      lossAt(0.2, stiff) === quiet && lossAt(0.95, stiff) > loud,
      { quiet, stiffQuiet: lossAt(0.2, stiff) },
    );
  }

  // ── 5・6. 隣接溝の pre/post-echo ───────────────────────────────────
  //
  // 隣の溝は螺旋上でちょうど1回転ぶん先／後にある。**距離の正本は
  // `grooveSpacingAt`** で、固定のディレイ時間ではない。
  {
    const revolutions = 3;
    const frames = Math.round(revolutions * perRevolution);
    const burstAt = Math.round(1.5 * perRevolution);
    const burstFrames = Math.round(0.08 * SAMPLE_RATE);
    /** 2回転目のまんなかにだけ置いたバースト。前後の回転は無音である。 */
    const burst = () => {
      const samples = new Float32Array(frames);
      for (let i = 0; i < burstFrames; i++) {
        samples[burstAt + i] =
          0.9 *
          Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE) *
          Math.sin((Math.PI * i) / burstFrames);
      }
      return samples;
    };
    const source = [burst(), burst()];
    const walls = cutToGroove(source, SAMPLE_RATE);

    /** 一定ピッチを外から与えて、隣の溝の距離だけを変える。 */
    const layoutWithPitch = (pitch: number) =>
      createCutLayout(
        frames / SAMPLE_RATE,
        SAMPLE_RATE,
        RPM,
        Float64Array.from({ length: revolutions }, () => pitch),
      );
    const echoesOf = (pitch: number) => {
      const layout = layoutWithPitch(pitch);
      const velocity = wallVelocity(press(walls, layout, PRESSED)[0]);
      const main = peakBetween(velocity, burstAt, burstAt + burstFrames);
      return {
        main,
        pre: peakBetween(
          velocity,
          Math.round(burstAt - perRevolution),
          Math.round(burstAt - perRevolution + burstFrames),
        ),
        post: peakBetween(
          velocity,
          Math.round(burstAt + perRevolution),
          Math.round(burstAt + perRevolution + burstFrames),
        ),
      };
    };

    const nominal = echoesOf(CUT.programPitch);
    check(
      "a burst leaves an echo exactly one revolution before and after it",
      nominal.pre > 0 && nominal.post > 0 && nominal.pre < nominal.main * 0.05,
      {
        pre: dbOf(nominal.pre, nominal.main),
        post: dbOf(nominal.post, nominal.main),
      },
    );
    // **pre と post は別々に扱える。** 実機と同じく pre のほうが強い設定にしてある。
    check(
      "pre-echo and post-echo are independent",
      nominal.pre > nominal.post * 1.5,
      { pre: nominal.pre, post: nominal.post },
    );
    check(
      "silencing one leaves the other",
      (() => {
        const layout = layoutWithPitch(CUT.programPitch);
        const preOnly = wallVelocity(
          press(walls, layout, {
            ...PRESSED,
            echo: { ...PRESSED.echo, postGain: 0 },
          })[0],
        );
        const before = peakBetween(
          preOnly,
          Math.round(burstAt - perRevolution),
          Math.round(burstAt - perRevolution + burstFrames),
        );
        const after = peakBetween(
          preOnly,
          Math.round(burstAt + perRevolution),
          Math.round(burstAt + perRevolution + burstFrames),
        );
        return before > 0 && after < before * 1e-3;
      })(),
    );

    // **狭いほど強い。** 距離が半分なら結合は exponent 乗ぶん増える。
    const tight = echoesOf(CUT.programPitch / 2);
    const wide = echoesOf(CUT.programPitch * 2);
    check(
      "a tighter groove spacing leaks more, a wider one leaks less",
      tight.pre > nominal.pre * 1.5 && wide.pre < nominal.pre * 0.7,
      { tight: tight.pre, nominal: nominal.pre, wide: wide.pre },
    );

    // **可変ピッチでは回転ごとに違う。** 同じ盤の中でエコー量が変わる。
    {
      const pitches = Float64Array.from([
        CUT.programPitch * 2,
        CUT.programPitch / 2,
        CUT.programPitch * 2,
      ]);
      const layout = createCutLayout(
        frames / SAMPLE_RATE,
        SAMPLE_RATE,
        RPM,
        pitches,
      );
      check(
        "the map, not a fixed delay, decides — spacing is read per revolution",
        grooveSpacingAt(layout, 0.5) === pitches[0] &&
          grooveSpacingAt(layout, 1.5) === pitches[1],
      );
      const velocity = wallVelocity(press(walls, layout, PRESSED)[0]);
      // pre-echo は回転1（狭い側）に書かれ、post-echo は回転2（広い側）へ出る。
      const pre = peakBetween(
        velocity,
        Math.round(burstAt - perRevolution),
        Math.round(burstAt - perRevolution + burstFrames),
      );
      const post = peakBetween(
        velocity,
        Math.round(burstAt + perRevolution),
        Math.round(burstAt + perRevolution + burstFrames),
      );
      check(
        "so a variable-pitch side has a different echo on each revolution",
        Math.abs(dbOf(pre, nominal.pre)) > 1 ||
          Math.abs(dbOf(post, nominal.post)) > 1,
        { pre: dbOf(pre, nominal.pre), post: dbOf(post, nominal.post) },
      );
    }

    // ── 7. 45 で回すとエコーの実時間間隔も縮む ─────────────────────────
    //
    // 焼き込まれているのは**盤上の距離**なので、速く回せばそのぶん早く来る。
    // 再生側にディレイは1つも無い（あったら速度で変わらない）。
    {
      const layout = layoutWithPitch(CUT.programPitch);
      const groove = createGrooveBuffer(press(walls, layout, PRESSED), SAMPLE_RATE);
      const playAt = (rpm: number) => {
        const deck = createDeckEngine({ sampleRate: SAMPLE_RATE });
        deck.loadGroove(groove, layout);
        return run(
          deck,
          baseInput({
            targetRpm: rpm,
            stylusRadius: radiusAtRevolution(layout, 0.2),
          }),
          Math.round(SAMPLE_RATE * 6),
          PHYSICS_CHUNK_FRAMES,
        ).left;
      };
      /** 立ち上がりの位置。しきい値をまたいだ最初のサンプルで測る。 */
      const onsetsIn = (played: Float32Array, threshold: number) => {
        const found: number[] = [];
        let quiet = true;
        for (let i = 0; i < played.length; i++) {
          const level = Math.abs(played[i]);
          if (quiet && level > threshold) {
            found.push(i);
            quiet = false;
          } else if (!quiet && level < threshold * 0.2) {
            quiet = true;
          }
        }
        return found;
      };
      const slow = playAt(NOMINAL_RPM);
      const fast = playAt(45);
      const slowPeak = peakBetween(
        Float64Array.from(slow),
        0,
        slow.length,
      );
      const slowOnsets = onsetsIn(slow, slowPeak * 0.02);
      const fastOnsets = onsetsIn(
        fast,
        peakBetween(Float64Array.from(fast), 0, fast.length) * 0.02,
      );
      const slowGap = slowOnsets.length >= 2 ? slowOnsets[1] - slowOnsets[0] : 0;
      const fastGap = fastOnsets.length >= 2 ? fastOnsets[1] - fastOnsets[0] : 0;
      check(
        "playing a 33⅓ disc at 45 brings the echo forward in real time too",
        slowGap > 0 &&
          fastGap > 0 &&
          Math.abs(slowGap / fastGap - 45 / NOMINAL_RPM) < 0.05,
        { slowGap, fastGap, ratio: slowGap / fastGap },
      );
    }
  }

  // ── 8. 製造しても隣の溝と衝突しない ────────────────────────────────
  //
  // 転写もエコーも溝の振れ幅を増やしうる。**pitch map は post-cutter の溝で
  // 解いてある**（§7.13）ので、製造がそれを食い潰していないことは別に確かめる。
  {
    const revolutions = 6;
    const frames = Math.round(revolutions * perRevolution);
    const loud = (phase: number) => {
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const t = i / SAMPLE_RATE;
        samples[i] =
          0.7 * Math.sin(2 * Math.PI * 60 * t + phase) +
          0.25 * Math.sin(2 * Math.PI * 3000 * t + phase);
      }
      return samples;
    };
    const walls = cutToGroove([loud(0), loud(0.4)], SAMPLE_RATE, {
      parameters: cuttingParametersFor("lathe"),
    });
    const layout = createCutLayout(frames / SAMPLE_RATE, SAMPLE_RATE, RPM);
    const made = press(walls, layout, manufacturingParametersFor("late-pressing"));
    const unitsToMetres = REFERENCE_WALL_VELOCITY / SAMPLE_RATE;
    let worst = 0;
    for (let k = 0; k < revolutions; k++) {
      const from = Math.round(k * perRevolution);
      const to = Math.min(frames, Math.round((k + 1) * perRevolution));
      let excursion = 0;
      for (let i = from; i < to; i++) {
        const lateral = Math.abs(made[0][i] + made[1][i]) * Math.SQRT1_2;
        if (lateral > excursion) excursion = lateral;
      }
      // 隣り合う2本がそれぞれ振れるので、中心間には両方ぶんが要る。
      worst = Math.max(
        worst,
        (2 * excursion * unitsToMetres) / grooveSpacingAt(layout, k),
      );
    }
    check(
      "even a tired pressing keeps the walls of adjacent grooves apart",
      worst < 1,
      { occupancy: worst },
    );
  }

  // ── 決定論とブロック非依存 ─────────────────────────────────────────
  {
    const seconds = 2;
    const frames = SAMPLE_RATE * seconds;
    const source = [sine(frames, 3000, 0.7), sine(frames, 3000, 0.7, 0.3)];
    const walls = cutToGroove(source, SAMPLE_RATE);
    const layout = createCutLayout(seconds, SAMPLE_RATE);
    const once = press(walls, layout, PRESSED);
    const twice = press(walls, layout, PRESSED);
    check(
      "the same lacquer, settings and seed press the same record every time",
      identical(once[0], twice[0]) && identical(once[1], twice[1]),
    );
    check(
      "a different plant seed presses a slightly different one",
      !identical(once[0], press(walls, layout, PRESSED, SEED ^ 0x5bf03)[0]),
    );
    check(
      "and the seed comes from the disc seed, deterministically",
      manufacturingSeedFrom(0x1234) === manufacturingSeedFrom(0x1234) &&
        manufacturingSeedFrom(0x1234) !== manufacturingSeedFrom(0x1235),
    );
    check(
      "manufacturing never writes into the lacquer it was given",
      identical(walls[0], cutToGroove(source, SAMPLE_RATE)[0]),
    );

    // 製造した盤を鳴らす。**ブロックの切り方で1ビットも変わらない。**
    const groove = createGrooveBuffer(once, SAMPLE_RATE);
    const play = (blockSize: number) => {
      const deck = createDeckEngine({ sampleRate: SAMPLE_RATE });
      deck.loadGroove(groove, layout);
      return run(
        deck,
        baseInput({ stylusRadius: radiusAtRevolution(layout, 0.25) }),
        SAMPLE_RATE,
        blockSize,
      );
    };
    const small = play(PHYSICS_CHUNK_FRAMES);
    const large = play(4096);
    check(
      "playing a pressed record is block-size independent",
      identical(small.left, large.left) && identical(small.right, large.right),
    );
  }
}

console.log("\ngroove wear from playing history");

/**
 * 再生履歴による溝の摩耗（`wear.ts`）。
 *
 * **測るのは「2回目の音が1回目と違うこと」**である。出力に足したエフェクトなら
 * 何度鳴らしても同じ音が出るので、ここが通れば形が変わっている証拠になる。
 *
 * 見るのは10個:
 *
 * 1. **摩耗ゼロならビット一致。** 何度鳴らしても1回目と同じ。
 * 2. **鳴らすほど減る。** 高曲率のところほど変形が大きい。
 * 3. **内周ほど、針圧が高いほど、鈍った針ほど、逆走ほど減る。**
 * 4. **針を上げていれば減らない。盤が止まっていても減らない。**
 * 5. **左右の壁は別々に減る。**
 * 6. **同じ操作履歴なら同じ結果。**
 * 7. **ブロック長に依らない。**
 * 8. **Reset で製造直後の盤へ完全に戻る。**
 * 9. **埃もハムも切ってなお、音楽そのものが変わっている。**
 * 10. **摩耗の場は溝バッファを複製していない。**
 */
{
  const SECONDS = 2;
  const frames = SAMPLE_RATE * SECONDS;
  const RPM = CUT.cutRpm;

  /**
   * 試験用の摩耗。**実機の 250倍の速さ**で減らす —— 現実の `vinyl` プリセットは
   * 1回通って 2e-4 しか進まないので、10回の検査では何も見えない。見ているのは
   * 進み方の**比**であって、絶対値ではない。
   */
  const FAST: WearParameters = {
    ...wearParametersFor("vinyl"),
    rate: 0.05,
  };

  const sine = (hz: number, amplitude: number, phase = 0) => {
    const samples = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE + phase);
    }
    return samples;
  };
  const rmsOf = (values: Float32Array, from: number) => {
    let sum = 0;
    let count = 0;
    for (let i = from; i < values.length; i++) {
      sum += values[i] * values[i];
      count += 1;
    }
    return Math.sqrt(sum / Math.max(1, count));
  };
  const identical = (a: Float32Array, b: Float32Array) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  /** 起動の過渡を外して比べる。**見たいのは溝の形の違いだけ。** */
  const SETTLED = SAMPLE_RATE / 2;
  const difference = (a: Float32Array, b: Float32Array) => {
    let worst = 0;
    for (let i = SETTLED; i < a.length; i++) {
      worst = Math.max(worst, Math.abs(a[i] - b[i]));
    }
    return worst;
  };

  /** 高曲率の溝。**摩耗が最初に食うのはここ。** */
  const demanding = cutToGroove([sine(9000, 0.9), sine(9000, 0.9, 0.7)], SAMPLE_RATE);
  const grooveOf = (walls: Float32Array[]) =>
    createGrooveBuffer(walls, SAMPLE_RATE);

  /**
   * 盤を1枚載せたデッキ。**`loadGroove` は摩耗の場を消さない**（同じ長さなら
   * 作り直さない）ので、これが「同じ盤をもう一度かける」ことになる。
   */
  const deckWith = (
    wear: WearParameters,
    walls: Float32Array[] = demanding,
    layout?: ReturnType<typeof createCutLayout>,
  ) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    const disc = grooveOf(walls);
    const map = layout ?? createCutLayout(SECONDS, SAMPLE_RATE);
    engine.setWear(wear);
    engine.loadGroove(disc, map);
    return { engine, disc, layout: map };
  };
  /**
   * 1回かける。**針を降ろし直し、盤の速さが定まってから**測る。
   *
   * 針を上げたまま「いったん完全に止める → 助走する」を通すので、何回目でも同じ
   * 速度から始まる（惰性で止まればクーロン摩擦が ω を厳密に 0 へ落とす・
   * `platterMotor.ts`）。**上げている間は摩耗しない**ので、助走は盤を減らさない。
   */
  const playAgain = (
    deck: ReturnType<typeof deckWith>,
    over: Partial<DeckEngineInput> = {},
    blockSize = PHYSICS_CHUNK_FRAMES,
  ) => {
    deck.engine.loadGroove(deck.disc, deck.layout);
    const input = baseInput({
      stylusRadius: radiusAtRevolution(deck.layout, 0.2),
      ...over,
    });
    const lifted = { ...input, stylusContact: false };
    // 完全停止 → その回し方で助走。どちらも針は上げたまま。
    run(
      deck.engine,
      { ...lifted, motorRequested: false, handAngularVelocity: null },
      SAMPLE_RATE * 2,
      blockSize,
    );
    run(deck.engine, lifted, SAMPLE_RATE * 2, blockSize);
    return run(deck.engine, input, frames, blockSize);
  };

  /**
   * **減る盤と減らない盤を、同じ操作でそろえて回す。**
   *
   * 比べる相手を毎回作り直さないのが要点である —— 盤の回転角は再生をまたいで
   * 積み上がるので（`phiUnwrapped`）、履歴の違う2台では 1 ULP の差が出る。
   * 同じ回数だけ回した2台なら、**残る違いは摩耗だけ**になる。
   */
  const twins = (
    walls: Float32Array[] = demanding,
    layout?: ReturnType<typeof createCutLayout>,
    wear: WearParameters = FAST,
  ) => ({
    worn: deckWith(wear, walls, layout),
    pristine: deckWith(NO_WEAR, walls, layout),
  });
  const playBoth = (
    pair: ReturnType<typeof twins>,
    over: Partial<DeckEngineInput> = {},
    blockSize = PHYSICS_CHUNK_FRAMES,
  ) => ({
    worn: playAgain(pair.worn, over, blockSize).left,
    pristine: playAgain(pair.pristine, over, blockSize).left,
  });

  // ── 1. 摩耗ゼロならビット一致 ──────────────────────────────────────
  {
    const pair = twins();
    const first = playBoth(pair);
    check(
      "the first play of a wearing record is bit-identical to one that never wears",
      identical(first.worn, first.pristine),
    );
    check(
      "and nothing has been recorded against the record that does not wear",
      pair.pristine.engine.wearSummary().plays === 0 &&
        pair.pristine.engine.wearSummary().peak === 0,
    );
    // **何度かけても同じ。** 減らない盤は減らない。
    let repeat = first.pristine;
    for (let i = 0; i < 4; i++) repeat = playAgain(pair.pristine).left;
    const reference = playAgain(deckWith(NO_WEAR)).left;
    check(
      "a record that does not wear still reads the same groove on the fifth play",
      identical(repeat, playAgain(pair.pristine).left) ||
        difference(repeat, reference) < 1e-6,
      difference(repeat, reference),
    );
  }

  // ── 2. 鳴らすほど減る ──────────────────────────────────────────────
  {
    const pair = twins();
    const after1 = playBoth(pair);
    const after2 = playBoth(pair);
    const second = difference(after2.worn, after2.pristine);
    let after10 = after2;
    for (let i = 0; i < 8; i++) after10 = playBoth(pair);
    const tenDiff = difference(after10.pristine, after10.worn);
    check(
      "the first play is untouched but the second is not",
      difference(after1.worn, after1.pristine) === 0 && second > 0,
      { firstPlay: difference(after1.worn, after1.pristine), secondPlay: second },
    );
    check(
      "and ten plays wear it more than two",
      tenDiff > second * 2,
      { two: second, ten: tenDiff },
    );
    // **減るのは高曲率のところ。** 9kHz を刻んだ溝は目に見えて鈍る。
    check(
      "a high-curvature groove loses level as it wears",
      rmsOf(after10.worn, SETTLED) < rmsOf(after10.pristine, SETTLED) * 0.98,
      {
        pristine: rmsOf(after10.pristine, SETTLED),
        worn: rmsOf(after10.worn, SETTLED),
      },
    );
    // 低い音を刻んだ盤は同じ距離を走っても変形が小さい（曲率が小さいので）。
    const gentle = twins(cutToGroove([sine(300, 0.9), sine(300, 0.9, 0.7)], SAMPLE_RATE));
    let gentleLast = playBoth(gentle);
    for (let i = 0; i < 9; i++) gentleLast = playBoth(gentle);
    const gentleLoss =
      1 - rmsOf(gentleLast.worn, SETTLED) / rmsOf(gentleLast.pristine, SETTLED);
    const sharpLoss =
      1 - rmsOf(after10.worn, SETTLED) / rmsOf(after10.pristine, SETTLED);
    check(
      "a gently cut groove survives the same mileage far better",
      gentleLoss < sharpLoss * 0.2,
      { gentleLoss, sharpLoss },
    );
  }

  // ── 3. 内周・針圧・鈍った針・逆走 ──────────────────────────────────
  {
    /** 送りを粗くして、短い盤の中に外周と内周を両方置く（実機の値ではない）。 */
    const coarse = Float64Array.from({ length: 2 }, () => 0.06);
    const spread = createCutLayout(SECONDS, SAMPLE_RATE, RPM, coarse);
    /**
     * **通った溝の平均の減り方。** 盤全体の平均でも最大でもなく、実際に針が乗った
     * セルだけを見る —— どこへ降ろすかで通るセルの数が変わるので、そうしないと
     * 「長く鳴らしたほうが最大値を引きやすい」という別の差が混じる。
     */
    const wornAfter = (
      over: Partial<DeckEngineInput>,
      wear: WearParameters = FAST,
      before?: (engine: ReturnType<typeof createDeckEngine>) => void,
    ) => {
      const deck = deckWith(wear, demanding, spread);
      before?.(deck.engine);
      playAgain(deck, over);
      const field = deck.engine.wearField();
      if (field === null) return 0;
      let sum = 0;
      let touched = 0;
      for (let i = 0; i < field.left.length; i++) {
        if (field.left[i] > 0) {
          sum += field.left[i];
          touched += 1;
        }
      }
      return touched === 0 ? 0 : sum / touched;
    };

    const outer = wornAfter({ stylusRadius: radiusAtRevolution(spread, 0.02) });
    const inner = wornAfter({ stylusRadius: radiusAtRevolution(spread, 1.0) });
    check(
      "the same music wears the record harder near the label than at the edge",
      inner > outer,
      { outer, inner },
    );

    // 針圧。**追える針でなければ意味が変わる**ので、どちらも追える設定で比べる。
    const stylusAt = (grams: number): StylusParameters => ({
      trackingForce: grams * 0.00980665,
      stylusMass: 0.45e-6,
      compliance: 15e-6 / 9.80665,
      damping: 0.9,
      referenceVelocity: REFERENCE_WALL_VELOCITY,
    });
    const light = wornAfter({}, FAST, (engine) => engine.setStylus(stylusAt(1)));
    const heavy = wornAfter({}, FAST, (engine) => engine.setStylus(stylusAt(2.5)));
    check(
      "a heavier tracking force wears it faster",
      heavy > light * 1.5,
      { light, heavy },
    );

    // 鈍った針。**谷へ入れないぶん肩で当たる**ので、削る量が増える。
    const sharpTip = wornAfter({}, FAST, (engine) => {
      engine.setStylus(stylusAt(1.8));
      engine.setStylusTip({ scanningRadius: 2e-6, transverseRadius: 5e-6 });
    });
    const bluntTip = wornAfter({}, FAST, (engine) => {
      engine.setStylus(stylusAt(1.8));
      engine.setStylusTip({ scanningRadius: 14e-6, transverseRadius: 16e-6 });
    });
    check(
      "a worn stylus wears the record faster than a sharp one",
      bluntTip > sharpTip,
      { sharpTip, bluntTip },
    );

    // 逆走。**針は前向きに作られている。**
    // 逆走は**手で回す**（セレクターに負の速度は無い。実機と同じ）。
    const byHand = rpmToRadPerSec(NOMINAL_RPM);
    const forward = wornAfter({
      motorRequested: false,
      handAngularVelocity: byHand,
    });
    const backward = wornAfter({
      motorRequested: false,
      handAngularVelocity: -byHand,
    });
    check(
      "scratching backwards wears it faster than playing it forwards",
      backward > forward,
      { forward, backward },
    );
  }

  // ── 4. 針上げ・停止中は変化なし ────────────────────────────────────
  {
    const deck = deckWith(FAST);
    playAgain(deck);
    const after = deck.engine.wearSummary().peak;
    playAgain(deck, { stylusContact: false });
    check(
      "a lifted stylus does not wear the record at all",
      deck.engine.wearSummary().peak === after,
      { after, lifted: deck.engine.wearSummary().peak },
    );
    const distance = deck.engine.wearSummary().distanceMetres;
    // **止まった盤。** 手を離して惰性で止めればクーロン摩擦が ω を厳密に 0 へ
    // 落とすので、針が降りていても溝の上を1µmも動かない。
    playAgain(deck, { motorRequested: false, handAngularVelocity: null });
    check(
      "and neither does a stopped platter with the stylus down",
      deck.engine.wearSummary().distanceMetres === distance,
      { distance, stopped: deck.engine.wearSummary().distanceMetres },
    );
  }

  // ── 5. 左右の壁は別々に減る ────────────────────────────────────────
  {
    // 左壁だけ高曲率、右壁は静か。**同じ盤の中で片側だけが削れる。**
    const lopsided = cutToGroove(
      [sine(9000, 0.9), sine(200, 0.05)],
      SAMPLE_RATE,
    );
    const deck = deckWith(FAST, lopsided);
    for (let i = 0; i < 4; i++) playAgain(deck);
    const field = deck.engine.wearField();
    let peakLeft = 0;
    let peakRight = 0;
    if (field !== null) {
      for (let i = 0; i < field.left.length; i++) {
        peakLeft = Math.max(peakLeft, field.left[i]);
        peakRight = Math.max(peakRight, field.right[i]);
      }
    }
    check(
      "the wall that carries the sharp modulation wears more than the quiet one",
      peakLeft > peakRight * 1.2,
      { peakLeft, peakRight },
    );
  }

  // ── 6・7. 決定論とブロック長 ───────────────────────────────────────
  {
    const historyOf = (blockSize: number) => {
      const deck = deckWith(FAST);
      let played = playAgain(deck, {}, blockSize);
      for (let i = 0; i < 3; i++) played = playAgain(deck, {}, blockSize);
      return { played, field: deck.engine.wearField() };
    };
    const once = historyOf(PHYSICS_CHUNK_FRAMES);
    const twice = historyOf(PHYSICS_CHUNK_FRAMES);
    const large = historyOf(4096);
    const sameField = (
      a: ReturnType<typeof historyOf>,
      b: ReturnType<typeof historyOf>,
    ) =>
      a.field !== null &&
      b.field !== null &&
      identical(a.field.left, b.field.left) &&
      identical(a.field.right, b.field.right);
    check(
      "the same playing history wears the record exactly the same way",
      sameField(once, twice) && identical(once.played.left, twice.played.left),
    );
    check(
      "and wearing it is block-size independent",
      sameField(once, large) && identical(once.played.left, large.played.left),
      {
        peak: once.field === null ? 0 : Math.max(...Array.from(once.field.left)),
      },
    );
  }

  // ── 8. Reset で製造直後へ戻る ──────────────────────────────────────
  {
    const pair = twins();
    let played = playBoth(pair);
    for (let i = 0; i < 5; i++) played = playBoth(pair);
    check(
      "a well-played record no longer sounds like a new one",
      !identical(played.worn, played.pristine),
    );
    pair.worn.engine.resetWear();
    check(
      "and the summary goes back to zero with it",
      pair.worn.engine.wearSummary().plays === 0 &&
        pair.worn.engine.wearSummary().peak === 0 &&
        pair.worn.engine.wearSummary().mean === 0,
      pair.worn.engine.wearSummary(),
    );
    const after = playBoth(pair);
    check(
      "reset takes it back to the record that came out of the press, bit for bit",
      identical(after.worn, after.pristine),
    );
  }

  // ── 9. 埃もハムも切って、なお音楽が変わっている ────────────────────
  //
  // **これが「出力に足したエフェクトではない」ことの証明**である。足したものなら
  // 切れば消える。減った形は残る。
  {
    const dusty = recordConditionFor("dusty", 0x77, 50);
    const grubby = recordConditionFor("poor-grounding", 0x77, 50);
    const pair = twins();
    const both = (apply: (engine: ReturnType<typeof createDeckEngine>) => void) => {
      apply(pair.worn.engine);
      apply(pair.pristine.engine);
    };
    // 埃だらけ・ハムありでさんざん鳴らす。**どちらの盤も同じ扱いを受ける。**
    both((engine) => {
      engine.setSurface(dusty.surface);
      engine.setHum(grubby.hum);
    });
    for (let i = 0; i < 6; i++) playBoth(pair);
    // 埃を払い、アースを直す。**盤の減りだけが残る。**
    both((engine) => {
      engine.setSurface(CLEAN_SURFACE);
      engine.setHum(IDEAL_HUM);
    });
    const afterwards = playBoth(pair);
    check(
      "wiping the dust and killing the hum does not undo the wear",
      !identical(afterwards.worn, afterwards.pristine) &&
        difference(afterwards.worn, afterwards.pristine) > 1e-4,
      difference(afterwards.worn, afterwards.pristine),
    );
    // 摩耗を消せば、埃もハムも無い盤は元どおり。**残っていたのは摩耗だけ。**
    pair.worn.engine.resetWear();
    const restored = playBoth(pair);
    check(
      "and once the wear is reset the clean record is bit-identical again",
      identical(restored.worn, restored.pristine),
      difference(restored.worn, restored.pristine),
    );
  }

  // ── 10. 溝バッファを複製していない ─────────────────────────────────
  {
    const deck = deckWith(FAST);
    const field = deck.engine.wearField();
    check(
      "the wear field is a coarse map, not a second copy of the groove",
      field !== null &&
        field.cellSamples === WEAR_CELL_SAMPLES &&
        field.left.length < frames / 8,
      field === null
        ? "none"
        : {
            cells: field.left.length,
            grooveFrames: frames,
            bytes: field.left.length * 8,
          },
    );
    // 元の溝は不変。**摩耗は別の場に溜まる。**
    playAgain(deck);
    playAgain(deck);
    check(
      "and the pressed groove it was given is never written to",
      identical(deck.disc.walls[0], demanding[0]) &&
        identical(deck.disc.walls[1], demanding[1]),
    );
  }
}

console.log("\nlevel calibration and overload");

/**
 * カートリッジ出力から Web Audio までのレベル校正（`levels.ts`）。
 *
 * 見るのは8つ:
 *
 * 1. **単位が繋がっている。** 溝の壁1単位 = 横5cm/s = 25mV = 0 dBFS。
 * 2. **基準設定はビット一致。** 利得の積が厳密に1で、どの段も働かない。
 * 3. **通常の音楽では飽和もセーフティも0回。**
 * 4. **クリックとミストラッキングはフォノ段の入力で受ける**（RIAAより前）。
 * 5. **低域の反りはライン出力で受ける**（RIAAより後）。
 * 6. **セーフティ段は天井より下では1ビットも触らず、超えたぶんだけ働く。**
 * 7. **低域を黙って消さない。** rumble filter は入れたときだけ効く。
 * 8. **感度とゲインを変えると、変わるべきものだけが変わる。**
 */
{
  /** 盤は2秒、鳴らすのは1秒。**溝を走り切らせない**（切れた後は無音になる）。 */
  const SECONDS = 2;
  const frames = SAMPLE_RATE * SECONDS;
  const RENDER = SAMPLE_RATE;

  const sine = (hz: number, amplitude: number, phase = 0) => {
    const samples = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE + phase);
    }
    return samples;
  };
  const peakOfBoth = (played: { left: Float32Array; right: Float32Array }) => {
    let top = 0;
    for (let i = 0; i < played.left.length; i++) {
      top = Math.max(top, Math.abs(played.left[i]), Math.abs(played.right[i]));
    }
    return top;
  };
  const identical = (a: Float32Array, b: Float32Array) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  const layout = createCutLayout(SECONDS, SAMPLE_RATE);
  const discOf = (hz: number, amplitude: number) =>
    createGrooveBuffer(
      cutToGroove([sine(hz, amplitude), sine(hz, amplitude, 0.3)], SAMPLE_RATE),
      SAMPLE_RATE,
    );
  const playWith = (
    disc: ReturnType<typeof createGrooveBuffer>,
    setup?: (engine: ReturnType<typeof createDeckEngine>) => void,
    over: Partial<DeckEngineInput> = {},
  ) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    setup?.(engine);
    engine.loadGroove(disc, layout);
    const input = baseInput({
      stylusRadius: radiusAtRevolution(layout, 0.2),
      ...over,
    });
    const played = run(engine, input, RENDER, PHYSICS_CHUNK_FRAMES);
    return { engine, played, telemetry: engine.levelTelemetry() };
  };

  // ── 1. 単位 ───────────────────────────────────────────────────────
  {
    // 基準の盤（1kHz・横5cm/s）＝ 壁1単位 ＝ 25mV ＝ 0 dBFS。
    check(
      "one groove unit is 25 mV on the reference cartridge",
      Math.abs(voltsPerGrooveUnit(REFERENCE_LEVELS.cartridgeSensitivity) - 0.025) <
        1e-12,
      voltsPerGrooveUnit(REFERENCE_LEVELS.cartridgeSensitivity),
    );
    check(
      "and the phono gain that puts it at 0 dBFS is 32.04 dB",
      Math.abs(phonoGainForReference(5) - 32.0412) < 1e-3,
      phonoGainForReference(5),
    );
    // **感度が下がれば、同じ 0 dBFS へ持ち上げるゲインは増える。**
    check(
      "a low-output cartridge needs exactly the gain its sensitivity is short by",
      Math.abs(
        phonoGainForReference(0.4) - phonoGainForReference(5) - 20 * Math.log10(5 / 0.4),
      ) < 1e-9,
    );
    // **物理基準とデジタル基準は別物。**
    //
    // 測るのは −12dB で切った盤にする。フルスケールの盤はライン基準では 1.0 ＝
    // セーフティの天井（−1dBFS）より上なので、**そちらを測ると天井を測って
    // しまう**（それ自体は正しい動作）。ここで見たいのは校正の位置である。
    const quiet = discOf(1000, 0.25);
    const calibrated = playWith(quiet);
    const line = playWith(quiet, (engine) => engine.setLevels(LINE_LEVELS));
    const lineDb = 20 * Math.log10(peakOfBoth(line.played));
    const digitalDb = 20 * Math.log10(peakOfBoth(calibrated.played));
    check(
      "the line output keeps the physical reference (−12 dB cut → −12 dB line)",
      Math.abs(lineDb - -20 * Math.log10(4)) < 1,
      lineDb,
    );
    check(
      "and the digital output sits the calibration below it",
      Math.abs(digitalDb - lineDb - DIGITAL_CALIBRATION_DB) < 0.01,
      { lineDb, digitalDb, calibration: DIGITAL_CALIBRATION_DB },
    );
    check(
      "so 0 dBFS is 10 cm/s lateral — twice the standard cutting level",
      Math.abs(DIGITAL_CALIBRATION_DB - -20 * Math.log10(2)) < 0.05,
      DIGITAL_CALIBRATION_DB,
    );
    // **校正はライン基準より前の物理を1dBも動かさない。**
    const full = playWith(discOf(1000, 1));
    check(
      "and the phono input still sees the 25 mV of a nominal 5 cm/s groove",
      Math.abs(full.telemetry.inputPeakMv - 25) < 2,
      full.telemetry.inputPeakMv,
    );
  }

  // ── 2・3. 基準設定は透明 ──────────────────────────────────────────
  {
    const music = discOf(1000, 0.7);
    const plain = playWith(music);
    const legacy = playWith(music, (engine) => engine.setLevels(LINE_LEVELS));
    const measured = playWith(music, (engine) => engine.setLevels(MEASURE_ONLY));
    // **互換設定（校正 0dB）では従来どおり。** 段を1つも通していない出力と一致する。
    check(
      "with the calibration at 0 dB the chain is bit-identical to no output stage",
      identical(legacy.played.left, measured.played.left) &&
        identical(legacy.played.right, measured.played.right),
    );
    check(
      "and the shipped calibration only scales it, nothing else",
      (() => {
        const scale = Math.pow(10, DIGITAL_CALIBRATION_DB / 20);
        for (let i = 0; i < plain.played.left.length; i++) {
          if (Math.abs(plain.played.left[i] - legacy.played.left[i] * scale) > 1e-7) {
            return false;
          }
        }
        return true;
      })(),
    );
    check(
      "and nothing saturates on ordinary music",
      plain.telemetry.inputOverloads === 0 &&
        plain.telemetry.outputOverloads === 0 &&
        plain.telemetry.safetyEvents === 0 &&
        plain.telemetry.safetyReductionDb === 0,
      plain.telemetry,
    );
    // メーターは**放送用と同じで落ちる**（20dB/s）。読めるのは「いま出ている
    // レベル」であって通しての最大値ではないので、比べる相手も**直近0.1秒**に
    // 揃える（それ以前の一瞬の跳ねは、メーターからはもう落ちている）。
    const recent = {
      left: plain.played.left.subarray(RENDER - SAMPLE_RATE / 10),
      right: plain.played.right.subarray(RENDER - SAMPLE_RATE / 10),
    };
    const settled = {
      left: plain.played.left.subarray(RENDER / 2),
      right: plain.played.right.subarray(RENDER / 2),
    };
    let square = 0;
    for (let i = 0; i < settled.left.length; i++) {
      square += (settled.left[i] * settled.left[i] + settled.right[i] * settled.right[i]) / 2;
    }
    const trueRms = Math.sqrt(square / settled.left.length);
    check(
      "the meters read the level that is actually coming out",
      Math.abs(20 * Math.log10(plain.telemetry.peak / peakOfBoth(recent))) < 0.2 &&
        plain.telemetry.truePeak >= plain.telemetry.peak,
      { peak: plain.telemetry.peak, played: peakOfBoth(recent) },
    );
    check(
      "and the running RMS lands on the real one",
      Math.abs(20 * Math.log10(plain.telemetry.rms / trueRms)) < 0.5,
      { meter: plain.telemetry.rms, measured: trueRms },
    );
  }

  // ── 4. 高域の過大はフォノ段の入力で受ける ─────────────────────────
  //
  // **RIAA より前は高域が持ち上がったまま**なので、尖ったものほどここへ来る。
  // 逆に RIAA を通った後では高域は下がっているので、ライン段には届かない。
  {
    const hotTreble = createGrooveBuffer(
      cutToGroove(
        [
          (() => {
            const a = new Float32Array(frames);
            for (let i = 0; i < frames; i++) {
              const t = i / SAMPLE_RATE;
              a[i] =
                0.95 * Math.sin(2 * Math.PI * 12000 * t) * 0.5 +
                0.95 * Math.sin(2 * Math.PI * 8000 * t) * 0.5;
            }
            return a;
          })(),
          (() => {
            const a = new Float32Array(frames);
            for (let i = 0; i < frames; i++) {
              const t = i / SAMPLE_RATE;
              a[i] =
                0.95 * Math.sin(2 * Math.PI * 12000 * t + 0.4) * 0.5 +
                0.95 * Math.sin(2 * Math.PI * 8000 * t + 0.2) * 0.5;
            }
            return a;
          })(),
        ],
        SAMPLE_RATE,
      ),
      SAMPLE_RATE,
    );
    const treble = playWith(hotTreble);
    check(
      "a hot pair of high tones overloads the phono input, not the line stage",
      treble.telemetry.inputOverloads > 0 && treble.telemetry.outputOverloads === 0,
      {
        input: treble.telemetry.inputOverloads,
        line: treble.telemetry.outputOverloads,
        mv: treble.telemetry.inputPeakMv,
      },
    );
    // **同じ盤を出力の小さいカートリッジで読めば通る。** 入る電圧が 1/12 なので、
    // 実機で MC が入力段を詰まらせにくいのと同じ理由である。
    const lowOutput = playWith(hotTreble, (engine) =>
      engine.setLevels(levelParametersFor("low-output")),
    );
    check(
      "a low-output cartridge rides the same groove without overloading",
      lowOutput.telemetry.inputOverloads === 0 &&
        lowOutput.telemetry.inputPeakMv < treble.telemetry.inputPeakMv,
      { mm: treble.telemetry.inputPeakMv, mc: lowOutput.telemetry.inputPeakMv },
    );
    // 普通の音楽は同じ段に指1本触れない。
    const music = playWith(discOf(1000, 0.5));
    check(
      "while ordinary music never touches it",
      music.telemetry.inputOverloads === 0,
      music.telemetry.inputPeakMv,
    );

    // **深い傷は全部の段を鳴らす。** 尖りも大きさも桁違いなので、入力段だけで
    // 収まる話ではない —— それが「盤を捨てる」ということである。
    const scratched: SurfaceParameters = {
      ...CLEAN_SURFACE,
      seed: 0x9a,
      scratches: {
        count: 400,
        width: 120e-6,
        depth: 120e-6,
        curvature: 0,
        length: 0.09,
      },
    };
    const clicky = playWith(discOf(1000, 0.5), (engine) =>
      engine.setSurface(scratched),
    );
    check(
      "a ruined record overloads every stage it passes through",
      clicky.telemetry.inputOverloads > 0 &&
        clicky.telemetry.outputOverloads > 0 &&
        clicky.telemetry.safetyEvents > 0,
      {
        input: clicky.telemetry.inputOverloads,
        line: clicky.telemetry.outputOverloads,
        safety: clicky.telemetry.safetyEvents,
      },
    );
  }

  // ── 5. 低域の反りはライン出力で受ける ──────────────────────────────
  {
    // 反りは RIAA の後で持ち上がる。**入力段ではなく出力段が受ける。**
    const warped: DiscShapeParameters = {
      seed: 0x31,
      eccentricity: { offset: 0 },
      warp: { dish: 0, amplitude: 4e-3, harmonics: 1 },
    };
    const music = discOf(1000, 0.5);
    const hot = playWith(music, (engine) => {
      engine.setDiscShape(warped);
      // 反りをコイルへ残すには理想のアーム（質量ゼロ）のまま。**盤の話**である。
      engine.setLevels({
        ...REFERENCE_LEVELS,
        outputHeadroomDb: 0,
        safetyCeilingDbfs: 60,
      });
    });
    check(
      "a heavy warp saturates the line stage, not the phono input",
      hot.telemetry.outputOverloads > 0 && hot.telemetry.inputOverloads === 0,
      {
        input: hot.telemetry.inputOverloads,
        line: hot.telemetry.outputOverloads,
      },
    );
    // **反りが小さければどの段も働かない。**
    const gentle = playWith(music, (engine) => {
      engine.setDiscShape({
        ...warped,
        warp: { dish: 0, amplitude: 0.15e-3, harmonics: 1 },
      });
    });
    check(
      "an ordinary warp passes through every stage untouched",
      gentle.telemetry.outputOverloads === 0 &&
        gentle.telemetry.inputOverloads === 0 &&
        gentle.telemetry.safetyEvents === 0,
      gentle.telemetry,
    );
  }

  // ── 6. セーフティ段 ───────────────────────────────────────────────
  {
    const loud = discOf(1000, 1);
    // 天井より下では**1ビットも触らない**。ゲインを 6dB 上げて超えさせる。
    const under = playWith(loud, (engine) =>
      engine.setLevels({ ...REFERENCE_LEVELS, safetyCeilingDbfs: 12 }),
    );
    const over = playWith(loud, (engine) =>
      engine.setLevels({
        ...REFERENCE_LEVELS,
        phonoGainDb: REFERENCE_LEVELS.phonoGainDb + 6,
        outputHeadroomDb: 60,
      }),
    );
    check(
      "below the ceiling the safety stage is a bit-exact pass-through",
      under.telemetry.safetyEvents === 0 &&
        identical(
          under.played.left,
          playWith(loud, (engine) =>
            engine.setLevels({ ...MEASURE_ONLY, digitalCalibrationDb: DIGITAL_CALIBRATION_DB }),
          ).played.left,
        ),
    );
    check(
      "above it, it holds the output at the ceiling and says how much it took",
      over.telemetry.safetyEvents > 0 &&
        peakOfBoth(over.played) <= 1 + 1e-6 &&
        over.telemetry.safetyMaxReductionDb > 0,
      {
        peak: peakOfBoth(over.played),
        reduction: over.telemetry.safetyMaxReductionDb,
        engaged: over.telemetry.safetyEvents,
      },
    );
    // **音量を一律に下げていない。** 天井より下の部分はそのまま通っている。
    const quietPart = playWith(discOf(1000, 0.2), (engine) =>
      engine.setLevels({
        ...REFERENCE_LEVELS,
        phonoGainDb: REFERENCE_LEVELS.phonoGainDb + 6,
      }),
    );
    check(
      "a quiet passage under the same hot gain is simply 6 dB louder, not limited",
      quietPart.telemetry.safetyEvents === 0 &&
        Math.abs(
          20 *
            Math.log10(
              peakOfBoth(quietPart.played) / peakOfBoth(playWith(discOf(1000, 0.2)).played),
            ) - 6,
        ) < 0.1,
    );
  }

  // ── 7. 低域を黙って消さない ───────────────────────────────────────
  {
    const warped: DiscShapeParameters = {
      seed: 0x31,
      eccentricity: { offset: 0 },
      warp: { dish: 0, amplitude: 1e-3, harmonics: 1 },
    };
    const music = discOf(1000, 0.4);
    const withWarp = (rumbleFilterHz: number) =>
      playWith(music, (engine) => {
        engine.setDiscShape(warped);
        engine.setLevels({ ...REFERENCE_LEVELS, rumbleFilterHz });
      });
    const kept = withWarp(0);
    const filtered = withWarp(30);
    // 反りは 0.55Hz。フィルタを入れなければ**そのまま残る。**
    const lowEnergy = (played: { left: Float32Array }) => {
      let sum = 0;
      let mean = 0;
      for (let i = 0; i < played.left.length; i++) mean += played.left[i];
      mean /= played.left.length;
      for (let i = 0; i < played.left.length; i++) {
        sum += (played.left[i] - mean) * (played.left[i] - mean);
      }
      return sum;
    };
    check(
      "the subsonic content of a warp is still there when no filter was asked for",
      lowEnergy(kept.played) > 0 && kept.telemetry.peak > filtered.telemetry.peak,
      { kept: kept.telemetry.peak, filtered: filtered.telemetry.peak },
    );
    check(
      "and asking for a rumble filter is the only thing that removes it",
      filtered.telemetry.peak < kept.telemetry.peak,
    );
  }

  // ── 8. 感度とゲイン ───────────────────────────────────────────────
  {
    // **天井に触れない高さで比べる。** 触れていたら測っているのは利得ではなく
    // セーフティ段になる。
    const music = discOf(1000, 0.25);
    const reference = playWith(music);
    const mc = playWith(music, (engine) =>
      engine.setLevels(levelParametersFor("low-output")),
    );
    const hot = playWith(music, (engine) =>
      engine.setLevels(levelParametersFor("hot")),
    );
    check(
      "a matched low-output cartridge comes out at the same level",
      Math.abs(
        20 * Math.log10(peakOfBoth(mc.played) / peakOfBoth(reference.played)),
      ) < 0.01,
      20 * Math.log10(peakOfBoth(mc.played) / peakOfBoth(reference.played)),
    );
    check(
      "but sees a twelfth of the voltage at the phono input",
      Math.abs(mc.telemetry.inputPeakMv / reference.telemetry.inputPeakMv - 0.4 / 5) <
        1e-3,
      { mm: reference.telemetry.inputPeakMv, mc: mc.telemetry.inputPeakMv },
    );
    check(
      "and a hotter phono stage is exactly 6 dB louder",
      Math.abs(
        20 * Math.log10(peakOfBoth(hot.played) / peakOfBoth(reference.played)) - 6,
      ) < 0.01,
    );
    check(
      "while the phono input, being before the gain, does not move",
      Math.abs(hot.telemetry.inputPeakMv - reference.telemetry.inputPeakMv) < 1e-9,
    );
  }

  // ── 密な音楽で Safety が働かないこと（監査で見つかった不具合の回帰検査）──
  //
  // **RIAA の録音→再生は振幅では戻るが位相は戻らない。** マスタリングで潰された
  // クレストがその位相回転で作り直されるので、**RMS はそのままピークだけが上がる**。
  // 5cm/s を 0 dBFS へ置いていたときは、この復元ぶんがそのまま天井を越えていた。
  {
    /** 現代のマスター相当。**ピークは 0 dBFS、クレストは詰めてある。** */
    const master = (drive: number, phase: number) => {
      const partials: [number, number][] = [
        [55, 1.0], [110, 0.8], [165, 0.5], [220, 0.45], [330, 0.3], [440, 0.28],
        [660, 0.2], [880, 0.18], [1320, 0.14], [1760, 0.12], [2640, 0.09],
        [3520, 0.07], [5280, 0.05], [7040, 0.04], [10560, 0.025],
      ];
      const raw = new Float64Array(frames);
      for (let i = 0; i < frames; i++) {
        const t = i / SAMPLE_RATE;
        let v = 0;
        for (let k = 0; k < partials.length; k++) {
          v += partials[k][1] * Math.sin(2 * Math.PI * partials[k][0] * t + phase + k * 1.7);
        }
        raw[i] = v;
      }
      let top = 0;
      for (let i = 0; i < frames; i++) top = Math.max(top, Math.abs(raw[i]));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        out[i] = Math.tanh((raw[i] / top) * drive) / Math.tanh(drive);
      }
      return out;
    };
    const crestOf = (x: Float32Array) => {
      let top = 0;
      let square = 0;
      for (let i = 0; i < x.length; i++) {
        top = Math.max(top, Math.abs(x[i]));
        square += x[i] * x[i];
      }
      return 20 * Math.log10(top / Math.sqrt(square / x.length));
    };

    // 緩いものから極端に潰したものまで。**どれも Safety は一度も働かないこと。**
    for (const drive of [1.2, 2.2, 3.5, 5.0]) {
      const source = [master(drive, 0), master(drive, 0.4)];
      const disc = createGrooveBuffer(cutToGroove(source, SAMPLE_RATE), SAMPLE_RATE);
      const played = playWith(disc);
      let over = 0;
      for (let i = 0; i < played.played.left.length; i++) {
        if (Math.abs(played.played.left[i]) > 1 || Math.abs(played.played.right[i]) > 1) {
          over += 1;
        }
      }
      check(
        `a master limited to ${crestOf(source[0]).toFixed(1)} dB crest never engages the safety`,
        played.telemetry.safetyEvents === 0 &&
          played.telemetry.safetyDutyRatio === 0 &&
          played.telemetry.safetyReductionDb === 0,
        {
          events: played.telemetry.safetyEvents,
          duty: played.telemetry.safetyDutyRatio,
          peak: 20 * Math.log10(peakOfBoth(played.played)),
        },
      );
      check(
        "and nothing above full scale reaches the destination",
        over === 0 && peakOfBoth(played.played) <= 1,
        peakOfBoth(played.played),
      );
    }
  }

  // ── 天井を超える値は destination へ渡さない ───────────────────────
  {
    // 4mm の反り。**セーフティが掴むべき異常**で、天井は超えさせない。
    const warped: DiscShapeParameters = {
      seed: 0x31,
      eccentricity: { offset: 0 },
      warp: { dish: 0, amplitude: 4e-3, harmonics: 1 },
    };
    const wild = playWith(discOf(1000, 0.5), (engine) => engine.setDiscShape(warped));
    const ceiling = Math.pow(10, REFERENCE_LEVELS.safetyCeilingDbfs / 20);
    check(
      "a 4 mm warp is caught by the safety, and it says so as an event",
      wild.telemetry.safetyEvents > 0 && wild.telemetry.safetyMaxReductionDb > 0,
      {
        events: wild.telemetry.safetyEvents,
        duty: wild.telemetry.safetyDutyRatio,
        max: wild.telemetry.safetyMaxReductionDb,
      },
    );
    check(
      "and the output never exceeds the ceiling, let alone full scale",
      peakOfBoth(wild.played) <= ceiling + 1e-9 && ceiling < 1,
      { peak: peakOfBoth(wild.played), ceiling },
    );
  }

  // ── telemetry: 現在値 / 最大 / 時間率 / 回数 を分ける ─────────────
  {
    const chain = createOutputChain(REFERENCE_LEVELS, SAMPLE_RATE);
    const ceiling = Math.pow(10, REFERENCE_LEVELS.safetyCeilingDbfs / 20);
    // 天井の2倍がセーフティへ入るように、**校正のぶんを戻して**から入れる。
    const overshoot = (2 * ceiling) / Math.pow(10, DIGITAL_CALIBRATION_DB / 20);
    chain.input(overshoot, overshoot);
    chain.output(overshoot, overshoot, 0, 0);
    const firstEvents = chain.telemetry.safetyEvents;
    const firstNow = chain.telemetry.safetyReductionDb;
    for (let i = 0; i < SAMPLE_RATE; i++) {
      chain.input(0, 0);
      chain.output(0, 0, 0, 0);
    }
    check(
      "one overshoot is one event, not one per sample",
      firstEvents === 1 && chain.telemetry.safetyEvents === 1,
      chain.telemetry.safetyEvents,
    );
    check(
      "the current reduction falls back to zero while the maximum is held",
      chain.telemetry.safetyReductionDb === 0 &&
        Math.abs(chain.telemetry.safetyMaxReductionDb - firstNow) < 1e-9 &&
        firstNow > 5,
      { now: chain.telemetry.safetyReductionDb, max: chain.telemetry.safetyMaxReductionDb },
    );
    // **リリースの尾を丸ごと作動時間率へ数えない。** 0.01dB を下回ったところで
    // 作動は終わる —— 1極が厳密な 1 へ戻るのを待つと、1発の過大が 1.35秒ぶん
    // （＝1秒の窓では 100%）に見えていた。
    check(
      "and the duty ratio ends when the reduction does, not when the gain reaches 1",
      chain.telemetry.safetyDutyRatio < 0.4 && chain.telemetry.safetyDutyRatio > 0,
      {
        duty: chain.telemetry.safetyDutyRatio,
        processed: chain.telemetry.processedSamples,
      },
    );
    chain.resetMeters();
    check(
      "an explicit reset clears the held maximum too",
      chain.telemetry.safetyMaxReductionDb === 0 &&
        chain.telemetry.safetyEvents === 0 &&
        chain.telemetry.safetyDutyRatio === 0,
    );
  }

  // ── 計測そのもの ──────────────────────────────────────────────────
  {
    const chain = createOutputChain(REFERENCE_LEVELS, SAMPLE_RATE);
    // サンプル間のピーク。**サンプル値だけを見ると見落とす形**を通す。
    for (let i = 0; i < 2000; i++) {
      const t = i / SAMPLE_RATE;
      // ナイキストの少し下。サンプル点は谷を外す。
      const value = 0.9 * Math.sin(2 * Math.PI * 11997 * t + 0.7);
      chain.input(value, value);
      chain.output(value, value, 0, 0);
    }
    check(
      "true peak sees between the samples, where the sample peak cannot",
      chain.telemetry.truePeak > chain.telemetry.peak,
      { peak: chain.telemetry.peak, truePeak: chain.telemetry.truePeak },
    );
    chain.resetMeters();
    check(
      "resetting the meters clears them without touching the settings",
      chain.telemetry.peak === 0 &&
        chain.telemetry.truePeak === 0 &&
        chain.telemetry.inputOverloads === 0 &&
        chain.netGain === 1,
    );
  }
}

console.log("\nrecord condition presets");

/**
 * プリセットが「既存モデルへ値を渡すだけ」であることの確認（`recordCondition.ts`）。
 *
 * 見るのは4つ:
 *
 * 1. **clean は完全バイパス。** 何も渡さないエンジンとビット単位で一致する。
 * 2. **盤の seed は盤ごとに固定。** 同じ seed なら何度でも同じ盤で、デッキ側の
 *    seed（モーター・筐体・配線）は盤を替えても動かない。
 * 3. **切り替えでクリックが出ない。** 鳴っている途中で入れ替えても、境目の段差は
 *    その状態が自分で出している段差より大きくならない。
 * 4. **各プリセットが自分の軸だけを動かす。** ハムは針を上げても鳴り、盤面の
 *    欠陥は針を上げれば消える。
 */
{
  /** worklet と同じ順で9段へ渡す（`deckProcessor.worklet.ts`）。 */
  const apply = (
    engine: ReturnType<typeof createDeckEngine>,
    condition: RecordCondition,
  ) => {
    engine.setSurface(condition.surface);
    engine.setDiscShape(condition.shape);
    engine.setStylus(condition.stylus);
    engine.setTonearm(condition.tonearm);
    engine.setStylusTip(condition.stylusTip);
    engine.setCartridge(condition.cartridge);
    engine.setWowFlutter(condition.wowFlutter);
    engine.setRumble(condition.rumble);
    engine.setHum(condition.hum);
  };

  const SECONDS = 4;
  const DISC_SEED = 0x5eed;
  const tone = cutTone(SECONDS, 1000, 0.6);
  const radius = dropRadius(SECONDS, 0.3);
  const input = baseInput({ stylusRadius: radius });

  /** 盤を1枚載せて鳴らす。`at` サンプル目で状態を差し替えられる。 */
  const play = (
    condition: RecordCondition | null,
    frames = 24000,
    swap?: { at: number; to: RecordCondition },
  ) => {
    const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
    engine.loadGroove(tone);
    if (condition !== null) apply(engine, condition);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    const blockL = new Float32Array(PHYSICS_CHUNK_FRAMES);
    const blockR = new Float32Array(PHYSICS_CHUNK_FRAMES);
    for (let at = 0; at < frames; at += PHYSICS_CHUNK_FRAMES) {
      // 差し替えはブロックとブロックの間。worklet の port と同じ位置である。
      if (swap !== undefined && at === swap.at) apply(engine, swap.to);
      const count = Math.min(PHYSICS_CHUNK_FRAMES, frames - at);
      engine.process({ ...input, frames: count }, blockL, blockR);
      left.set(blockL.subarray(0, count), at);
      right.set(blockR.subarray(0, count), at);
    }
    return { left, right, state: engine.state };
  };

  const identical = (a: Float32Array, b: Float32Array) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const loudest = (values: Float32Array, from: number, to: number) => {
    let top = 0;
    for (let i = from; i < to; i++) top = Math.max(top, Math.abs(values[i]));
    return top;
  };
  /** 隣り合うサンプルの最大の段差。クリックはここに出る。 */
  const biggestStep = (values: Float32Array, from: number, to: number) => {
    let top = 0;
    for (let i = Math.max(1, from); i < to; i++) {
      top = Math.max(top, Math.abs(values[i] - values[i - 1]));
    }
    return top;
  };

  const clean = recordConditionFor("clean", DISC_SEED, 50);
  const bare = play(null);

  // ── 1. clean は完全バイパス ──────────────────────────────────────────
  check(
    "clean is a bit-exact bypass",
    identical(play(clean).left, bare.left) &&
      identical(play(clean).right, bare.right),
  );
  check(
    "and every one of its nine parts is the ideal object itself",
    clean.surface === CLEAN_SURFACE &&
      clean.shape === FLAT_DISC &&
      clean.stylus === IDEAL_STYLUS &&
      clean.stylusTip === IDEAL_STYLUS_TIP &&
      clean.cartridge === IDEAL_CARTRIDGE &&
      clean.tonearm === IDEAL_TONEARM &&
      clean.wowFlutter === IDEAL_WOW_FLUTTER &&
      clean.rumble === IDEAL_RUMBLE &&
      clean.hum === IDEAL_HUM,
  );

  // 途中で clean へ戻せば、そこから先はバイパスへ戻る。RIAA には切り替え前の音の
  // 記憶が残っているので、**厳密一致ではなくその尾が消えることを見る**。
  //
  // 往復に使うのは針側だけを変えるプリセットである。**盤を回す側を触る状態
  // （wow / 偏心）を通ると、戻したときに盤は別の場所を向いている** — 少し違う
  // 速さでしばらく回った以上それが正しく、バイパスの話ではない。
  {
    const swapped = play(recordConditionFor("worn-stylus", DISC_SEED, 50), 24000, {
      at: 12800,
      to: clean,
    });
    let worst = 0;
    for (let i = 18000; i < 24000; i++) {
      worst = Math.max(worst, Math.abs(swapped.left[i] - bare.left[i]));
    }
    check("switching back to clean returns to the bypass", worst < 1e-6, worst);
  }

  // ── 2. seed ─────────────────────────────────────────────────────────
  //
  // 盤の seed は**音源の中身**から決まる。長さとサンプルレートでは足りない
  // ——同じ長さの別の曲が同じ盤になってしまう（`discSeedFromBytes`）。
  {
    /** ファイルのバイト列を1本作る。`vary` の位置だけ中身を変える。 */
    const fileBytes = (size: number, vary = -1, value = 0xff) => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
      if (vary >= 0) bytes[vary] = value;
      return bytes.buffer;
    };

    const SIZE = 1024 * 1024 + 3; // 4の倍数でない = 端数のバイトも通る
    const original = fileBytes(SIZE);
    check(
      "the same file always gives the same disc",
      discSeedFromBytes(original) === discSeedFromBytes(original) &&
        discSeedFromBytes(original) === discSeedFromBytes(fileBytes(SIZE)),
    );
    check(
      "a different file of the same length gives a different disc",
      discSeedFromBytes(original) !== discSeedFromBytes(fileBytes(SIZE, 0)) &&
        discSeedFromBytes(original) !==
          discSeedFromBytes(fileBytes(SIZE, SIZE >> 1)) &&
        // 末尾の端数。4バイト単位だけ見ていると、ここの違いを落とす。
        discSeedFromBytes(original) !==
          discSeedFromBytes(fileBytes(SIZE, SIZE - 1)),
    );
    check(
      "and so does the same file with its tail cut off",
      discSeedFromBytes(fileBytes(SIZE)) !== discSeedFromBytes(fileBytes(SIZE - 1)),
    );
    check(
      "an empty file still answers, and answers the same way",
      Number.isInteger(discSeedFromBytes(new ArrayBuffer(0))) &&
        discSeedFromBytes(new ArrayBuffer(0)) ===
          discSeedFromBytes(new ArrayBuffer(0)),
    );

    // 同じ長さ・同じレートの2つの音源が、実際に別の盤になること。**ここが
    // 直したかったこと**で、上のハッシュ単体ではなく出力で見る。
    const first = recordConditionFor("dusty", discSeedFromBytes(original), 50);
    const second = recordConditionFor(
      "dusty",
      discSeedFromBytes(fileBytes(SIZE, 64)),
      50,
    );
    check(
      "two same-length recordings land their dust in different places",
      !identical(play(first).left, play(second).left),
    );
    check(
      "and reloading the same one lands it in the same places",
      identical(
        play(first).left,
        play(recordConditionFor("dusty", discSeedFromBytes(fileBytes(SIZE)), 50))
          .left,
      ),
    );

    const a = recordConditionFor("used", DISC_SEED, 50);
    const b = recordConditionFor("used", DISC_SEED + 1, 50);
    check(
      "the disc seed reaches the two parts that belong to the disc",
      a.surface.seed !== b.surface.seed && a.shape.seed !== b.shape.seed,
    );
    check(
      "and never reaches the deck — same motor, same case, same wiring",
      a.rumble.seed === b.rumble.seed &&
        a.hum.seed === b.hum.seed &&
        a.wowFlutter.seed === b.wowFlutter.seed,
    );
    check(
      "the same disc plays the same defects every time",
      identical(play(a).left, play(a).left),
    );
    check(
      "and a different disc does not",
      !identical(play(a).left, play(b).left),
    );
  }

  // ── 3. 切り替えでクリックが出ない ────────────────────────────────────
  for (const preset of RECORD_CONDITIONS) {
    if (preset.name === "clean") continue;
    const condition = recordConditionFor(preset.name, DISC_SEED, 50);
    const AT = 12800;
    const swapped = play(clean, 24000, { at: AT, to: condition });
    const always = play(condition);
    // その状態が自分で出している段差。切り替えの境目がこれを超えなければ、
    // 聞こえるのは新しい状態そのものであってクリックではない。
    const settled = biggestStep(always.left, AT + 2000, AT + 6000);
    const seam = biggestStep(swapped.left, AT, AT + 64);
    check(
      `switching to ${preset.name} mid-note does not click`,
      seam <= settled * 1.5 + 1e-7,
      { seam, settled },
    );
  }

  // ── 4. 各プリセットが自分の軸だけを動かす ────────────────────────────
  {
    const lifted = (condition: RecordCondition) => {
      const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
      engine.loadGroove(tone);
      apply(engine, condition);
      const left = new Float32Array(PHYSICS_CHUNK_FRAMES);
      const right = new Float32Array(PHYSICS_CHUNK_FRAMES);
      // 針を上げたまま1秒回す。**盤に属するものはここで消える。**
      for (let at = 0; at < SAMPLE_RATE; at += PHYSICS_CHUNK_FRAMES) {
        engine.process(
          { ...input, stylusContact: false, frames: PHYSICS_CHUNK_FRAMES },
          left,
          right,
        );
      }
      return loudest(left, 0, left.length);
    };

    const grounding = recordConditionFor("poor-grounding", DISC_SEED, 50);
    check(
      "hum keeps sounding with the stylus lifted — it is electrical",
      lifted(grounding) > 1e-5,
      lifted(grounding),
    );
    check(
      "surface noise does not — it is on the disc",
      lifted(recordConditionFor("dusty", DISC_SEED, 50)) === 0,
    );

    // 溝の無い（=変調のない）盤でも聞こえるもの／聞こえないもの。
    const quiet = createGrooveBuffer(
      cutToGroove([new Float32Array(SAMPLE_RATE * SECONDS)], SAMPLE_RATE),
      SAMPLE_RATE,
    );
    const floorOf = (condition: RecordCondition) => {
      const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
      engine.loadGroove(quiet);
      apply(engine, condition);
      const left = new Float32Array(PHYSICS_CHUNK_FRAMES);
      const right = new Float32Array(PHYSICS_CHUNK_FRAMES);
      let top = 0;
      for (let at = 0; at < SAMPLE_RATE * 3; at += PHYSICS_CHUNK_FRAMES) {
        engine.process({ ...input, frames: PHYSICS_CHUNK_FRAMES }, left, right);
        if (at > SAMPLE_RATE) top = Math.max(top, loudest(left, 0, left.length));
      }
      return top;
    };

    check(
      "a used disc has a floor where a clean one is silent",
      floorOf(recordConditionFor("used", DISC_SEED, 50)) > 0 &&
        floorOf(clean) === 0,
    );
    check(
      "a dusty one is louder still",
      floorOf(recordConditionFor("dusty", DISC_SEED, 50)) >
        floorOf(recordConditionFor("used", DISC_SEED, 50)),
    );
    check(
      "a worn stylus adds nothing to an unmodulated groove — it only reads",
      floorOf(recordConditionFor("worn-stylus", DISC_SEED, 50)) === 0,
    );
    check(
      "but it does change what a modulated one sounds like",
      !identical(
        play(recordConditionFor("worn-stylus", DISC_SEED, 50)).left,
        bare.left,
      ),
    );
  }
}

console.log("\nclock migration parity");

/**
 * 正本を rAF から音声クロックへ移して挙動が変わっていないことの確認。
 *
 * 旧: PlatterDrive が 1/60 秒ごとに stepPlatterMotor を呼んでいた。
 * 新: エンジンが 128サンプル（48kHzで 1/375 秒）ごとに同じ関数を呼ぶ。
 *
 * 刻み幅が変わっても、起動時間・停止時間・整定RPM・手回しの結果が一致すること。
 * ここが落ちたら `MOTOR_TUNING` を触って合わせ込むのではなく、移設の側を疑う
 * （audio-engine.md 11.2 段階B）。
 */
{
  /** 旧世界: フレーム時計で直接踏む。 */
  const runFrames = (
    runtime: MotorRuntime,
    seconds: number,
    motorRequested: boolean,
    hand: number | null,
  ) => {
    const step = 1 / 60;
    let elapsed = 0;
    let reached = Infinity;
    while (elapsed < seconds) {
      const out = stepPlatterMotor(runtime, {
        deltaSeconds: step,
        motorRequested,
        targetRpm: NOMINAL_RPM,
        handAngularVelocity: hand,
      });
      runtime.angle = out.angle;
      runtime.angularVelocity = out.angularVelocity;
      elapsed += step;
      if (reached === Infinity && out.state === (motorRequested ? "running" : "stopped")) {
        reached = elapsed;
      }
    }
    return { reached, rpm: radPerSecToRpm(runtime.angularVelocity) };
  };

  /** 新世界: エンジン越し。刻みは常に128サンプル。 */
  const runEngine = (
    engine: ReturnType<typeof createDeckEngine>,
    seconds: number,
    motorRequested: boolean,
    hand: number | null,
  ) => {
    const blocks = Math.round((seconds * SAMPLE_RATE) / 128);
    const outL = new Float32Array(128);
    const outR = new Float32Array(128);
    let reached = Infinity;
    for (let i = 0; i < blocks; i++) {
      engine.process(
        baseInput({
          motorRequested,
          handAngularVelocity: hand,
          stylusContact: false,
        }),
        outL,
        outR,
      );
      if (
        reached === Infinity &&
        engine.state.motorState === (motorRequested ? "running" : "stopped")
      ) {
        reached = ((i + 1) * 128) / SAMPLE_RATE;
      }
    }
    return { reached, rpm: radPerSecToRpm(engine.state.motor.angularVelocity) };
  };

  // 起動
  const frameRuntime: MotorRuntime = { angle: 0, angularVelocity: 0 };
  const engine = createDeckEngine({ sampleRate: SAMPLE_RATE });
  const spinUpOld = runFrames(frameRuntime, 3, true, null);
  const spinUpNew = runEngine(engine, 3, true, null);

  check(
    "spin-up time survives the move to the audio clock",
    Math.abs(spinUpOld.reached - spinUpNew.reached) < 0.05,
    { rAF: spinUpOld.reached, audio: spinUpNew.reached },
  );
  check(
    "and settles on the same rpm",
    Math.abs(spinUpOld.rpm - spinUpNew.rpm) < 0.01,
    { rAF: spinUpOld.rpm, audio: spinUpNew.rpm },
  );
  check(
    "which is still the nominal speed",
    Math.abs(spinUpNew.rpm - NOMINAL_RPM) < 0.15,
    spinUpNew.rpm,
  );

  // 制動
  const brakeOld = runFrames(frameRuntime, 2, false, null);
  const brakeNew = runEngine(engine, 2, false, null);
  check(
    "brake time survives the move",
    Math.abs(brakeOld.reached - brakeNew.reached) < 0.05,
    { rAF: brakeOld.reached, audio: brakeNew.reached },
  );
  check(
    "and both reach a real standstill",
    brakeOld.rpm === 0 && brakeNew.rpm === 0,
    { rAF: brakeOld.rpm, audio: brakeNew.rpm },
  );

  // 手回し: 押さえて止める
  runFrames(frameRuntime, 3, true, null);
  runEngine(engine, 3, true, null);
  const heldOld = runFrames(frameRuntime, 0.5, true, 0);
  const heldNew = runEngine(engine, 0.5, true, 0);
  check(
    "a hand holding the record slows it the same amount",
    Math.abs(heldOld.rpm - heldNew.rpm) < 0.5,
    { rAF: heldOld.rpm, audio: heldNew.rpm },
  );

  // 手回し: 逆へ回す
  const backOld = runFrames(frameRuntime, 0.4, true, -4);
  const backNew = runEngine(engine, 0.4, true, -4);
  check(
    "and turning it backwards reaches the same speed",
    Math.abs(backOld.rpm - backNew.rpm) < 0.5 && backOld.rpm < 0 && backNew.rpm < 0,
    { rAF: backOld.rpm, audio: backNew.rpm },
  );

  // 離したあとの復帰
  const freeOld = runFrames(frameRuntime, 3, true, null);
  const freeNew = runEngine(engine, 3, true, null);
  check(
    "letting go recovers the nominal speed on both clocks",
    Math.abs(freeOld.rpm - freeNew.rpm) < 0.01 &&
      Math.abs(freeNew.rpm - NOMINAL_RPM) < 0.15,
    { rAF: freeOld.rpm, audio: freeNew.rpm },
  );
}

if (failures > 0) throw new Error(`${failures} check(s) FAILED`);
console.log("\nall checks passed");
