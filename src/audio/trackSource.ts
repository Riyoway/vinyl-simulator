/**
 * Putting a record on the deck: take an audio file, decode it, and keep what
 * came out of it.
 *
 * The split is the one the rest of the app already uses. The decoded
 * AudioBuffer and the File itself are runtime objects — several hundred MB of
 * samples in the buffer's case — so they live here in a plain module box and
 * never enter Zustand. What crosses into the store is TrackInfo: numbers and
 * strings only, so the state stays serialisable for presets and the record
 * library later (rdd.md 5.3 / 25).
 *
 * Nothing here plays anything. There is no graph, no source node and no
 * output — decoding is all this layer does.
 */

import { getAudioContext } from "./audioContext";
import { discSeedFromBytes } from "./engine/recordCondition";

/** What decoding alone can tell you about a file. */
export interface DecodedInfo {
  fileName: string;
  /** The browser's MIME type. Empty string when the OS supplied none. */
  mimeType: string;
  sizeBytes: number;
  /** Seconds, from the decoded samples — not from any container header. */
  duration: number;
  /**
   * The rate the samples are **at**, which is the AudioContext's rate, not
   * necessarily the file's: Web Audio resamples everything on decode, so a
   * 44.1kHz file on a 48kHz device arrives here as 48000 (measured, not
   * assumed). The file's original rate is only in the container header and
   * would take a parser per format to read.
   *
   * This is the number the playback maths wants anyway — it is the rate the
   * buffer actually plays at.
   */
  sampleRate: number;
  channelCount: number;
}

/**
 * That, plus what the tags said: the serialisable half of a loaded track, safe
 * for Zustand and later for IndexedDB.
 */
export interface TrackInfo extends DecodedInfo {
  /** Never empty: the file name stands in when the file carries no tags. */
  title: string;
  artist: string | null;
  album: string | null;
  year: number | null;
  trackNumber: number | null;
  /**
   * What the embedded cover art is, not the art itself — the bytes and the
   * object URL live in `trackRuntime`, because neither survives serialising.
   */
  artwork: { mimeType: string; sizeBytes: number } | null;
}

/**
 * The runtime half. Read it directly; never copy any of it into React state.
 * Null whenever no record is on the deck.
 *
 * `artworkUrl` is a blob: URL — a handle into this document, not a value. It
 * dies with `disposeTrack`, so nothing may hold a copy across a track change,
 * and it must never reach the store: persisted to IndexedDB later it would
 * come back as a dangling link.
 */
export const trackRuntime: {
  file: File | null;
  buffer: AudioBuffer | null;
  artwork: Blob | null;
  artworkUrl: string | null;
} = {
  file: null,
  buffer: null,
  artwork: null,
  artworkUrl: null,
};

/**
 * デコードは**再生と同じコンテキスト**で行う（audio/audioContext.ts）。別々に
 * 作ると、デコード先のレートと再生側のレートが食い違いうる。
 *
 * 生成は初回のデコードまで遅れる: デコードは必ずクリックかドロップの内側で
 * 起きるので、コンテキストはユーザー操作の中で生まれる。ここでは resume しない
 * — `decodeAudioData` に稼働中のコンテキストは要らない。
 */

/**
 * Take the current record off. The buffer and the File are only reachable from
 * here, so dropping the references is the whole of the disposal — and it has
 * to happen, because a stale buffer is the largest object the app can hold.
 *
 * The AudioContext deliberately survives: it is reused by the next decode, and
 * a closed one cannot decode at all.
 */
export function disposeTrack(): void {
  trackRuntime.file = null;
  trackRuntime.buffer = null;
  trackRuntime.artwork = null;
  // A blob: URL is a document-lifetime registration, not a value: dropping the
  // string leaks the image until the tab closes. Only revoke() actually frees
  // it, so every path that replaces a track has to come through here.
  if (trackRuntime.artworkUrl !== null) {
    URL.revokeObjectURL(trackRuntime.artworkUrl);
    trackRuntime.artworkUrl = null;
  }
}

/**
 * Hand the cover art to the runtime and hand back what the store may know
 * about it. Called only once a load has won its race, so a superseded load can
 * never leave an object URL behind.
 */
export function holdArtwork(picture: TrackPicture): TrackInfo["artwork"] {
  // Copied out of the parser's buffer rather than viewed into it — the copy is
  // a cover image, and it is what lets this be typed rather than asserted (the
  // parser's Uint8Array is over an ArrayBufferLike, which may be shared).
  const blob = new Blob([new Uint8Array(picture.bytes)], {
    type: picture.mimeType,
  });
  trackRuntime.artwork = blob;
  trackRuntime.artworkUrl = URL.createObjectURL(blob);
  return { mimeType: picture.mimeType, sizeBytes: blob.size };
}

