/*
 * Windows microphone recorder for the meeting plugin. Same protocol as the macOS MeetingRecorder:
 *   meeting-recorder.exe <output dir> <chunk seconds>
 * writes 000000.wav, 000001.wav ... (16 kHz mono 16-bit), prints one JSON event per line on stdout
 * (ready, level, chunk, paused, resumed, stopped, device_changed, error) and reads pause/resume/stop lines on stdin.
 * Capture uses waveIn through the wave mapper, which converts any device format to 16 kHz mono.
 * "--simulate <file.wav> <speed>" feeds a WAV file instead of the microphone; tests use it on any OS.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>
#ifdef _WIN32
#include <windows.h>
#include <mmsystem.h>
#include <io.h>
#include <fcntl.h>
typedef CRITICAL_SECTION lock_t;
static void lock_init(lock_t *l) { InitializeCriticalSection(l); }
static void lock_on(lock_t *l) { EnterCriticalSection(l); }
static void lock_off(lock_t *l) { LeaveCriticalSection(l); }
static void sleep_ms(int ms) { Sleep(ms); }
static double now_ms(void) { return (double)GetTickCount64(); }
#else
#include <pthread.h>
#include <unistd.h>
#include <time.h>
typedef pthread_mutex_t lock_t;
static void lock_init(lock_t *l) { pthread_mutex_init(l, NULL); }
static void lock_on(lock_t *l) { pthread_mutex_lock(l); }
static void lock_off(lock_t *l) { pthread_mutex_unlock(l); }
static void sleep_ms(int ms) { usleep(ms * 1000); }
static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000.0 + t.tv_nsec / 1e6; }
#endif

#define RATE 16000
static lock_t out_lock, state_lock;
static void emit(const char *json) { lock_on(&out_lock); fputs(json, stdout); fputc('\n', stdout); fflush(stdout); lock_off(&out_lock); }

/* Output folder, kept as UTF-16 on Windows so a Chinese user name in the path works. */
#ifdef _WIN32
static wchar_t out_dir[4096];
#else
static char out_dir[4096];
#endif
static int16_t *pending = NULL; static size_t pending_len = 0, pending_cap = 0, chunk_frames = 0;
static long long sample_offset = 0; static int sequence = 0, paused = 0, finished = 0;
static double last_level = 0;
static int stream_pcm = 0;
static int16_t stream_samples[3200];
static size_t stream_count = 0;

static void emit_pcm(void) {
  if (!stream_count) return;
  static const char digits[] = "0123456789abcdef";
  char json[12864] = "{\"event\":\"pcm\",\"hex\":\"";
  char *cursor = json + strlen(json);
  for (size_t i = 0; i < stream_count; i++) {
    uint16_t value = (uint16_t)stream_samples[i];
    *cursor++ = digits[(value >> 4) & 15]; *cursor++ = digits[value & 15];
    *cursor++ = digits[(value >> 12) & 15]; *cursor++ = digits[(value >> 8) & 15];
  }
  strcpy(cursor, "\"}");
  emit(json);
  stream_count = 0;
}

static int write_wav(const int16_t *data, size_t count, const char *name) {
  unsigned char head[44]; uint32_t bytes = (uint32_t)(count * 2);
  memcpy(head, "RIFF", 4); uint32_t v = 36 + bytes; memcpy(head + 4, &v, 4); memcpy(head + 8, "WAVEfmt ", 8);
  v = 16; memcpy(head + 16, &v, 4); uint16_t s = 1; memcpy(head + 20, &s, 2); memcpy(head + 22, &s, 2);
  v = RATE; memcpy(head + 24, &v, 4); v = RATE * 2; memcpy(head + 28, &v, 4); s = 2; memcpy(head + 32, &s, 2); s = 16; memcpy(head + 34, &s, 2);
  memcpy(head + 36, "data", 4); memcpy(head + 40, &bytes, 4);
#ifdef _WIN32
  wchar_t final_path[4200], temp_path[4200], wname[32];
  MultiByteToWideChar(CP_UTF8, 0, name, -1, wname, 32);
  _snwprintf(final_path, 4200, L"%ls\\%ls", out_dir, wname); _snwprintf(temp_path, 4200, L"%ls.tmp", final_path);
  FILE *f = _wfopen(temp_path, L"wb");
#else
  char final_path[4200], temp_path[4200];
  snprintf(final_path, sizeof final_path, "%s/%s", out_dir, name); snprintf(temp_path, sizeof temp_path, "%s.tmp", final_path);
  FILE *f = fopen(temp_path, "wb");
#endif
  if (!f) return 0;
  int ok = fwrite(head, 1, 44, f) == 44 && fwrite(data, 2, count, f) == count;
  ok = fclose(f) == 0 && ok;
#ifdef _WIN32
  return ok && MoveFileExW(temp_path, final_path, MOVEFILE_REPLACE_EXISTING);
#else
  return ok && rename(temp_path, final_path) == 0;
#endif
}

