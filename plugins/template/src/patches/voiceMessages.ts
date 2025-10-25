import { findByProps } from "@vendetta/metro";
import { before } from "@vendetta/patcher";
import { storage, logger } from "@vendetta";

// Utility: encode waveform array (0..255) into base64 string Discord expects
function waveformToBase64(arr) {
    const uint8 = new Uint8Array(arr);
    let binary = "";
    for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
    if (typeof btoa !== "undefined") return btoa(binary);
    try {
        return globalThis.Buffer.from(uint8).toString("base64");
    } catch {
        logger.warn("MP3ToVoiceNote: no base64 encoder available");
        return "";
    }
}

// Downsample PCM data to small amplitude array
function computeWaveformFromAudioBuffer(audioBuffer, samples = 80) {
    const data = audioBuffer.getChannelData(0);
    const block = Math.floor(data.length / samples);
    const waveform = new Uint8Array(samples);
    for (let i = 0; i < samples; i++) {
        let sum = 0;
        for (let j = 0; j < block; j++) sum += Math.abs(data[i * block + j] || 0);
        waveform[i] = Math.min(255, Math.round((sum / block) * 255));
    }
    return waveform;
}

// Try decoding MP3 file to AudioBuffer
async function arrayBufferToAudioBuffer(ab) {
    try {
        const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (AudioContext) {
            const ctx = new AudioContext();
            const buf = await ctx.decodeAudioData(ab.slice(0));
            ctx.close?.();
            return buf;
        }
    } catch (e) {
        logger.warn("MP3ToVoiceNote: decodeAudioData failed", e);
    }
    return null;
}

// Transform function that updates metadata
async function transform(item, file) {
    try {
        let duration = null;
        let waveformB64 = null;

        if (file && typeof file.arrayBuffer === "function") {
            try {
                const ab = await file.arrayBuffer();
                const audioBuf = await arrayBufferToAudioBuffer(ab);
                if (audioBuf) {
                    duration = audioBuf.duration;
                    const wf = computeWaveformFromAudioBuffer(audioBuf, 80);
                    waveformB64 = waveformToBase64(wf);
                }
            } catch (e) {
                logger.warn("MP3ToVoiceNote: decoding failed", e);
            }
        }

        // Fallback to HTMLAudioElement for duration only
        if (!duration && file) {
            try {
                const url = URL.createObjectURL(file);
                const audio = new Audio(url);
                duration = await new Promise((res) => {
                    const t = setTimeout(() => res(null), 3000);
                    audio.addEventListener("loadedmetadata", () => {
                        clearTimeout(t);
                        res(audio.duration);
                    });
                    audio.addEventListener("error", () => {
                        clearTimeout(t);
                        res(null);
                    });
                });
                URL.revokeObjectURL(url);
            } catch (e) {
                logger.warn("MP3ToVoiceNote: HTMLAudio fallback failed", e);
            }
        }

        if (duration) item.durationSecs = Math.round(duration * 100) / 100;
        if (waveformB64) item.waveform = waveformB64;
        if (item.mimeType?.startsWith("audio")) item.mimeType = "audio/ogg";
    } catch (e) {
        logger.warn("MP3ToVoiceNote: transform error", e);
    }
}

export default () => {
    const unpatches = [];

    const patchMethod = (methodName) => {
        try {
            const module = findByProps(methodName);
            if (!module) return;
            const unpatch = before(methodName, module, (args) => {
                const upload = args[0];
                if (!upload) return;
                if (storage?.sendAsVM === false) return;
                if (upload.flags === 8192) return;

                const item = upload.items?.[0] ?? upload;
                const file = upload.items?.[0]?.file ?? upload.file ?? upload;

                if (item?.mimeType?.startsWith("audio")) {
                    transform(item, file).then(() => {
                        upload.flags = 8192; // mark as voice message
                    });
                    upload.flags = 8192;
                }
            });
            unpatches.push(unpatch);
        } catch (e) {
            logger.warn("MP3ToVoiceNote: patch failed", e);
        }
    };

    patchMethod("uploadLocalFiles");
    patchMethod("CloudUpload");

    return () => unpatches.forEach((u) => u());
};
