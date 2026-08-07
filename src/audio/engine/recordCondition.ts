/**
 * レコードの状態プリセット — **既にある非理想モデルへ、まとまった値を与えるだけ。**
 *
 * ここに新しい信号処理は1行も無い。`surface` / `discShape` / `stylus` /
 * `stylusTip` / `cartridge` / `tonearm` / `wowFlutter` / `rumble` / `hum` は
 * すべて実装済みで、既定が理想＝完全バイパスになっている。本モジュールが持つのは
 * **その9つへ同時に渡す値の組**である。
 *
 * ```
 *   RecordCondition ──┬→ surface      盤面の欠陥（粗さ・埃）
 *                     ├→ discShape    盤の形（偏心・反り）
 *                     ├→ stylus       追従能力・着地
 *                     ├→ stylusTip    針先の幾何（トレーシング歪み・pinch）
 *                     ├→ cartridge    幾何行列（クロストーク）
 *                     ├→ tonearm      縦方向の実効質量
 *                     ├→ wowFlutter   Drive領域の外乱トルク
 *                     ├→ rumble       構造伝播振動
 *                     └→ hum          電源ハムと誘導
 * ```
 *
 * **出力へ足すノイズは1つも無い。** どの値も既存モデルの入口であり、盤を止めれば
 * 止まるもの・逆走すれば逆順に辿るもの・電気だから針を上げても鳴るものの区別は、
 * それぞれのモジュールが元から持っている性質のまま出る。
 *
 * ## seed は盤ごとに固定する
 *
 * 盤に属する2つ（`surface` / `discShape`）だけが `discSeed` を受け取る。**同じ盤なら
 * 埃も反りの向きも毎回同じ場所にある** — 針を上げ下げしても、プリセットを往復しても、
 * 配置は動かない（`discShape.ts` の counter-based hash）。
 *
 * デッキに属する3つ（`wowFlutter` / `rumble` / `hum`）は `DECK_SEED` 固定である。
 * **盤を替えてもモーターと筐体と配線は同じ個体**なので、ここが盤で変わってはならない。
 *
 * ## 値について
 *
 * **実在機種の値ではない。** どれも「その現象がどのくらいの寸法で起きるか」から
 * 置いた初期値で、調整される前提の目盛りである（各モジュールが「推測値を既定に
 * 混ぜない」と書いているのはそちらの既定＝理想の話で、明示的なプリセットは別）。
 *
 * ## 反りのあるプリセットが針とアームを持つ理由
 *
 * `IDEAL_TONEARM` は**質量ゼロ＝反りの全量がカンチレバーに残る**という定義である
 * （`physics/tonearm.ts`）。0.15mm の反りは 1kHz フルスケールの変調の 25倍あるので、
 * 理想アームのまま反らせると 0.55Hz が −17dBFS で出てしまう。実機で反りが聞こえない
 * のは**アームが付いていってしまうから**なので、反りを入れるプリセットは必ず
 * 実効質量のあるアームと組で渡す。「反り＝低域ノイズ」ではない。
 */

import {
  IDEAL_TONEARM,
  type TonearmVerticalParameters,
} from "../../physics/tonearm";
import {
  IDEAL_WOW_FLUTTER,
  torqueForSpeedRatio,
  type WowFlutterParameters,
} from "../../physics/wowFlutter";
import {
  IDEAL_CARTRIDGE,
  separationDbToRatio,
  type CartridgeParameters,
} from "./cartridge";
import type { CuttingParameters } from "./cutterHead";
import type { ManufacturingParameters } from "./manufacturing";
import { FLAT_DISC, type DiscShapeParameters } from "./discShape";
import { IDEAL_HUM, type HumParameters, type MainsHz } from "./hum";
import { IDEAL_RUMBLE, type RumbleParameters } from "./rumble";
import {
  complianceUnitsToMetresPerNewton as cu,
  gramsForceToNewtons as gf,
  IDEAL_STYLUS,
  REFERENCE_WALL_VELOCITY,
  type StylusParameters,
} from "./stylus";
import { IDEAL_STYLUS_TIP, type StylusTipParameters } from "./stylusTip";
import { CLEAN_SURFACE, type SurfaceParameters } from "./surface";

