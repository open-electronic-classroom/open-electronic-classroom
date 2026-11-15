using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace OecDesktop;

/// <summary>
/// 机房教师端外壳：一个窗口 + 一个 WebView2，页面通过虚拟域名 oec.local 加载，
/// 这样 http(s) 上下文里的 localStorage、ES 模块等行为与浏览器一致，且不受 file:// 限制。
/// </summary>
internal sealed class HostForm : Form
{
    private const string VirtualHost = "oec.local";
    private const string StartPage = "https://oec.local/web-console/index.html";

    // 页面是按 1280×800 CSS 像素设计的控制台布局，窗口按这个尺寸反算
    private const int DesignWidth = 1280;
    private const int DesignHeight = 800;
    private const double MinZoom = 0.75;

    private readonly WebView2 _webView = new();
    private readonly bool _selfTest;
    private readonly string _selfTestOut;
    private readonly string? _server;
    private CoreWebView2Environment? _environment;
    private NotifyIcon? _tray;

    public HostForm(bool selfTest = false, string? selfTestOut = null, string? server = null)
    {
        _selfTest = selfTest;
        _selfTestOut = selfTestOut ?? "oec-selftest.json";
        _server = string.IsNullOrWhiteSpace(server) ? null : server.TrimEnd('/');
        Text = "Open Electronic Classroom · 机房教师端";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1280, 800);
        BackColor = Color.FromArgb(0xE8, 0xEC, 0xF2);
        DoubleBuffered = true;

        var iconPath = Path.Combine(AppContext.BaseDirectory, "app-icon.ico");
        if (File.Exists(iconPath))
        {
            Icon = new Icon(iconPath);
        }

        _webView.Dock = DockStyle.Fill;
        _webView.DefaultBackgroundColor = Color.FromArgb(0xE8, 0xEC, 0xF2);
        Controls.Add(_webView);

        CreateTrayIcon(iconPath);

        if (Environment.GetEnvironmentVariable("OEC_TRAY_PREVIEW") == "1")
        {
            var timer = new System.Windows.Forms.Timer { Interval = 1200 };
            timer.Tick += (_, _) => { timer.Stop(); ShowTrayMenu(); };
            timer.Start();
        }

