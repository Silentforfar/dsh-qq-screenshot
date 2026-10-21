# QQ 截图（DSH 插件）

<!-- English -->

## English

**QQ Screenshot** — Captures a screen region with QQ's own screenshot tool and hands the PNG to the model — from the input box button, the `/screenshot` command, or the `qq_screenshot` tool.

A [DSH](https://github.com/deepseek-ai) bundle (DeepSeek Harness plugin).

### Install from the DSH plugin market

1. Open **Plugins** in the DSH Web sidebar, select **More** next to **Experimental plugins**, and switch on **Custom plugin markets**.
2. Open the **Discover** tab and add this index source:

   `https://silentforfar.github.io/dsh-market-index/index.json`

3. Find **QQ Screenshot** (`@silentforfar/dsh-qq-screenshot`) in the list and press install.

### Install straight from this repository

Pass this spec to `plugin_manager`'s `install_bundle` (or the equivalent bundle install in your profile):

```text
git+https://github.com/Silentforfar/dsh-qq-screenshot.git#<commit-sha>
```

Use a full 40-character commit SHA from this repository's history so the install stays pinned and reproducible.

**Requirements.** Windows, DSH 0.2.1-rc.2 or newer, and a running, signed-in QQ NT. Its screenshot hotkey is `Ctrl+Alt+A` by default; override it in `%USERPROFILE%\.dsh\qq-screenshot.json`.

**License.** MIT. The rest of this README documents the plugin in Chinese.

---

用 QQ 自带的截图工具截屏，把图片交给 DSH 里的模型。

- **模型工具 `qq_screenshot`**：模型可以主动调用；调用后 QQ 截图界面弹出，框选区域并按 Enter，图片保存到工作区并随结果返回（模型支持图片输入时）。
- **输入框按钮**：消息输入框左下角（权限下拉框右侧）的取景框图标，点一下就会唤起 QQ 截图；完成后会把图片路径写进输入框。
- **命令 `/screenshot`**：与按钮同一套逻辑，可以在输入框直接输入。

截图保存在当前会话工作区的 `screenshots/` 目录，文件名形如 `qq-20261018-170519.png`。

## 依赖

- Windows
- QQ NT 正在运行且已登录（截图快捷键默认 `Ctrl+Alt+A`）
- 完成后按 **Enter**，QQ 会把截图复制到剪贴板，插件从剪贴板取图

## 工作原理

1. 宿主插件用 `capture.ps1` 通过 `SendInput` 触发 QQ 的截图快捷键；
2. 轮询检测 QQ 的截图窗口（窗口类 `QQScreenCapture Window Class`）；
3. 等用户框选完成、QQ 把位图写入剪贴板后，把剪贴板图片保存为 PNG；
4. 工具路径再通过 `attachments` 服务把 PNG 作为图片附件返回给模型。

如果 QQ 的截图快捷键不是 `Ctrl+Alt+A`，新建 `%USERPROFILE%\.dsh\qq-screenshot.json`（每次截图都会重新读取，改完立即生效）：

```json
{
  "hotkey": "Ctrl+Alt+A",
  "timeoutSec": 100
}
```

## 常见问题

- **提示“QQ 的截图窗口没有打开”**：确认 QQ 在运行并已登录；确认快捷键与配置一致。
- **提示“截图已在 QQ 中被取消”**：在 QQ 截图界面里按 Enter（复制到剪贴板）而不是点关闭；也可以先点“完成”按钮。
- **模型看不到图**：当前模型不支持图片输入时，工具只返回文件路径，可以用 `read_image` 查看该文件，或换一个支持图片输入的模型。
