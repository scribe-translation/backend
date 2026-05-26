/**
 * Migration: Rename userCode -> sessionCode in Firestore user documents
 *
 * Usage:
 *   node src/migrations/rename-userCode-to-sessionCode.js [options]
 *
 * Options:
 *   --dry-run              Print what would change without writing anything
 *   --rollback             Reverse the migration (sessionCode -> userCode)
 *   --only=<email>         Target only a single user (e.g. --only=john@example.com)
 *
 * Examples:
 *   # Dry run against test account only
 *   node src/migrations/rename-userCode-to-sessionCode.js --dry-run --only=johnascott14@gmail.com
 *
 *   # Migrate test account only
 *   node src/migrations/rename-userCode-to-sessionCode.js --only=johnascott14@gmail.com
 *
 *   # Dry run for all users (prod)
 *   node src/migrations/rename-userCode-to-sessionCode.js --dry-run
 *
 *   # Migrate all users (prod)
 *   node src/migrations/rename-userCode-to-sessionCode.js
 *
 *   # Rollback test account
 *   node src/migrations/rename-userCode-to-sessionCode.js --rollback --only=johnascott14@gmail.com
 *
 *   # Rollback all users
 *   node src/migrations/rename-userCode-to-sessionCode.js --rollback
 */

const { initFirestore, getDb, Collections } = require('../database/firestore');
const { FieldValue } = require('@google-cloud/firestore');

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const rollback = args.includes('--rollback');
  const onlyFlag = args.find(a => a.startsWith('--only='));
  const onlyEmail = onlyFlag ? onlyFlag.split('=')[1] : null;
  return { dryRun, rollback, onlyEmail };
}

async function migrate({ dryRun = false, rollback = false, onlyEmail = null } = {}) {
  await initFirestore();
  const db = getDb();
  const usersRef = db.collection(Collections.USERS);

  const fromField = rollback ? 'sessionCode' : 'userCode';
  const toField = rollback ? 'userCode' : 'sessionCode';
  const direction = rollback ? 'ROLLBACK' : 'MIGRATE';

  let query = usersRef;
  if (onlyEmail) {
    query = usersRef.where('email', '==', onlyEmail);
  }

  const snapshot = await query.get();

  if (snapshot.empty) {
    console.log(onlyEmail
      ? `No user found with email "${onlyEmail}". Nothing to do.`
      : 'No users found in the collection. Nothing to do.');
    return;
  }

  console.log(`Found ${snapshot.size} user(s) to check.\n`);

  let changed = 0;
  let skipped = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const hasFrom = fromField in data;
    const hasTo = toField in data;

    if (!hasFrom && hasTo) {
      console.log(`  ⏭  ${doc.id} (${data.email}) — already has ${toField}, skipping`);
      skipped++;
      continue;
    }

    if (hasFrom && hasTo && !rollback) {
      const value = data.sessionCode ?? data[toField];
      if (dryRun) {
        console.log(
          `  🔍 ${doc.id} (${data.email}) — has both fields; would keep ${toField}="${value}" and delete ${fromField}`
        );
      } else {
        await doc.ref.update({
          [toField]: String(value).trim().toUpperCase(),
          [fromField]: FieldValue.delete(),
        });
        console.log(
          `  ✅ ${doc.id} (${data.email}) — kept ${toField}="${value}", removed legacy ${fromField}`
        );
      }
      changed++;
      continue;
    }

    if (!hasFrom && !hasTo) {
      console.log(`  ⏭  ${doc.id} (${data.email}) — no ${fromField} field present, skipping`);
      skipped++;
      continue;
    }

    const value = data[fromField];

    if (dryRun) {
      console.log(`  🔍 ${doc.id} (${data.email}) — would rename ${fromField}="${value}" to ${toField}`);
    } else {
      await doc.ref.update({
        [toField]: value,
        [fromField]: FieldValue.delete(),
      });
      console.log(`  ✅ ${doc.id} (${data.email}) — renamed ${fromField}="${value}" to ${toField}`);
    }
    changed++;
  }

  console.log(`\nDone. [${direction}${dryRun ? ' DRY RUN' : ''}] Changed: ${changed}, Skipped: ${skipped}`);
}

const { dryRun, rollback, onlyEmail } = parseArgs();

if (rollback) console.log('⬅  ROLLBACK mode — reverting sessionCode back to userCode.');
if (dryRun) console.log('Running in DRY RUN mode — no writes will be made.');
if (onlyEmail) console.log(`Targeting only: ${onlyEmail}`);
if (!onlyEmail) console.log('Targeting ALL users.');
console.log();

migrate({ dryRun, rollback, onlyEmail })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
