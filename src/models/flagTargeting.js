function normalizeUserIds(ids) {
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of ids) {
    if (raw == null) continue;
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function userIdKey(userId) {
  if (userId == null) return '';
  return String(userId).trim();
}

/**
 * Default applies to everyone not listed.
 * A user on the disabled list is off even if they are also on the enabled list.
 */
function resolveFlagForUser(flag, userId) {
  const id = userIdKey(userId);
  const disabled = normalizeUserIds(flag?.disabledUserIds);
  const enabled = normalizeUserIds(flag?.enabledUserIds);
  if (id && disabled.includes(id)) return false;
  if (id && enabled.includes(id)) return true;
  return flag?.defaultValue === true;
}

function mergeFlagTargeting(current, patch) {
  const next = {
    defaultValue: current?.defaultValue === true,
    enabledUserIds: normalizeUserIds(current?.enabledUserIds),
    disabledUserIds: normalizeUserIds(current?.disabledUserIds),
  };

  if (patch?.defaultValue !== undefined) {
    next.defaultValue = patch.defaultValue === true;
  }

  const enabledPatched = patch?.enabledUserIds !== undefined;
  const disabledPatched = patch?.disabledUserIds !== undefined;

  if (enabledPatched && !Array.isArray(patch.enabledUserIds)) {
    return { ok: false, error: 'enabledUserIds must be an array' };
  }
  if (disabledPatched && !Array.isArray(patch.disabledUserIds)) {
    return { ok: false, error: 'disabledUserIds must be an array' };
  }

  if (enabledPatched) next.enabledUserIds = normalizeUserIds(patch.enabledUserIds);
  if (disabledPatched) next.disabledUserIds = normalizeUserIds(patch.disabledUserIds);

  if (enabledPatched && disabledPatched) {
    const disabled = new Set(next.disabledUserIds);
    const overlap = next.enabledUserIds.filter((id) => disabled.has(id));
    if (overlap.length > 0) {
      return { ok: false, conflictUserIds: overlap };
    }
  } else if (enabledPatched) {
    const enabled = new Set(next.enabledUserIds);
    next.disabledUserIds = next.disabledUserIds.filter((id) => !enabled.has(id));
  } else if (disabledPatched) {
    const disabled = new Set(next.disabledUserIds);
    next.enabledUserIds = next.enabledUserIds.filter((id) => !disabled.has(id));
  }

  return { ok: true, targeting: next };
}

function interimTranslationFlagFromDoc(data) {
  return {
    defaultValue: data?.interimTranslationEnabled === true,
    enabledUserIds: normalizeUserIds(data?.interimTranslationEnabledUserIds),
    disabledUserIds: normalizeUserIds(data?.interimTranslationDisabledUserIds),
  };
}

module.exports = {
  interimTranslationFlagFromDoc,
  mergeFlagTargeting,
  normalizeUserIds,
  resolveFlagForUser,
};
