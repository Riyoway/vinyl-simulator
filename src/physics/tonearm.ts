/**
 * Tonearm geometry, pure and dependency-free like the rest of src/physics.
 *
 * Yaw is measured from the arm's pose in the GLB, in radians, in the usual
 * right-handed sense about world up: 0 is the arm sitting on its rest, and
 * negative swings the stylus inward across the record.
 *
 * The limits come from the asset's own geometry (arm length 209.8mm, pivot to
 * spindle 203.2mm, 12" record), solved for where the stylus lands:
 *
 *     yaw       stylus radius   where
 *       0°        196.9mm       arm rest, off the record
 *     −13.6°      152.4mm       record edge
 *     −15.5°      146.0mm       lead-in groove
 *     −41.0°       57.5mm       lead-out groove
 *     −43.5°       50.0mm       label edge
 */
const MAX_LIFT_RADIANS = (5 * Math.PI) / 180;
const FALL_SECONDS = 0.3;

export const TONEARM = {
  /** Arm rest. A real rest is a hard stop, so nothing goes past it. */
  maxYawRadians: 0,
  /** Label edge: the stylus cannot ride up onto the label. */
  minYawRadians: (-43.5 * Math.PI) / 180,

  /**
   * Lift, in radians above the arm's pose in the GLB. 5° is about 18mm at the
   * stylus on this 209.8mm arm — enough to lift the arm clear of the record by
   * hand, which is the only way to lift it: this deck has no cueing lever.
   */
  maxLiftRadians: MAX_LIFT_RADIANS,
  /** How long a fully raised arm takes to drop once it is let go. */
  fallSeconds: FALL_SECONDS,
  /**
   * Gravity for the drop, rad/s², from θ = ½at² — derived from the two numbers
   * above so the quoted fall time is what actually happens.
   */
  fallAcceleration: (2 * MAX_LIFT_RADIANS) / (FALL_SECONDS * FALL_SECONDS),
  /** A backgrounded tab must not drop the arm in one enormous step. */
  maxFallStepSeconds: 0.05,
};

/**
 * The arm's own dimensions, in metres (rdd.md 10.2). The yaw/radius table in
 * that section is not a lookup here — it is what this geometry predicts, and
 * the deterministic check asserts every row of it.
 */
export const TONEARM_GEOMETRY = {
  /** Pivot to stylus. */
  effectiveLength: 0.2098,
  /** Pivot to spindle. */
  pivotToSpindle: 0.2032,
};

/**
 * The angle at the pivot between the arm and the pivot→spindle line, for a
 * stylus sitting `radius` from the spindle. Plain law of cosines on the
 * triangle pivot–spindle–stylus:
 *
 *     radius² = L² + D² − 2·L·D·cos(interior)
 *
 * Returns null for a radius the arm cannot reach at all.
 */
function interiorAngleForRadius(radius: number): number | null {
  const { effectiveLength: L, pivotToSpindle: D } = TONEARM_GEOMETRY;
  const cosine = (L * L + D * D - radius * radius) / (2 * L * D);
  if (!Number.isFinite(cosine) || cosine < -1 || cosine > 1) return null;
  return Math.acos(cosine);
}

/**
 * The yaw that puts the stylus at `radius` — the inverse of the arm's geometry,
 * solved rather than interpolated from a table.
 *
 * Yaw is measured from the arm's pose in the GLB, where the stylus sits at
 * 196.9mm, so the rest pose is the zero. Swinging inward is negative, which is
 * why the two angles subtract in this order.
 *
 * This is what lets the arm be *driven* to a radius — the cut layout says where
 * the groove has carried the stylus, and this turns that into a pose.
 */
export function yawForRadius(radius: number): number | null {
  const target = interiorAngleForRadius(radius);
  const rest = interiorAngleForRadius(REST_RADIUS_METRES);
  if (target === null || rest === null) return null;
  return clampTonearmYaw(target - rest);
}

/** Where the stylus sits with the arm on its rest, i.e. at yaw 0 (rdd.md 10.2). */
const REST_RADIUS_METRES = 0.1969;

