param([Parameter(Mandatory=$true)][string]$Installer, [string]$Output = 'desktop-smoke-results')
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Run installer smoke tests in a disposable CI runner.' }
$Installer = (Resolve-Path $Installer).Path
New-Item -ItemType Directory -Force $Output | Out-Null
$Output = (Resolve-Path $Output).Path
Get-FileHash $Installer -Algorithm SHA256 | Format-List | Out-File "$Output\artifact.sha256"
$installDir = Join-Path $env:RUNNER_TEMP 'anagram-installed'
$driver = $null
$policies = @()
try {
  $install = Start-Process $Installer -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Installer failed: $($install.ExitCode)" }
  $binary = Join-Path $installDir 'anagram.exe'
  if (!(Test-Path $binary)) { throw 'Installer did not install anagram.exe' }
  # Match the actual WebView2 runtime, not the separately installed Edge browser.
  $runtime = Get-ChildItem "${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application\*\msedgewebview2.exe" |
    Sort-Object { [version]$_.VersionInfo.ProductVersion } -Descending | Select-Object -First 1
  if (!$runtime) { throw 'WebView2 runtime missing after installation' }
  $version = $runtime.VersionInfo.ProductVersion
  $zip = Join-Path $env:RUNNER_TEMP 'edgedriver.zip'
  $driverDir = Join-Path $env:RUNNER_TEMP 'edgedriver'
  Invoke-WebRequest "https://msedgedriver.microsoft.com/$version/edgedriver_win64.zip" -OutFile $zip
  Expand-Archive $zip -DestinationPath $driverDir -Force
  # Drive WebView2 directly so its startup diagnostics survive a failed session.
  # Keep the runtime and driver matched even if another Edge channel is installed.
  $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = Split-Path $runtime.FullName
  Write-Output "WebView2 runtime: $version ($env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER)"
  & "$driverDir\msedgedriver.exe" --version
  if ($LASTEXITCODE -ne 0) { throw 'Could not run Microsoft Edge WebDriver' }
  $driver = Start-Process "$driverDir\msedgedriver.exe" -ArgumentList @('--port=4444', '--verbose', "--log-path=`"$Output\edge-driver.log`"") -PassThru -RedirectStandardOutput "$Output\driver.log" -RedirectStandardError "$Output\driver-error.log"
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    if ($driver.HasExited) { throw 'Native WebDriver exited' }
    try {
      $status = Invoke-RestMethod 'http://127.0.0.1:4444/status' -TimeoutSec 2
      if ($status.value.ready) { $ready = $true; break }
    } catch { }
    Start-Sleep 1
  }
  if (!$ready) { throw 'Microsoft Edge WebDriver did not become ready' }
  # Hosted Windows jobs run elevated. WebView2 150+ ignores WEBVIEW2_*
  # environment overrides at high integrity, including the driver's port=0.
  # Configure only this app on the disposable runner and attach on a known port.
  # https://github.com/MicrosoftEdge/WebView2Feedback/issues/5645
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $debugPort = $listener.LocalEndpoint.Port
  $listener.Stop()
  $settings = @{
    AdditionalBrowserArguments = "--remote-debugging-port=$debugPort --remote-debugging-address=127.0.0.1"
    UserDataFolder = (Join-Path $env:RUNNER_TEMP 'anagram-webview-smoke')
    BrowserExecutableFolder = (Split-Path $runtime.FullName)
  }
  foreach ($setting in $settings.GetEnumerator()) {
    $path = "HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\$($setting.Key)"
    if (!(Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
    $key = Get-Item $path
    $existed = $key.GetValueNames() -contains 'anagram.exe'
    $policies += @{ Path = $path; Existed = $existed; Value = $key.GetValue('anagram.exe') }
    New-ItemProperty -Path $path -Name 'anagram.exe' -Value $setting.Value -PropertyType String -Force | Out-Null
  }
  $env:ANAGRAM_WEBVIEW2_DEBUG_PORT = "$debugPort"
  $env:ANAGRAM_WEBDRIVER_KIND = 'webview2'
  $env:ANAGRAM_DISPOSABLE_TEST = '1'
  node scripts/release-smoke/desktop.mjs $binary $Output
  if ($LASTEXITCODE -ne 0) { throw 'Installed Windows app failed smoke checks' }
} finally {
  if ($driver -and !$driver.HasExited) { taskkill /PID $driver.Id /T /F | Out-Null }
  foreach ($policy in $policies) {
    if ($policy.Existed) {
      Set-ItemProperty -Path $policy.Path -Name 'anagram.exe' -Value $policy.Value
    } else {
      Remove-ItemProperty -Path $policy.Path -Name 'anagram.exe' -ErrorAction SilentlyContinue
    }
  }
}
