#!/usr/bin/env bash
cd "$(dirname "$0")/../.."
for pass in 1 2 3 4 5 6; do
  echo "=== PASS $pass start $(date) ===" >> emoji-catalog/collect.log
  node tools/emoji-collector/cli.js --resume --static-cap 10000 --concurrency 2 --delay 450 >> emoji-catalog/collect.log 2>&1
  echo "=== PASS $pass end $(date) ===" >> emoji-catalog/collect.log
  sleep 900
done
