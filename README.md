# IP定位 Chrome 扩展

一个 Manifest V3 Chrome 扩展，用 IP 定位结果自动覆盖网页中的 `navigator.geolocation` 返回值，并在弹窗中展示 IP、经纬度和接口状态。

## 功能

- 依次尝试 `https://ipwho.is/`、`https://api.ip.sb/geoip`、`https://ip9.com.cn/get` 获取当前出口 IP 的定位信息，每个请求最多等待 8 秒；网络、HTTP、JSON 或数据校验失败时切换备用接口
- 在本地保存最近一次成功的 IP、原始定位、接口来源和更新时间；所有接口失败时保留并继续使用缓存位置，缓存可能已过时
- 每次接口请求失败、位置更新失败或网页注入失败（含超过 8 秒未返回）都发送 Chrome 通知并显示 `!` 标记；不再按故障类型去重
- 扩展弹窗会显示最近失败详情并弹出提醒，确认后可设置手动经纬度；Chrome 内置页、其他扩展页等不支持注入的页面会跳过
- 支持保存手动经纬度，手动模式暂停 IP 刷新，直到点击「恢复 IP 自动定位」；原 IP 缓存保留
- 每分钟后台刷新一次位置
- 在新加载的标签页中注入 geolocation 覆盖逻辑
- 支持手动刷新定位
- 在扩展弹窗中显示国家、纬度、经度和更新时间
- 网页 Geolocation API 返回的经纬度与所选 IP 接口结果一致，不根据国家替换坐标

## 安装

1. 打开 Chrome 的扩展管理页：

   ```text
   chrome://extensions/
   ```

2. 开启右上角的「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 直接选择本项目目录。

安装后，扩展会在后台自动获取并保存最近一次定位结果。

## 使用

- 点击浏览器工具栏中的扩展图标，查看当前保存的 IP 信息和经纬度。弹窗不加载地图，不向底图服务发送坐标。
- 点击「立即刷新」手动更新 IP 定位。
- 弹窗显示 IP、接口来源及故障状态；刷新结果不会等待所有网页的脚本注入完成。
- 输入纬度（-90 到 90）、经度（-180 到 180），点击「保存并使用手动经纬度」后应用到网页。空值、非数字、超出范围的输入会报错并保留原设置。
- 点击「恢复 IP 自动定位」退出手动模式并立即尝试获取 IP 定位；失败时继续使用上次成功的 IP 缓存。
- 最近一次失败会保留在弹窗并显示对话框，点击「知道了，查看或设置经纬度」确认。系统通知无法强制绕过 Chrome、系统通知设置或勿扰模式；通知 API 报错会记录到弹窗。
- 扩展会在页面加载时覆盖网页调用到的 `navigator.geolocation.getCurrentPosition` 和 `navigator.geolocation.watchPosition`。

## 项目结构

```text
.
├── manifest.json      # Chrome 扩展配置
├── background.js      # 后台刷新、存储和脚本注入逻辑
├── popup.html         # 扩展弹窗界面
├── popup.js           # 弹窗数据读取和手动刷新逻辑
└── icon.png           # 扩展图标
```

## 权限说明

扩展使用以下权限：

- `storage`：保存最近一次成功的 IP 信息、应用到网页的位置及故障状态，保存在当前 Chrome 配置中，失败时不覆盖缓存。
- `notifications`：在 API 故障时发送系统通知，实际显示受 Chrome 和操作系统的通知设置控制。
- `alarms`：定时刷新定位。
- `scripting`：向页面注入 geolocation 覆盖脚本。
- `tabs`：查找并更新已打开的标签页。
- `<all_urls>`：允许在所有网页中注入定位覆盖逻辑。

## 开发

本项目没有构建步骤，修改文件后在 Chrome 扩展管理页点击刷新按钮即可重新加载。

逻辑回归检查：`node --test background.test.cjs`。增加通知权限后，已有安装可能需要重新启用扩展并确认 Chrome 的权限提示。

主要逻辑在 `background.js`：

- `updateGeolocation()` 负责请求 IP 定位接口并写入 `chrome.storage.local`
- `injectScript()` 负责把 geolocation 覆盖函数注入页面主世界
- `updateAllTabs()` 负责把新位置应用到已打开标签页

## 发布

推送 `v*` tag 会触发 GitHub Actions 自动打包扩展，并把 zip 上传到对应的 GitHub Release。

```bash
git tag v1.1.0
git push origin v1.1.0
```

zip 包只包含 Chrome 扩展运行需要的文件，解压后 `manifest.json` 位于根目录。

## 注意事项

- 扩展依赖外部 IP 定位接口，离线或服务不可用时使用最近一次成功的缓存；IP 定位是接口估计的位置，不代表设备真实 GPS 位置。
- 该扩展只能影响网页通过浏览器 Geolocation API 获取的位置，不能修改网站通过 IP、账号、Cookie 或其他方式判断出的地区。
- 部分 Chrome 内置页面、扩展页面或受限制页面不允许脚本注入。
