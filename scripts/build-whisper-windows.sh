#!/bin/sh
# Rebuilds native/windows/whisper-cli.exe (AVX2) and whisper-cli-compat.exe (SSE4.2) from whisper.cpp v1.9.5
# with zig as a cross compiler: statically linked, no Visual C++ runtime needed, only Windows 10+ system DLLs.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
curl -sL -o "$work/src.tgz" https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz
tar xzf "$work/src.tgz" -C "$work"
src="$work/whisper.cpp-1.9.5"
for tool in ar ranlib rc; do printf '#!/bin/sh\nexec zig %s "$@"\n' "$tool" > "$work/zig-$tool"; chmod +x "$work/zig-$tool"; done
cat > "$work/toolchain.cmake" <<EOF
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER zig cc)
set(CMAKE_CXX_COMPILER zig c++)
set(CMAKE_C_COMPILER_TARGET x86_64-windows-gnu)
set(CMAKE_CXX_COMPILER_TARGET x86_64-windows-gnu)
set(CMAKE_AR $work/zig-ar)
set(CMAKE_RANLIB $work/zig-ranlib)
set(CMAKE_RC_COMPILER $work/zig-rc)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
EOF
common="-DCMAKE_TOOLCHAIN_FILE=$work/toolchain.cmake -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DCMAKE_EXE_LINKER_FLAGS=-static"
cmake -S "$src" -B "$work/avx2" $common -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON
cmake -S "$src" -B "$work/compat" $common -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF -DGGML_SSE42=ON
cmake --build "$work/avx2" -j 8 --target whisper-cli
cmake --build "$work/compat" -j 8 --target whisper-cli
cp "$work/avx2/bin/whisper-cli.exe" "$here/native/windows/whisper-cli.exe"
cp "$work/compat/bin/whisper-cli.exe" "$here/native/windows/whisper-cli-compat.exe"
cp "$src/LICENSE" "$here/native/windows/LICENSE.whisper.cpp"
(cd "$here/native/windows" && shasum -a 256 whisper-cli.exe whisper-cli-compat.exe > SHA256SUMS)
echo "Built whisper-cli for Windows into native/windows"

