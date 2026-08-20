// audio-viz-helper: a small persistent process that captures whatever audio
// Windows is currently outputting (via WASAPI loopback -- this is
// system-wide, not tied to any specific app, so it works for Apple Music,
// a browser tab, anything) and continuously streams frequency band levels
// to stdout as JSON lines. main.js spawns this once and keeps it running
// for as long as the app window is open and something is playing; it reads
// each line and forwards the bands to the renderer to drive the real
// visualizer bars.
//
// This is fundamentally different from smtc-helper.exe: that one reports
// metadata an app *chooses* to expose (song name, position). This one reads
// the literal audio samples being played, which is the only way to get
// real (not simulated) visualizer motion.
//
// Output contract (one JSON object per line, newline-terminated):
//   {"bands":[0.12,0.45,0.88,...]}   -- N_BANDS floats, each 0.0-1.0
// On startup failure (e.g. no default output device), a single line is
// written to stderr and the process exits with a non-zero code so the
// Node side can detect the failure and disable the visualizer gracefully
// instead of retrying forever.

using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Dsp;
using NAudio.Wave;

const int N_BANDS = 28;          // matches BAR_COUNT in renderer.js's visualizer
const int FFT_SIZE = 1024;       // power of two, required by NAudio's FFT
const int FFT_SIZE_LOG2 = 10;    // log2(1024)
const int TARGET_FPS = 30;

var sampleBuffer = new List<float>(FFT_SIZE * 2);
var bandLevels = new float[N_BANDS];      // smoothed output levels, 0..1
var bandPeaks = new float[N_BANDS];       // rolling per-band peak, for auto-gain shape
// Tracks how loud the loudest recent moment was (slow decay, minutes-scale),
// separate from the fast per-band peaks above. Used so bars only reach the
// top when the TRACK is genuinely loud right now, not just when a band is
// loud relative to its own quiet-passage baseline (which made quiet parts
// falsely hit max height before).
float globalPeak = 0.0001f;
var stdout = Console.OpenStandardOutput();
var writer = new System.IO.StreamWriter(stdout, new UTF8Encoding(false)) { AutoFlush = false };

WasapiLoopbackCapture? capture = null;
int hopSize = 1600; // recalculated once we know the real sample rate below
int samplesSinceLastFrame = 0;
DateTime lastFrameAt = DateTime.UtcNow;

try
{
    capture = new WasapiLoopbackCapture();
    hopSize = Math.Max(256, capture.WaveFormat.SampleRate / TARGET_FPS);

    capture.DataAvailable += (s, a) =>
    {
        // Convert the raw byte buffer to mono float samples. WASAPI loopback
        // is typically 32-bit float, but handle 16-bit PCM defensively too
        // since the exact format depends on the current default device.
        var fmt = capture.WaveFormat;
        int bytesPerSample = fmt.BitsPerSample / 8;
        int channels = fmt.Channels;
        int frameCount = a.BytesRecorded / (bytesPerSample * channels);

        for (int i = 0; i < frameCount; i++)
        {
            float sum = 0f;
            for (int ch = 0; ch < channels; ch++)
            {
                int offset = i * bytesPerSample * channels + ch * bytesPerSample;
                float sample;
                if (fmt.BitsPerSample == 32 && fmt.Encoding == WaveFormatEncoding.IeeeFloat)
                {
                    sample = BitConverter.ToSingle(a.Buffer, offset);
                }
                else if (fmt.BitsPerSample == 16)
                {
                    short raw = BitConverter.ToInt16(a.Buffer, offset);
                    sample = raw / 32768f;
                }
                else
                {
                    // Unsupported format for this simple path -- treat as silence
                    // rather than crashing; bars will just sit low until a
                    // format we handle comes through.
                    sample = 0f;
                }
                sum += sample;
            }
            sampleBuffer.Add(sum / channels);
        }

        samplesSinceLastFrame += frameCount;

        // Trim buffer so it never grows unbounded if consumption falls behind.
        if (sampleBuffer.Count > FFT_SIZE * 4)
        {
            sampleBuffer.RemoveRange(0, sampleBuffer.Count - FFT_SIZE * 4);
        }

        // Emit a frame once we have enough new samples AND enough total
        // buffered samples to run a full FFT window.
        if (samplesSinceLastFrame >= hopSize && sampleBuffer.Count >= FFT_SIZE)
        {
            samplesSinceLastFrame = 0;
            EmitFrame();
        }
    };

    capture.RecordingStopped += (s, a) =>
    {
        Console.Error.WriteLine("Capture stopped: " + (a.Exception?.Message ?? "unknown reason"));
        Environment.Exit(1);
    };

    capture.StartRecording();
}
catch (Exception ex)
{
    Console.Error.WriteLine("Failed to start loopback capture: " + ex.Message);
    Environment.Exit(1);
}

// Keep the process alive. main.js manages the lifetime by killing this
// child process outright (via Node's child_process kill) rather than us
// polling for a shutdown signal -- simplest and matches how smtc-helper's
// sibling processes are already managed elsewhere in this app.
while (true)
{
    System.Threading.Thread.Sleep(1000);
}

