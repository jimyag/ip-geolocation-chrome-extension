# IP定位 Chrome 扩展

一个 Manifest V3 Chrome 扩展，用 IP 定位结果自动覆盖网页中的 `navigator.geolocation` 返回值，并在弹窗中展示当前位置和地图。

## 功能

- 自动从 `https://ors.de5.net/ip` 获取当前 IP 的定位信息
- 每分钟后台刷新一次位置
- 在新加载的标签页中注入 geolocation 覆盖逻辑
- 支持手动刷新定位
- 在扩展弹窗中显示国家、纬度、经度和更新时间
- 使用 Leaflet + OpenStreetMap 在弹窗中展示位置
- 当定位国家为 `CN` 时，使用内置隐私保护坐标

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

- 点击浏览器工具栏中的扩展图标，查看当前保存的位置和地图。
- 点击「立即刷新」手动更新 IP 定位。
- 扩展会在页面加载时覆盖网页调用到的 `navigator.geolocation.getCurrentPosition` 和 `navigator.geolocation.watchPosition`。

## 项目结构

```text
.
├── manifest.json      # Chrome 扩展配置
├── background.js      # 后台刷新、存储和脚本注入逻辑
├── popup.html         # 扩展弹窗界面
├── popup.js           # 弹窗数据读取和手动刷新逻辑
├── map.html           # 沙箱地图页面
├── map.js             # Leaflet 地图渲染逻辑
├── leaflet.css        # Leaflet 样式
├── leaflet.js         # Leaflet 运行时代码
├── icon.png           # 扩展图标
└── images/            # Leaflet marker 图标资源
```

## 权限说明

扩展使用以下权限：

- `storage`：保存最近一次定位结果。
- `alarms`：定时刷新定位。
- `scripting`：向页面注入 geolocation 覆盖脚本。
- `tabs`：查找并更新已打开的标签页。
- `<all_urls>`：允许在所有网页中注入定位覆盖逻辑。

## 开发

本项目没有构建步骤，修改文件后在 Chrome 扩展管理页点击刷新按钮即可重新加载。

主要逻辑在 `background.js`：

- `updateGeolocation()` 负责请求 IP 定位接口并写入 `chrome.storage.local`
- `injectScript()` 负责把 geolocation 覆盖函数注入页面主世界
- `updateAllTabs()` 负责把新位置应用到已打开标签页

## 发布

推送 `v*` tag 会触发 GitHub Actions 自动打包扩展，并把 zip 上传到对应的 GitHub Release。

```bash
git tag v1.0.0
git push origin v1.0.0
```

zip 包只包含 Chrome 扩展运行需要的文件，解压后 `manifest.json` 位于根目录。

## 注意事项

- 扩展依赖外部 IP 定位接口和 OpenStreetMap 瓦片服务，离线或服务不可用时地图和定位刷新可能失败。
- 该扩展只能影响网页通过浏览器 Geolocation API 获取的位置，不能修改网站通过 IP、账号、Cookie 或其他方式判断出的地区。
- 部分 Chrome 内置页面、扩展页面或受限制页面不允许脚本注入。