/** The trust boundary for the arm's angle: pointer maths and presets both pass here. */
export function clampTonearmYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) return TONEARM.maxYawRadians;
  return Math.min(
    Math.max(yaw, TONEARM.minYawRadians),
    TONEARM.maxYawRadians,
  );
}

/**
 * Same, for the lift. The floor is whatever is under the stylus right now: the
 * arm's own rest pose out over the arm rest, or the record's surface — which is
 * below the rest pose, hence negative — when the arm is over the disc.
 */
export function clampTonearmLift(lift: number, floor = 0): number {
  const bottom = Math.min(floor, TONEARM.maxLiftRadians);
  if (!Number.isFinite(lift)) return bottom;
  return Math.min(Math.max(lift, bottom), TONEARM.maxLiftRadians);
}

/**
 * The lift angle at which the stylus tip meets a horizontal surface.
 *
 * The tip swings on a circle about the lift pivot, so with the tip at
 * (`alongArm`, `aboveTip`) from that pivot in the arm's vertical plane, its
 * height above the pivot at angle θ is `alongArm·sinθ + aboveTip·cosθ`. Solving
 * that for `surfaceOffset` (the surface's height relative to the pivot, so
 * negative) gives the angle.
 *
 * Every argument is measured off the scene — the stylus mesh's lowest point and
 * the record mesh's top face — so no height is ever assumed. Returns null when
 * the surface is out of the tip's reach.
 */
export function liftAngleForSurface(
  alongArm: number,
  aboveTip: number,
  surfaceOffset: number,
): number | null {
  const reach = Math.hypot(alongArm, aboveTip);
  if (!(reach > 0)) return null;

  const ratio = surfaceOffset / reach;
  if (!Number.isFinite(ratio) || ratio < -1 || ratio > 1) return null;

  return Math.asin(ratio) - Math.atan2(aboveTip, alongArm);
}

/** Mutable, caller-owned, like MotorRuntime. */
export interface LiftFall {
  lift: number;
  velocity: number;
}

/**
 * One step of a released arm dropping back to its rest.
 *
 * Constant acceleration rather than an eased curve: it is a falling arm, not an
 * animation, so it starts slowly and lands at speed. Integrated against the
 * caller's clock, so the drop takes the same time at any frame rate.
 *
 * This is the arm falling through air after a hand lift. Once it is down on the
 * record, `TonearmVertical` below owns the same degree of freedom — there the
 * arm is riding a spring, not falling.
 */
export function stepTonearmFall(
  state: LiftFall,
  deltaSeconds: number,
  floor = 0,
): LiftFall {
  const delta = Math.min(
    Math.max(deltaSeconds, 0),
    TONEARM.maxFallStepSeconds,
  );
  const bottom = Math.min(floor, TONEARM.maxLiftRadians);
  if (!Number.isFinite(state.lift) || state.lift <= bottom) {
    return { lift: bottom, velocity: 0 };
  }

  const velocity = state.velocity - TONEARM.fallAcceleration * delta;
  const lift = clampTonearmLift(state.lift + velocity * delta, bottom);
  return lift <= bottom ? { lift: bottom, velocity: 0 } : { lift, velocity };
}

/* -------------------------------------------------------------------------
 * トーンアームの縦方向の機械応答
 * ---------------------------------------------------------------------- */

