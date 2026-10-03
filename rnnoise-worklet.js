// RNNoise AudioWorklet processor for Knot's microphone noise suppression.
//
// Based on src/worklet.js from simple-rnnoise-wasm 1.1.0
// (MIT License, Copyright (c) 2020 WONG Tin Chi Timothy,
// Copyright (c) 2025 Dmitry Zlygin), loaded in its place by app.js.
//
// The upstream processor reads input[0][0] unconditionally. While nothing
// feeds the node (its microphone source is disconnected or being replaced),
// the input has no channels, so that read throws. An exception in process()
// stops the processor for good and the microphone stays silent until the
// call is rejoined. Output silence for that render quantum instead.
let instance, heapFloat32;

function heap() {
    // A grown WebAssembly memory detaches the old view.
    if (heapFloat32.buffer !== instance.memory.buffer) heapFloat32 = new Float32Array(instance.memory.buffer);
    return heapFloat32;
}

class RNNoiseAudioWorklet extends AudioWorkletProcessor {
    constructor(options) {
        super({
            ...options,
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1]
        });
        if (!instance)
            heapFloat32 = new Float32Array((instance = new WebAssembly.Instance(options.processorOptions.module).exports).memory.buffer);
        this.state = instance.newState();
        this.alive = true;
        this.statSize = Math.ceil(sampleRate / 128);
        this.stat = new Float32Array(2 * this.statSize); // 1 s
        this.statPtr = 0;
        this.ts = 0;
        this.port.onmessage = ({ data: keepalive }) => {
            if (this.alive) {
                if (keepalive) {
                    const message = { vadProb: instance.getVadProb(this.state) };
                    if (keepalive === 'stat') {
                        message.stat = this.stat;
                    }

                    this.port.postMessage(message);
                } else {
                    this.alive = false;
                    instance.deleteState(this.state);
                }
            }
        };
    }

    process(input, output) {
        if (!this.alive) return false;

        const o = output[0] && output[0][0];
        if (!o) return true;
        const samples = input[0] && input[0][0];
        if (!samples) {
            o.fill(0);
            return true;
        }

        const ts = Date.now();

        heap().set(samples, instance.getInput(this.state) / 4);
        const ptr4 = instance.pipe(this.state, o.length) / 4;

        if (ptr4) {
            o.set(heap().subarray(ptr4, ptr4 + o.length));
        }

        if (this.ts !== 0) {
            this.stat[this.statPtr] = ts - this.ts;
            this.stat[this.statPtr + this.statSize] = Date.now() - this.ts;
            this.statPtr = (this.statPtr + 1) % this.statSize;
        }
        this.ts = ts;

        return true;
    }
}

registerProcessor("rnnoise", RNNoiseAudioWorklet);
