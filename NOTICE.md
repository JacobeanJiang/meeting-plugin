# 第三方说明

- **voxtype**：https://github.com/peteonrails/voxtype ，MIT License，Peter Jackson 及贡献者。macOS 版随包附带官方发布的 voxtype 1.2.2 macOS 通用二进制（来自 https://github.com/peteonrails/voxtype/releases/tag/v1.2.2 的 voxtype-1.2.2-macos-universal，SHA256 3dfd45551538fb53f2d11321172da9298c57d0cf5dee347ffd09805286f3ca98，未修改），许可证见 native/LICENSE.voxtype。该二进制不存放在仓库中，构建时下载并校验。
- **whisper.cpp**：https://github.com/ggml-org/whisper.cpp ，MIT License。Windows 版随包附带 whisper.cpp v1.9.5 的 whisper-cli，由 scripts/build-whisper-windows.sh 从官方源码交叉编译，未修改源码，校验和见 native/windows/SHA256SUMS，许可证见 native/windows/LICENSE.whisper.cpp。识别模型不随包附带：首次使用时从 huggingface.co（失败时改用 hf-mirror.com）下载 whisper.cpp 官方 ggml 模型（MIT）及 Silero VAD 模型；本机已有 voxtype 下载的模型时直接复用。
- **Open Artifact**：https://github.com/JimLiu/open-artifact ，固定提交 03158112d0dcba34cd4ea5dab95f600d5304ab07，Apache-2.0，Copyright 2026 Jim Liu 宝玉。许可证与声明保留在 vendor/LICENSE.open-artifact、vendor/NOTICE.open-artifact，其依赖的许可汇总见 vendor/THIRD-PARTY-NOTICES.txt。修改范围：新增本项目的受限数据库适配，在仅监听本机回环地址的服务中承载白板，禁用默认的局域网地址发现；构建时由 scripts/board-embedding.mjs 为白板页面的 frame-ancestors 增加 file: 来源，并在画布就绪时发送不含内容的就绪信号。不改写上游白板编辑器。
- **opencc-js**：https://github.com/nk2028/opencc-js ，MIT AND Apache-2.0，用于简繁转换，许可证随构建产物附带在 licenses/opencc-js。
- 录音程序（native/MeetingRecorder.swift 使用系统 AVFoundation；native/windows/meeting-recorder.c 使用 waveIn）由本项目编写。

