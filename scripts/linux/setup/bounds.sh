# Sourced by setup and its network steps; do not execute it. Setup's bounds, in
# one place, written plainly enough for any bash to read: scripts/check-bounds.mjs
# reads them here (on the Mac's bash 3.2 too) and checks that the updater's stop
# budget covers SETUP_STOP_SEC.

# Every call of a network tool is bounded (`timeout -k NET_KILL_SEC`):
NET_CMD_SEC=30     # a call that is not an apply
NET_APPLY_SEC=90   # an apply, and the wait after it for the address or route
NET_KILL_SEC=10    # what a call that ran past its bound gets to die after TERM
NET_WAIT_SEC=30    # the wait for an interface a step declares (the DNS stub)

# The most calls one read of an interface's state makes (net-state.sh,
# l3_state: four of `ip`, two of systemd-resolved's).
NET_READ_CALLS=6

# How long a stopped bridge step can take to end, worst case, every bound run
# out (a call's bound is its limit and NET_KILL_SEC to die): the apply call in
# flight when the stop comes, which runs to its end; then the longest undo,
# NetworkManager's (journal_restore, undo_networkmanager): netplan's files
# generated, the connections reloaded, the uplink connection looked up, its
# copy loaded, its state read, it brought up; then the wait for the uplink to
# hold what it held before, and its last read; and NET_LOCAL_SEC for the work
# that is no network call (the journal's reads and syncs, install_file,
# python, the waits' one-second sleeps). The bridge-journal step's commit or
# undo is shorter.
NET_LOCAL_SEC=30
NET_CALL_BOUND=$(( NET_CMD_SEC + NET_KILL_SEC ))
NET_APPLY_BOUND=$(( NET_APPLY_SEC + NET_KILL_SEC ))
BRIDGE_STOP_SEC=$(( NET_APPLY_BOUND + 5 * NET_CALL_BOUND + NET_APPLY_BOUND + NET_APPLY_SEC + NET_READ_CALLS * NET_CALL_BOUND + NET_LOCAL_SEC ))

# A stopped step gets STEP_STOP_SEC to end — the longest a step takes to, the
# bridge step's — and its session is then killed; SETUP_STOP_SEC is how long a
# stopped setup takes to end, at most: that, and the kill.
STEP_STOP_SEC=$BRIDGE_STOP_SEC
SETUP_STOP_SEC=$(( STEP_STOP_SEC + NET_KILL_SEC ))

# Setup run alone waits this long for the install lock (lib.sh, WISP_LOCK)
# that another install, update or setup holds.
LOCK_WAIT_SEC=600
