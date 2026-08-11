[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $PluginArchive,

  [Parameter(Mandatory = $true)]
  [string] $AppVersion,

  [string] $OutputSuffix = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$installerRoot = $PSScriptRoot
$dependencies = Get-Content (Join-Path $installerRoot 'dependencies.json') -Raw |
  ConvertFrom-Json
$pluginPath = (Resolve-Path $PluginArchive).Path

if ($AppVersion -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
  throw "Invalid app version: $AppVersion"
}
if ($OutputSuffix -notmatch '^[0-9A-Za-z._-]*$') {
  throw "Invalid output suffix: $OutputSuffix"
}
$stagingRoot = Join-Path $installerRoot 'staging'
$downloadRoot = Join-Path $stagingRoot 'downloads'
$runtimeRoot = Join-Path $stagingRoot 'runtime'
$pluginRoot = Join-Path $stagingRoot 'plugin'
$serviceRoot = Join-Path $stagingRoot 'service'
$outputRoot = Join-Path $installerRoot 'output'

foreach ($path in @($stagingRoot, $outputRoot)) {
  if (Test-Path $path) {
    Remove-Item $path -Recurse -Force
  }
}
foreach ($path in @($downloadRoot, $runtimeRoot, $pluginRoot, $serviceRoot, $outputRoot)) {
  New-Item $path -ItemType Directory -Force | Out-Null
}

$runtimeArchive = Join-Path $downloadRoot $dependencies.runtime.archive
Invoke-WebRequest $dependencies.runtime.url -OutFile $runtimeArchive

$expectedRuntimeHash = $dependencies.runtime.sha256.ToLowerInvariant()
$actualRuntimeHash = (Get-FileHash $runtimeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualRuntimeHash -ne $expectedRuntimeHash) {
  throw "Runtime checksum mismatch. Expected $expectedRuntimeHash, got $actualRuntimeHash."
}

Expand-Archive $runtimeArchive -DestinationPath $runtimeRoot
if (-not (Test-Path (Join-Path $runtimeRoot 'hbsearch.exe'))) {
  throw 'The runtime archive must contain hbsearch.exe at its root.'
}

$serviceExecutable = Join-Path $serviceRoot 'HebrewBooksSearchService.exe'
Invoke-WebRequest $dependencies.serviceWrapper.url -OutFile $serviceExecutable
$actualWrapperHash = (Get-FileHash $serviceExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedWrapperHash = $dependencies.serviceWrapper.sha256.ToLowerInvariant()
if ($actualWrapperHash -ne $expectedWrapperHash) {
  throw "WinSW checksum mismatch. Expected $expectedWrapperHash, got $actualWrapperHash."
}

Copy-Item $pluginPath (Join-Path $pluginRoot 'HebrewBooksPlugin.otzplugin')

$isccCandidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
  (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
$iscc = $isccCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($null -eq $iscc) {
  throw 'Inno Setup 6 was not found. Install it before running this script.'
}

$isccArguments = @("/DAppVersion=$AppVersion")
if (-not [string]::IsNullOrEmpty($OutputSuffix)) {
  $isccArguments += "/DOutputSuffix=$OutputSuffix"
}
$isccArguments += (Join-Path $installerRoot 'HebrewBooksPlugin.iss')

& $iscc @isccArguments
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup failed with exit code $LASTEXITCODE."
}

$installers = @(Get-ChildItem $outputRoot -Filter '*.exe')
if ($installers.Count -ne 1) {
  throw "Expected one installer output, found $($installers.Count)."
}
$installer = $installers[0]
Write-Host "Installer created: $($installer.FullName)"
