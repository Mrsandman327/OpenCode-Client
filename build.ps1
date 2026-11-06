[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Platform,

    [Parameter(Position = 1)]
    [string]$Arch,

    [switch]$Clean,

    [switch]$Help
)

$ErrorActionPreference = 'Stop'

# 平台配置：界面显示名、Go 的 GOOS、输出目录、可执行文件后缀
$platformMap = @{
    'windows' = [pscustomobject]@{ Label = 'Windows'; Goos = 'windows'; Dir = 'bin-win';    Ext = '.exe' }
    'linux'   = [pscustomobject]@{ Label = 'Linux';   Goos = 'linux';   Dir = 'bin-linux';  Ext = '' }
    'mac'     = [pscustomobject]@{ Label = 'macOS';   Goos = 'darwin';  Dir = 'bin-darwin'; Ext = '' }
}
$platforms = @('windows', 'linux', 'mac')
$arches = @('amd64', 'arm64')
$defaultPlatform = 'windows'
$defaultArch = 'amd64'

# 产物名固定，不拼平台和架构；不同架构写同一路径时后者覆盖前者
$binName = 'oc-manager'

function Show-Usage {
    Write-Host ''
    Write-Host '用法: build.ps1 [平台] [架构] [选项]'
    Write-Host ''
    Write-Host '  不传平台和架构时进入交互菜单（方向键选择，无法读取按键时回退数字菜单）'
    Write-Host '  平台   windows、linux、mac'
    Write-Host '  架构   amd64、arm64'
    Write-Host ''
    Write-Host '选项:'
    Write-Host '  -Clean   构建前删除对应的输出目录'
    Write-Host '  -Help    显示帮助'
    Write-Host ''
    Write-Host '输出:'
    Write-Host '  bin-win/oc-manager.exe'
    Write-Host '  bin-linux/oc-manager'
    Write-Host '  bin-darwin/oc-manager'
    Write-Host ''
    Write-Host '示例:'
    Write-Host '  build.ps1'
    Write-Host '  build.ps1 linux amd64'
    Write-Host '  build.ps1 mac arm64 -Clean'
    Write-Host '  build.ps1 windows'
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

# 未传平台和架构时进入交互菜单，只生成选择的那一个目标
$needsMenu = -not (
    $PSBoundParameters.ContainsKey('Platform') -or
    $PSBoundParameters.ContainsKey('Arch')
)

if ($needsMenu) {
    $platformMenu = @(
        'Windows'
        'Linux'
        'macOS'
    )
    $picked = Select-Menu "选择目标平台（项目: $Root）" $platformMenu 0
    if ($null -eq $picked) {
        exit 0
    }
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

if ([string]::IsNullOrWhiteSpace($Platform)) { $Platform = $defaultPlatform }
if ([string]::IsNullOrWhiteSpace($Arch)) { $Arch = $defaultArch }

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

if (-not (Get-Command wails3 -ErrorAction SilentlyContinue)) {
    Write-Host '未在 PATH 中找到 wails3 命令。' -ForegroundColor Red
    exit 1
}

$info = $platformMap[$Platform]
$outDir = Join-Path $Root $info.Dir

if ($Clean -and (Test-Path $outDir)) {
    Remove-Item $outDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 每次构建前重置环境变量，避免上一次构建的设置残留
Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED, Env:WAILS_PUREGO -ErrorAction SilentlyContinue
$env:GOOS = $info.Goos
$env:GOARCH = $Arch
# Windows 与 purego 后端都要求 CGO_ENABLED=0
$env:CGO_ENABLED = '0'
if ($info.Goos -ne 'windows') {
    # wails3 看到 WAILS_PUREGO=1 会自动把 purego 加入构建标签
    $env:WAILS_PUREGO = '1'
}

# OUTPUT 是 Taskfile 的自定义变量，决定最终产物路径。
# 必须用正斜杠：Taskfile 的命令由 sh 执行，反斜杠会被当成转义符。
$outFile = "$($info.Dir)/$binName$($info.Ext)"

Write-Host ''
Write-Host "正在构建 $($info.Label) / $Arch -> $outFile（CGO_ENABLED=0）..." -ForegroundColor Green

& wails3 build "OUTPUT=$outFile"
$code = $LASTEXITCODE

# 恢复环境变量，避免影响当前终端后续的普通构建
Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED, Env:WAILS_PUREGO -ErrorAction SilentlyContinue

if ($code -ne 0) {
    Write-Host "构建失败，退出码 $code。" -ForegroundColor Red
    exit $code
}

$outPath = Join-Path $Root $outFile
if (-not (Test-Path $outPath)) {
    Write-Host "构建命令成功，但未找到产物: $outFile" -ForegroundColor Red
    exit 1
}

$sizeMB = [math]::Round((Get-Item $outPath).Length / 1MB, 2)
Write-Host "已生成: $outFile（$sizeMB MB）" -ForegroundColor Green
exit 0
