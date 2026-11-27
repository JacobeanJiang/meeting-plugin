# 接入实时字幕与说话人识别

在 `~/.meeting-assistant/config.json` 添加以下字段，或在 MCP 主机设置同名环境变量。重启会议助手后，在会议设置中选用云端识别。未设置实时接口地址时，插件沿用分段转写和字幕预览。

```json
{
  "MEETING_VOICE_STREAM_URL": "wss://speech.example.org/meetings",
  "MEETING_VOICE_STREAM_API_KEY": "your-provider-key"
}
```

设置 `MEETING_LIVE_CAPTIONS=0` 时，插件关闭实时接口，仅保留分段识别。

每场录音首次收到麦克风数据时建立一条 WebSocket 连接。服务需要鉴权时，插件在握手请求中发送 `Authorization: Bearer <MEETING_VOICE_STREAM_API_KEY>`，不需要鉴权时省略该配置。远程服务使用 `wss://`，本机开发也支持 `ws://127.0.0.1`、`ws://localhost` 和 `ws://[::1]`。

## 服务端协议

1. 握手成功后，服务端发送文本帧 `{"type":"ready"}`。插件随后发送二进制帧，内容为 16 kHz 单声道小端有符号 16 位 PCM，每毫秒 32 字节。
2. 用 `transcript` 事件推送字幕。每行使用相对录音开始的毫秒数，时间不计暂停，时间范围不能超过已收到的音频。`definite: false` 表示当前草稿，每次事件列出所有活跃草稿。`definite: true` 的句子将按起始时间写入录音分段。

   ```json
   {"type":"transcript","utterances":[{"startMs":250,"endMs":950,"text":"开始会议。","definite":true}]}
   ```

3. 用 `speaker` 事件推送当前发言人，`endMs` 表示本次识别窗口结束时间，须按时间递增。匹配成功时返回用户可读的名字，无法识别时返回 `null`，界面会结束上一位发言人的标记。

   ```json
   {"type":"speaker","endMs":900,"name":"发言人 A"}
   ```

4. 录音结束后，插件发送纯文本帧 `finish`。服务端应发完剩余字幕和说话人事件，最后发送 `{"type":"done"}`。

实时接口中断时，插件保留分段 WAV，优先尝试已配置的 `MEETING_ASR_MODEL` 分段转写，其次使用本地识别。分段接口采用 OpenAI 兼容的 `POST <MEETING_ASR_BASE_URL>/audio/transcriptions`，可以和实时接口使用不同的服务和密钥。
