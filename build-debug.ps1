# ============================================================
# build-debug.ps1 — 调试版构建脚本
#
# 行为与 build.ps1 完全一致：相同的平台/架构参数、交互菜单、
# -All、-Clean、-Help、输出目录和失败汇总。
# 唯一区别：调用 wails3 build 时额外加 devtools build tag，
# 启用 WebView2 DevTools（F12 / Ctrl+Shift+I）。
#
# 注意：调试版会覆盖正式输出路径；发布时仍使用 build.ps1。
# ============================================================

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Platform,

    [Parameter(Position = 1)]
    [string]$Arch,

    [switch]$All,

    [switch]$Clean,

    [switch]$Help
)

$ErrorActionPreference = 'Stop'

# 平台配置：界面显示名、Go 的 GOOS、输出根目录、可执行文件后缀
$platformMap = @{
    'windows' = [pscustomobject]@{ Label = 'Windows'; Goos = 'windows'; Dir = 'bin-win';    Ext = '.exe' }
    'linux'   = [pscustomobject]@{ Label = 'Linux';   Goos = 'linux';   Dir = 'bin-linux';  Ext = '' }
    'mac'     = [pscustomobject]@{ Label = 'macOS';   Goos = 'darwin';  Dir = 'bin-darwin'; Ext = '' }
}
$platforms = @('windows', 'linux', 'mac')
$arches = @('amd64', 'arm64')

# 产物名固定，平台和架构用目录区分
$binName = 'oc-manager'

# 构造一个构建目标；Output 使用正斜杠：
# Taskfile 的命令由 sh 执行，Windows 的反斜杠会被当成转义符。
function New-BuildTarget {
    param(
        [string]$TargetPlatform,
        [string]$TargetArch
    )
    $info = $platformMap[$TargetPlatform]
    [pscustomobject]@{
        Platform = $TargetPlatform
        Arch     = $TargetArch
        Label    = $info.Label
        Goos     = $info.Goos
        Dir      = $info.Dir
        Ext      = $info.Ext
        Output   = "$($info.Dir)/$TargetArch/$binName$($info.Ext)"
    }
}

# 全部目标：Windows / Linux / macOS × amd64 / arm64，共 6 个
$allTargets = @()
foreach ($p in $platforms) {
    foreach ($a in $arches) {
        $allTargets += New-BuildTarget -TargetPlatform $p -TargetArch $a
    }
}

function Show-Usage {
    Write-Host ''
    Write-Host '用法: build-debug.ps1 [平台] [架构] [选项]'
    Write-Host '      build-debug.ps1 -All'
    Write-Host ''
    Write-Host '  不传平台和架构时进入交互菜单（方向键选择，无法读取按键时回退数字菜单）'
    Write-Host '  平台   windows、linux、mac'
    Write-Host '  架构   amd64、arm64'
    Write-Host '  调试   额外启用 devtools（F12 / Ctrl+Shift+I 打开 DevTools），不要用于发布'
    Write-Host ''
    Write-Host '选项:'
    Write-Host '  -All     一次生成全部 6 个目标（Windows / Linux / macOS × amd64 / arm64）'
    Write-Host '  -Clean   构建前删除对应的输出目录'
    Write-Host '  -Help    显示帮助'
    Write-Host ''
    Write-Host '输出（按平台 / 架构分目录）:'
    Write-Host '  bin-win/amd64/oc-manager.exe'
    Write-Host '  bin-win/arm64/oc-manager.exe'
    Write-Host '  bin-linux/amd64/oc-manager'
    Write-Host '  bin-linux/arm64/oc-manager'
    Write-Host '  bin-darwin/amd64/oc-manager'
    Write-Host '  bin-darwin/arm64/oc-manager'
    Write-Host ''
    Write-Host '示例:'
    Write-Host '  build-debug.ps1'
    Write-Host '  build-debug.ps1 -All'
    Write-Host '  build-debug.ps1 linux amd64'
    Write-Host '  build-debug.ps1 mac arm64 -Clean'
    Write-Host '  build-debug.ps1 windows'
    Write-Host ''
}