void EmitFrame()
{
    // Take the most recent FFT_SIZE samples for this frame.
    int start = sampleBuffer.Count - FFT_SIZE;
    var complex = new Complex[FFT_SIZE];
    for (int i = 0; i < FFT_SIZE; i++)
    {
        // Hann window reduces spectral leakage -- standard practice before FFT.
        float windowMul = (float)(0.5 * (1 - Math.Cos(2 * Math.PI * i / (FFT_SIZE - 1))));
        complex[i].X = sampleBuffer[start + i] * windowMul;
        complex[i].Y = 0;
    }

    FastFourierTransform.FFT(true, FFT_SIZE_LOG2, complex);

    // Only the first half of FFT output is meaningful (real input -> mirrored spectrum).
    int usableBins = FFT_SIZE / 2;

    // Group bins into N_BANDS using a log scale, since music energy skews
    // heavily toward bass/low-mid -- a linear split would make most bands
    // sit near-silent and a few high bands do all the visible work.
    var rawBands = new float[N_BANDS];
    for (int b = 0; b < N_BANDS; b++)
    {
        double loFrac = Math.Pow((double)b / N_BANDS, 2.0);
        double hiFrac = Math.Pow((double)(b + 1) / N_BANDS, 2.0);
        int loBin = Math.Max(1, (int)(loFrac * usableBins)); // skip bin 0 (DC offset)
        int hiBin = Math.Max(loBin + 1, (int)(hiFrac * usableBins));

        float sum = 0f;
        int count = 0;
        for (int bin = loBin; bin < hiBin && bin < usableBins; bin++)
        {
            float mag = (float)Math.Sqrt(complex[bin].X * complex[bin].X + complex[bin].Y * complex[bin].Y);
            sum += mag;
            count++;
        }
        rawBands[b] = count > 0 ? sum / count : 0f;
    }

    // Overall track loudness right now, independent of per-band shape --
    // just the average raw magnitude across all bands this frame.
    float overallLevel = 0f;
    for (int b = 0; b < N_BANDS; b++) overallLevel += rawBands[b];
    overallLevel /= N_BANDS;

    // globalPeak decays very slowly (minutes-scale) so it represents "the
    // loudest this track has gotten recently", not just the last second or
    // two. volumeFactor is how loud THIS instant is relative to that --
    // 1.0 only during genuinely loud sections, much lower during quiet
    // ones, regardless of what any individual band's own local peak is.
    //
    // Rising is EASED, not instant: a single loud frame (a transient click,
    // a brief spike, a capture artifact) used to be able to jump globalPeak
    // straight to that spike's level in one frame, and because the decay
    // is so slow, that bad ceiling would then linger for a long time --
    // making every genuinely loud moment afterward look muted by
    // comparison until it finally faded. Easing the rise means it takes
    // real *sustained* loudness (many frames in a row) to actually raise
    // the ceiling, so one-off spikes can't poison it.
    if (overallLevel > globalPeak) {
        globalPeak = globalPeak * 0.9f + overallLevel * 0.1f;
    } else {
        globalPeak = Math.Max(overallLevel, globalPeak * 0.998f);
    }
    float volumeFactor = Math.Clamp(overallLevel / globalPeak, 0f, 1f);

    // Auto-gain: track a decaying peak per band and normalize against it,
    // so quiet passages don't leave bars visually dead and loud passages
    // don't clip everything to max forever. Peak decay is fast-ish (~1.5s
    // half-life at 30fps) rather than slow (~8s) -- a slow decay means one
    // loud hit sets a high "ceiling" that lingers for seconds afterward,
    // making everything that follows look artificially flat/insensitive by
    // comparison. Faster decay keeps the gain honest to *recent* loudness.
    for (int b = 0; b < N_BANDS; b++)
    {
        bandPeaks[b] = Math.Max(rawBands[b], bandPeaks[b] * 0.96f);
        float normalized = bandPeaks[b] > 0.0001f ? rawBands[b] / bandPeaks[b] : 0f;
        normalized = Math.Clamp(normalized, 0f, 1f);

        // Perceptual boost: raise to a fractional power so quiet/mid-level
        // signal (which would otherwise sit near-flat close to 0) gets
        // pushed up into visibly-moving territory, matching how loudness
        // perception itself is closer to logarithmic than linear. Loud
        // peaks were already near 1.0 so this mostly helps everything else.
        normalized = MathF.Pow(normalized, 0.55f);

        // Scale by overall volume so bars only reach the very top when the
        // track itself is genuinely loud right now -- without this, a
        // quiet passage's bars would still hit 1.0 relative to their own
        // quiet local peak, which looked wrong (everything always "maxed
        // out" regardless of actual loudness).
        normalized *= volumeFactor;

        // Smoothing: attack fast (bars jump up immediately on a hit),
        // release tuned so a bar falls back to near-zero in ~0.3s at
        // TARGET_FPS (30fps here -- 0.6 retained per frame over 9 frames
        // ≈ 1% of the original value left, i.e. visually "gone").
        if (normalized > bandLevels[b])
            bandLevels[b] = bandLevels[b] * 0.3f + normalized * 0.7f;
        else
            bandLevels[b] = bandLevels[b] * 0.6f + normalized * 0.4f;
    }

    var payload = new Dictionary<string, object> { ["bands"] = bandLevels };
    writer.WriteLine(JsonSerializer.Serialize(payload));
    writer.Flush();
}