/**
 * **盤面の高さは、そのままアームの高さではない。**
 *
 * アームには実効質量があり、その質量はカンチレバーというばねの上に乗っている。
 * 針先とカンチレバーは同じばねの反対側にあるので、**ばねは1本しかない**:
 *
 * ```
 *          盤面 u(t)  ← 反り。針先はここに乗る
 *            │
 *          ばね（カンチレバー、compliance C。針側 stylus.ts と同じ1本）
 *            │
 *          実効質量 M（アーム＋ヘッドシェル＋カートリッジ）
 * ```
 *
 * 針圧 VTF はこのばねを通して針先へ届くので、静止していてもばねは
 * `d₀ = VTF·C` だけ縮んでいる。**この縮みが接触の余裕そのもの**である。
 *
 * 接触している間、アームの高さ x は
 *
 * ```
 *   ẍ = ω₀²·(u − x) − 2ζω₀·ẋ          ω₀ = 1/√(M·C)
 * ```
 *
 * つまり **u に対する2次のローパス**。帰結は全部ここから出る:
 *
 * - **共振より下（反り 0.55〜1.1Hz）**: x → u。アームが盤面に付いていくので、
 *   カンチレバーはたわまない＝**コイルは何も拾わない**。
 * - **共振より上（音声帯域）**: x はほとんど動かない。盤面の動きは丸ごと
 *   カンチレバーの相対運動として残り、そのままコイルが拾う。
 * - **共振点（10〜15Hz あたり）**: 1/(2ζ) 倍に持ち上がる。実機で反りが
 *   ウーファーを煽るのはこれで、後付けのフィルタではない。
 *
 * これが `discShape.ts` に書いてあった「アームの実効質量が無いので超低域の
 * 出力を過大に見積もる」の解消である。
 *
 * ## 接触が切れるとき
 *
 * ばねは押すことしかできない。縮み `d = u − x` が 0 になった時点で針先は
 * 盤面から離れ、アームに残るのは針圧だけになる:
 *
 * ```
 *   ẍ = −VTF/M = −ω₀²·d₀              （ばねは自由長）
 * ```
 *
 * **離れる瞬間の d はちょうど 0 なので、たわみは段差なく −d₀ へ繋がる。**
 * しきい値をまたいだところでクリックは出ない。
 *
 * なお、**滑らかな反りは正しく荷重されたアームを持ち上げない** — 33⅓rpm の
 * 1回転周期で VTF/M を超える加速度を要求するには、盤が数cm反っていなければ
 * ならない。持ち上がるのは共振付近から上であり、検査でも両方を押さえてある。
 *
 * ## 二重計上について
 *
 * **コンプライアンスはここに持たない。** `TonearmSuspension` は
 * `StylusParameters` の部分型なので、呼び出し側は針のパラメータをそのまま
 * 渡す。同じカンチレバーを2本に増やさないための構造であって、省略ではない。
 * 針側（`stylus.ts`）が同じ C を針先質量と組んで使うのは正しい —
 * **1本のばねに2つの質量が付いている**だけで、共振は2つとも実在する
 * （アーム 10Hz 前後、針先 20kHz 前後）。
 */
export interface TonearmVerticalParameters {
  /**
   * 針先で見た実効質量 kg。カタログの「実効質量 12g」なら 0.012。
   * **0 が理想** — この値が 0 のときモデル全体がバイパスされる。
   */
  effectiveMass: number;
  /**
   * ピボットまわりの慣性 kg·m²。実測できるならこちらが正本で、実効質量は
   * `I / L²` としてここから出る。**0 か非有限なら `effectiveMass` を使う。**
   */
  pivotInertia: number;
  /** 縦方向共振の減衰比 ζ。軸受けと制動材の合計。1 が臨界減衰。 */
  damping: number;
}

/**
 * ばね側。**`StylusParameters` をそのまま渡せる**（構造的部分型）。
 * ここへ数値を書き写さないこと — 書き写した時点でばねが2本になる。
 */
export interface TonearmSuspension {
  /** カンチレバーのコンプライアンス m/N。 */
  compliance: number;
  /** 針圧 N。 */
  trackingForce: number;
}

/**
 * 理想のアーム。**質量ゼロ＝縦方向の機械応答を持たない。**
 *
 * この設定でモデルはバイパスされ、姿勢は盤面に貼り付き、たわみは反りの全量に
 * なる。**物理としては両立しない**（質量ゼロのアームなら反りは全部吸われる）が、
 * これはモデルを入れる前の挙動そのものであり、`IDEAL_STYLUS` と同じ約束
 * ——理想設定では1ビットも変わらない——を守るための定義である。
 *
 * **実機の値はまだどこにも書いていない。推測値を既定に混ぜないこと。**
 */
