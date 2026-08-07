/**
 * Where the stylus sits on the disc, answered from one number: the horizontal
 * distance between the stylus tip and the spindle. Pure, like the rest of
 * src/physics — the caller measures the radius off the scene.
 *
 * The radii are the asset's own, solved from its geometry and recorded in
 * rdd.md 10.2 alongside the arm angles that reach them:
 *
 *     152.4mm   record edge
 *     146.0mm   lead-in groove — program starts
 *      57.5mm   lead-out groove — program ends
 *      50.0mm   label edge
 */
export const GROOVE = {
  discRadius: 0.1524,
  leadInRadius: 0.146,
  leadOutRadius: 0.0575,
  labelRadius: 0.05,
};

export type GrooveZone =
  | "outside"
  | "lead-in"
  | "program"
  | "lead-out"
  | "label";

/**
 * Purely horizontal: the tip may be off the disc, on it, or held above it, and
 * this reports the same zone either way. Whether the stylus is actually down is
 * `stylusContact`, and it is the caller's job to combine the two.
 */
export function grooveZoneAt(radius: number): GrooveZone {
  if (!Number.isFinite(radius) || radius > GROOVE.discRadius) return "outside";
  if (radius > GROOVE.leadInRadius) return "lead-in";
  if (radius >= GROOVE.leadOutRadius) return "program";
  if (radius >= GROOVE.labelRadius) return "lead-out";
  return "label";
}

/**
 * The recorded programme as 0…1, outer groove to inner (rdd.md 10.5). Audio
 * time is this times the duration, so only the program area has one: null
 * everywhere else rather than a number that means nothing.
 *
 * The zone gate is the range check — both its bounds are inclusive, so the
 * result cannot leave 0…1.
 */
export function groovePositionAt(radius: number): number | null {
  if (grooveZoneAt(radius) !== "program") return null;
  return (
    (GROOVE.leadInRadius - radius) / (GROOVE.leadInRadius - GROOVE.leadOutRadius)
  );
}
