/** Matches TargetRpm in the store: the selector's two speeds, no 78 (rdd.md 3.2). */
export type TurntableSpeed = 33.333 | 45;

export interface DeckState {
  /**
   * The operator's START/STOP intent. There is no power state: the deck has no
   * power switch printed anywhere, so mains is always present and START/STOP is
   * the only gate (rdd.md 0.1.1).
   */
  motorEnabled: boolean;

  nominalRpm: TurntableSpeed;
  currentRpm: number;
  pitch: number;

  platterAngle: number;
  tonearmAngle: number;
  tonearmHeight: number;

  trackingForce: number;
  antiSkate: number;
}
