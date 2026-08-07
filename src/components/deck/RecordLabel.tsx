import { useEffect } from "react";
import {
  CanvasTexture,
  SRGBColorSpace,
  type Mesh,
  type MeshStandardMaterial,
} from "three";
import type { ResolvedTurntable } from "../../model/manifest";
import { trackRuntime } from "../../audio/trackSource";
import { useDeckStore } from "../../store/useDeckStore";

/**
 * Square, because the label is round: a centre crop of a square fills the disc
 * whatever the cover's aspect ratio was. 512 is enough for a 100mm label that
 * is never seen closer than the camera's minimum distance.
 */
const LABEL_PIXELS = 512;

/**
 * The GLB's own textures use glTF's UV convention — origin at the image's top
 * left — which GLTFLoader implements by uploading them unflipped. A texture
 * built here has to say the same thing or it reads mirrored top to bottom.
 */
const LABEL_FLIP_Y = false;

/**
 * A quarter turn, because this label's UV island is a quarter turn off the
 * deck. Measured, not guessed: rendering a texture with a different colour in
 * each corner puts the image's top edge along the deck's left side, so the art
 * needs turning by this much to read upright to someone standing at the front.
 *
 * To check it again after an asset change, paint the corners of
 * `recordLabel.canvas` (the DEV handle) and look:
 *
 *     const g = recordLabel.canvas.getContext("2d");
 *     g.fillStyle = "#f00"; g.fillRect(0, 0, 256, 256);   // image top-left
 *     recordLabel.texture.needsUpdate = true;
 *
 * Red belongs at the back left of the label. `recordLabel.texture.rotation` and
 * `.flipY` can both be tried live from there.
 */
const LABEL_ROTATION = Math.PI / 2;

/** Plain enough to read while spinning: a solid label with the title on it. */
function paintPlainLabel(
  context: CanvasRenderingContext2D,
  title: string,
  artist: string | null,
) {
  const size = LABEL_PIXELS;
  context.fillStyle = "#8d1f24";
  context.fillRect(0, 0, size, size);

  context.textAlign = "center";
  context.textBaseline = "middle";

  // Shrink to fit rather than wrap: a title band on a record label is one line.
  context.fillStyle = "#f7f2e8";
  let titleSize = 46;
  do {
    context.font = `600 ${titleSize}px system-ui, sans-serif`;
    titleSize -= 2;
  } while (context.measureText(title).width > size * 0.78 && titleSize > 18);
  context.fillText(title, size / 2, size * 0.42, size * 0.8);

  if (artist !== null) {
    context.fillStyle = "#e2c9a0";
    context.font = "400 30px system-ui, sans-serif";
    context.fillText(artist, size / 2, size * 0.56, size * 0.8);
  }
}

/**
 * The cover, cropped to the largest centred square it contains. Cropping
 * rather than squashing: a stretched sleeve on a round label reads as a
 * mistake, a cropped one reads as a label.
 */
function paintArtwork(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
) {
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  context.drawImage(
    image,
    (image.naturalWidth - side) / 2,
    (image.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    LABEL_PIXELS,
    LABEL_PIXELS,
  );
}

/**
 * Puts the loaded track's cover art — or a plain label bearing its title — on
 * the record's top label, and only there.
 *
 * Every resource this makes is owned by the one effect that made it: the
 * cloned material, the canvas and the texture all go when the track changes or
 * the component unmounts. The mesh gets its original material back, untouched;
 * the GLB's materials are shared between meshes (the whole record is one
 * `lambert1`), so writing to one would repaint the deck (rdd.md 5.9).
 */
export function RecordLabel({ parts }: { parts: ResolvedTurntable }) {
  const track = useDeckStore((s) => s.track);
  const node = parts.nodes.recordLabelTop;

  useEffect(() => {
    const mesh = node as Mesh;
    if (!mesh.isMesh || track === null) return;

    const original = mesh.material;
    if (Array.isArray(original)) {
      if (import.meta.env.DEV) {
        console.warn("[label] multi-material label mesh, leaving it alone");
      }
      return;
    }

    // The clone is this component's own material. Nothing else in the scene
    // may end up pointing at it, and nothing here may touch `original`.
    const material = original.clone() as MeshStandardMaterial;
    mesh.material = material;

    const canvas = document.createElement("canvas");
    canvas.width = LABEL_PIXELS;
    canvas.height = LABEL_PIXELS;

    let texture: CanvasTexture | null = null;
    let cancelled = false;

    const paint = async () => {
      const context = canvas.getContext("2d");
      if (context === null) return;

      const url = track.artwork === null ? null : trackRuntime.artworkUrl;
      if (url !== null) {
        try {
          const image = new Image();
          image.src = url;
          // decode() rather than onload: it rejects on a corrupt image instead
          // of handing back a blank one, which is what makes the fallback work.
          await image.decode();
          if (cancelled) return;
          paintArtwork(context, image);
        } catch (cause) {
          if (import.meta.env.DEV) {
            console.warn("[label] cover art would not decode", cause);
          }
          paintPlainLabel(context, track.title, track.artist);
        }
      } else {
        paintPlainLabel(context, track.title, track.artist);
      }
      if (cancelled) return;

      texture = new CanvasTexture(canvas);
      // Colour data, not data-as-colour: without this the artwork renders
      // washed out under the linear pipeline.
      texture.colorSpace = SRGBColorSpace;
      texture.flipY = LABEL_FLIP_Y;
      // About the middle of the label, not its corner.
      texture.center.set(0.5, 0.5);
      texture.rotation = LABEL_ROTATION;
      texture.needsUpdate = true;

      material.map = texture;
      material.needsUpdate = true;

      // Dev-only handle, like deckStore and trackRuntime: the orientation and
      // crop are checked by eye, and this is what lets them be checked without
      // editing code (`recordLabel.texture.flipY = true`, then re-render).
      if (import.meta.env.DEV) {
        (globalThis as { recordLabel?: unknown }).recordLabel = {
          mesh,
          material,
          texture,
          canvas,
        };
      }
    };

    void paint();

    return () => {
      cancelled = true;
      // Order matters: hand the mesh back its shared material before letting
      // go of the clone, so nothing is ever pointing at a disposed material.
      mesh.material = original;
      material.map = null;
      material.dispose();
      // Only ever the texture made here — `original.map` is the asset's own
      // and is shared with the rest of the deck.
      texture?.dispose();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [node, track]);

  return null;
}
