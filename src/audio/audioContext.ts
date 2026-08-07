/**
 * デッキがただ一つ持つ AudioContext。
 *
 * デコードも再生も同じコンテキストを使う。別々に作ると、レートが食い違った
 * ときにデコード済みバッファと再生側のレートがずれる（`decodeAudioData` は
 * 呼ばれたコンテキストのレートへリサンプリングする — rdd.md 7.1）。
 *
 * 生成は初回の要求時まで遅らせる。デコードも再生開始も必ずユーザー操作の内側で
 * 起きるので、コンテキストはジェスチャの中で生まれる。
 */

let context: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  context ??= new AudioContext();
  return context;
}

/** まだ生成していなければ null。生成を誘発しない問い合わせ用。 */
export function peekAudioContext(): AudioContext | null {
  return context;
}