# 方向键菜单：与 afsim-agent/build.ps1 的交互方式一致。
# 返回选中的项，Esc/Q 返回 $null。
function Select-MenuByArrow {
    param(
        [string]$Title,
        [string[]]$Items,
        [int]$StartIndex = 0
    )

    $index = [Math]::Max(0, [Math]::Min($StartIndex, $Items.Count - 1))
    while ($true) {
        Clear-Host
        Write-Host ''
        Write-Host "  $Title" -ForegroundColor Cyan
        Write-Host '  ------------------------------------' -ForegroundColor DarkGray
        for ($i = 0; $i -lt $Items.Count; $i++) {
            if ($i -eq $index) {
                Write-Host ("  > " + $Items[$i]) -ForegroundColor Black -BackgroundColor Cyan
            } else {
                Write-Host ("    " + $Items[$i])
            }
        }
        Write-Host ''
        Write-Host '  ↑/↓: 选择   Enter: 确认   Esc/Q: 退出' -ForegroundColor DarkGray

        $key = [Console]::ReadKey($true)
        switch ($key.Key.ToString()) {
            'UpArrow' {
                $index = ($index - 1 + $Items.Count) % $Items.Count
            }
            'DownArrow' {
                $index = ($index + 1) % $Items.Count
            }
            'Enter' {
                return $Items[$index]
            }
            'Escape' {
                return $null
            }
            'Q' {
                return $null
            }
        }
    }
}

# 数字菜单：输入被重定向或没有真实控制台时，ReadKey 会抛异常，
# 这时回退到 Read-Host，保证脚本在 CI / 管道 / 非交互环境里仍能使用。
function Select-MenuByNumber {
    param(
        [string]$Title,
        [string[]]$Items,
        [int]$StartIndex = 0
    )

    Write-Host ''
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host '  ------------------------------------' -ForegroundColor DarkGray
    for ($i = 0; $i -lt $Items.Count; $i++) {
        Write-Host ("  {0}) {1}" -f ($i + 1), $Items[$i])
    }
    Write-Host '  0) 退出' -ForegroundColor DarkGray
    Write-Host ''

    $default = $StartIndex + 1
    while ($true) {
        $input = Read-Host "请输入序号 [$default]"
        if ($null -eq $input) {
            return $null
        }
        $input = $input.Trim()
        if ($input -eq '') {
            return $Items[$StartIndex]
        }
        if ($input -eq '0' -or $input -match '^(?i:q|quit|exit|esc)$') {
            return $null
        }

        $n = 0
        if ([int]::TryParse($input, [ref]$n) -and $n -ge 1 -and $n -le $Items.Count) {
            return $Items[$n - 1]
        }
        Write-Host '  输入无效，请重新选择。' -ForegroundColor Yellow
    }
}

# 统一入口：优先方向键；只在「没有控制台」导致的 ReadKey 失败时回退数字菜单。
# Ctrl+C 之类的用户中断不会被这个 catch 吞掉。
function Select-Menu {
    param(
        [string]$Title,
        [string[]]$Items,
        [int]$StartIndex = 0
    )

    try {
        return Select-MenuByArrow -Title $Title -Items $Items -StartIndex $StartIndex
    } catch [System.InvalidOperationException] {
        return Select-MenuByNumber -Title $Title -Items $Items -StartIndex $StartIndex
    }
}

if ($Help) {
    Show-Usage
    exit 0
}

# 脚本所在目录就是项目根目录；直接双击/从其他目录调用也能定位正确
$Root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = (Get-Location).Path
}
Set-Location $Root

$selected = @()

