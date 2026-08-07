/**
 * DSPコアの負荷計測。**音は測らない** — 出力は捨て、1レンダークォンタム（128
 * フレーム）に何ns掛かったかだけを見る。`deckEngine.check.ts` と同じ方式で、
 * テスト基盤は使わない。コンパイルして直接走らせる:
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
 *     src/audio/engine/deckEngine.bench.ts \
 *     --outDir <tmp> --module commonjs --target es2022
 *   node --max-old-space-size=8192 <tmp>/audio/engine/deckEngine.bench.js
 *
 * **1つも数式を触らない。** 計測のためにエンジンへ計数器を入れることもしない
 * （入れた瞬間、測っているのは計数器の入ったエンジンになる）。呼び出し回数は
 * モデルの幾何から解いて出し、負荷は**差分計測**——ある段を理想に戻したときに
 * 何ns減るか——で切り分ける。
 *
 * 結果の読み方と結論は docs/audio-performance.md。
 */

import {
  createCutLayout,
  radiusAtRevolution,
  type CutLayout,
} from "./cutLayout";
import { rpmToRadPerSec } from "../../physics/platterMotor";
import { createDeckEngine, PHYSICS_CHUNK_FRAMES } from "./deckEngine";
import { createGrooveBuffer, type GrooveBuffer } from "./grooveBuffer";
import {
  RECORD_CONDITIONS,
  recordConditionFor,
  type RecordCondition,
} from "./recordCondition";
import { CLEAN_SURFACE } from "./surface";
import { FLAT_DISC } from "./discShape";
import { IDEAL_STYLUS } from "./stylus";
import { IDEAL_STYLUS_TIP } from "./stylusTip";
import { IDEAL_CARTRIDGE } from "./cartridge";
import { IDEAL_TONEARM } from "../../physics/tonearm";
import { IDEAL_WOW_FLUTTER } from "../../physics/wowFlutter";
import { IDEAL_RUMBLE } from "./rumble";
import { IDEAL_HUM } from "./hum";

/**
 * Node の高分解能時計と環境。**型は持ち込まない** — この一族は `--ignoreConfig`
 * で単体コンパイルされるので、`@types/node` に依存すると走らせ方が増える。
 */
const host = (globalThis as unknown as {
  process?: {
    hrtime: { bigint(): bigint };
    version: string;
    platform: string;
    arch: string;
  };
}).process;
if (host === undefined) throw new Error("bench: needs Node's process.hrtime");
const nanos = () => host.hrtime.bigint();

const DISC_SEED = 0x5eed;
const NOMINAL_RPM = 33.333;
/** 出力は2ch固定（`deckProcessor.worklet.ts` の `outputChannelCount: [2]`）。 */
const CHANNELS = 2;

/* ------------------------------------------------------------------ *
 * 盤
 * ------------------------------------------------------------------ */

/**
 * 溝を**直接**作る。`cutToGroove` は通さない。
 *
 * 測るのは再生側の負荷なので、盤の中身は「実際に鳴っている変位」でありさえすれば
 * よい。カッティングを通すと20分の盤で音源のコピーが2本増えるだけで、1サンプルの
 * 仕事は1つも変わらない。振幅はフルスケール相当（1kHz片壁 7.64単位）に合わせる。
 */
function syntheticGroove(seconds: number, sampleRate: number): GrooveBuffer {
  const frames = Math.round(seconds * sampleRate);
  const walls: Float32Array[] = [];
  for (let channel = 0; channel < CHANNELS; channel++) {
    const wall = new Float32Array(frames);
    // 変位なので 1/f 傾斜。倍音は左右でずらし、**両壁を別の配列にする**
    // （モノラルだと両壁が同じ配列を指し、キャッシュの当たり方が変わる）。
    const partials = [110, 220, 440, 880, 1760, 3520, 7040];
    for (let i = 0; i < frames; i++) {
      const t = i / sampleRate;
      let value = 0;
      for (let k = 0; k < partials.length; k++) {
        const hz = partials[k] * (channel === 0 ? 1 : 1.03);
        value += (7.64 / (k + 1)) * Math.sin(2 * Math.PI * hz * t + k + channel);
      }
      wall[i] = value;
    }
    walls.push(wall);
  }
  return createGrooveBuffer(walls, sampleRate);
}

