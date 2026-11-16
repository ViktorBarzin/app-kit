/**
 * Values a parity test changes in a commit to make the next Deploy behave
 * differently. Cloud's parity suite edits this file with a plain text
 * replacement, so keep each knob on its own line in this form.
 */

/** When true, /healthz answers 500 from boot: a Deploy that must fail its health check. */
export const HEALTHZ_FAILS_AT_BOOT = false;

/** A free text the suite bumps to make a commit that changes the image. */
export const REVISION = "0";
