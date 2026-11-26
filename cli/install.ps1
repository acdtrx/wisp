# Installs the wisp CLI from the Wisp that served this script, for Windows
# (docs/specs/CLI.md, Getting it):
#   irm <url>/api/cli/install.ps1 | iex
# The Wisp writes its own address into $wispUrl as it serves the script. The
# binary goes to %LocalAppData%\Programs\wisp\wisp.exe, with no administrator.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$wispUrl = '{{wisp_url}}'

# A 32-bit PowerShell on a 64-bit Windows names the machine's processor in the second.
$machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($machine) {
  'AMD64' { 'amd64' }
  'ARM64' { 'arm64' }
  default { throw "wisp install: no wisp CLI for the $machine processor" }
}

$dir = Join-Path $env:LOCALAPPDATA 'Programs\wisp'
$dest = Join-Path $dir 'wisp.exe'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$tmp = Join-Path $dir ('.wisp-install-' + [guid]::NewGuid().ToString() + '.exe')

Write-Host "Downloading the wisp CLI for windows-$arch from $wispUrl"
try {
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 -Uri "$wispUrl/api/cli/wisp-windows-$arch" -OutFile $tmp
  & $tmp help | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'wisp install: the downloaded CLI does not run on this machine' }
  # A running wisp.exe cannot be written over, but it can be moved aside.
  if (Test-Path $dest) {
    Remove-Item -Force -ErrorAction SilentlyContinue "$dest.old"
    Move-Item -Force $dest "$dest.old"
  }
  Move-Item -Force $tmp $dest
} finally {
  if (Test-Path $tmp) { Remove-Item -Force $tmp }
}
Write-Host "Installed $dest"

if (-not (($env:Path -split ';') -contains $dir)) {
  Write-Host ''
  Write-Host "$dir is not on your PATH. Add it for your user, then open a new terminal:"
  Write-Host "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';$dir', 'User')"
}
Write-Host ''
Write-Host 'Next, sign in with an API token (Host -> App Config -> API tokens):'
Write-Host "  wisp login $wispUrl"