export const IDEAL_TONEARM: TonearmVerticalParameters = {
  effectiveMass: 0,
  pivotInertia: 0,
  damping: 1,
};

/** 無限に柔らかく、針圧は無限。`IDEAL_STYLUS` と同じ意味の退化値。 */
const IDEAL_SUSPENSION: TonearmSuspension = {
  compliance: Number.POSITIVE_INFINITY,
  trackingForce: Number.POSITIVE_INFINITY,
};

/** 陽的なばね項が安定でいられる刻み。共振周期のおよそ 1/25。 */
const STABLE_STEP_RADIANS = 0.25;
/** 1回の `step` で刻む上限。背面タブの巨大な delta を有界にする。 */
const MAX_SUBSTEPS = 64;

const clampFinite = (
  value: number,
  low: number,
  high: number,
  fallback: number,
) => (Number.isFinite(value) ? Math.min(Math.max(value, low), high) : fallback);

export interface TonearmVertical {
  /** 理想設定なら true。このとき盤面がそのまま姿勢にもたわみにもなる。 */
  readonly bypassed: boolean;
  /** アーム自身の高さ m（針先の位置で測る）。**画面の姿勢はこれを使う。** */
  readonly height: number;
  /**
   * カンチレバーのたわみ m（静的なたわみからの差）。**コイルが拾うのはこれ。**
   * 反りのうちアームが追従し切れなかったぶんだけが残る。
   */
  readonly deflection: number;
  /** 針先が盤面に触れているか。false は反りに置いていかれた状態。 */
  readonly touching: boolean;
  /** 縦方向の共振周波数 Hz。理想なら Infinity（何にでも付いていける）。 */
  readonly resonanceHz: number;
  /** 針先で見た実効質量 kg（`pivotInertia` からの換算を含む）。 */
  readonly effectiveMass: number;
  /** 静的なたわみ m（= VTF·C）。接触の余裕そのもの。 */
  readonly staticCompression: number;
  /** 接触を失ったステップ数の累計。`reset` では消さない。 */
  readonly contactLossSteps: number;
  configure(
    arm: TonearmVerticalParameters,
    suspension: TonearmSuspension,
  ): void;
  /** 盤面の高さ `surfaceHeight` へ置き直す。着地速度 m/s（下向きが負）を渡せる。 */
  reset(surfaceHeight: number, velocity?: number): void;
  /** 盤面の高さを受け取り、`height` と `deflection` を進める。 */
  step(surfaceHeight: number, deltaSeconds: number): void;
}

/**
 * 縦方向の応答をひとつ作る。**メインスレッドと音声スレッドが同じ関数を使う** —
 * 前者は毎フレーム姿勢を、後者は毎サンプルたわみを解く。刻みは呼び出し側の
 * 時計から取るので、フレームレートにもブロック長にも依らない。
 */
