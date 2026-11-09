#!/bin/sh
# Shim: this path now runs agentnet spawn. Installed by the cutover (plan section 5.3).
exec "${AGENTNET_BIN:-agentnet}" spawn "$@"
