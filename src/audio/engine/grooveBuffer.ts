/**
 * 仮想溝バッファ — 「盤に刻まれているもの」そのもの。
 *
 * 45/45ステレオでは溝の左右の壁がそのままLとRなので、壁の変調として持つ。
 * 横方向（lateral = L+R）と垂直方向（vertical = L−R）が要る段——カッティング
 * 前処理やトラッキング判定——はこの2本の回転で得られるため、ここでは回さない
 * （audio-engine.md 7.1 / rdd.md 11.7）。
 *
 * **engine 配下は Web Audio 型を1つも import しない。** その境界がオフライン検証と
 * 将来の WASM 移植を成立させている（audio-engine.md 9.1）。
 */

export interface GrooveBuffer {
  /**
   * [左壁, 右壁]。モノラル音源では同じ Float32Array を2回指す — 複製しない。
   */
  walls: readonly [Float32Array, Float32Array];
  /** 溝を刻んだときのサンプルレート。再生側のレートとは独立に扱う。 */
  sampleRate: number;
  frames: number;
  durationSeconds: number;
}

/**
 * デコード済みチャンネルから溝を作る。信頼境界なので、ここで弾いたものは
 * エンジンへ入らない。
 */
export function createGrooveBuffer(
  channels: readonly Float32Array[],
  sampleRate: number,
): GrooveBuffer {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`groove: sample rate must be positive, got ${sampleRate}`);
  }
  const left = channels[0];
  if (!left || left.length === 0) {
    throw new Error("groove: needs at least one non-empty channel");
  }

  // モノラルは両壁が同じ振れ方をする。3ch以上は先頭2本だけを使う。
  const right = channels[1] ?? left;
  const frames = Math.min(left.length, right.length);

  return {
    walls: [left, right],
    sampleRate,
    frames,
    durationSeconds: frames / sampleRate,
  };
}