/* Writes the first count pending samples as the next chunk. Caller holds state_lock. */
static void flush(size_t count) {
  if (count == 0 || count > pending_len) count = pending_len;
  if (count == 0) return;
  char name[32]; snprintf(name, sizeof name, "%06d.wav", sequence);
  double energy = 0; size_t voiced = 0;
  for (size_t i = 0; i < count; i++) { double x = pending[i] / 32767.0; energy += x * x; if (fabs(x) > 0.01) voiced++; }
  energy = sqrt(energy / count);
  if (!write_wav(pending, count, name)) { emit("{\"event\":\"error\",\"message\":\"audio_write_failed\"}"); finished = 1; return; }
  char json[256];
  snprintf(json, sizeof json, "{\"event\":\"chunk\",\"name\":\"%s\",\"seq\":%d,\"startMs\":%lld,\"endMs\":%lld,\"rms\":%.6f,\"voicedMs\":%.1f}",
    name, sequence, sample_offset / 16, (sample_offset + (long long)count) / 16, energy, voiced / 16.0);
  emit(json);
  sample_offset += count; sequence++;
  memmove(pending, pending + count, (pending_len - count) * 2); pending_len -= count;
}

static void consume(const int16_t *data, size_t count) {
  lock_on(&state_lock);
  if (!paused && !finished && count) {
    if (pending_len + count > pending_cap) { pending_cap = (pending_len + count) * 2; pending = realloc(pending, pending_cap * 2); }
    memcpy(pending + pending_len, data, count * 2); pending_len += count;
    if (stream_pcm) for (size_t i = 0; i < count; i++) {
      stream_samples[stream_count++] = data[i];
      if (stream_count == 3200) emit_pcm();
    }
    if (now_ms() - last_level > 200) {
      int peak = 0; for (size_t i = 0; i < count; i++) { int a = abs((int)data[i]); if (a > peak) peak = a; }
      double db = 20 * log10(fmax(peak / 32767.0, 0.000001)); if (db < -120) db = -120;
      char json[64]; snprintf(json, sizeof json, "{\"event\":\"level\",\"db\":%.1f}", db); emit(json); last_level = now_ms();
    }
    while (pending_len >= chunk_frames && !finished) flush(chunk_frames);
  }
  lock_off(&state_lock);
}

static volatile int stopping = 0;
/* stdin commands; returns when stop arrives or the plugin closes stdin. */
static void read_commands(void) {
  char line[64];
  while (fgets(line, sizeof line, stdin)) {
    line[strcspn(line, "\r\n")] = 0;
    if (!strcmp(line, "pause")) { lock_on(&state_lock); flush(0); paused = 1; lock_off(&state_lock); emit("{\"event\":\"paused\"}"); }
    else if (!strcmp(line, "resume")) { lock_on(&state_lock); paused = 0; lock_off(&state_lock); emit("{\"event\":\"resumed\"}"); }
    else if (!strcmp(line, "stop")) break;
  }
  stopping = 1;
}

