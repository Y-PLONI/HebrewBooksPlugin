[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $PluginArchive,

  [Parameter(Mandatory = $true)]
  [string] $AppVersion,

  [string] $OutputSuffix = '',

  # A runtime archive already on disk. Without it the archive is fetched from
  # the private service repository named in dependencies.json, which needs a
  # token in GH_TOKEN.
  [string] $RuntimeArchive = '',

  # Accept a downloaded runtime that GitHub reports no digest for. The supported
  # way to build without the digest check is -RuntimeArchive, with a copy you trust.
  [switch] $AllowUnverifiedRuntime
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

$runtimeArchivePath = Join-Path $downloadRoot $dependencies.runtime.archive

if (-not [string]::IsNullOrWhiteSpace($RuntimeArchive)) {
  Copy-Item (Resolve-Path $RuntimeArchive).Path $runtimeArchivePath
  Write-Host "Runtime supplied locally: $RuntimeArchive"
}
else {
  $release = $dependencies.runtime.release
  if ([string]::IsNullOrWhiteSpace($env:GH_TOKEN)) {
    throw "The runtime comes from the private repository $($release.repo). Set GH_TOKEN (in CI: secrets.ANGINE_PRIVATE), or pass -RuntimeArchive with a local copy."
  }

  Write-Host "Fetching $($release.asset) from $($release.repo)@$($release.tag)"
  gh release download $release.tag --repo $release.repo --pattern $release.asset --output $runtimeArchivePath --clobber
  if ($LASTEXITCODE -ne 0) {
    throw "Could not download $($release.asset) from $($release.repo)@$($release.tag)."
  }

  # That release is rebuilt on every push to the service, so a checksum pinned
  # in this repository would go stale within a day. Compare against the digest
  # GitHub recorded for the asset instead, which travels with it.
  $view = gh release view $release.tag --repo $release.repo --json assets | ConvertFrom-Json
  $asset = @($view.assets | Where-Object { $_.name -eq $release.asset })
  if ($asset.Count -ne 1) {
    throw "Expected one asset named $($release.asset), found $($asset.Count)."
  }
  # An older gh omits the field entirely, which Set-StrictMode turns into an
  # unrelated-looking error; treat that the same as an empty digest.
  $digest = if ($asset[0].PSObject.Properties.Name -contains 'digest') { $asset[0].digest } else { '' }
  if ([string]::IsNullOrWhiteSpace($digest)) {
    # Shipping an unverified runtime is worse than not shipping one.
    if (-not $AllowUnverifiedRuntime) {
      throw "GitHub reported no digest for $($release.asset), so the download cannot be verified. Pass -RuntimeArchive with a copy you trust, or -AllowUnverifiedRuntime to build anyway."
    }
    Write-Warning "GitHub reported no digest for $($release.asset); building unverified because -AllowUnverifiedRuntime was given."
  }
  else {
    $expectedRuntimeHash = ($digest -replace '^sha256:', '').ToLowerInvariant()
    $actualRuntimeHash = (Get-FileHash $runtimeArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualRuntimeHash -ne $expectedRuntimeHash) {
      throw "Runtime checksum mismatch. Expected $expectedRuntimeHash, got $actualRuntimeHash."
    }
  }
}

Expand-Archive $runtimeArchivePath -DestinationPath $runtimeRoot

if (-not (Test-Path (Join-Path $runtimeRoot 'hbsearch.exe'))) {
  # The service repository archives publish/<rid>, so its payload sits one
  # level down. Lift it, and keep accepting an archive that is already flat.
  $nested = @(Get-ChildItem $runtimeRoot -Directory)
  if ($nested.Count -eq 1 -and (Test-Path (Join-Path $nested[0].FullName 'hbsearch.exe'))) {
    Get-ChildItem $nested[0].FullName -Force | Move-Item -Destination $runtimeRoot
    Remove-Item $nested[0].FullName -Recurse -Force
  }
}

# dtSearch is loaded by filename at run time, so a runtime missing any of these
# starts and then fails every search. Catch it here rather than in the field.
foreach ($required in @(
    'hbsearch.exe',
    'dtSearchNetApi4.dll',
    'dten600.dll',
    'lbvProt.dll',
    'Alphabet.abc',
    'msvcp140.dll',
    'vcruntime140.dll')) {
  if (-not (Test-Path (Join-Path $runtimeRoot $required))) {
    throw "The runtime archive is missing $required."
  }
}
Write-Host "Runtime staged: $((Get-ChildItem $runtimeRoot -Recurse -File).Count) files"

$serviceExecutable = Join-Path $serviceRoot 'HebrewBooksSearchService.exe'
Invoke-WebRequest $dependencies.serviceWrapper.url -OutFile $serviceExecutable
$actualWrapperHash = (Get-FileHash $serviceExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedWrapperHash = $dependencies.serviceWrapper.sha256.ToLowerInvariant()
if ($actualWrapperHash -ne $expectedWrapperHash) {
  throw "WinSW checksum mismatch. Expected $expectedWrapperHash, got $actualWrapperHash."
}

Copy-Item $pluginPath (Join-Path $pluginRoot 'HebrewBooksPlugin.otzplugin')

# Machine-wide installers land in Program Files; winget installs Inno Setup per
# user, under LOCALAPPDATA, and spells the folder both ways.
$isccRoots = @(
  ${env:ProgramFiles(x86)},
  $env:ProgramFiles,
  (Join-Path $env:LOCALAPPDATA 'Programs')
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
$isccCandidates = foreach ($root in $isccRoots) {
  foreach ($folder in @('Inno Setup 6', 'InnoSetup6')) {
    Join-Path $root (Join-Path $folder 'ISCC.exe')
  }
}
$iscc = $isccCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($null -eq $iscc) {
  $onPath = Get-Command 'ISCC.exe' -ErrorAction SilentlyContinue
  if ($null -ne $onPath) {
    $iscc = $onPath.Source
  }
}
if ($null -eq $iscc) {
  throw 'Inno Setup 6 was not found. Install it before running this script.'
}
Write-Host "Inno Setup: $iscc"

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
