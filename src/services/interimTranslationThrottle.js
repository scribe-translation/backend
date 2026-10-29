const INTERIM_TRANSLATION_INTERVAL_MS = 2000;

function shouldTranslateInterim(lastTranslatedAt, now, intervalMs = INTERIM_TRANSLATION_INTERVAL_MS) {
  if (lastTranslatedAt == null) return true;
  return now - lastTranslatedAt >= intervalMs;
}

module.exports = {
  INTERIM_TRANSLATION_INTERVAL_MS,
  shouldTranslateInterim,
};