        Load += async (_, _) => await InitializeWebViewAsync();
    }

    private void CreateTrayIcon(string iconPath)
    {
        _tray = new NotifyIcon
        {
            Text = "Open Electronic Classroom · 机房教师端",
            Visible = true,
            Icon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application
        };
        _tray.DoubleClick += (_, _) => RestoreFromTray();
        _tray.MouseUp += (_, e) =>
        {
            if (e.Button == MouseButtons.Right) ShowTrayMenu();
        };
    }

    /// <summary>托盘右键菜单：用 WebView2 渲染的浮层菜单。</summary>
    private void ShowTrayMenu()
    {
        if (_environment is null) return;
        var menu = new TrayMenuForm(_environment, action =>
        {
            if (action == "show") RestoreFromTray();
            else if (action == "exit")
            {
                RequestExit();
            }
        });

        var cursor = Cursor.Position;
        var screen = Screen.FromPoint(cursor).WorkingArea;
        var x = Math.Min(cursor.X, screen.Right - menu.Width);
        var y = Math.Max(screen.Top, cursor.Y - menu.Height);
        menu.Location = new Point(x, y);
        menu.Show();
        menu.Activate();
    }

    private void RestoreFromTray()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private bool _reallyExit;

    /// <summary>点叉收进托盘；只有托盘菜单的“退出”才真正结束进程。</summary>
    public void RequestExit()
    {
        _reallyExit = true;
        if (_tray is not null) _tray.Visible = false;
        Application.Exit();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        if (_tray is not null)
        {
            _tray.Visible = false;
            _tray.Dispose();
            _tray = null;
        }
        base.OnFormClosed(e);
    }

    private static string WebRoot => Path.Combine(AppContext.BaseDirectory, "web");

    /// <summary>
    /// 窗口尺寸按"设计尺寸 × DPI 缩放"算，在句柄创建时一次到位，避免显示后被重排回去。
    /// 150% 缩放下 1280×800 的页面需要 1920×1200 的物理客户区，否则 CSS 视口只剩 854。
    /// </summary>
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);

        var scale = DeviceDpi / 96.0;
        var work = Screen.FromControl(this).WorkingArea;
        var design = LoadDesignSize();          // 上次关闭时的尺寸，首次为 1280×800
        var floor = new Size(DesignWidth, DesignHeight);   // 页面能正常显示的下限

        ClientSize = new Size(
            Math.Min((int)Math.Round(design.Width * scale), work.Width),
            Math.Min((int)Math.Round(design.Height * scale), work.Height));
        MinimumSize = SizeFromClientSize(new Size(
            Math.Min((int)Math.Round(floor.Width * scale), work.Width),
            Math.Min((int)Math.Round(floor.Height * scale), work.Height)));
        CenterToScreen();
    }

    /* ---------- 记住窗口尺寸（按 CSS 像素存，跨 DPI 也能用） ---------- */

    private static readonly string StatePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Open-electronic-classroom",
        "window.json");

    private static Size LoadDesignSize()
    {
        try
        {
            if (File.Exists(StatePath))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(StatePath));
                var w = doc.RootElement.GetProperty("width").GetInt32();
                var h = doc.RootElement.GetProperty("height").GetInt32();
                if (w >= DesignWidth && h >= DesignHeight) return new Size(w, h);
            }
        }
        catch (Exception)
        {
            // 配置坏了就回到默认尺寸
        }
        return new Size(DesignWidth, DesignHeight);
    }

    private void SaveDesignSize()
    {
        try
        {
            var scale = DeviceDpi / 96.0;
            var width = (int)Math.Round(ClientSize.Width / scale);
            var height = (int)Math.Round(ClientSize.Height / scale);
            if (width < DesignWidth || height < DesignHeight) return;

            Directory.CreateDirectory(Path.GetDirectoryName(StatePath)!);
            File.WriteAllText(StatePath, $"{{\"width\":{width},\"height\":{height}}}");
        }
        catch (Exception)
        {
            // 存不下就算了，不影响使用
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        SaveDesignSize();

        // 除了“退出”菜单和关机，其余关闭动作（点叉、Alt+F4、任务栏关闭）都收进托盘
        if (!_reallyExit
            && e.CloseReason != CloseReason.ApplicationExitCall
            && e.CloseReason != CloseReason.WindowsShutDown)
        {
            e.Cancel = true;
            Hide();
            return;
        }

        base.OnFormClosing(e);
    }

    /// <summary>
    /// 屏幕装不下设计尺寸时的兜底：读真实 CSS 视口，用缩放把它补到 1280。
    /// </summary>
    private async Task FitDesignViewportAsync(CoreWebView2 core)
    {
        try
        {
            var raw = await core.ExecuteScriptAsync("innerWidth");
            if (!double.TryParse(raw, out var cssWidth) || cssWidth <= 0) return;

            var zoom = Math.Clamp(cssWidth / DesignWidth, MinZoom, 1.0);
            if (Math.Abs(zoom - 1) > 0.01) _webView.ZoomFactor = zoom;
        }
        catch (Exception)
        {
        }
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        if (_webView.CoreWebView2 is { } core) _ = FitDesignViewportAsync(core);
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Open-electronic-classroom",
                "WebView2");

            var environment = await CoreWebView2Environment.CreateAsync(null, userData);
            _environment = environment;
            await _webView.EnsureCoreWebView2Async(environment);

            var core = _webView.CoreWebView2;

            // 默认用随包静态页面；给了 --server 就以 Python 后端为准（页面会走 /api）
            string origin;
            string startPage;
            if (_server is null)
            {
                core.SetVirtualHostNameToFolderMapping(
                    VirtualHost, WebRoot, CoreWebView2HostResourceAccessKind.Allow);
                origin = $"https://{VirtualHost}/";
                startPage = StartPage;
            }
            else
            {
                origin = _server + "/";
                startPage = origin + "web-console/index.html";
            }

            // 桌面软件观感：去掉浏览器自己的右键菜单、状态栏与缩放控件
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreDevToolsEnabled = false;

            // 页面内 window.open 一律开成独立的远程控制窗口
            var virtualHost = _server is null;
            core.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                if (_environment is null) return;
                if (!e.Uri.StartsWith(origin, StringComparison.OrdinalIgnoreCase)) return;
                var child = new RemoteWindow(_environment, virtualHost, e.Uri);
                child.Show(this);
            };
            core.NavigationStarting += (_, e) =>
            {
                if (!e.Uri.StartsWith(origin, StringComparison.OrdinalIgnoreCase))
                {
                    e.Cancel = true;
                }
            };

            core.NavigationCompleted += async (_, completed) =>
            {
                if (completed.IsSuccess) await FitDesignViewportAsync(core);
            };

            core.Navigate(startPage);

            if (_selfTest)
            {
                core.NavigationCompleted += async (_, e) =>
                {
                    if (!_selfTest) return;
                    await Task.Delay(700); // 等自适应缩放跑完再采样
                    var probe = await core.ExecuteScriptAsync(
                        "JSON.stringify({title:document.title," +
                        " machines:document.querySelectorAll('[data-id]').length," +
                        " view:document.getElementById('stageTitle')?.textContent," +
                        " ready:!!document.getElementById('castToggle')," +
                        " inner:[innerWidth,innerHeight],dpr:devicePixelRatio})");
                    File.WriteAllText(
                        _selfTestOut,
                        $"navigation={e.IsSuccess}\n" +
                        $"client={ClientSize.Width}x{ClientSize.Height} dpi={DeviceDpi} zoom={_webView.ZoomFactor:0.###} " +
                        $"min={MinimumSize.Width}x{MinimumSize.Height}\n" +
                        $"{probe}\n");
                    Close();
                };
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"无法启动 WebView2：{ex.Message}\n\n请确认已安装 Microsoft Edge WebView2 运行时。",
                "Open Electronic Classroom",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Close();
        }
    }
}

