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

# Accepts '3.0.115', '3.0.115.0' and '3.0.115-beta2+<sha>'; $null when unparseable.
function ConvertTo-RuntimeVersion([string] $text) {
  if ([string]::IsNullOrWhiteSpace($text) -or
    $text.Trim() -notmatch '^(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$') {
    return $null
  }
  $parts = @($Matches[1] -split '\.') + @('0', '0', '0', '0')
  [pscustomobject] @{
    Version    = [version] ($parts[0..3] -join '.')
    Prerelease = if ($Matches.ContainsKey(2)) { $Matches[2] } else { '' }
    # SemVer build metadata; the engine stamps its full commit SHA here.
    Build      = if ($Matches.ContainsKey(3)) { $Matches[3] } else { '' }
  }
}

# Newer than declared is fine; older is the failure. A prerelease of the declared
# version is not the declared version.
function Test-RuntimeOlder($staged, $declared) {
  ($staged.Version -lt $declared.Version) -or
    (($staged.Version -eq $declared.Version) -and $staged.Prerelease -and (-not $declared.Prerelease))
}

# A short SHA in dependencies.json matches the stamped full one as a prefix.
function Test-RuntimeCommit($staged, [string] $declared) {
  (-not [string]::IsNullOrWhiteSpace($staged.Build)) -and
    $staged.Build.StartsWith($declared, [System.StringComparison]::OrdinalIgnoreCase)
}

# The runtime comes from a rolling tag, so a plugin pushed before the service has
# republished it would otherwise be packaged around an engine older than it needs.
$declaredText = if ($dependencies.runtime.PSObject.Properties.Name -contains 'version') {
  $dependencies.runtime.version
} else { '' }
$declared = ConvertTo-RuntimeVersion $declaredText
if ($null -eq $declared) {
  throw "dependencies.json declares no usable runtime.version (found '$declaredText')."
}

# The engine's version number does not move with every commit: two builds that
# differ by real fixes both report 3.0.115. runtime.commit demands one of them.
$declaredCommit = if ($dependencies.runtime.PSObject.Properties.Name -contains 'commit') {
  ([string] $dependencies.runtime.commit).Trim()
} else { '' }
if ($declaredCommit -and $declaredCommit -notmatch '^[0-9A-Fa-f]{7,40}$') {
  throw "dependencies.json declares an unusable runtime.commit (found '$declaredCommit'). It must be the engine commit SHA, 7 to 40 hexadecimal characters."
}

$stampedInfo = (Get-Item (Join-Path $runtimeRoot 'hbsearch.exe')).VersionInfo
# ProductVersion carries the full SemVer; FileVersion is the four-part fallback.
$stampedText = $stampedInfo.ProductVersion
$staged = ConvertTo-RuntimeVersion $stampedText
if ($null -eq $staged) {
  $stampedText = $stampedInfo.FileVersion
  $staged = ConvertTo-RuntimeVersion $stampedText
}

if ($null -eq $staged) {
  # An engine we cannot identify is exactly the case this check exists for.
  if (-not $AllowUnverifiedRuntime) {
    throw "The staged hbsearch.exe carries no readable version (FileVersion '$($stampedInfo.FileVersion)', ProductVersion '$($stampedInfo.ProductVersion)'), so it cannot be checked against the $declaredText dependencies.json declares. Pass -AllowUnverifiedRuntime to build anyway."
  }
  Write-Warning "The staged hbsearch.exe carries no readable version; building unverified because -AllowUnverifiedRuntime was given."
}
else {
  if (Test-RuntimeOlder $staged $declared) {
    throw "Runtime too old. dependencies.json declares runtime.version $declaredText, but the staged hbsearch.exe reports $stampedText. $($dependencies.runtime.release.repo)@$($dependencies.runtime.release.tag) has probably not been republished yet; rebuild once it has, or pass -RuntimeArchive with an engine that is $declaredText or newer."
  }
  Write-Host "Runtime version: $stampedText (declared: $declaredText or newer)"

  if ($declaredCommit) {
    if ([string]::IsNullOrWhiteSpace($staged.Build)) {
      # No build metadata is "cannot verify", which is what the switch waives.
      if (-not $AllowUnverifiedRuntime) {
        throw "The staged hbsearch.exe reports $stampedText, with no build metadata, so the engine commit $declaredCommit that dependencies.json demands cannot be confirmed. Pass -RuntimeArchive with an engine built from that commit, or -AllowUnverifiedRuntime to build anyway."
      }
      Write-Warning "The staged hbsearch.exe carries no build metadata; runtime.commit $declaredCommit was not verified because -AllowUnverifiedRuntime was given."
    }
    elseif (-not (Test-RuntimeCommit $staged $declaredCommit)) {
      # A known-wrong engine, not an unverifiable one, so no switch waives it.
      throw "Runtime commit mismatch. dependencies.json demands engine commit $declaredCommit, but the staged hbsearch.exe was built from $($staged.Build). The engine's version number does not change per commit, so $($dependencies.runtime.release.repo)@$($dependencies.runtime.release.tag) can serve a different build under the same $stampedText; rebuild once that tag has caught up, point runtime.release.tag at the build-<short sha> release for the demanded commit, or pass -RuntimeArchive with that build."
    }
    else {
      Write-Host "Runtime commit: $($staged.Build) (demanded: $declaredCommit)"
    }
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