/** Embedded cover art as it comes out of the file, before it is held. */
export interface TrackPicture {
  mimeType: string;
  bytes: Uint8Array;
}

export interface TrackTags {
  title: string;
  artist: string | null;
  album: string | null;
  year: number | null;
  trackNumber: number | null;
  picture: TrackPicture | null;
}

/** Tag text is often padded or empty rather than absent. Treat blank as absent. */
const clean = (value: string | undefined): string | null => {
  const text = value?.trim();
  return text ? text : null;
};

/** "Blue Train.flac" → "Blue Train". The stand-in title when a file has no tags. */
const titleFromFileName = (fileName: string): string => {
  const dot = fileName.lastIndexOf(".");
  const stem = (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
  return stem || fileName;
};

/**
 * Read the tags and the embedded cover art. **Never throws** — tags are
 * decoration, the samples are the point, and a file with an exotic or damaged
 * tag block still plays. Anything unreadable comes back as the file-name
 * fallback so a bad tag can never fail a good decode.
 *
 * ID3v1/v2, MP4 atoms, Vorbis comments and APE all have their own layout, so
 * this is music-metadata's job rather than five hand-written parsers. It reads
 * the Blob locally and talks to nothing — no part of the file leaves the
 * machine, here or anywhere else in this app.
 *
 * The picture is returned as bytes, not as a Blob or a URL: making the URL is
 * the caller's move, once it knows this load actually won (see useTrackLoader).
 */
export async function readTrackTags(file: File): Promise<TrackTags> {
  const fallback: TrackTags = {
    title: titleFromFileName(file.name),
    artist: null,
    album: null,
    year: null,
    trackNumber: null,
    picture: null,
  };

  try {
    // Imported on demand, not at module load: the parser is a bigger download
    // than the deck itself, and nobody who never loads a file needs it.
    const { parseBlob } = await import("music-metadata");
    // duration: false — the decoded buffer already knows how long it is, and
    // asking for it here makes the parser scan a whole VBR file to guess.
    const { common } = await parseBlob(file, { duration: false });
    const picture = common.picture?.[0];

    return {
      title: clean(common.title) ?? fallback.title,
      artist: clean(common.artist),
      album: clean(common.album),
      year:
        typeof common.year === "number" && Number.isFinite(common.year)
          ? common.year
          : null,
      trackNumber: common.track?.no ?? null,
      picture: picture
        ? { mimeType: picture.format, bytes: picture.data }
        : null,
    };
  } catch (cause) {
    if (import.meta.env.DEV) {
      console.warn(`[track] no readable tags in ${file.name}`, cause);
    }
    return fallback;
  }
}

/**
 * Decode one file. Throws with a message meant for the screen — the caller
 * puts it in front of the user rather than interpreting it.
 *
 * The buffer is returned instead of being stored, so the caller decides
 * whether this result is still the one that matters (see useTrackLoader).
 */
export async function decodeAudioFile(
  file: File,
): Promise<{ info: DecodedInfo; buffer: AudioBuffer; discSeed: number }> {
  if (file.size === 0) {
    throw new Error(`${file.name}: the file is empty`);
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (cause) {
    // Moved, deleted, permission-denied, or a folder rather than a file: the
    // picker handed over a reference the disk no longer honours.
    throw new Error(
      `${file.name}: could not be read — it may have been moved or deleted`,
      { cause },
    );
  }

  // **デコードの前に盤の指紋を取る。** `decodeAudioData` は渡された ArrayBuffer を
  // detach するので、この後では中身が読めない — 読み直せば同じファイルを2回読む
  // ことになる。ここで畳んで 32bit だけ持ち出す（`recordCondition.ts`）。
  const discSeed = discSeedFromBytes(bytes);

  let buffer: AudioBuffer;
  try {
    buffer = await getAudioContext().decodeAudioData(bytes);
  } catch (cause) {
    // decodeAudioData is the only authority on what this browser can play, so
    // an unsupported codec and a truncated file both arrive here as the same
    // EncodingError. Name both possibilities instead of guessing between them.
    throw new Error(
      `${file.name}: could not be decoded as audio — the format is unsupported, or the file is damaged`,
      { cause },
    );
  }

  return {
    buffer,
    // 呼び出し側へ渡す。**モジュールに覚えさせない** — 追い越された読み込みが
    // 勝った読み込みの盤を書き換えてしまう（TrackLoader の順序調停）。
    discSeed,
    info: {
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      duration: buffer.duration,
      sampleRate: buffer.sampleRate,
      channelCount: buffer.numberOfChannels,
    },
  };
}

// Dev-only handle, like deckStore and handInput: the decoded buffer can be
// inspected from the console before there is any way to hear it.
if (import.meta.env.DEV) {
  (globalThis as { trackRuntime?: typeof trackRuntime }).trackRuntime =
    trackRuntime;
}
