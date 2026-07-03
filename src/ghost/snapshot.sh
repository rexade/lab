#!/bin/bash
# ghost-trio snapshot — called by Pi Pulse incubator
# Freezes a moment of machine awareness into a RUN_LOG entry.
cd /home/admin/lab/src/ghost
node snapshot.js >> /tmp/ghost-snapshot.log 2>&1
