const CreditLedger = require('../models/CreditLedger');
const {
  BALANCE_TICK_SECONDS,
  LOW_BALANCE_WARN_SECONDS,
  BILLING_TIERS,
} = require('../billing/constants');

async function startMetering(connection, socket, { onLowBalance, onDepleted }) {
  stopMetering(connection);

  if (!socket.user?.id) return;

  connection.lastBalanceTickAt = Date.now();
  connection.warnedBalanceThresholds = new Set();

  try {
    const User = require('../models/User');
    const balance = await User.getBalance(socket.user.id);
    if (!balance) return;

    if (balance.billingTier === BILLING_TIERS.COMPLIMENTARY) {
      socket.emit('balanceUpdate', {
        balanceSeconds: balance.balanceSeconds,
        complimentary: true,
        billingTier: balance.billingTier,
      });
      return;
    }

    if (balance.balanceSeconds <= 0) {
      if (onDepleted) await onDepleted(balance);
      return;
    }

    socket.emit('balanceUpdate', {
      balanceSeconds: balance.balanceSeconds,
      complimentary: false,
      billingTier: balance.billingTier,
    });
    maybeWarn(socket, connection, balance.balanceSeconds, onLowBalance);
  } catch (err) {
    console.error('Balance pre-check failed:', err.message);
  }

  connection.balanceTickTimer = setInterval(async () => {
    try {
      const now = Date.now();
      const elapsedSec = Math.max(
        1,
        Math.round((now - (connection.lastBalanceTickAt || now)) / 1000)
      );
      connection.lastBalanceTickAt = now;

      const result = await CreditLedger.spendSeconds(socket.user.id, elapsedSec, {
        note: 'Streaming tick',
      });

      if (result.complimentary || result.skipped) {
        socket.emit('balanceUpdate', {
          balanceSeconds: result.balanceSeconds,
          complimentary: true,
          billingTier: BILLING_TIERS.COMPLIMENTARY,
        });
        stopMetering(connection);
        return;
      }

      socket.emit('balanceUpdate', {
        balanceSeconds: result.balanceSeconds,
        complimentary: false,
        depleted: result.depleted,
      });

      maybeWarn(socket, connection, result.balanceSeconds, onLowBalance);

      if (result.depleted && onDepleted) {
        await onDepleted(result);
      }
    } catch (err) {
      console.error('Balance tick failed:', err.message);
    }
  }, BALANCE_TICK_SECONDS * 1000);
}

async function reconcileMetering(connection, socket) {
  if (!socket.user?.id || !connection?.lastBalanceTickAt) {
    stopMetering(connection);
    return null;
  }

  const elapsedSec = Math.max(
    0,
    Math.round((Date.now() - connection.lastBalanceTickAt) / 1000)
  );
  stopMetering(connection);

  if (elapsedSec < 1) return null;

  try {
    return await CreditLedger.spendSeconds(socket.user.id, elapsedSec, {
      note: 'Streaming reconcile',
    });
  } catch (err) {
    console.error('Balance reconcile failed:', err.message);
    return null;
  }
}

function stopMetering(connection) {
  if (!connection) return;
  if (connection.balanceTickTimer) {
    clearInterval(connection.balanceTickTimer);
    connection.balanceTickTimer = null;
  }
  connection.lastBalanceTickAt = null;
}

function maybeWarn(socket, connection, balanceSeconds, onLowBalance) {
  if (!onLowBalance || !connection.warnedBalanceThresholds) return;
  for (const threshold of LOW_BALANCE_WARN_SECONDS) {
    if (balanceSeconds <= threshold && !connection.warnedBalanceThresholds.has(threshold)) {
      connection.warnedBalanceThresholds.add(threshold);
      onLowBalance(balanceSeconds, threshold);
    }
  }
}

module.exports = {
  startMetering,
  reconcileMetering,
  stopMetering,
  BALANCE_TICK_SECONDS,
};
