// knot-nvdec: decodes AV1 pictures on an NVIDIA GPU (NVDEC) and hands them back as raw NV12, one the moment it is decoded.
//
// Why this exists instead of `ffmpeg -c:v av1_cuvid`: ffmpeg's command line always keeps one or two decoded pictures back until the next
// one arrives, so on a screen that stops changing the last changes never show. Here a picture is written as soon as the GPU has it, with
// the timestamp it was given. It is also much smaller than ffmpeg and starts faster.
//
// stdin  : repeated { u32 size, u64 pts, size bytes } (little endian): one AV1 temporal unit each, the first with a sequence header.
// stdout : repeated { u32 width, u32 height, u64 pts, width*height*3/2 bytes of NV12 }, in display order. Ends with stdin.
// stderr : one line saying why, when it fails. Exit status 0 when stdin ended cleanly.
// args   : knot-nvdec <outWidth> <outHeight>   scale on the GPU to this size (0 0 = the stream's own size); even numbers, not larger
//          knot-nvdec --probe                  print the GPU and its AV1 limits and exit 0, or say why not and exit 1
//
// NVIDIA's libcuda and libnvcuvid are loaded at run time (ffnvcodec headers), so nothing here needs the NVIDIA SDK to build or run.
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <ffnvcodec/dynlink_loader.h>

#define MAX_PACKET (64u * 1024 * 1024)

typedef struct {
    CudaFunctions *cu;
    CuvidFunctions *cv;
    CUcontext ctx;
    CUvideoctxlock lock;
    CUvideodecoder decoder;
    CUvideoparser parser;
    unsigned outW, outH;          // what the caller asked for (0 = the stream's size)
    unsigned width, height;       // what is being produced
    uint8_t *host;                // one picture
    size_t hostBytes;
    int failed;
    char why[256];
} State;

static void fail(State *s, const char *what) {
    if (!s->failed) { s->failed = 1; snprintf(s->why, sizeof s->why, "%s", what); }
}

static int check(State *s, CUresult result, const char *what) {
    if (result == CUDA_SUCCESS) return 1;
    char text[256]; snprintf(text, sizeof text, "%s failed (CUDA error %d)", what, (int)result);
    fail(s, text); return 0;
}

static int write_all(int fd, const void *data, size_t size) {
    const uint8_t *p = data;
    while (size) {
        ssize_t n = write(fd, p, size);
        if (n < 0) { if (errno == EINTR) continue; return 0; }
        p += n; size -= (size_t)n;
    }
    return 1;
}

static int read_all(int fd, void *data, size_t size) {
    uint8_t *p = data;
    while (size) {
        ssize_t n = read(fd, p, size);
        if (n < 0) { if (errno == EINTR) continue; return -1; }
        if (n == 0) return 0;
        p += n; size -= (size_t)n;
    }
    return 1;
}

static int open_cuda(State *s) {
    if (cuda_load_functions(&s->cu, NULL) < 0) { fail(s, "libcuda is not available (no NVIDIA driver)"); return 0; }
    if (cuvid_load_functions(&s->cv, NULL) < 0) { fail(s, "libnvcuvid is not available (the NVIDIA video decoder library)"); return 0; }
    CUdevice device;
    if (!check(s, s->cu->cuInit(0), "cuInit") || !check(s, s->cu->cuDeviceGet(&device, 0), "cuDeviceGet")) return 0;
    if (!check(s, s->cu->cuCtxCreate(&s->ctx, CU_CTX_SCHED_BLOCKING_SYNC, device), "cuCtxCreate")) return 0;
    return check(s, s->cv->cuvidCtxLockCreate(&s->lock, s->ctx), "cuvidCtxLockCreate");
}