/// <summary>
/// 独立的远程控制窗口：同一个 WebView2 环境，默认观看模式，工具栏里切换控制。
/// </summary>
internal sealed class RemoteWindow : Form
{
    private readonly WebView2 _view = new() { Dock = DockStyle.Fill };

    public RemoteWindow(CoreWebView2Environment environment, bool virtualHost, string url)
    {
        Text = "远程控制";
        StartPosition = FormStartPosition.CenterParent;

        // 目标 2200×1520（原 1100×760 的两倍），超出屏幕可用区域时按屏幕收口
        var area = Screen.FromPoint(Cursor.Position).WorkingArea;
        ClientSize = new Size(
            Math.Min(2200, (int)(area.Width * 0.74)),
            Math.Min(1520, (int)(area.Height * 0.72)));
        MinimumSize = new Size(760, 520);
        BackColor = Color.FromArgb(0x0D, 0x15, 0x22);

        var iconPath = Path.Combine(AppContext.BaseDirectory, "app-icon.ico");
        if (File.Exists(iconPath))
        {
            Icon = new Icon(iconPath);
        }

        _view.DefaultBackgroundColor = Color.FromArgb(0x0D, 0x15, 0x22);
        Controls.Add(_view);

        Load += async (_, _) =>
        {
            await _view.EnsureCoreWebView2Async(environment);
            var core = _view.CoreWebView2;

            if (virtualHost)
            {
                core.SetVirtualHostNameToFolderMapping(
                    "oec.local", Path.Combine(AppContext.BaseDirectory, "web"),
                    CoreWebView2HostResourceAccessKind.Allow);
            }

            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.Navigate(url);
        };
    }
}

/// <summary>
/// 托盘右键菜单：一个无边框小窗，里面是 WebView2 渲染的 HTML 菜单。
/// </summary>
internal sealed class TrayMenuForm : Form
{
    private readonly WebView2 _view = new() { Dock = DockStyle.Fill };
    private readonly Action<string> _onChoose;

    public TrayMenuForm(CoreWebView2Environment environment, Action<string> onChoose)
    {
        _onChoose = onChoose;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        BackColor = Color.White;

        // WebView2 的 CSS 视口 = 窗体像素 / DPI 缩放，所以要按 DPI 放大窗体才能得到 224×128 的页面
        using (var screenGfx = Graphics.FromHwnd(IntPtr.Zero))
        {
            var scale = screenGfx.DpiX / 96f;
            Size = new Size(
                (int)Math.Round(150 * scale),
                (int)Math.Round(84 * scale));
        }

        _view.DefaultBackgroundColor = Color.White;
        Controls.Add(_view);

        Load += async (_, _) =>
        {
            await _view.EnsureCoreWebView2Async(environment);
            var core = _view.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.WebMessageReceived += (_, e) =>
            {
                var action = e.TryGetWebMessageAsString();
                _onChoose(action);
                Close();
            };
            core.NavigateToString(Html);
        };

        Deactivate += (_, _) => Close();

        HandleCreated += (_, _) =>
        {
            ApplyRoundedCorners(10);
        };
    }

    /// <summary>Win11 用 DWM 圆角，其他系统用 Region 裁圆。</summary>
    private void ApplyRoundedCorners(int radius)
    {
        var preference = DwmWindowCornerRound;
        try
        {
            DwmSetWindowAttribute(Handle, DwmWindowCornerPreference, ref preference, sizeof(int));
        }
        catch (DllNotFoundException)
        {
            // 老系统没有 dwmapi 的这个属性，走下面的 Region
        }

        using var path = new System.Drawing.Drawing2D.GraphicsPath();
        var d = radius * 2;
        path.AddArc(0, 0, d, d, 180, 90);
        path.AddArc(Width - d, 0, d, d, 270, 90);
        path.AddArc(Width - d, Height - d, d, d, 0, 90);
        path.AddArc(0, Height - d, d, d, 90, 90);
        path.CloseFigure();
        var old = Region;
        Region = new Region(path);
        old?.Dispose();
    }

    private const int DwmWindowCornerPreference = 33;
    private const int DwmWindowCornerRound = 2;

    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    private const string Html = """
        <!doctype html>
        <meta charset="utf-8">
        <style>
          html, body { margin: 0; height: 100%; box-sizing: border-box; }
          body {
            display: flex; flex-direction: column; justify-content: center;
            gap: 2px; padding: 6px;
            font: 12.5px "Segoe UI", "Microsoft YaHei UI", sans-serif;
            background: #fff; border: 1px solid #d6dee9; border-radius: 10px;
            overflow: hidden; user-select: none;
          }
          button {
            display: block; width: 100%; padding: 6px 10px; border: 0;
            border-radius: 8px;
            background: transparent; text-align: left; font: inherit;
            color: #0f172a; cursor: pointer;
          }
          button:hover { background: #eef4ff; color: #2563eb; }
        </style>
        <button data-action="show">显示主窗口</button>
        <button data-action="exit">退出</button>
        <script>
          document.querySelectorAll("button").forEach((btn) => {
            btn.addEventListener("click", () => window.chrome.webview.postMessage(btn.dataset.action));
          });
        </script>
        """;
}
