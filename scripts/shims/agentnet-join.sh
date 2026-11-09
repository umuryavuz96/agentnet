#!/bin/sh
# Shim: this path now runs agentnet join. Installed by the cutover (plan section 5.3).
exec "${AGENTNET_BIN:-agentnet}" join "$@"
