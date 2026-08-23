#!/usr/bin/env bash
cd "$(dirname "$0")/../.."
for pass in 1 2 3 4 5 6; do
  echo "=== PASS $pass start $(date) ===" >> emoji-catalog/collect.log
  node tools/emoji-collector/cli.js --resume --static-cap 0 --concurrency 3 --delay 350 >> emoji-catalog/collect.log 2>&1
  echo "=== PASS $pass end $(date) ===" >> emoji-catalog/collect.log
  sleep 900
done