if ($All) {
    # -All：一次生成全部 6 个目标
    $selected = $allTargets
} else {
    # 未传平台和架构时进入交互菜单
    $needsMenu = -not (
        $PSBoundParameters.ContainsKey('Platform') -or
        $PSBoundParameters.ContainsKey('Arch')
    )

    if ($needsMenu) {
        $platformMenu = @(
            'Windows'
            'Linux'
            'macOS'
            '全部生成（6 个目标）'
        )
        $picked = Select-Menu "选择目标平台（项目: $Root）" $platformMenu 0
        if ($null -eq $picked) {
            exit 0
        }

        if ($picked -like '全部*') {
            $selected = $allTargets
        } else {
            switch ($picked) {
                'Windows' { $Platform = 'windows' }
                'Linux'   { $Platform = 'linux' }
                'macOS'   { $Platform = 'mac' }
            }

            $archMenu = @(
                'amd64 (x64)'
                'arm64'
            )
            $picked = Select-Menu "选择架构（平台: $picked）" $archMenu 0
            if ($null -eq $picked) {
                exit 0
            }
            $Arch = if ($picked -like 'amd64*') { 'amd64' } else { 'arm64' }
        }
    }

    if ($selected.Count -eq 0) {
        # 参数模式或菜单里选了单平台：补默认值并校验
        if ([string]::IsNullOrWhiteSpace($Platform)) { $Platform = 'windows' }
        if ([string]::IsNullOrWhiteSpace($Arch)) { $Arch = 'amd64' }

        $Platform = $Platform.ToLowerInvariant()
        $Arch = $Arch.ToLowerInvariant()

        if ($platforms -notcontains $Platform) {
            Write-Host "无效平台: $Platform" -ForegroundColor Red
            Write-Host "有效平台: $($platforms -join '、')"
            exit 1
        }
        if ($arches -notcontains $Arch) {
            Write-Host "无效架构: $Arch" -ForegroundColor Red
            Write-Host "有效架构: $($arches -join '、')"
            exit 1
        }

        $selected = @(New-BuildTarget -TargetPlatform $Platform -TargetArch $Arch)
    }
}

if (-not (Get-Command wails3 -ErrorAction SilentlyContinue)) {
    Write-Host '未在 PATH 中找到 wails3 命令。' -ForegroundColor Red
    exit 1
}

# -Clean：只删除本次涉及的「平台 / 架构」子目录，
# 保留 bin-*/agentdatas 等运行数据，避免误删便携数据。
if ($Clean) {
    foreach ($t in $selected) {
        $outDir = Join-Path $Root "$($t.Dir)/$($t.Arch)"
        if (Test-Path $outDir) {
            Remove-Item $outDir -Recurse -Force
        }
    }
}

$failed = @()

foreach ($t in $selected) {
    $outDir = Join-Path $Root "$($t.Dir)/$($t.Arch)"
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    # 每次构建前重置环境变量，避免上一次构建的设置残留
    Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED, Env:WAILS_PUREGO -ErrorAction SilentlyContinue
    $env:GOOS = $t.Goos
    $env:GOARCH = $t.Arch
    # Windows 与 purego 后端都要求 CGO_ENABLED=0
    $env:CGO_ENABLED = '0'
    if ($t.Goos -ne 'windows') {
        # wails3 看到 WAILS_PUREGO=1 会自动把 purego 加入构建标签
        $env:WAILS_PUREGO = '1'
    }

    Write-Host ''
    Write-Host "正在构建调试版 $($t.Label) / $($t.Arch) -> $($t.Output)（CGO_ENABLED=0，devtools）..." -ForegroundColor Green

    & wails3 build "OUTPUT=$($t.Output)" -tags devtools
    $code = $LASTEXITCODE

    # 恢复环境变量，避免影响当前终端后续的普通构建
    Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED, Env:WAILS_PUREGO -ErrorAction SilentlyContinue

    if ($code -ne 0) {
        $failed += "$($t.Label)/$($t.Arch)"
        Write-Host "构建失败：$($t.Label)/$($t.Arch)" -ForegroundColor Red
        continue
    }

    $outPath = Join-Path $Root $t.Output
    if (-not (Test-Path $outPath)) {
        $failed += "$($t.Label)/$($t.Arch)"
        Write-Host "构建命令成功，但未找到产物：$($t.Output)" -ForegroundColor Red
        continue
    }

    $sizeMB = [math]::Round((Get-Item $outPath).Length / 1MB, 2)
    Write-Host "已生成：$($t.Output)（$sizeMB MB）" -ForegroundColor Green
}

Write-Host ''
if ($failed.Count -gt 0) {
    Write-Host "失败目标：$($failed -join '、')" -ForegroundColor Red
    exit 1
}
Write-Host "全部构建成功。" -ForegroundColor Green
exit 0