static int CUDAAPI on_sequence(void *user, CUVIDEOFORMAT *format) {
    State *s = user;
    if (format->codec != cudaVideoCodec_AV1) { fail(s, "the stream is not AV1"); return 0; }
    if (format->chroma_format != cudaVideoChromaFormat_420 || format->bit_depth_luma_minus8 != 0) { fail(s, "only 8-bit 4:2:0 AV1 is decoded here"); return 0; }
    unsigned srcW = format->display_area.right - format->display_area.left, srcH = format->display_area.bottom - format->display_area.top;
    if (!srcW || !srcH) { srcW = format->coded_width; srcH = format->coded_height; }
    unsigned w = s->outW ? s->outW : srcW & ~1u, h = s->outH ? s->outH : srcH & ~1u;
    if (w > srcW || h > srcH) { w = srcW & ~1u; h = srcH & ~1u; }       // never larger than the picture
    if (s->decoder) { s->cv->cuvidDestroyDecoder(s->decoder); s->decoder = NULL; }

    CUVIDDECODECREATEINFO info; memset(&info, 0, sizeof info);
    info.ulWidth = format->coded_width; info.ulHeight = format->coded_height;
    info.ulNumDecodeSurfaces = format->min_num_decode_surfaces + 2;
    info.CodecType = format->codec; info.ChromaFormat = format->chroma_format; info.bitDepthMinus8 = 0;
    info.ulCreationFlags = cudaVideoCreate_PreferCUVID;
    info.OutputFormat = cudaVideoSurfaceFormat_NV12; info.DeinterlaceMode = cudaVideoDeinterlaceMode_Weave;
    info.display_area.left = (short)format->display_area.left; info.display_area.top = (short)format->display_area.top;
    info.display_area.right = (short)format->display_area.right; info.display_area.bottom = (short)format->display_area.bottom;
    info.ulTargetWidth = w; info.ulTargetHeight = h; info.ulNumOutputSurfaces = 2;
    info.target_rect.left = 0; info.target_rect.top = 0; info.target_rect.right = (short)w; info.target_rect.bottom = (short)h;
    info.vidLock = s->lock;
    if (!check(s, s->cv->cuvidCreateDecoder(&s->decoder, &info), "cuvidCreateDecoder")) return 0;

    size_t bytes = (size_t)w * h * 3 / 2;
    if (bytes != s->hostBytes) {
        free(s->host);
        s->host = malloc(bytes); s->hostBytes = 0;
        if (!s->host) { fail(s, "out of memory"); return 0; }
        s->hostBytes = bytes;
    }
    s->width = w; s->height = h;
    return (int)info.ulNumDecodeSurfaces;
}

static int CUDAAPI on_decode(void *user, CUVIDPICPARAMS *picture) {
    State *s = user;
    if (!s->decoder) { fail(s, "a picture came before the stream's description"); return 0; }
    return check(s, s->cv->cuvidDecodePicture(s->decoder, picture), "cuvidDecodePicture");
}

static int CUDAAPI on_display(void *user, CUVIDPARSERDISPINFO *display) {
    State *s = user;
    if (!display || !s->decoder) return 1;
    CUVIDPROCPARAMS params; memset(&params, 0, sizeof params);
    params.progressive_frame = display->progressive_frame; params.top_field_first = display->top_field_first;
    CUdeviceptr device = 0; unsigned pitch = 0;
    if (!check(s, s->cv->cuvidMapVideoFrame(s->decoder, display->picture_index, &device, &pitch, &params), "cuvidMapVideoFrame")) return 0;
    int ok = 1;
    // The luma plane, then the chroma plane which starts height rows further down the same surface.
    for (int plane = 0; plane < 2 && ok; plane++) {
        CUDA_MEMCPY2D copy; memset(&copy, 0, sizeof copy);
        copy.srcMemoryType = CU_MEMORYTYPE_DEVICE; copy.srcDevice = device + (plane ? (CUdeviceptr)pitch * s->height : 0); copy.srcPitch = pitch;
        copy.dstMemoryType = CU_MEMORYTYPE_HOST; copy.dstHost = s->host + (plane ? (size_t)s->width * s->height : 0); copy.dstPitch = s->width;
        copy.WidthInBytes = s->width; copy.Height = plane ? s->height / 2 : s->height;
        ok = check(s, s->cu->cuMemcpy2D(&copy), "cuMemcpy2D");
    }
    s->cv->cuvidUnmapVideoFrame(s->decoder, device);
    if (!ok) return 0;
    uint8_t header[16]; uint32_t w = s->width, h = s->height; uint64_t pts = (uint64_t)display->timestamp;
    memcpy(header, &w, 4); memcpy(header + 4, &h, 4); memcpy(header + 8, &pts, 8);
    if (!write_all(1, header, sizeof header) || !write_all(1, s->host, s->hostBytes)) { fail(s, "the reader went away"); return 0; }
    return 1;
}