const radiusAt = (layout: CutLayout, fraction: number) =>
  radiusAtRevolution(layout, layout.programRevolutions * fraction);

/* ------------------------------------------------------------------ *
 * 条件
 * ------------------------------------------------------------------ */

/**
 * **DEV専用の worst-case。** 6プリセットの非理想な軸を全部同時に立て、さらに
 * どのプリセットも使っていない傷を入れたもの。
 *
 * **利用者向けプリセットではない**（`RECORD_CONDITIONS` に入れない）。音として
 * 妥当かどうかは見ておらず、「全モデルが同時に動くと1サンプルいくらか」を測る
 * ためだけの上限である。`preset` の値はラベルにしか使われないので "dusty" のまま。
 */
function worstCase(): RecordCondition {
  const dusty = recordConditionFor("dusty", DISC_SEED, 50);
  const warped = recordConditionFor("warped", DISC_SEED, 50);
  const worn = recordConditionFor("worn-stylus", DISC_SEED, 50);
  const grounding = recordConditionFor("poor-grounding", DISC_SEED, 50);
  return {
    ...dusty,
    surface: {
      ...dusty.surface,
      // 傷。**どのプリセットも 0 のまま**なので、ここだけは実測値ではなく
      // 「その段を通す」ための負荷プローブである。
      scratches: {
        count: 24,
        width: 120e-6,
        depth: 1.5e-6,
        curvature: 0.5,
        length: 0.03,
      },
    },
    shape: warped.shape,
    stylus: worn.stylus,
    stylusTip: worn.stylusTip,
    cartridge: worn.cartridge,
    tonearm: worn.tonearm,
    hum: grounding.hum,
  };
}

/** worst-case から1段だけ理想へ戻す。差が**その段の負荷**である。 */
const WITHOUT: { name: string; strip: (c: RecordCondition) => RecordCondition }[] =
  [
    { name: "surface", strip: (c) => ({ ...c, surface: CLEAN_SURFACE }) },
    { name: "discShape", strip: (c) => ({ ...c, shape: FLAT_DISC }) },
    { name: "stylus", strip: (c) => ({ ...c, stylus: IDEAL_STYLUS }) },
    { name: "stylusTip", strip: (c) => ({ ...c, stylusTip: IDEAL_STYLUS_TIP }) },
    { name: "cartridge", strip: (c) => ({ ...c, cartridge: IDEAL_CARTRIDGE }) },
    { name: "tonearm", strip: (c) => ({ ...c, tonearm: IDEAL_TONEARM }) },
    {
      name: "wowFlutter",
      strip: (c) => ({ ...c, wowFlutter: IDEAL_WOW_FLUTTER }),
    },
    { name: "rumble", strip: (c) => ({ ...c, rumble: IDEAL_RUMBLE }) },
    { name: "hum", strip: (c) => ({ ...c, hum: IDEAL_HUM }) },
  ];

/* ------------------------------------------------------------------ *
 * 計測
 * ------------------------------------------------------------------ */

interface Timing {
  /** 1クォンタムあたりの処理時間 ms。 */
  mean: number;
  p95: number;
  p99: number;
  max: number;
  /** 予算（128 / sampleRate）に対する平均使用率。 */
  load: number;
  peakLoad: number;
  /** 予算を超えたクォンタムの数と割合。 */
  overruns: number;
  quanta: number;
}

