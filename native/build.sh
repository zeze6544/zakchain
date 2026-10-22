#!/bin/sh
# Build the optional native engine from source and print its SHA-256 so you can compare it with a known build.
# Nothing is installed anywhere: the binary stays in this folder. Remove it with: rm native/zakminer
set -e
cd "$(dirname "$0")"
${CC:-gcc} -O3 -march=native -pthread -Wall -o zakminer zakminer.c -lcrypto
sha256sum zakminer.c shani.h zakminer | tee zakminer.sha256
echo "NOTE: this is a local, unsigned build. -march=native output differs between CPUs, so compare hashes only between identical toolchains/CPUs."