/**
 * 9つのモデルへ**同時に**渡す値の組。**Worklet へはこれ1通で送る** — 段ごとに
 * 送ると、届いた順に半分だけ適用された状態が1ブロック鳴る。
 */
export interface RecordCondition {
  /** どのプリセットから作られたか。UI の表示と往復の判定に使う。 */
  readonly preset: RecordConditionName;
  readonly surface: SurfaceParameters;
  readonly shape: DiscShapeParameters;
  readonly stylus: StylusParameters;
  readonly stylusTip: StylusTipParameters;
  readonly cartridge: CartridgeParameters;
  readonly tonearm: TonearmVerticalParameters;
  readonly wowFlutter: WowFlutterParameters;
  readonly rumble: RumbleParameters;
  readonly hum: HumParameters;
}

/**
 * 盤1枚を決める3つ。**型が分かれているのは、変えたときに起きることが違うから**
 * であって、整理のためではない。
 *
 * | | いつ効くか | 変えたら |
 * |---|---|---|
 * | `cutting` | **溝を切るとき**（`cutterHead.ts`） | **音源から切り直し。** 位置は失われ、長い音源では数百msかかる |
 * | `manufacturing` | **切った溝を盤にするとき**（`manufacturing.ts`） | **製造からやり直し**（＝溝の作り直し）。同上 |
 * | `playback` | 再生のたび（`deckEngine.ts` の9段） | **鳴っている途中でも差し替えられる。** 盤はそのまま |
 *
 * 上2つは**溝に焼かれて外せない**。再生側は針とデッキの設定なので、`clean` へ
 * 戻せばいつでも完全バイパスに戻る。この非対称がレコードそのものの性質であり、
 * 型で分けているのはそれを取り違えないためである。
 */
export interface RecordSpec {
  readonly cutting: CuttingParameters;
  readonly manufacturing: ManufacturingParameters;
  readonly playback: RecordCondition;
}

/** 選べる状態。**この並びがそのまま UI の並びになる。** */
export const RECORD_CONDITIONS = [
  { name: "clean", label: "Clean / Reference" },
  { name: "used", label: "Normal Used LP" },
  { name: "dusty", label: "Dusty Record" },
  { name: "worn-stylus", label: "Worn Stylus" },
  { name: "warped", label: "Warped / Off-center" },
  { name: "poor-grounding", label: "Poor Grounding" },
] as const;

export type RecordConditionName = (typeof RECORD_CONDITIONS)[number]["name"];

/**
 * 音源のバイト列 → **その盤の seed**。「同じ盤」の定義そのものである。
 *
 * 長さとサンプルレートでは足りない —— 同じ長さ・同じレートの別の曲が同じ盤になり、
 * 埃の位置も反りの向きも共有されてしまう。**中身そのものを見る。**
 *
 * - 見るのは**デコード前のファイルのバイト列**である。デコード結果ではないので、
 *   出力レートの違う環境で開いても同じファイルなら同じ盤になる。
 * - **`decodeAudioData` より前に呼ぶこと。** あれは渡された ArrayBuffer を detach
 *   するので、後から読もうとすればファイルを2回読むことになる。
 * - **残すのは畳んだ 32bit だけ。** 音源ごとに数十MBの指紋を抱えない。
 * - **メインスレッドのロード時にだけ走る。** 音声スレッドはこの関数を呼ばない
 *   ——1ブロックの締切がある場所で数十MBを舐めてよい理由が無い。
 *
 * 4バイトずつ FNV-1a で潰し、端数のバイトと全長を混ぜてから最後に撹拌する。全長も
 * 入れるので、末尾を切り落としただけのファイルも別の盤になる。
 */
