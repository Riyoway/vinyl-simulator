import { useCallback, useEffect, useRef, useState } from "react";
import { loadGrooveIntoDeck } from "../audio/deckAudio";
import {
  decodeAudioFile,
  disposeTrack,
  holdArtwork,
  readTrackTags,
  trackRuntime,
  type TrackInfo,
} from "../audio/trackSource";
import { useDeckStore } from "../store/useDeckStore";

/**
 * Extensions alongside audio/*: Windows and Linux hand over an empty MIME type
 * for FLAC and Opus often enough that the filter would hide them.
 */
const ACCEPT = "audio/*,.mp3,.wav,.ogg,.opus,.flac,.m4a,.aac,.aiff,.aif";

const clock = (seconds: number) => {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const channels = (count: number) =>
  count === 1 ? "mono" : count === 2 ? "stereo" : `${count} ch`;

/** "audio/mpeg" → "MPEG", falling back to the extension when the OS gave none. */
function formatOf(track: TrackInfo) {
  const fromMime = track.mimeType.split("/")[1];
  if (fromMime) return fromMime.toUpperCase();
  const dot = track.fileName.lastIndexOf(".");
  return dot > 0 ? track.fileName.slice(dot + 1).toUpperCase() : "—";
}

/**
 * Loads a file onto the deck, whichever way it arrived.
 *
 * Decoding a long file takes long enough for a second one to be dropped on top
 * of it, so each attempt carries a sequence number and only the newest one is
 * allowed to write — the same reason `pressSeq` exists for drags. Without it
 * the slower of two decodes wins simply by finishing last.
 */
function useTrackLoader() {
  const seq = useRef(0);

  return useCallback(async (file: File | null | undefined) => {
    // A cancelled picker reports no file at all. Nothing was asked for, so
    // nothing changes — in particular the record already on the deck stays.
    if (!file) return;

    const attempt = ++seq.current;
    // Off with the old one first: the store must never describe a track whose
    // buffer has already been dropped, and holding two decoded albums at once
    // is the easiest way to run this tab out of memory.
    disposeTrack();
    // 音声スレッド側の盤も同時に降ろす。降ろし忘れると、載っていない盤の音が
    // 鳴り続ける。
    loadGrooveIntoDeck(null);
    useDeckStore.getState().beginTrackLoad();

    try {
      // Side by side: the tag read is a separate pass over the same file, and
      // it never rejects, so only a failed decode can fail the load.
      const [{ info, buffer, discSeed }, tags] = await Promise.all([
        decodeAudioFile(file),
        readTrackTags(file),
      ]);
      if (attempt !== seq.current) return; // superseded mid-decode

      trackRuntime.file = file;
      trackRuntime.buffer = buffer;
      // 溝として音声スレッドへ。チャンネルデータは複製して渡すので、こちらの
      // AudioBuffer はラベル生成や波形表示のために残る。
      //
      // **盤の seed も一緒に渡す。** 中身から決まるので、同じファイルを何度
      // 載せ直しても埃と反りは同じ場所に出る（`recordCondition.ts`）。負けた
      // 読み込みの seed はこの行まで来ないので、盤とレコードが食い違わない。
      loadGrooveIntoDeck(buffer, discSeed);
      // Held only now, past the race check — an object URL made any earlier
      // would be leaked by the load that lost.
      const artwork = tags.picture === null ? null : holdArtwork(tags.picture);

      useDeckStore.getState().setTrack({
        ...info,
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        year: tags.year,
        trackNumber: tags.trackNumber,
        artwork,
      });
    } catch (error) {
      if (attempt !== seq.current) return;
      useDeckStore
        .getState()
        .setTrackError(
          error instanceof Error ? error.message : String(error),
        );
    }
  }, []);
}

/**
 * The record-loading panel: a file picker, and the whole window as a drop
 * target. No playback — this only gets the samples into memory (rdd.md 7.1).
 */
export function TrackLoader() {
  const track = useDeckStore((s) => s.track);
  const status = useDeckStore((s) => s.trackStatus);
  const error = useDeckStore((s) => s.trackError);
  const load = useTrackLoader();
  const [dragging, setDragging] = useState(false);

  // Window-level, so a file can be dropped anywhere over the deck rather than
  // onto this small panel. The listeners also cancel the browser's own default
  // for a dropped file, which is to navigate away from the app and take the
  // whole session with it — that applies to misses as much as hits.
  useEffect(() => {
    const over = (event: DragEvent) => {
      event.preventDefault();
      setDragging(true);
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      // One deck, one record: anything after the first file is ignored.
      void load(event.dataTransfer?.files[0]);
    };
    // dragleave also fires when moving between elements inside the page; only
    // a null relatedTarget means the pointer has left the window itself.
    const leave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragging(false);
    };

    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    window.addEventListener("dragleave", leave);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragleave", leave);
    };
  }, [load]);

  return (
    <section
      className={`track-panel${dragging ? " track-panel--dropping" : ""}`}
    >
      <label className="track-panel__pick">
        <input
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(event) => {
            void load(event.target.files?.[0]);
            // Clear it so choosing the same file twice in a row still fires a
            // change event. The File above is already captured by then.
            event.target.value = "";
          }}
        />
        {status === "loading" ? "Decoding…" : "Load audio"}
      </label>

      {track ? (
        <>
          <div className="track-panel__tags">
            {/* The URL is read straight from the runtime: it is a handle, not
                state, and it is always set before the store says there is
                artwork to show. */}
            {track.artwork !== null && trackRuntime.artworkUrl !== null && (
              <img
                className="track-panel__cover"
                src={trackRuntime.artworkUrl}
                alt={`Cover art for ${track.title}`}
              />
            )}
            <div className="track-panel__titles">
              <strong title={track.title}>{track.title}</strong>
              {track.artist !== null && <span>{track.artist}</span>}
              {track.album !== null && (
                <span>
                  {track.album}
                  {track.year !== null && ` (${track.year})`}
                  {track.trackNumber !== null && ` · #${track.trackNumber}`}
                </span>
              )}
            </div>
          </div>

          <dl className="track-panel__info">
            <dt>file</dt>
            <dd title={track.fileName}>{track.fileName}</dd>
            <dt>format</dt>
            <dd>
              {formatOf(track)} / {megabytes(track.sizeBytes)}
            </dd>
            <dt>length</dt>
            <dd>{clock(track.duration)}</dd>
            {/* "decoded" because Web Audio resamples to the device rate — this
                is not necessarily the rate the file was written at. */}
            <dt>decoded</dt>
            <dd>
              {track.sampleRate.toLocaleString()} Hz /{" "}
              {channels(track.channelCount)}
            </dd>
          </dl>
        </>
      ) : (
        <p className="track-panel__hint">
          {dragging ? "Drop to load" : "or drop an audio file anywhere"}
        </p>
      )}

      {error !== null && (
        <p className="track-panel__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
