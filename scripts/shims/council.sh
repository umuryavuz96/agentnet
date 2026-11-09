#!/bin/sh
# Shim: this path runs agentnet council.
exec "${AGENTNET_BIN:-agentnet}" council "$@"
