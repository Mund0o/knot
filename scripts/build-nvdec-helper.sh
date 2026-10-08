#!/usr/bin/env bash
# Builds knot-nvdec, the small program Knot's Linux packages carry in resources/knot-nvdec so a viewer with an NVIDIA card decodes AV1
# shares on the GPU (Chromium cannot show pictures its own hardware decoder makes on NVIDIA; see share-decode-nvdec.js).
#
# It needs only a C compiler: NVIDIA's libcuda and libnvcuvid are loaded at run time through the ffnvcodec headers, which are pinned
# here (the same commit scripts/build-nvidia-vaapi.sh pins) so the result does not depend on the build machine's packages.
# Output: vendor/knot-nvdec/{knot-nvdec,LICENSE,SOURCE}.
set -euo pipefail

HEADERS_REPO=https://github.com/FFmpeg/nv-codec-headers.git
HEADERS_COMMIT=1889e62e2d35ff7aa9baca2bceb14f053785e6f1 # n12.1.14.0
# The release builds on Ubuntu 22.04, so the program runs on any distribution with glibc 2.35 or newer.
MAX_GLIBC=${KNOT_NVDEC_MAX_GLIBC:-2.35}

root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/vendor/knot-nvdec"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git init -q "$work/headers"
git -C "$work/headers" fetch -q --depth 1 "$HEADERS_REPO" "$HEADERS_COMMIT"
git -C "$work/headers" checkout -q FETCH_HEAD
[ "$(git -C "$work/headers" rev-parse HEAD)" = "$HEADERS_COMMIT" ] || { echo "error: $HEADERS_REPO did not resolve to $HEADERS_COMMIT" >&2; exit 1; }
make -s -C "$work/headers" PREFIX="$work/prefix" install >/dev/null

bin="$work/knot-nvdec"
${CC:-cc} -std=gnu11 -O2 -Wall -Wextra -Wno-unused-parameter -o "$bin" "$root/native/nvdec/knot-nvdec.c" -I"$work/prefix/include" -ldl
strip --strip-unneeded "$bin"

# It must start on users' machines: only libraries every Linux system has, and no newer glibc than allowed.
needed=$(readelf -d "$bin" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p' | sort)
for lib in $needed; do
  case "$lib" in
    libc.so.6|libdl.so.2|libm.so.6|libpthread.so.0|ld-linux-x86-64.so.2) ;;
    *) echo "error: knot-nvdec links $lib, which users may not have" >&2; exit 1 ;;
  esac
done
glibc=$(objdump -T "$bin" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -V | tail -1)
if [ "$(printf '%s\n%s\n' "$glibc" "$MAX_GLIBC" | sort -V | tail -1)" != "$MAX_GLIBC" ]; then
  echo "error: knot-nvdec needs glibc $glibc; build it on a system with glibc $MAX_GLIBC" >&2; exit 1
fi

rm -rf "$out"
mkdir -p "$out"
install -m 0755 "$bin" "$out/knot-nvdec"
# The ffnvcodec headers carry their MIT licence in every file; keep one copy next to the program that was built with them.
sed -n '2,/^ \*\//p' "$work/prefix/include/ffnvcodec/dynlink_loader.h" > "$out/LICENSE"
cat > "$out/SOURCE" <<EOS
knot-nvdec native/nvdec/knot-nvdec.c (this repository)
nv-codec-headers $HEADERS_REPO $HEADERS_COMMIT
glibc $glibc
links $(echo $needed)
EOS
echo "built $out/knot-nvdec ($(stat -c%s "$out/knot-nvdec") bytes, glibc $glibc, links: $(echo $needed))"