export function discSeedFromBytes(bytes: ArrayBuffer): number {
  const length = bytes.byteLength;
  let hash = 0x811c9dc5 | 0;

  // 4バイト単位。1バイトずつ回すと 100MB のファイルで4倍の時間がかかる。
  const words = new Uint32Array(bytes, 0, length >>> 2);
  for (let i = 0; i < words.length; i++) {
    hash = Math.imul(hash ^ words[i], 0x01000193);
  }
  // 4で割り切れない端数。捨てると最後の3バイトの違いを見落とす。
  const tail = new Uint8Array(bytes, words.length * 4);
  for (let i = 0; i < tail.length; i++) {
    hash = Math.imul(hash ^ tail[i], 0x01000193);
  }
  hash = Math.imul(hash ^ length, 0x01000193);

  // 最後に撹拌する。FNV は上位ビットにしか差が出ないことがあるので、これが無いと
  // 「1バイト違うだけの2枚」が似た欠陥配置になりうる（`discShape.ts` と同じ mix）。
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
  hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97);
  return (hash ^ (hash >>> 15)) | 0;
}

/**
 * デッキ側の個体差の seed。**盤の seed とは別物で、盤を替えても変わらない。**
 * モーター・軸受け・配線は1台ぶんしかない。
 */
const DECK_SEED = 0x9d17;

/** 公称回転数。外乱トルクの較正（`torqueForSpeedRatio`）の基準。 */
const NOMINAL_RPM = 33.333;

/* ------------------------------------------------------------------ *
 * 部品。プリセットはこれらの組み合わせで、値の重複を持たない。
 * ------------------------------------------------------------------ */

/**
 * ちゃんと手入れされた針。**このプリセット群の標準**で、Worn Stylus だけが
 * これを置き換える。針先は楕円相当（溝方向 5µm・横方向 18µm）。
 */
const GOOD_STYLUS: StylusParameters = {
  trackingForce: gf(1.8),
  /** 実効針先質量 0.45mg。 */
  stylusMass: 0.45e-6,
  compliance: cu(15),
  damping: 0.9,
  referenceVelocity: REFERENCE_WALL_VELOCITY,
};

/**
 * 標準のアーム。実効質量 12g × `GOOD_STYLUS` の 15cu で縦共振は約 11.9Hz
 * ——反り（0.55〜1.1Hz）のはるか上なので、アームは反りに付いていく。
 */
const GOOD_ARM: TonearmVerticalParameters = {
  effectiveMass: 0.012,
  pivotInertia: 0,
  damping: 0.6,
};

/**
 * 盤に属さないもの一式を理想のまま返す土台。プリセットは**自分が動かす軸だけ**を
 * 上書きする（「Poor Grounding で盤が汚れる」といった巻き込みを防ぐ）。
 */
const idealParts = () => ({
  surface: CLEAN_SURFACE,
  shape: FLAT_DISC,
  stylus: IDEAL_STYLUS,
  stylusTip: IDEAL_STYLUS_TIP,
  cartridge: IDEAL_CARTRIDGE,
  tonearm: IDEAL_TONEARM,
  wowFlutter: IDEAL_WOW_FLUTTER,
  rumble: IDEAL_RUMBLE,
  hum: IDEAL_HUM,
});

/**
 * 質量のある針とアームを載せた土台。**反り・偏心を入れるプリセットが使う。**
 *
 * **針先の形とクロストークはここに入れない。** それらは Worn Stylus の主題なので、
 * 盤の状態のプリセットに混ぜると「盤が汚れると歪みも増える」という別の話になる。
 * ここで理想から外すのは、反りを物理的に成立させるのに要る2つだけである。
 */
const realPickup = () => ({
  ...idealParts(),
  stylus: GOOD_STYLUS,
  tonearm: GOOD_ARM,
});

/** 時間由来の外乱を「公称速度の何倍ぶれるか」で書く。較正の入口はこれ1つ。 */
const speedRatio = (ratio: number, hz: number) =>
  torqueForSpeedRatio(ratio, hz, NOMINAL_RPM);

