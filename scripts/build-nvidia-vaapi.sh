#!/usr/bin/env bash
# Builds the nvidia-vaapi-driver that Knot's Linux packages carry in
# resources/nvidia-vaapi, so NVIDIA users decode shared screens on the GPU
# without installing anything.
#
# The driver is pinned to an upstream commit that includes the AV1
# frame_size_override fix (elFarto/nvidia-vaapi-driver#460): 0.0.18, the newest
# release, decodes NVENC's 1080p/2160p AV1 with the wrong geometry and the
# picture smears after every key frame. NVIDIA's codec headers are pinned too,
# so the result does not depend on the build machine's packages.
#
# Needs git, make, meson, ninja and the libva, libdrm and EGL development
# headers (Debian/Ubuntu: meson ninja-build libva-dev libdrm-dev libegl-dev).
# Output: vendor/nvidia-vaapi/{nvidia_drv_video.so,LICENSE,SOURCE}.
set -euo pipefail

DRIVER_REPO=https://github.com/elFarto/nvidia-vaapi-driver.git
DRIVER_COMMIT=29b569d86f3ae4183be6ddc52a152f5f14312c5b
HEADERS_REPO=https://github.com/FFmpeg/nv-codec-headers.git
HEADERS_COMMIT=1889e62e2d35ff7aa9baca2bceb14f053785e6f1 # n12.1.14.0
# The release builds on Ubuntu 22.04, so the driver runs on any distribution
# with glibc 2.35 or newer. Override only for local test builds.
MAX_GLIBC=${KNOT_NVIDIA_VAAPI_MAX_GLIBC:-2.35}

root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/vendor/nvidia-vaapi"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fetch() { # repo commit dir
  git init -q "$work/$3"
  git -C "$work/$3" fetch -q --depth 1 "$1" "$2"
  git -C "$work/$3" checkout -q FETCH_HEAD
  [ "$(git -C "$work/$3" rev-parse HEAD)" = "$2" ] || { echo "error: $1 did not resolve to $2" >&2; exit 1; }
}

fetch "$HEADERS_REPO" "$HEADERS_COMMIT" nv-codec-headers
make -s -C "$work/nv-codec-headers" PREFIX="$work/prefix" install >/dev/null
fetch "$DRIVER_REPO" "$DRIVER_COMMIT" driver

# GStreamer's codec parsers are optional (VP9 only) and many desktops lack
# them; a driver linked against them would not load there. Hide them from the
# build whatever the build machine has installed.
real_pkg_config=$(command -v pkg-config)
cat > "$work/pkg-config" <<EOF
#!/bin/sh
for arg in "\$@"; do case "\$arg" in gstreamer-*) exit 1 ;; esac; done
exec "$real_pkg_config" "\$@"
EOF
chmod +x "$work/pkg-config"

PKG_CONFIG="$work/pkg-config" PKG_CONFIG_PATH="$work/prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}" \
  meson setup "$work/build" "$work/driver" --buildtype=release -Db_ndebug=true >/dev/null
ninja -C "$work/build" >/dev/null
so="$work/build/nvidia_drv_video.so"
strip --strip-unneeded "$so"

# The driver must load on users' machines: only libraries every desktop with
# the NVIDIA driver has, libva's entry point, and no newer glibc than allowed.
needed=$(readelf -d "$so" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p' | sort)
for lib in $needed; do
  case "$lib" in
    libEGL.so.1|libc.so.6|libm.so.6|libdl.so.2|libpthread.so.0|ld-linux-x86-64.so.2) ;;
    *) echo "error: nvidia_drv_video.so links $lib, which users may not have" >&2; exit 1 ;;
  esac
done
nm -D --defined-only "$so" | grep -q ' __vaDriverInit_1_0$' || { echo "error: libva entry point __vaDriverInit_1_0 is missing" >&2; exit 1; }
glibc=$(objdump -T "$so" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -V | tail -1)
if [ "$(printf '%s\n%s\n' "$glibc" "$MAX_GLIBC" | sort -V | tail -1)" != "$MAX_GLIBC" ]; then
  echo "error: nvidia_drv_video.so needs glibc $glibc; build it on a system with glibc $MAX_GLIBC" >&2; exit 1
fi

rm -rf "$out"
mkdir -p "$out"
install -m 0644 "$so" "$out/nvidia_drv_video.so"
install -m 0644 "$work/driver/COPYING" "$out/LICENSE"
cat > "$out/SOURCE" <<EOF
nvidia-vaapi-driver $DRIVER_REPO $DRIVER_COMMIT
nv-codec-headers $HEADERS_REPO $HEADERS_COMMIT
glibc $glibc
links $(echo $needed)
EOF
echo "built $out/nvidia_drv_video.so ($(stat -c%s "$out/nvidia_drv_video.so") bytes, glibc $glibc, links: $(echo $needed))"
