#!/bin/sh
# Shim: this path now runs agentnet pick-model. Installed by the cutover (plan section 5.3).
exec "${AGENTNET_BIN:-agentnet}" pick-model "$@"
