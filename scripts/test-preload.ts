/**
 * bun test preload for packages/ and scripts/: quiet logs unless LOG_LEVEL is
 * set. @viktorbarzin/log reads LOG_LEVEL once, when it is first imported.
 */
process.env.LOG_LEVEL ??= "WARNING";
