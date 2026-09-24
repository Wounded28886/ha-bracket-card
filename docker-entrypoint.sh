#!/bin/sh
# Make the data directory usable, then drop privileges and run the server.
#
# A bind-mounted folder belongs to whoever created it on the host — on a NAS
# that is usually root — so an unprivileged container can't write to it. This
# starts as root just long enough to hand the folder to the app user, then
# gives up root for good.
#
# Taking ownership isn't always allowed: some hosts remap container root to
# an unprivileged host user, or put the folder on a filesystem that refuses
# chown. Rather than fail to start, the container then stays root — noisily,
# so it's clear why — because a board nobody can use is worse than a
# container running as root on a home network.
#
# PUID/PGID override the user the app runs as, for anyone who would rather
# match an existing account than have the folder re-owned.
set -e

DATA_DIR="${DATA_DIR:-/data}"
APP_UID="${PUID:-1000}"
APP_GID="${PGID:-1000}"

# Alpine ships BusyBox's setpriv, which has none of the flags we need, so
# prefer su-exec where it exists and fall back to util-linux's setpriv.
# Deliberately unquoted where used: this is a command prefix, not one word.
if command -v su-exec >/dev/null 2>&1; then
  DROP="su-exec ${APP_UID}:${APP_GID}"
else
  DROP="setpriv --reuid ${APP_UID} --regid ${APP_GID} --clear-groups"
fi

writable_by_app() {
  $DROP sh -c '[ -w "$1" ]' sh "$DATA_DIR" 2>/dev/null
}

if [ "$(id -u)" != "0" ]; then
  # Already unprivileged (someone set `user:` in compose). Nothing can be
  # fixed from here, so say so plainly if the folder isn't writable.
  if [ ! -w "$DATA_DIR" ]; then
    echo "entrypoint: running as uid $(id -u), and $DATA_DIR is not writable by it."
    echo "entrypoint: give that user write access to the folder, or drop the"
    echo "entrypoint: 'user:' setting so the container can take ownership itself."
  fi
  exec "$@"
fi

mkdir -p "$DATA_DIR" 2>/dev/null || true

if writable_by_app; then
  exec $DROP "$@"
fi

echo "entrypoint: $DATA_DIR is not writable by ${APP_UID}:${APP_GID} — taking ownership"
chown -R "$APP_UID:$APP_GID" "$DATA_DIR" 2>/dev/null || true

if writable_by_app; then
  exec $DROP "$@"
fi

# Ownership couldn't be changed. Run as root so the app works, and explain.
echo "entrypoint: could not make $DATA_DIR writable by ${APP_UID}:${APP_GID}."
echo "entrypoint: this host does not allow the container to take ownership of it"
echo "entrypoint: (user-namespace remapping, or a filesystem that refuses chown)."
echo "entrypoint: continuing as root so the data folder works."
echo "entrypoint: to run unprivileged instead, give the folder to a user and set"
echo "entrypoint: PUID/PGID to match it."
exec "$@"