const percentile = (sorted: Float64Array, p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/**
 * `quanta` 回ぶん、**1クォンタムずつ**時間を取る。
 *
 * まとめて回して総時間を割らない — それでは p99 も最大も出ず、「たまに間に合わ
 * ない」が消えてしまう。音声スレッドが実際に守るのは1回ぶんの締切である。
 */
function measure(
  condition: RecordCondition,
  groove: GrooveBuffer,
  sampleRate: number,
  fraction: number,
  quanta: number,
  options: { stylusContact?: boolean; marker?: string } = {},
): Timing {
  const marker = options.marker;
  const engine = createDeckEngine({ sampleRate });
  engine.loadGroove(groove);
  engine.setSurface(condition.surface);
  engine.setDiscShape(condition.shape);
  engine.setStylus(condition.stylus);
  engine.setTonearm(condition.tonearm);
  engine.setStylusTip(condition.stylusTip);
  engine.setCartridge(condition.cartridge);
  engine.setWowFlutter(condition.wowFlutter);
  engine.setRumble(condition.rumble);
  engine.setHum(condition.hum);

  const layout = createCutLayout(groove.durationSeconds, groove.sampleRate);
  const input = {
    frames: PHYSICS_CHUNK_FRAMES,
    motorRequested: true,
    targetRpm: NOMINAL_RPM,
    handAngularVelocity: null,
    stylusContact: options.stylusContact ?? true,
    stylusRadius: radiusAt(layout, fraction),
    armIntent: "follow" as const,
    landingSpeed: 0,
    stylusAzimuth: 0,
  };
  const left = new Float32Array(PHYSICS_CHUNK_FRAMES);
  const right = new Float32Array(PHYSICS_CHUNK_FRAMES);

  // JIT が温まる前の数百クォンタムは別物。捨てる。
  for (let i = 0; i < 2000; i++) engine.process(input, left, right);
  // `--trace-gc` で走らせたとき、どの行の GC か分かるようにする（計測方法は
  // docs/audio-performance.md）。stdout に1行出るだけで、計測には入らない。
  if (marker !== undefined) console.log(`[gc] ${marker}`);

  const samples = new Float64Array(quanta);
  for (let i = 0; i < quanta; i++) {
    const started = nanos();
    engine.process(input, left, right);
    samples[i] = Number(nanos() - started) / 1e6;
  }

  const budget = (PHYSICS_CHUNK_FRAMES / sampleRate) * 1000;
  let total = 0;
  let max = 0;
  let overruns = 0;
  for (const value of samples) {
    total += value;
    if (value > max) max = value;
    if (value > budget) overruns += 1;
  }
  const sorted = samples.slice().sort();
  const mean = total / quanta;
  return {
    mean,
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max,
    load: mean / budget,
    peakLoad: max / budget,
    overruns,
    quanta,
  };
}

/* ------------------------------------------------------------------ *
 * 呼び出し回数（幾何から解く。計数器は入れない）
 * ------------------------------------------------------------------ */

/**
 * 出力1サンプルあたりの評価回数。**`stylusTip.ts` の定数と同じ式**で、コードを
 * 読み替えたものではなく同じ幾何から出している。
 *
 *   窓の半幅 half = min(scanningRadius / metresPerSample, 64)   溝サンプル
 *   刻み     steps = round(clamp(half*2, 3, 24))
 *   readAt   = 1（中心）+ 2·steps（窓）+ 2（pinch の前後差分）
 *
 * `surface.sample` は本読みで1回、そのうえで `readAt` ごとに1回呼ばれる。
 */
function evaluationCounts(condition: RecordCondition, radius: number, cutRpm: number, grooveRate: number) {
  const metresPerSample = (rpmToRadPerSec(cutRpm) * radius) / grooveRate;
  const scanning = condition.stylusTip.scanningRadius;
  const pinch = condition.stylusTip.transverseRadius > 0;
  const tipActive = scanning > 0 || pinch;
  const half = Math.min(scanning / metresPerSample, 64);
  const steps =
    scanning > 0 ? Math.round(Math.min(Math.max(half * 2, 3), 24)) : 0;
  const readAt = tipActive ? (scanning > 0 ? 1 + 2 * steps : 0) + (pinch ? 2 : 0) : 0;
  const surfaceActive =
    condition.surface.roughness.rms > 0 ||
    condition.surface.dust.count > 0 ||
    condition.surface.scratches.count > 0;
  return {
    metresPerSample,
    half,
    steps,
    readAt,
    grooveReads: 2 + readAt * 2,
    surfaceSamples: surfaceActive ? (readAt > 0 ? 1 + readAt : 1) : 0,
  };
}

/* ------------------------------------------------------------------ *
 * 出力
 * ------------------------------------------------------------------ */

const pad = (value: string | number, width: number) =>
  String(value).padStart(width);
const ms = (value: number) => value.toFixed(3);
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

function header(title: string) {
  console.log(`\n${title}`);
  console.log(
    `${"".padEnd(22)} ${pad("mean", 7)} ${pad("p95", 7)} ${pad("p99", 7)} ${pad(
      "max",
      7,
    )} ${pad("load", 7)} ${pad("peak", 7)} ${pad("over", 6)}`,
  );
}

function row(label: string, timing: Timing) {
  console.log(
    `${label.padEnd(22)} ${pad(ms(timing.mean), 7)} ${pad(
      ms(timing.p95),
      7,
    )} ${pad(ms(timing.p99), 7)} ${pad(ms(timing.max), 7)} ${pad(
      pct(timing.load),
      7,
    )} ${pad(pct(timing.peakLoad), 7)} ${pad(timing.overruns, 6)}`,
  );
}

/* ------------------------------------------------------------------ *
 * 走らせる
 * ------------------------------------------------------------------ */

const RATES = [44100, 48000, 96000];
/** 行列用。10秒ぶん（≒ 3400クォンタム）で percentile は十分に落ち着く。 */
const MATRIX_SECONDS = 10;
/** 連続再生の確認用。 */
const SOAK_SECONDS = 60;

const label = (rate: number) => `${(rate / 1000).toFixed(1)}kHz`;

console.log(`node ${host.version} / ${host.platform} ${host.arch}`);
console.log(
  `quantum ${PHYSICS_CHUNK_FRAMES} frames, ${CHANNELS} ch — budget ` +
    RATES.map((rate) => `${label(rate)}: ${((PHYSICS_CHUNK_FRAMES / rate) * 1000).toFixed(3)}ms`).join(", "),
);

// 外周側で鳴る盤を各レートで1枚ずつ。**60秒の連続再生が走り切る長さが要る** —
// 短いと途中でリードアウトへ抜け、そこから先は無音の fast-path を測ってしまう
// （最初の版がこれを踏んだ)。
const SHORT_SECONDS = 90;
const shortGrooves = new Map<number, GrooveBuffer>();
for (const rate of RATES) shortGrooves.set(rate, syntheticGroove(SHORT_SECONDS, rate));

const worst = worstCase();
const CONDITIONS: { name: string; condition: RecordCondition }[] = [
  ...RECORD_CONDITIONS.map((entry) => ({
    name: entry.name,
    condition: recordConditionFor(entry.name, DISC_SEED, 50),
  })),
  { name: "worst-case (DEV)", condition: worst },
];

for (const rate of RATES) {
  const groove = shortGrooves.get(rate)!;
  const quanta = Math.round((MATRIX_SECONDS * rate) / PHYSICS_CHUNK_FRAMES);
  header(`${label(rate)} — ${MATRIX_SECONDS}s, outer groove (program 5%)`);
  for (const entry of CONDITIONS) {
    row(
      entry.name,
      measure(entry.condition, groove, rate, 0.05, quanta, {
        marker: `${label(rate)} ${entry.name}`,
      }),
    );
  }
}

// 針を上げたまま。**電気ハムだけが回る経路**で、機械系は無音のまま通らない。
{
  const rate = 48000;
  const groove = shortGrooves.get(rate)!;
  const quanta = Math.round((MATRIX_SECONDS * rate) / PHYSICS_CHUNK_FRAMES);
  header(`${label(rate)} — stylus lifted (electrical path only)`);
  for (const name of ["clean", "poor-grounding"] as const) {
    row(
      name,
      measure(recordConditionFor(name, DISC_SEED, 50), groove, rate, 0.05, quanta, {
        stylusContact: false,
        marker: `lifted ${name}`,
      }),
    );
  }
}

// 内周。**針先の窓は距離で決まるので、線速度が落ちるぶんだけ広がる。**
{
  const rate = 48000;
  console.log(
    `\ncutting a 20 min record at ${label(rate)} for the inner groove...`,
  );
  const long = syntheticGroove(20 * 60, rate);
  const layout = createCutLayout(long.durationSeconds, long.sampleRate);
  const quanta = Math.round((MATRIX_SECONDS * rate) / PHYSICS_CHUNK_FRAMES);
  header(`${label(rate)} — radius sweep, worst-case (DEV)`);
  for (const fraction of [0.02, 0.5, 0.98]) {
    const radius = radiusAt(layout, fraction);
    const counts = evaluationCounts(worst, radius, layout.cutRpm, long.sampleRate);
    row(
      `r=${(radius * 1000).toFixed(0)}mm steps=${counts.steps}`,
      measure(worst, long, rate, fraction, quanta, {
        marker: `radius ${(radius * 1000).toFixed(0)}mm`,
      }),
    );
  }

  console.log(
    `\nevaluations per output sample (from the geometry, not a counter)`,
  );
  console.log(
    `${"".padEnd(22)} ${pad("m/sample", 10)} ${pad("half", 6)} ${pad(
      "steps",
      6,
    )} ${pad("readAt", 7)} ${pad("wallReads", 10)} ${pad("surface", 8)}`,
  );
  for (const fraction of [0.02, 0.5, 0.98]) {
    const radius = radiusAt(layout, fraction);
    for (const entry of [
      { name: "used / dusty", condition: recordConditionFor("dusty", DISC_SEED, 50) },
      { name: "worn-stylus", condition: recordConditionFor("worn-stylus", DISC_SEED, 50) },
      { name: "worst-case (DEV)", condition: worst },
    ]) {
      const counts = evaluationCounts(
        entry.condition,
        radius,
        layout.cutRpm,
        long.sampleRate,
      );
      console.log(
        `${`${(radius * 1000).toFixed(0)}mm ${entry.name}`.padEnd(22)} ${pad(
          counts.metresPerSample.toExponential(2),
          10,
        )} ${pad(counts.half.toFixed(2), 6)} ${pad(counts.steps, 6)} ${pad(
          counts.readAt,
          7,
        )} ${pad(counts.grooveReads, 10)} ${pad(counts.surfaceSamples, 8)}`,
      );
    }
  }

  // 段ごとの負荷。**1段だけ理想へ戻したときの差**で切り分ける。
  console.log(`\nper-model cost at the inner groove (worst-case minus one)`);
  const inner = 0.98;
  const base = measure(worst, long, rate, inner, quanta);
  console.log(
    `${"worst-case".padEnd(22)} ${pad(ms(base.mean), 7)} ms  ${pad(pct(base.load), 7)}`,
  );
  for (const entry of WITHOUT) {
    const without = measure(entry.strip(worst), long, rate, inner, quanta);
    const saved = base.mean - without.mean;
    console.log(
      `${`  − ${entry.name}`.padEnd(22)} ${pad(ms(without.mean), 7)} ms  ${pad(
        pct(without.load),
        7,
      )}   saves ${pad(ms(saved), 7)} ms (${pad(pct(saved / base.mean), 6)})`,
    );
  }
}

// 60秒連続。**締切を割ったクォンタムを数える。**
{
  const rate = 48000;
  const groove = shortGrooves.get(rate)!;
  const quanta = Math.round((SOAK_SECONDS * rate) / PHYSICS_CHUNK_FRAMES);
  header(`${label(rate)} — ${SOAK_SECONDS}s soak, outer groove`);
  for (const name of ["used", "dusty"] as const) {
    row(
      name,
      measure(recordConditionFor(name, DISC_SEED, 50), groove, rate, 0.05, quanta, {
        marker: `soak ${name}`,
      }),
    );
  }
  row("worst-case (DEV)", measure(worst, groove, rate, 0.05, quanta, { marker: "soak worst" }));
}

console.log("\ndone");
