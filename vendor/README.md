# 离线依赖

- 项目根目录 `tencent-connect-qqbot-connector-1.2.0.tgz`：用户通过 npm 下载提供。保留原包，不重写其二维码或凭据解密协议。`package.json` 通过 `file:` 引用。
- `qrcode-terminal-0.12.0.tgz`：SDK 的依赖，从本机 `/usr/local/lib/node_modules/npm/node_modules/qrcode-terminal` 使用 `npm pack --ignore-scripts` 打包。保留包内 LICENSE。作为直接本地依赖，满足 SDK 的 `^0.12` 依赖，便于受限网络环境安装。

两份归档均由 `package-lock.json` 记录完整性。归档没有包含扫码凭据。其他依赖首次安装仍需要 npm 网络或相应本地缓存。
