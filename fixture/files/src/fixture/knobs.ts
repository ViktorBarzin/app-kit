/**
 * Values a parity test changes in a commit to make the next Deploy behave
 * differently. Cloud's parity suite edits this file with a plain text
 * replacement, so keep each knob on its own line in this form.
 */

/** When true, /healthz answers 500 from boot: a Deploy that must fail its health check. */
export const HEALTHZ_FAILS_AT_BOOT = false;

/** A free text the suite bumps to make a commit that changes the image. */
export const REVISION = "0";

/** When not empty, the migrate step prints this line first: P10's `migration-ran`. */
export const MIGRATION_LOG = "";

/** When not 0, the migrate step exits with this code before it migrates: a Deploy whose migration fails. */
export const MIGRATION_EXIT = 0;
