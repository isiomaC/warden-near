#!/usr/bin/env sh
# near-sdk-js downloads its toolchain in a postinstall that pnpm does not run for us. Do it once, then build.
set -eu
cd "$(dirname "$0")/.."
[ -d node_modules/near-sdk-js/lib/cli/deps ] || (cd node_modules/near-sdk-js && node lib/cli/post-install.js)
mkdir -p build
exec node_modules/.bin/near-sdk-js build contract/src/contract.ts build/warden_anchor.wasm
