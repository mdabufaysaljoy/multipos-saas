#!/bin/sh
# Turns a running mongod into a single-node replica set, once.
#
# WHY THIS EXISTS. `mongod --replSet rs0` does not create a replica set; it
# starts a server willing to join one. Until `rs.initiate()` runs, the node has
# no primary, refuses writes, and - the reason this matters here - cannot open a
# transaction. The application detects that and falls back to compensating
# writes, so a standalone looks like it works while never exercising the
# transaction path at all. That is the gap this stack exists to close.
#
# IDEMPOTENT. On a volume that has already been initialised, `rs.status()`
# answers and nothing is reconfigured. Re-running `rs.initiate()` on a live set
# would be an error at best and a reconfiguration at worst.
set -eu

HOST="${MONGO_HOST:-mongo:27017}"
RS_NAME="${MONGO_REPLICA_SET:-rs0}"

echo "waiting for mongod at ${HOST}..."
i=0
until mongosh --host "${HOST}" --quiet --eval 'quit(db.adminCommand({ping:1}).ok ? 0 : 1)' >/dev/null 2>&1; do
  i=$((i+1))
  [ "${i}" -gt 60 ] && { echo "mongod did not answer within 60s"; exit 1; }
  sleep 1
done

if mongosh --host "${HOST}" --quiet --eval 'quit(rs.status().ok === 1 ? 0 : 1)' >/dev/null 2>&1; then
  echo "replica set ${RS_NAME} is already initialised; leaving it alone"
else
  echo "initialising replica set ${RS_NAME}"
  # The member host MUST be the name other containers use. A replica set
  # advertises its members to clients, so putting `localhost` here would have
  # the API told to connect to its own container.
  mongosh --host "${HOST}" --quiet --eval "
    rs.initiate({ _id: '${RS_NAME}', members: [{ _id: 0, host: '${HOST}' }] })
  "
fi

echo "waiting for a writable primary..."
i=0
until mongosh --host "${HOST}" --quiet --eval 'quit(db.hello().isWritablePrimary ? 0 : 1)' >/dev/null 2>&1; do
  i=$((i+1))
  [ "${i}" -gt 60 ] && { echo "no primary was elected within 60s"; exit 1; }
  sleep 1
done

# Proof, in the log, that the thing this stack exists for actually works.
mongosh --host "${HOST}" --quiet --eval '
  const s = db.getMongo().startSession();
  s.startTransaction();
  s.getDatabase("rs_init_probe").probe.insertOne({ at: new Date() });
  s.abortTransaction();
  s.endSession();
  print("transactions available: yes");
'
echo "replica set ${RS_NAME} ready"