export function createTonearmVertical(
  arm: TonearmVerticalParameters = IDEAL_TONEARM,
  suspension: TonearmSuspension = IDEAL_SUSPENSION,
): TonearmVertical {
  let omegaSquared = 0;
  let omega = 0;
  let damping = 0;
  let compression0 = 0;
  let velocity = 0;
  let height = 0;
  let touching = true;
  let losses = 0;

  const mutable = () =>
    model as {
      -readonly [K in keyof TonearmVertical]: TonearmVertical[K];
    };

  const model: TonearmVertical = {
    bypassed: true,
    height: 0,
    deflection: 0,
    touching: true,
    resonanceHz: Number.POSITIVE_INFINITY,
    effectiveMass: 0,
    staticCompression: 0,
    contactLossSteps: 0,

    configure(next, spring) {
      const inertia = next.pivotInertia;
      const L = TONEARM_GEOMETRY.effectiveLength;
      // 慣性が入っていればそちらが正本。実効質量はその針先換算にすぎない。
      const mass =
        Number.isFinite(inertia) && inertia > 0
          ? inertia / (L * L)
          : Math.max(next.effectiveMass, 0);
      const compliance = spring.compliance;
      const force = Math.max(spring.trackingForce, 0);

      // 質量ゼロ、あるいは無限に柔らかいばね — どちらも「縦方向の応答が無い」。
      const live =
        mass > 0 &&
        Number.isFinite(mass) &&
        compliance > 0 &&
        Number.isFinite(compliance);

      const self = mutable();
      self.bypassed = !live;
      self.effectiveMass = mass;

      if (!live) {
        omega = 0;
        omegaSquared = 0;
        damping = 0;
        compression0 = 0;
        self.resonanceHz = Number.POSITIVE_INFINITY;
        self.staticCompression = 0;
      } else {
        omega = 1 / Math.sqrt(mass * compliance);
        omegaSquared = omega * omega;
        // ζ は正の有限値へ丸めるので、**どんな設定でも積分が発散しない。**
        damping = 2 * clampFinite(next.damping, 0.02, 20, 1) * omega;
        // 針圧が無限（＝理想の針）なら余裕も無限で、接触は決して切れない。
        compression0 = Number.isFinite(force)
          ? force * compliance
          : Number.POSITIVE_INFINITY;
        self.resonanceHz = omega / (2 * Math.PI);
        self.staticCompression = compression0;
      }

      model.reset(0);
    },

    reset(surfaceHeight, landing = 0) {
      const surface = Number.isFinite(surfaceHeight) ? surfaceHeight : 0;
      height = surface;
      velocity = Number.isFinite(landing) ? landing : 0;
      touching = true;
      const self = mutable();
      self.height = surface;
      // 理想では反りの全量がたわみ。実機設定では静的な位置＝たわみ0。
      self.deflection = model.bypassed ? surface : 0;
      self.touching = true;
    },

    step(surfaceHeight, deltaSeconds) {
      const self = mutable();
      const surface = Number.isFinite(surfaceHeight) ? surfaceHeight : 0;

      if (model.bypassed) {
        // 理想: 姿勢は盤面に貼り付き、たわみは反りの全量。**モデルを入れる前と
        // 1ビットも変わらない**ことの定義（`IDEAL_TONEARM` の注記）。
        height = surface;
        self.height = surface;
        self.deflection = surface;
        self.touching = true;
        return;
      }

      const delta = clampFinite(deltaSeconds, 0, TONEARM.maxFallStepSeconds, 0);
      if (delta > 0) {
        // 共振周期に対して粗い刻みで呼ばれても崩れないよう、内側で割る。
        // 音声レート（20µs）では常に1回で、ブロック長にも依らない。
        const steps = Math.min(
          Math.max(Math.ceil(delta / (STABLE_STEP_RADIANS / omega)), 1),
          MAX_SUBSTEPS,
        );
        const h = delta / steps;
        for (let i = 0; i < steps; i++) {
          // ばねの縮み。静的なたわみのぶんだけ余裕がある。
          if (surface - height + compression0 > 0) {
            touching = true;
            // 減衰は陰的に扱うので、ζ をいくら大きくしても行き過ぎない。
            velocity =
              (velocity + omegaSquared * (surface - height) * h) /
              (1 + damping * h);
          } else {
            // 盤面が逃げてカンチレバーが自由長へ戻った。残るのは針圧だけ。
            touching = false;
            losses += 1;
            velocity -= omegaSquared * compression0 * h;
          }
          height += velocity * h;
        }

        if (!Number.isFinite(height) || !Number.isFinite(velocity)) {
          // どんな設定を入れられても値を撒き散らさない。盤面へ戻して仕切り直す。
          height = surface;
          velocity = 0;
          touching = true;
        }
      }

      self.height = height;
      // 離れる瞬間の縮みはちょうど 0 なので、両者は段差なく繋がる。
      self.deflection = touching ? surface - height : -compression0;
      self.touching = touching;
      self.contactLossSteps = losses;
    },
  };

  model.configure(arm, suspension);
  return model;
}

/** 実効質量 kg → ピボットまわりの慣性 kg·m²。カタログ値から入れるとき用。 */
export const effectiveMassToPivotInertia = (mass: number) =>
  mass * TONEARM_GEOMETRY.effectiveLength * TONEARM_GEOMETRY.effectiveLength;