/* ------------------------------------------------------------------ *
 * プリセット
 * ------------------------------------------------------------------ */

/**
 * その盤・そのデッキの状態を1組作る。
 *
 * @param preset  プリセット名
 * @param discSeed **盤ごとに固定**の seed。同じ盤なら欠陥配置は毎回同じになる
 * @param mainsHz 電源周波数。**地域で決まる設定**なので既定を持たない（`hum.ts`）
 */
export function recordConditionFor(
  preset: RecordConditionName,
  discSeed: number,
  mainsHz: MainsHz,
): RecordCondition {
  const seed = Number.isFinite(discSeed) ? discSeed | 0 : 0;

  switch (preset) {
    /**
     * **完全バイパス。** 9つとも既定の理想値そのもので、プリセットを入れる前と
     * 出力がビット単位で一致する。ここへ戻せば必ず素の音に戻る。
     */
    case "clean":
      return { preset, ...idealParts() };

    /**
     * **普通に聴かれてきたLP。** 粗さ・埃・偏心・反り・wow/flutter・ランブルを
     * どれも控えめに。狙いは「音楽の下にレコードが居る」ことで、音楽を覆うことでは
     * ない。実測（audio-engine.md 7.12）で無変調溝の床が −44dBFS、内訳は粗さ −52dBFS・
     * ランブル −60dBFS で、埃は 5秒に1つほど −30dBFS を超える。
     */
    case "used":
      return {
        preset,
        ...realPickup(),
        surface: {
          seed,
          // 溝の壁の荒れ。相関長 25µm は外周で約 20kHz の節の密度にあたり、
          // **内周ほど遅く通るので同じ粗さが低く鳴る**（surface.ts の arcLength）。
          roughness: { rms: 1.0e-8, correlationLength: 25e-6 },
          // 盤全体で 200粒。**面積一様に撒く**ので、外周では毎分12回ほど −30dBFS を
          // 超える粒に当たり、1回転の短い内周ほど当たる間隔は空く。
          dust: {
            count: 200,
            minRadius: 60e-6,
            maxRadius: 260e-6,
            height: 0.8e-6,
          },
          // 傷は入れない。**この盤は汚れているだけで、傷んではいない。**
          scratches: { count: 0, width: 0, depth: 0, curvature: 0, length: 0 },
        },
        shape: {
          seed,
          // 0.06mm。1回転周期の緩い wow で、±0.04%（外周）〜±0.10%（リードアウト）。
          eccentricity: { offset: 60e-6 },
          // 1次（傾き）と2次（鞍）。アームが追うので音にはほとんど出ず、
          // 画面のアームが1回転周期で上下する。
          warp: { dish: 0, amplitude: 0.15e-3, harmonics: 2 },
        },
        wowFlutter: {
          seed: DECK_SEED,
          wow: { torque: speedRatio(0.0006, 3), hz: 3, components: 3 },
          flutter: { torque: speedRatio(0.0002, 25), hz: 25, components: 3 },
          commutationRipple: {
            torque: speedRatio(0.0002, 13),
            cyclesPerRevolution: 24,
          },
        },
        rumble: {
          ...IDEAL_RUMBLE,
          seed: DECK_SEED,
          bearing: { amplitude: 6e-8, harmonics: 12 },
          motor: { amplitude: 1.6e-8, hz: 30, components: 3 },
        },
      };

    /**
     * **埃をかぶった盤。** `used` から**表面粗さと埃だけ**を強める。偏心・反り・
     * wow/flutter・ランブルは `used` のまま — 埃が増えても盤は反らないし、
     * モーターも変わらない。
     */
    case "dusty": {
      const base = recordConditionFor("used", seed, mainsHz);
      return {
        ...base,
        preset,
        surface: {
          ...base.surface,
          roughness: { rms: 2.6e-8, correlationLength: 20e-6 },
          dust: {
            count: 900,
            minRadius: 80e-6,
            maxRadius: 320e-6,
            height: 1.2e-6,
          },
        },
      };
    }

    /**
     * **摩耗した針。盤は綺麗なまま。** 溝方向の接触半径が広がって谷へ入れなくなり
     * （トレーシング歪み・**内周ほど強い**）、質量が増えて針圧が下がったぶん
     * 追従限界が落ち、セパレーションも −18dB まで悪化する。
     *
     * 盤側は完全に理想のままなので、**針だけを変えるとどう聞こえるか**が分離して
     * 出る（表面雑音も埃も混ざらない）。
     */
    case "worn-stylus":
      return {
        preset,
        ...idealParts(),
        stylus: {
          ...GOOD_STYLUS,
          trackingForce: gf(1.4),
          /** 摩耗して重くなった針先 0.9mg。追従限界は良品の 4割ほどまで落ちる。 */
          stylusMass: 0.9e-6,
        },
        stylusTip: {
          // 平らに削れた接触面。溝方向 12µm は内周で溝サンプル約3つぶんの窓になる。
          scanningRadius: 12e-6,
          transverseRadius: 15e-6,
        },
        cartridge: {
          ...IDEAL_CARTRIDGE,
          crosstalk: {
            leftFromRight: separationDbToRatio(-18),
            rightFromLeft: separationDbToRatio(-18),
          },
        },
        tonearm: GOOD_ARM,
      };

    /**
     * **反って中心のずれた盤。** 偏心 0.25mm は1回転周期で ±0.17%（外周）〜
     * ±0.44%（リードアウト）の wow になり、ピアノや持続音ではっきり分かる。反りは
     * アームを目に見えて上下させるが、音に出るのは 0.55〜1.1Hz（−35dBFS）で
     * **可聴帯ではない** — アームが付いていくからである。**盤面は綺麗なまま。**
     */
    case "warped":
      return {
        preset,
        ...realPickup(),
        shape: {
          seed,
          eccentricity: { offset: 0.25e-3 },
          // 1次＝1回転に1回の傾き、2次＝鞍。皿は入れない（実寸が無い）。
          warp: { dish: 0, amplitude: 0.5e-3, harmonics: 2 },
        },
      };

    /**
     * **アースの悪い設置。** 混入する3箇所を全部使う — コイルへの誘導（電気負荷と
     * RIAA の両方を受ける）、配線（RIAA だけ）、アースループ（左右同相）。
     *
     * **盤にも針にも触らない。** 針を上げても盤を止めてもハムは鳴り続け、
     * アームを内周へ寄せると誘導が強くなる（`hum.ts`）。
     */
    case "poor-grounding":
      return {
        preset,
        ...idealParts(),
        hum: {
          seed: DECK_SEED,
          mainsHz,
          cartridgeInduction: {
            fundamental: 0.0012,
            rectifier: 0.0007,
            harmonics: 0.0004,
            harmonicCount: 3,
            /** 内周へ寄るとトランスとモーターに近づく。 */
            positionSensitivity: 0.4,
            /** プラッターの漏れ磁束は回転と一緒に向きを変える。 */
            platterSensitivity: 0.15,
            /** 45° から外して、左右で振幅を偏らせる。 */
            coilAngleRadians: Math.PI / 4 - 0.12,
          },
          cableHum: {
            fundamental: 0.001,
            rectifier: 0.0004,
            harmonics: 0.00024,
            harmonicCount: 3,
          },
          groundLoop: {
            fundamental: 0.0024,
            rectifier: 0.0018,
            harmonics: 0.0008,
            harmonicCount: 4,
            /** アース線は1本なので、ほぼ同相で乗る。 */
            commonMode: 0.9,
          },
          electronics: {
            fundamental: 0.00016,
            rectifier: 0.00024,
            harmonics: 0.00008,
            harmonicCount: 2,
          },
        },
      };
  }
}
