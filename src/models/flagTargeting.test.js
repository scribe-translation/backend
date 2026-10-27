const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  interimTranslationFlagFromDoc,
  mergeFlagTargeting,
  resolveFlagForUser,
} = require('./flagTargeting');

describe('resolveFlagForUser', () => {
  it('gives an unlisted user the default when the flag is off', () => {
    const enabled = resolveFlagForUser(
      {
        defaultValue: false,
        enabledUserIds: ['speaker-a'],
        disabledUserIds: [],
      },
      'speaker-b'
    );

    assert.equal(enabled, false);
  });

  it('gives an unlisted user the default when the flag is on', () => {
    const enabled = resolveFlagForUser(
      {
        defaultValue: true,
        enabledUserIds: [],
        disabledUserIds: ['speaker-a'],
      },
      'speaker-b'
    );

    assert.equal(enabled, true);
  });

  it('turns the flag on for a listed user when the default is off', () => {
    const enabled = resolveFlagForUser(
      {
        defaultValue: false,
        enabledUserIds: ['speaker-a'],
        disabledUserIds: ['speaker-b', 'speaker-c'],
      },
      'speaker-a'
    );

    assert.equal(enabled, true);
  });

  it('turns the flag off for each user on the disabled list when the default is on', () => {
    const flag = {
      defaultValue: true,
      enabledUserIds: ['speaker-a'],
      disabledUserIds: ['speaker-b', 'speaker-c'],
    };

    assert.equal(resolveFlagForUser(flag, 'speaker-b'), false);
    assert.equal(resolveFlagForUser(flag, 'speaker-c'), false);
    assert.equal(resolveFlagForUser(flag, 'speaker-d'), true);
  });

  it('turns the flag on for a list and off for one user when the default is off', () => {
    const flag = {
      defaultValue: false,
      enabledUserIds: ['speaker-b', 'speaker-c'],
      disabledUserIds: ['speaker-a'],
    };

    assert.equal(resolveFlagForUser(flag, 'speaker-a'), false);
    assert.equal(resolveFlagForUser(flag, 'speaker-b'), true);
    assert.equal(resolveFlagForUser(flag, 'speaker-c'), true);
    assert.equal(resolveFlagForUser(flag, 'speaker-d'), false);
  });

  it('treats a user on both lists as off', () => {
    const enabled = resolveFlagForUser(
      {
        defaultValue: true,
        enabledUserIds: ['speaker-a'],
        disabledUserIds: ['speaker-a'],
      },
      'speaker-a'
    );

    assert.equal(enabled, false);
  });

  it('uses the default when there is no user id', () => {
    const flag = {
      defaultValue: false,
      enabledUserIds: ['speaker-a'],
      disabledUserIds: [],
    };

    assert.equal(resolveFlagForUser(flag, undefined), false);
    assert.equal(resolveFlagForUser(flag, ''), false);
  });

  it('matches a numeric user id against string list entries', () => {
    const enabled = resolveFlagForUser(
      {
        defaultValue: false,
        enabledUserIds: ['42'],
        disabledUserIds: [],
      },
      42
    );

    assert.equal(enabled, true);
  });
});

describe('mergeFlagTargeting', () => {
  it('removes a user from the off list when they are added to the on list', () => {
    const result = mergeFlagTargeting(
      {
        defaultValue: false,
        enabledUserIds: [],
        disabledUserIds: ['speaker-a', 'speaker-b'],
      },
      { enabledUserIds: ['speaker-a'] }
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.targeting.enabledUserIds, ['speaker-a']);
    assert.deepEqual(result.targeting.disabledUserIds, ['speaker-b']);
    assert.equal(result.targeting.defaultValue, false);
  });

  it('removes a user from the on list when they are added to the off list', () => {
    const result = mergeFlagTargeting(
      {
        defaultValue: true,
        enabledUserIds: ['speaker-a', 'speaker-b'],
        disabledUserIds: [],
      },
      { disabledUserIds: ['speaker-a'] }
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.targeting.enabledUserIds, ['speaker-b']);
    assert.deepEqual(result.targeting.disabledUserIds, ['speaker-a']);
  });

  it('rejects a single update that puts the same user on both lists', () => {
    const result = mergeFlagTargeting(
      {
        defaultValue: false,
        enabledUserIds: [],
        disabledUserIds: [],
      },
      {
        enabledUserIds: ['speaker-a'],
        disabledUserIds: ['speaker-a', 'speaker-b'],
      }
    );

    assert.equal(result.ok, false);
    assert.deepEqual(result.conflictUserIds, ['speaker-a']);
  });

  it('rejects a user id list that is not an array', () => {
    const result = mergeFlagTargeting(
      {
        defaultValue: false,
        enabledUserIds: ['speaker-a'],
        disabledUserIds: [],
      },
      { enabledUserIds: 'speaker-b' }
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, 'enabledUserIds must be an array');
    assert.deepEqual(result.targeting, undefined);
  });
});

describe('interimTranslationFlagFromDoc', () => {
  it('keeps an existing document off for everyone when no user lists are stored', () => {
    const flag = interimTranslationFlagFromDoc({
      interimTranslationEnabled: false,
    });

    assert.equal(resolveFlagForUser(flag, 'speaker-a'), false);
    assert.deepEqual(flag.enabledUserIds, []);
    assert.deepEqual(flag.disabledUserIds, []);
  });

  it('reads stored on and off lists', () => {
    const flag = interimTranslationFlagFromDoc({
      interimTranslationEnabled: true,
      interimTranslationEnabledUserIds: ['speaker-a', 'speaker-a', '  '],
      interimTranslationDisabledUserIds: [' speaker-b '],
    });

    assert.equal(flag.defaultValue, true);
    assert.deepEqual(flag.enabledUserIds, ['speaker-a']);
    assert.deepEqual(flag.disabledUserIds, ['speaker-b']);
    assert.equal(resolveFlagForUser(flag, 'speaker-b'), false);
  });
});