/* Test source: a 16 kHz mono 16-bit WAV played in 100 ms blocks, speed times faster than real time. */
static FILE *sim_file = NULL; static double sim_speed = 1;
static int simulate_open(const char *path) {
  sim_file = fopen(path, "rb"); if (!sim_file) return 0;
  unsigned char head[44]; if (fread(head, 1, 44, sim_file) != 44 || memcmp(head, "RIFF", 4)) return 0;
  return 1;
}
#ifdef _WIN32
static DWORD WINAPI simulate_thread(LPVOID unused) {
#else
static void *simulate_thread(void *unused) {
#endif
  (void)unused; int16_t block[1600]; size_t n;
  while (!stopping && (n = fread(block, 2, 1600, sim_file)) > 0) { consume(block, n); sleep_ms((int)(100 / sim_speed)); }
  return 0;
}

#ifdef _WIN32
#define BUFFERS 8
#ifndef DRVM_MAPPER_PREFERRED_GET
#define DRVM_MAPPER_PREFERRED_GET (DRV_RESERVED + 21)
#endif
static HWAVEIN device; static WAVEHDR headers[BUFFERS]; static int16_t buffers[BUFFERS][1600]; static HANDLE wake;
static int device_open = 0; static DWORD opened_on = (DWORD)-1;
/* Held while the device is opened, closed or reopened, so stopping never races a reconnect. */
static CRITICAL_SECTION device_lock;
/* The input the wave mapper uses now: the system default recording device. */
static DWORD preferred_device(void) {
  DWORD id = (DWORD)-1, flags = 0;
  if (waveInMessage((HWAVEIN)(UINT_PTR)WAVE_MAPPER, DRVM_MAPPER_PREFERRED_GET, (DWORD_PTR)&id, (DWORD_PTR)&flags) != MMSYSERR_NOERROR) return (DWORD)-1;
  return id;
}
static void close_microphone(void) {
  if (!device_open) return;
  waveInStop(device); waveInReset(device);
  for (int i = 0; i < BUFFERS; i++) waveInUnprepareHeader(device, &headers[i], sizeof(WAVEHDR));
  waveInClose(device); device_open = 0;
}
static int open_microphone(void) {
  WAVEFORMATEX format = { WAVE_FORMAT_PCM, 1, RATE, RATE * 2, 2, 16, 0 };
  if (!wake) wake = CreateEventW(NULL, FALSE, FALSE, NULL);
  opened_on = preferred_device();
  if (waveInOpen(&device, WAVE_MAPPER, &format, (DWORD_PTR)wake, 0, CALLBACK_EVENT) != MMSYSERR_NOERROR) return 0;
  device_open = 1;
  for (int i = 0; i < BUFFERS; i++) {
    headers[i].lpData = (LPSTR)buffers[i]; headers[i].dwBufferLength = sizeof buffers[i]; headers[i].dwFlags = 0; headers[i].dwBytesRecorded = 0;
    if (waveInPrepareHeader(device, &headers[i], sizeof(WAVEHDR)) != MMSYSERR_NOERROR || waveInAddBuffer(device, &headers[i], sizeof(WAVEHDR)) != MMSYSERR_NOERROR) { close_microphone(); return 0; }
  }
  if (waveInStart(device) != MMSYSERR_NOERROR) { close_microphone(); return 0; }
  return 1;
}
/*
 * The wave mapper keeps the device it opened. When the system default recording device changes (a headset is plugged in
 * or removed) or the device stops delivering audio, the microphone is reopened on the current default so the recording
 * does not go silent. After about 10 s without a working device the plugin is told the microphone is lost.
 */
static DWORD WINAPI capture_thread(LPVOID unused) {
  (void)unused;
  double last_audio = now_ms(), last_check = now_ms();
  int failures = 0, lost = 0;
  while (!stopping) {
    WaitForSingleObject(wake, 200);
    EnterCriticalSection(&device_lock);
    if (device_open) for (int i = 0; i < BUFFERS; i++) if (headers[i].dwFlags & WHDR_DONE) {
      if (headers[i].dwBytesRecorded) { consume(buffers[i], headers[i].dwBytesRecorded / 2); last_audio = now_ms(); }
      headers[i].dwFlags &= ~WHDR_DONE; headers[i].dwBytesRecorded = 0;
      if (!stopping) waveInAddBuffer(device, &headers[i], sizeof(WAVEHDR));
    }
    double t = now_ms();
    if (!stopping && t - last_check >= 1000) {
      last_check = t;
      if (!device_open || preferred_device() != opened_on || t - last_audio > 3000) {
        close_microphone();
        if (open_microphone()) { failures = 0; lost = 0; last_audio = now_ms(); emit("{\"event\":\"device_changed\"}"); }
        else if (++failures >= 10 && !lost) { lost = 1; emit("{\"event\":\"error\",\"message\":\"microphone_lost\"}"); }
      }
    }
    LeaveCriticalSection(&device_lock);
  }
  return 0;
}
#endif

int main(int argc, char **argv) {
  lock_init(&out_lock); lock_init(&state_lock);
#ifdef _WIN32
  _setmode(_fileno(stdout), _O_BINARY);
  int wargc = 0; wchar_t **wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);
  if (!wargv || wargc < 3) { fputs("usage: meeting-recorder <dir> <seconds> [--simulate file speed]\n", stderr); return 2; }
  wcsncpy(out_dir, wargv[1], 4095);
  double seconds = _wtof(wargv[2]);
  for (int i = 3; i < wargc; i++) if (!wcscmp(wargv[i], L"--stream-pcm")) stream_pcm = 1;
  int simulate = wargc >= 5 && !wcscmp(wargv[3], L"--simulate");
  char sim_path[4096] = ""; if (simulate) { WideCharToMultiByte(CP_ACP, 0, wargv[4], -1, sim_path, sizeof sim_path, NULL, NULL); sim_speed = wargc >= 6 ? _wtof(wargv[5]) : 1; }
#else
  if (argc < 3) { fputs("usage: meeting-recorder <dir> <seconds> [--simulate file speed]\n", stderr); return 2; }
  strncpy(out_dir, argv[1], 4095);
  double seconds = atof(argv[2]);
  for (int i = 3; i < argc; i++) if (!strcmp(argv[i], "--stream-pcm")) stream_pcm = 1;
  int simulate = argc >= 5 && !strcmp(argv[3], "--simulate");
  const char *sim_path = simulate ? argv[4] : ""; if (simulate) sim_speed = argc >= 6 ? atof(argv[5]) : 1;
#endif
  if (seconds < 1 || seconds > 120) seconds = 15;
  if (sim_speed <= 0) sim_speed = 1;
  chunk_frames = (size_t)(seconds * RATE);
  if (simulate) {
    if (!simulate_open(sim_path)) { emit("{\"event\":\"error\",\"message\":\"microphone_unavailable\"}"); return 1; }
#ifdef _WIN32
    CreateThread(NULL, 0, simulate_thread, NULL, 0, NULL);
#else
    pthread_t t; pthread_create(&t, NULL, simulate_thread, NULL);
#endif
  } else {
#ifdef _WIN32
    InitializeCriticalSection(&device_lock);
    if (!open_microphone()) { emit("{\"event\":\"error\",\"message\":\"microphone_permission_or_device\"}"); return 1; }
    CreateThread(NULL, 0, capture_thread, NULL, 0, NULL);
#else
    emit("{\"event\":\"error\",\"message\":\"microphone_unavailable\"}"); return 1;
#endif
  }
  emit("{\"event\":\"ready\"}");
  read_commands();
#ifdef _WIN32
  if (!simulate) { sleep_ms(250); EnterCriticalSection(&device_lock); if (device_open) { waveInStop(device); waveInReset(device); } LeaveCriticalSection(&device_lock); }
#endif
  sleep_ms(150);
  lock_on(&state_lock); emit_pcm(); flush(0); finished = 1; lock_off(&state_lock);
  emit("{\"event\":\"stopped\"}");
#ifdef _WIN32
  if (!simulate) { EnterCriticalSection(&device_lock); close_microphone(); LeaveCriticalSection(&device_lock); }
#endif
  return 0;
}