static int probe(State *s) {
    if (!open_cuda(s)) return 1;
    char name[128] = "NVIDIA GPU"; s->cu->cuDeviceGetName(name, sizeof name, 0);
    CUVIDDECODECAPS caps; memset(&caps, 0, sizeof caps);
    caps.eCodecType = cudaVideoCodec_AV1; caps.eChromaFormat = cudaVideoChromaFormat_420; caps.nBitDepthMinus8 = 0;
    if (!s->cv->cuvidGetDecoderCaps) { printf("ok %s (limits unknown)\n", name); return 0; }
    if (!check(s, s->cv->cuvidGetDecoderCaps(&caps), "cuvidGetDecoderCaps")) return 1;
    if (!caps.bIsSupported) { fail(s, "this GPU has no AV1 decoder"); return 1; }
    printf("ok %s av1 %ux%u..%ux%u\n", name, caps.nMinWidth, caps.nMinHeight, caps.nMaxWidth, caps.nMaxHeight);
    return 0;
}

int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);
    State s; memset(&s, 0, sizeof s);
    int code = 0;
    if (argc == 2 && !strcmp(argv[1], "--probe")) {
        code = probe(&s);
        if (code) fprintf(stderr, "%s\n", s.why[0] ? s.why : "no GPU decoder");
        return code;
    }
    if (argc != 3) { fprintf(stderr, "usage: knot-nvdec <outWidth> <outHeight> | --probe\n"); return 2; }
    s.outW = (unsigned)strtoul(argv[1], NULL, 10) & ~1u; s.outH = (unsigned)strtoul(argv[2], NULL, 10) & ~1u;
    if (s.outW > 8192 || s.outH > 8192) { fprintf(stderr, "invalid size\n"); return 2; }
    if (!open_cuda(&s)) { fprintf(stderr, "%s\n", s.why); return 1; }

    CUVIDPARSERPARAMS params; memset(&params, 0, sizeof params);
    params.CodecType = cudaVideoCodec_AV1; params.ulMaxNumDecodeSurfaces = 1; params.ulClockRate = 1000000;
    params.ulErrorThreshold = 100; params.ulMaxDisplayDelay = 0;       // 0: a picture is shown as soon as it is decoded
    params.pUserData = &s; params.pfnSequenceCallback = on_sequence; params.pfnDecodePicture = on_decode; params.pfnDisplayPicture = on_display;
    if (!check(&s, s.cv->cuvidCreateVideoParser(&s.parser, &params), "cuvidCreateVideoParser")) { fprintf(stderr, "%s\n", s.why); return 1; }

    uint8_t *buffer = NULL; size_t capacity = 0;
    for (;;) {
        uint8_t head[12];
        int got = read_all(0, head, sizeof head);
        if (got <= 0) break;                                   // end of input (or a broken pipe): finish
        uint32_t size; uint64_t pts; memcpy(&size, head, 4); memcpy(&pts, head + 4, 8);
        if (!size || size > MAX_PACKET) { fail(&s, "a picture of impossible size was sent"); break; }
        // Room for a temporal delimiter in front: encoders that hand out bare units leave it off, and the decoder wants it.
        if (size + 2 > capacity) { capacity = size + 2 + 65536; free(buffer); buffer = malloc(capacity); if (!buffer) { fail(&s, "out of memory"); break; } }
        if (read_all(0, buffer + 2, size) <= 0) break;
        uint8_t *data = buffer + 2; size_t length = size;
        if (((data[0] >> 3) & 15) != 2) { buffer[0] = 0x12; buffer[1] = 0x00; data = buffer; length = (size_t)size + 2; }
        CUVIDSOURCEDATAPACKET packet; memset(&packet, 0, sizeof packet);
        packet.flags = CUVID_PKT_TIMESTAMP | CUVID_PKT_ENDOFPICTURE; packet.payload_size = (unsigned long)length; packet.payload = data; packet.timestamp = (CUvideotimestamp)pts;
        if (!check(&s, s.cv->cuvidParseVideoData(s.parser, &packet), "cuvidParseVideoData") && !s.failed) break;
        if (s.failed) break;
    }
    if (s.failed) { fprintf(stderr, "%s\n", s.why); code = 1; }
    if (s.parser) s.cv->cuvidDestroyVideoParser(s.parser);
    if (s.decoder) s.cv->cuvidDestroyDecoder(s.decoder);
    free(s.host);
    free(buffer);
    return code;
}
