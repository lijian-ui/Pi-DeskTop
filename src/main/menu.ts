import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";

/**
 * Replaces Electron's default (English) application menu with a Chinese one.
 * Roles keep the native accelerators/behaviors; labels are localized so the
 * menu reads 编辑 / 视图 / 窗口 / 帮助 instead of File / Edit / …
 */
export function setupApplicationMenu(): void {
  const appName = "Pi Desktop";

  const template: MenuItemConstructorOptions[] = [
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "forceReload", label: "强制重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        { type: "separator" },
        { role: "close", label: "关闭窗口" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: `关于 ${appName}`,
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send("pi:showAbout");
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
