import type { Mesh, Object3D } from "three";

// The manifest in public/models is the single source of truth for node names —
// nothing else in the app may hardcode a GLB node name (rdd.md 5.4).
export const MANIFEST_PATH = "/models/turntable-manifest.json";

export const NODE_KEYS = [
  "platter",
  "tonearmYaw",
  "tonearmLift",
  // The arm has no HIT_* proxy in the asset, so these two double as its grab
  // target — see TurntableControls.
  "tonearmMesh",
  "headshell",
  // The tip is measured off this mesh, so contact is never a guessed height.
  "stylus",
  "dustCover",
  "recordSocket",
  "recordRoot",
  "recordMesh",
  // The playing side's label. The bottom label is deliberately absent: nothing
  // in the app may touch it (rdd.md 7.4).
  "recordLabelTop",
  "pitch",
  "knobLeft",
  "knobRight",
  "speedButton",
  "startStopButton",
  "counterweight",
] as const;

export const COLLIDER_KEYS = [
  "record",
  "pitch",
  "knobLeft",
  "knobRight",
  "speed",
  "startStop",
] as const;

export type NodeKey = (typeof NODE_KEYS)[number];
export type ColliderKey = (typeof COLLIDER_KEYS)[number];

// The one vocabulary shared by the store, the interaction layer and the model.
//
// These follow what the deck actually has printed on it, which is NOT what the
// GLB's `extras.controlId` claims: the round control the asset calls "power" is
// silk-screened "45 / 33" and is the speed selector. The model has no power
// switch printed anywhere, so there is no "power" control id.
export const CONTROL_IDS = [
  "speed",
  "start-stop",
  "pitch",
  "knob-left",
  "knob-right",
  "record",
  // No collider of its own: the arm's own meshes are the grab target.
  "tonearm",
] as const;

export type ControlId = (typeof CONTROL_IDS)[number];

/** The manifest key is authoritative for meaning. */
const CONTROL_ID_BY_COLLIDER: Record<ColliderKey, ControlId> = {
  speed: "speed",
  startStop: "start-stop",
  pitch: "pitch",
  knobLeft: "knob-left",
  knobRight: "knob-right",
  record: "record",
};

export interface TurntableManifest {
  model: string;
  root: string;
  nodes: Record<NodeKey, string>;
  colliders: Record<ColliderKey, string>;
}

export interface ResolvedTurntable {
  root: Object3D;
  nodes: Record<NodeKey, Object3D>;
  colliders: Record<ColliderKey, Mesh>;
}

// HIT_* colliders are moved onto their own layer. The camera and the shadow
// passes only draw layer 0, so the geometry stays in the scene (and stays
// raycastable) without ever being rendered — and without touching materials,
// which the colliders share with each other (rdd.md 5.6 / 29.7).
export const COLLIDER_LAYER = 1;

function requireStrings<K extends string>(
  source: Record<string, unknown> | undefined,
  keys: readonly K[],
  label: string,
): Record<K, string> {
  const out = {} as Record<K, string>;
  const missing: string[] = [];

  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
    else missing.push(key);
  }

  if (missing.length > 0) {
    throw new Error(
      `${MANIFEST_PATH}: missing ${label}: ${missing.join(", ")}`,
    );
  }
  return out;
}

export function parseManifest(text: string): TurntableManifest {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`${MANIFEST_PATH}: not valid JSON`, { cause });
  }

  const { model, root } = requireStrings(raw, ["model", "root"], "field(s)");
  return {
    model,
    root,
    nodes: requireStrings(
      raw.nodes as Record<string, unknown> | undefined,
      NODE_KEYS,
      "nodes entry(s)",
    ),
    colliders: requireStrings(
      raw.colliders as Record<string, unknown> | undefined,
      COLLIDER_KEYS,
      "colliders entry(s)",
    ),
  };
}

/**
 * The single place a collider Mesh becomes a ControlId.
 *
 * The manifest wins. `extras.controlId` is only cross-checked, because the
 * asset's extras mislabel the "45 / 33" speed selector as "power" — see the
 * note on CONTROL_IDS. Unresolvable colliders are ignored rather than
 * crashing interaction.
 */
export function buildControlResolver(
  colliders: Record<ColliderKey, Mesh>,
): (object: Object3D) => ControlId | null {
  const byObject = new Map<Object3D, ControlId>();

  for (const key of COLLIDER_KEYS) {
    const mesh = colliders[key];
    if (!mesh) continue;

    const id = CONTROL_ID_BY_COLLIDER[key];
    if (!id) {
      if (import.meta.env.DEV) {
        console.warn(`collider ${mesh.name}: no controlId, ignoring`);
      }
      continue;
    }

    if (import.meta.env.DEV) {
      const fromExtras = (mesh.userData as { controlId?: unknown }).controlId;
      if (typeof fromExtras === "string" && fromExtras !== id) {
        console.info(
          `${mesh.name}: using manifest id "${id}" over extras "${fromExtras}"`,
        );
      }
    }

    byObject.set(mesh, id);
  }

  return (object) => byObject.get(object) ?? null;
}

let pending: Promise<TurntableManifest> | null = null;

/** Cached so React can `use()` it without refetching on every render. */
export function loadManifest(): Promise<TurntableManifest> {
  pending ??= fetch(MANIFEST_PATH)
    .then((res) => {
      if (!res.ok) {
        throw new Error(`${MANIFEST_PATH}: HTTP ${res.status}`);
      }
      return res.text();
    })
    .then(parseManifest);
  return pending;
}

/**
 * Look every manifest node up in the loaded GLB. Throws naming the exact nodes
 * that are absent rather than handing back silent undefineds (rdd.md 22.3).
 */
export function resolveTurntable(
  scene: Object3D,
  manifest: TurntableManifest,
): ResolvedTurntable {
  const missing: string[] = [];

  const find = (name: string) => {
    const found = scene.getObjectByName(name);
    if (!found) missing.push(name);
    return found;
  };

  const root = find(manifest.root);
  const nodes = {} as Record<NodeKey, Object3D>;
  for (const key of NODE_KEYS) {
    const node = find(manifest.nodes[key]);
    if (node) nodes[key] = node;
  }

  const colliders = {} as Record<ColliderKey, Mesh>;
  for (const key of COLLIDER_KEYS) {
    const name = manifest.colliders[key];
    const node = find(name);
    if (!node) continue;
    if (!(node as Mesh).isMesh) {
      throw new Error(`${name}: expected a Mesh collider, got ${node.type}`);
    }
    colliders[key] = node as Mesh;
  }

  if (missing.length > 0 || !root) {
    throw new Error(
      `${manifest.model}: missing node(s) named in ${MANIFEST_PATH}: ${missing.join(", ")}`,
    );
  }

  return { root, nodes, colliders };
}
